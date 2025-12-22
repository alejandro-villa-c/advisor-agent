import { Injectable, Logger } from '@nestjs/common';
import { AgentToolsService } from './agent-tools.service';
import { ToolExecutorService } from '../tools/tools-executor.service';
import { AgentTasksService, type AgentTaskRow } from './agent-tasks.service';
import {
  OpenAiToolChatService,
  type OpenAiChatMessage,
  type OpenAiToolCall,
  type OpenAiChatToolCall,
} from '../integrations/openai/openai-tool-chat.service';
import { PgBossService } from '../../jobs/pgboss.service';
import { AGENT_REACT_JOB } from '../../jobs/job.constants';
import { GmailApiService } from '../integrations/google/gmail-api.service';

/**
 * AgentRunnerService - Executes agent tasks using an LLM-driven tool-calling loop.
 *
 * DESIGN PRINCIPLES:
 * 1. NO PATTERN MATCHING - All decisions made by LLM
 * 2. Every LLM turn must end with a control tool (await/complete/fail)
 * 3. If LLM outputs text without control tool, we ASK the LLM to decide
 * 4. Full context always loaded from DB
 * 5. Memory persisted across waits
 */
@Injectable()
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);

  // Control tools that determine task state
  private readonly CONTROL_TOOLS = [
    'await_user_message',
    'await_email_reply',
    'await_calendar_event',
    'complete_task',
    'fail_task',
  ];

  constructor(
    private readonly openAi: OpenAiToolChatService,
    private readonly agentTools: AgentToolsService,
    private readonly toolExecutor: ToolExecutorService,
    private readonly tasks: AgentTasksService,
    private readonly pgBoss: PgBossService,
    private readonly gmailApi: GmailApiService,
  ) {}

  /**
   * Run a task to completion or until it needs to wait.
   */
  async runTask(taskId: number): Promise<void> {
    const task = await this.tasks.getTask(taskId);
    if (!task) {
      this.logger.warn(`[agent] Task not found: ${taskId}`);
      return;
    }

    this.logger.log(`[agent] Running task ${taskId}: "${task.goal.slice(0, 60)}..."`);

    try {
      if (task.status === 'completed' || task.status === 'failed') {
        this.logger.log(`[agent] Task ${taskId} already terminal: ${task.status}`);
        return;
      }

      if (!this.openAi.isConfigured()) {
        await this.tasks.setStatus(taskId, 'failed', 'OPENAI_API_KEY is not set.');
        return;
      }

      await this.tasks.setWaiting(taskId, null);
      await this.tasks.setStatus(taskId, 'running', null);

      await this.runLlmLoop(taskId, task);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[agent] Task ${taskId} error: ${msg}`);
      await this.tasks.setStatus(taskId, 'failed', `Error: ${msg}`);
    } finally {
      await this.enqueueReact(taskId);
    }
  }

  /**
   * Main LLM loop - runs until a control tool determines the next state.
   */
  private async runLlmLoop(taskId: number, task: AgentTaskRow): Promise<void> {
    const MAX_TURNS = 25;
    const MAX_TOOL_CALLS = 60;
    let toolCallCount = 0;

    // Get fresh task state (memory may have been updated)
    const freshTask = (await this.tasks.getTask(taskId)) ?? task;
    const memory = freshTask.memory ?? {};

    // Build system prompt
    const systemPrompt = this.agentTools.buildSystemPrompt({
      goal: task.goal,
      memory,
    });

    // Get tool definitions
    const toolDefs = this.agentTools.getToolDefinitions();

    // Load FULL conversation history from DB
    const history = await this.tasks.getMessagesForOpenAi(taskId);
    this.logger.debug(`[agent] Task ${taskId}: Loaded ${history.length} history messages`);

    // Build messages array
    const messages: OpenAiChatMessage[] = [{ role: 'system', content: systemPrompt }, ...history];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      this.logger.debug(`[agent] Task ${taskId}: Turn ${turn + 1}/${MAX_TURNS}`);

      const resp = await this.openAi.completeWithTools({
        messages,
        tools: toolDefs,
        temperature: 0.2,
      });

      // =====================================================================
      // CASE 1: LLM returned tool calls
      // =====================================================================
      if (resp.kind === 'tool_calls') {
        const assistantText = resp.assistantText?.trim() ?? '';

        // Save assistant text if present
        if (assistantText) {
          await this.tasks.appendMessage({
            taskId,
            userId: task.userId,
            role: 'assistant',
            content: assistantText,
          });
        }

        // Add to messages for next turn
        const toolCallsFormatted: OpenAiChatToolCall[] = resp.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argumentsJson },
        }));

        messages.push({
          role: 'assistant',
          content: assistantText,
          tool_calls: toolCallsFormatted,
        });

        // Execute each tool call
        for (const tc of resp.toolCalls) {
          toolCallCount++;
          if (toolCallCount > MAX_TOOL_CALLS) {
            await this.tasks.setStatus(taskId, 'failed', 'Too many tool calls.');
            return;
          }

          const result = await this.executeToolCall(taskId, task, tc);

          // Persist tool result
          const resultJson = JSON.stringify(result.output, null, 2);
          await this.tasks.appendMessage({
            taskId,
            userId: task.userId,
            role: 'tool',
            content: resultJson,
            toolName: tc.name,
            toolCallId: tc.id,
          });

          messages.push({
            role: 'tool',
            name: tc.name,
            tool_call_id: tc.id,
            content: resultJson,
          });

          // Check for control flow
          if (result.controlFlow === 'wait') {
            if (result.userMessage) {
              await this.tasks.appendMessage({
                taskId,
                userId: task.userId,
                role: 'assistant',
                content: result.userMessage,
              });
            }
            await this.tasks.setStatus(taskId, 'waiting', null);
            this.logger.log(`[agent] Task ${taskId}: Now waiting`);
            return;
          }

          if (result.controlFlow === 'complete') {
            if (result.userMessage) {
              await this.tasks.appendMessage({
                taskId,
                userId: task.userId,
                role: 'assistant',
                content: result.userMessage,
              });
            }
            await this.tasks.setStatus(taskId, 'completed', null);
            this.logger.log(`[agent] Task ${taskId}: Completed`);
            return;
          }

          if (result.controlFlow === 'fail') {
            await this.tasks.setStatus(taskId, 'failed', result.failReason ?? 'Task failed');
            this.logger.log(`[agent] Task ${taskId}: Failed - ${result.failReason}`);
            return;
          }
        }

        // No control tool was called - continue to next turn
        continue;
      }

      // =====================================================================
      // CASE 2: LLM returned final text (no tool calls)
      // This should NOT happen if the LLM follows instructions.
      // We ask the LLM to make an explicit decision.
      // =====================================================================
      const finalText = resp.text.trim();
      this.logger.warn(
        `[agent] Task ${taskId}: LLM returned text without control tool. Asking for decision.`,
      );

      // Save the text the LLM produced
      if (finalText) {
        await this.tasks.appendMessage({
          taskId,
          userId: task.userId,
          role: 'assistant',
          content: finalText,
        });
        messages.push({ role: 'assistant', content: finalText });
      }

      // Ask LLM to make an explicit control decision
      const controlResult = await this.askLlmForControlDecision(taskId, task, messages, finalText);

      if (controlResult.controlFlow === 'wait') {
        await this.tasks.setStatus(taskId, 'waiting', null);
        this.logger.log(`[agent] Task ${taskId}: Now waiting (via control decision)`);
        return;
      }

      if (controlResult.controlFlow === 'complete') {
        await this.tasks.setStatus(taskId, 'completed', null);
        this.logger.log(`[agent] Task ${taskId}: Completed (via control decision)`);
        return;
      }

      if (controlResult.controlFlow === 'fail') {
        await this.tasks.setStatus(taskId, 'failed', controlResult.failReason ?? 'Task failed');
        this.logger.log(`[agent] Task ${taskId}: Failed (via control decision)`);
        return;
      }

      // If somehow no decision was made, continue (shouldn't happen)
      this.logger.warn(`[agent] Task ${taskId}: No control decision made, continuing loop`);
    }

    // Max turns exhausted
    await this.tasks.setStatus(taskId, 'failed', 'Max turns reached without completion.');
    this.logger.warn(`[agent] Task ${taskId}: Max turns exhausted`);
  }

  /**
   * When the LLM outputs text without a control tool, we explicitly ask it to decide.
   * This uses a focused prompt with ONLY control tools available.
   */
  private async askLlmForControlDecision(
    taskId: number,
    task: AgentTaskRow,
    messages: OpenAiChatMessage[],
    lastOutput: string,
  ): Promise<ToolCallResult> {
    const decisionPrompt = `You just output this message to the user:

"${lastOutput}"

You MUST now decide what happens next. Call exactly ONE of these tools:

1. await_user_message - Call this if you asked the user a question or need their input before continuing. Pass the question/prompt as the parameter.

2. complete_task - Call this if the user's goal has been FULLY achieved. The task is done.

3. fail_task - Call this if you cannot complete the goal (missing info, error, impossible request).

Think about what you just said:
- Did you ask a question? → await_user_message
- Did you confirm something is done? → complete_task  
- Did you explain why you can't proceed? → fail_task

Call the appropriate tool NOW.`;

    // Only provide control tools
    const controlToolDefs = this.agentTools
      .getToolDefinitions()
      .filter((t) =>
        ['await_user_message', 'complete_task', 'fail_task'].includes(t.function.name),
      );

    const decisionMessages: OpenAiChatMessage[] = [
      ...messages,
      { role: 'user', content: decisionPrompt },
    ];

    const resp = await this.openAi.completeWithTools({
      messages: decisionMessages,
      tools: controlToolDefs,
      temperature: 0.0, // Deterministic
    });

    if (resp.kind === 'tool_calls' && resp.toolCalls.length > 0) {
      const tc = resp.toolCalls[0];
      return await this.executeToolCall(taskId, task, tc);
    }

    // If LLM still doesn't call a tool, default to await_user_message
    // (safer than completing prematurely)
    this.logger.warn(
      `[agent] Task ${taskId}: LLM failed to call control tool even when asked. Defaulting to wait.`,
    );

    const waiting = {
      kind: 'user_message',
      prompt: lastOutput || 'Waiting for your response...',
      sinceIso: new Date().toISOString(),
      fallbackTriggered: true,
    };
    await this.tasks.setWaiting(taskId, waiting);

    return {
      success: true,
      output: { waiting: true, fallback: true },
      controlFlow: 'wait',
    };
  }

  /**
   * Execute a single tool call and return the result.
   */
  private async executeToolCall(
    taskId: number,
    task: AgentTaskRow,
    tc: OpenAiToolCall,
  ): Promise<ToolCallResult> {
    const params = safeJsonParse(tc.argumentsJson);

    // Log the tool call
    await this.tasks.logToolCall({
      taskId,
      userId: task.userId,
      toolName: tc.name,
      toolCallId: tc.id,
      status: 'ok',
      inputJson: params,
    });

    // Handle control tools
    switch (tc.name) {
      case 'await_user_message':
        return this.handleAwaitUserMessage(taskId, params);

      case 'await_email_reply':
        return this.handleAwaitEmailReply(taskId, task.userId, params);

      case 'await_calendar_event':
        return this.handleAwaitCalendarEvent(taskId, params);

      case 'remember':
        return this.handleRemember(taskId, params);

      case 'complete_task':
        return this.handleCompleteTask(params);

      case 'fail_task':
        return this.handleFailTask(params);
    }

    // Execute regular tools
    const result = await this.toolExecutor.execute(task.userId, tc.name, params);

    // Log result
    await this.tasks.logToolCall({
      taskId,
      userId: task.userId,
      toolName: tc.name,
      toolCallId: tc.id,
      status: result.success ? 'ok' : 'error',
      inputJson: params,
      outputJson: result.data,
      error: result.error,
    });

    return {
      success: result.success,
      output: result.data ?? { error: result.error },
      error: result.error,
    };
  }

  // ===========================================================================
  // CONTROL TOOL HANDLERS
  // ===========================================================================

  private async handleAwaitUserMessage(
    taskId: number,
    params: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const prompt = safeString(params.prompt) || 'Waiting for your response...';

    await this.tasks.setWaiting(taskId, {
      kind: 'user_message',
      prompt,
      sinceIso: new Date().toISOString(),
    });

    return {
      success: true,
      output: { waiting: true, kind: 'user_message' },
      controlFlow: 'wait',
      userMessage: prompt,
    };
  }

  private async handleAwaitEmailReply(
    taskId: number,
    userId: number,
    params: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const threadId = safeString(params.threadId);
    const fromEmail = safeString(params.fromEmail) || null;
    const purpose = safeString(params.purpose) || 'Waiting for email reply';

    if (!threadId) {
      return {
        success: false,
        output: { error: 'threadId is required' },
        error: 'threadId is required',
      };
    }

    // Get baseline for detecting new replies
    let sinceMs = Date.now();
    try {
      const msgs = await this.gmailApi.getThreadMessages(userId, threadId);
      if (msgs.length > 0) {
        sinceMs = Math.max(...msgs.map((m) => m.internalDateMs ?? 0));
      }
    } catch {
      // Use current time as baseline
    }

    await this.tasks.setWaiting(taskId, {
      kind: 'gmail_reply',
      threadId,
      fromEmail,
      purpose,
      sinceIso: new Date().toISOString(),
      sinceInternalDateMs: sinceMs,
    });

    return {
      success: true,
      output: { waiting: true, kind: 'gmail_reply', threadId },
      controlFlow: 'wait',
      userMessage: `I'll wait for a reply to that email. ${purpose}`,
    };
  }

  private async handleAwaitCalendarEvent(
    taskId: number,
    params: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const eventId = safeString(params.eventId);
    const triggerMinutesBefore = safeNumber(params.triggerMinutesBefore, 0);
    const purpose = safeString(params.purpose) || 'Waiting for event';

    if (!eventId) {
      return {
        success: false,
        output: { error: 'eventId is required' },
        error: 'eventId is required',
      };
    }

    await this.tasks.setWaiting(taskId, {
      kind: 'calendar_event',
      eventId,
      triggerMinutesBefore,
      purpose,
      sinceIso: new Date().toISOString(),
    });

    const timing = triggerMinutesBefore > 0 ? `${triggerMinutesBefore} minutes before` : 'when';

    return {
      success: true,
      output: { waiting: true, kind: 'calendar_event', eventId },
      controlFlow: 'wait',
      userMessage: `I'll resume ${timing} the event starts.`,
    };
  }

  private async handleRemember(
    taskId: number,
    params: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const key = safeString(params.key);
    const value = params.value;

    if (!key) {
      return {
        success: false,
        output: { error: 'key is required' },
        error: 'key is required',
      };
    }

    const merged = await this.tasks.mergeMemory(taskId, { [key]: value });

    return {
      success: true,
      output: { remembered: true, key, memory: merged },
    };
  }

  private handleCompleteTask(params: Record<string, unknown>): ToolCallResult {
    const summary = safeString(params.summary) || 'Task completed.';

    return {
      success: true,
      output: { completed: true },
      controlFlow: 'complete',
      userMessage: summary,
    };
  }

  private handleFailTask(params: Record<string, unknown>): ToolCallResult {
    const reason = safeString(params.reason) || 'Task failed.';

    return {
      success: true,
      output: { failed: true },
      controlFlow: 'fail',
      failReason: reason,
      userMessage: `I couldn't complete this task: ${reason}`,
    };
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private async enqueueReact(taskId: number): Promise<void> {
    try {
      await this.pgBoss.client.send(
        AGENT_REACT_JOB,
        { taskId },
        { singletonKey: `agent.react:${taskId}:${Date.now()}`, singletonSeconds: 5 },
      );
    } catch (err) {
      this.logger.warn(`enqueueReact failed: ${err}`);
    }
  }
}

// =============================================================================
// TYPES & HELPERS
// =============================================================================

type ToolCallResult = {
  success: boolean;
  output: Record<string, unknown>;
  error?: string;
  controlFlow?: 'wait' | 'complete' | 'fail';
  failReason?: string;
  userMessage?: string;
};

function safeJsonParse(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text || '{}');
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function safeString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function safeNumber(value: unknown, defaultValue: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return defaultValue;
}
