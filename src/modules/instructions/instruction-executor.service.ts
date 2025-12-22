import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { OpenAiChatService } from '../integrations/openai/openai-chat.service';
import { ToolExecutorService } from '../tools/tools-executor.service';
import { InstructionsService, InstructionRow } from './instructions.service';

export type TriggerEvent = {
  type:
    | 'gmail_received'
    | 'gmail_sent'
    | 'calendar_event_created'
    | 'calendar_event_updated'
    | 'calendar_event_deleted'
    | 'hubspot_contact_created'
    | 'hubspot_contact_updated'
    | 'hubspot_contact_deleted'
    | 'hubspot_note_created'
    | 'hubspot_note_deleted';
  summary: string;
  data: Record<string, unknown>;
};

type ActionPlan = {
  shouldAct: boolean;
  matchingInstructionId: number | null;
  matchingInstructionText: string | null;
  actions: Array<{
    tool: string;
    description: string;
    params: Record<string, unknown>;
  }>;
  reasoning: string;
};

/**
 * InstructionExecutorService - Executes proactive actions based on ongoing instructions.
 *
 * This service:
 * 1. Receives trigger events (new email, calendar change, etc.)
 * 2. Uses LLM to determine if any active instruction applies
 * 3. Plans and executes actions using the shared ToolExecutorService
 *
 * Uses the shared ToolExecutorService for actual tool execution,
 * which is also used by the AgentRunnerService.
 */
@Injectable()
export class InstructionExecutorService {
  private readonly logger = new Logger(InstructionExecutorService.name);

  constructor(
    private readonly dbService: DbService,
    private readonly llm: OpenAiChatService,
    private readonly instructionsService: InstructionsService,
    private readonly toolExecutor: ToolExecutorService,
  ) {}

  /**
   * Process a trigger event against user's active instructions.
   * Uses LLM to determine if any instruction applies and what action to take.
   */
  async processTrigger(
    userId: number,
    trigger: TriggerEvent,
    instructions: InstructionRow[],
  ): Promise<void> {
    if (instructions.length === 0) return;

    // Safety: Check for self-loop (agent's own emails)
    if (this.isSelfGeneratedTrigger(trigger)) {
      this.logger.debug(`[InstructionExecutor] Skipping self-generated trigger: ${trigger.type}`);
      return;
    }

    // Safety: Check idempotency - have we already processed this exact trigger?
    const alreadyProcessed = await this.instructionsService.isTriggerProcessed(
      userId,
      trigger.type,
      trigger.summary,
    );
    if (alreadyProcessed) {
      this.logger.debug(
        `[InstructionExecutor] Skipping already-processed trigger: ${trigger.type} - ${trigger.summary}`,
      );
      return;
    }

    // Check rate limit
    const rateLimit = await this.instructionsService.checkRateLimit(userId);
    if (!rateLimit.allowed) {
      this.logger.warn(
        `[InstructionExecutor] User ${userId} hit rate limit (${rateLimit.remaining} remaining)`,
      );
      return;
    }

    // Ask LLM to plan actions
    const plan = await this.planActions(userId, trigger, instructions);

    if (!plan.shouldAct) {
      this.logger.debug(`[InstructionExecutor] No action needed for trigger: ${trigger.type}`);
      return;
    }

    this.logger.log(
      `[InstructionExecutor] Executing ${plan.actions.length} action(s) for trigger: ${trigger.type}`,
    );

    // Execute the planned actions
    for (const action of plan.actions) {
      // Log the action as "running"
      const actionLogId = await this.instructionsService.logProactiveAction({
        userId,
        instructionId: plan.matchingInstructionId,
        instructionText: plan.matchingInstructionText ?? '',
        triggerType: trigger.type,
        triggerSummary: trigger.summary,
        triggerData: trigger.data,
        actionTaken: `${action.tool}: ${action.description}`,
        status: 'running',
      });

      try {
        // Use shared ToolExecutorService
        const result = await this.toolExecutor.execute(userId, action.tool, action.params);

        if (result.success) {
          // Update log to completed
          await this.instructionsService.updateProactiveAction(actionLogId, {
            status: 'completed',
            actionResult: result.data,
          });

          // Increment rate limit counter
          await this.instructionsService.incrementRateLimit(userId);
        } else {
          // Update log to failed
          await this.instructionsService.updateProactiveAction(actionLogId, {
            status: 'failed',
            error: result.error,
          });
        }
      } catch (err) {
        this.logger.error(
          `[InstructionExecutor] Action failed: ${err instanceof Error ? err.message : String(err)}`,
        );

        // Update log to failed
        await this.instructionsService.updateProactiveAction(actionLogId, {
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Check if this trigger was generated by the agent itself (to prevent loops)
   */
  private isSelfGeneratedTrigger(trigger: TriggerEvent): boolean {
    if (trigger.type === 'gmail_received') {
      const data = trigger.data;

      // Check if this is flagged as sent by us (from the worker)
      if (data.isSent === true) {
        return true;
      }

      // Check for markers that indicate automated emails
      const snippet = safeString(data.snippet).toLowerCase();
      const subject = safeString(data.subject).toLowerCase();

      if (snippet.includes('[sent by ai assistant]') || subject.includes('[automated]')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Use LLM to determine what actions (if any) should be taken
   */
  private async planActions(
    _userId: number,
    trigger: TriggerEvent,
    instructions: InstructionRow[],
  ): Promise<ActionPlan> {
    if (!this.llm.isConfigured()) {
      return {
        shouldAct: false,
        matchingInstructionId: null,
        matchingInstructionText: null,
        actions: [],
        reasoning: 'LLM not configured',
      };
    }

    const instructionsList = instructions
      .map((inst, i) => `${i + 1}. [ID:${inst.id}] "${inst.instruction}"`)
      .join('\n');

    const triggerDescription = `
Type: ${trigger.type}
Summary: ${trigger.summary}
Details: ${JSON.stringify(trigger.data, null, 2)}
    `.trim();

    // Get tool definitions from shared service
    const toolDefs = this.toolExecutor.getToolDefinitions();
    const toolDescriptions = toolDefs
      .filter(
        (t) =>
          ![
            'await_user_message',
            'await_email_reply',
            'await_calendar_event',
            'remember',
            'complete_task',
            'fail_task',
          ].includes(t.function.name),
      )
      .map((t) => `- ${t.function.name}: ${t.function.description}`)
      .join('\n');

    const systemPrompt = `You are evaluating whether any ongoing instructions apply to a trigger event.

TRIGGER EVENT:
${triggerDescription}

USER'S ACTIVE INSTRUCTIONS:
${instructionsList}

AVAILABLE TOOLS:
${toolDescriptions}

═══════════════════════════════════════════════════════════════════════════════
CRITICAL: EXTRACTING DATA FROM TRIGGER EVENTS
═══════════════════════════════════════════════════════════════════════════════

For gmail_received triggers, the trigger data contains PARSED sender information.
You MUST use ALL available fields when creating contacts:

The "sender" object contains:
- sender.email: The sender's email address (ALWAYS use this)
- sender.firstName: First name (use if available, otherwise null)
- sender.lastName: Last name (use if available, otherwise null)
- sender.name: Full name (use if firstName/lastName not available)

EXAMPLE - Trigger data contains:
{
  "sender": {
    "email": "john.smith@example.com",
    "firstName": "John",
    "lastName": "Smith",
    "name": "John Smith"
  }
}

When using hubspot_find_or_create_contact, you MUST include:
{
  "email": "john.smith@example.com",
  "firstName": "John",      // FROM sender.firstName
  "lastName": "Smith",      // FROM sender.lastName
  "noteBody": "..."
}

DO NOT omit firstName or lastName if they are present in the trigger data!

═══════════════════════════════════════════════════════════════════════════════
RESPONSE FORMAT
═══════════════════════════════════════════════════════════════════════════════

Return ONLY valid JSON:
{
  "shouldAct": boolean,
  "matchingInstructionIndex": number | null,  // 1-based index
  "reasoning": string,
  "actions": [
    {
      "tool": string,
      "description": string,  // Human-readable description
      "params": { ... }       // Tool-specific parameters - INCLUDE ALL AVAILABLE DATA
    }
  ]
}

═══════════════════════════════════════════════════════════════════════════════
IMPORTANT RULES
═══════════════════════════════════════════════════════════════════════════════

1. Only act if an instruction CLEARLY applies to this trigger
2. Don't act on automated/system emails (noreply@, notifications, newsletters)
3. Use hubspot_find_or_create_contact with ALL available contact fields (email, firstName, lastName)
4. Be conservative - when in doubt, don't act
5. NEVER act on emails from AI/automated systems
6. For notes, include relevant context (email subject, snippet)

═══════════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════════

Instruction: "When someone emails me that's not in HubSpot, create a contact"
Trigger: gmail_received with sender.email="alejandro@example.com", sender.firstName="Alejandro", sender.lastName="Villa"

CORRECT action:
{
  "tool": "hubspot_find_or_create_contact",
  "description": "Creating contact for Alejandro Villa",
  "params": {
    "email": "alejandro@example.com",
    "firstName": "Alejandro",
    "lastName": "Villa",
    "noteBody": "Received email with subject: [subject]. Snippet: [snippet]"
  }
}

WRONG (missing lastName):
{
  "tool": "hubspot_find_or_create_contact",
  "params": {
    "email": "alejandro@example.com",
    "firstName": "Alejandro"
  }
}

═══════════════════════════════════════════════════════════════════════════════

Analyze the trigger and plan actions, making sure to include ALL available data fields.`;

    try {
      const raw = await this.llm.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Analyze and plan actions.' },
        ],
        temperature: 0.0,
      });

      const parsed = safeJsonParse(raw);
      if (!isRecord(parsed)) {
        return {
          shouldAct: false,
          matchingInstructionId: null,
          matchingInstructionText: null,
          actions: [],
          reasoning: 'Failed to parse LLM response',
        };
      }

      const shouldAct = parsed.shouldAct === true;
      const matchingIndex =
        typeof parsed.matchingInstructionIndex === 'number'
          ? parsed.matchingInstructionIndex
          : null;

      const matchingInstruction =
        matchingIndex !== null && matchingIndex >= 1 && matchingIndex <= instructions.length
          ? instructions[matchingIndex - 1]
          : null;

      const actions = Array.isArray(parsed.actions)
        ? parsed.actions
            .filter((a): a is Record<string, unknown> => isRecord(a))
            .map((a) => ({
              tool: typeof a.tool === 'string' ? a.tool : '',
              description: typeof a.description === 'string' ? a.description : '',
              params: isRecord(a.params) ? a.params : {},
            }))
            .filter((a) => a.tool)
        : [];

      const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';

      return {
        shouldAct,
        matchingInstructionId: matchingInstruction?.id ?? null,
        matchingInstructionText: matchingInstruction?.instruction ?? null,
        actions,
        reasoning,
      };
    } catch (err) {
      this.logger.error(
        `[InstructionExecutor] planActions failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        shouldAct: false,
        matchingInstructionId: null,
        matchingInstructionText: null,
        actions: [],
        reasoning: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function safeJsonParse(text: string): unknown {
  if (!text) return null;
  try {
    const cleaned = text
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
