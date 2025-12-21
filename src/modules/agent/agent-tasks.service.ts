import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '../../db/db.service';
import { agentTaskMessages, agentTaskToolCalls, agentTasks } from '../../db/schema';
import type {
  OpenAiChatMessage,
  OpenAiChatMessageRole,
} from '../integrations/openai/openai-tool-chat.service';

export type AgentTaskRow = {
  id: number;
  userId: number;
  status: string;
  goal: string;
  memory: Record<string, unknown>;
  waiting: Record<string, unknown> | null;
  lastError: string | null;
};

export type AgentUiMessage = {
  id: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolName: string | null;
  toolCallId: string | null;
};

@Injectable()
export class AgentTasksService {
  constructor(private readonly dbService: DbService) {}

  async createTask(input: {
    userId: number;
    goal: string;
    memory?: Record<string, unknown>;
  }): Promise<number> {
    const goal = String(input.goal ?? '').trim();
    if (!goal) throw new Error('createTask: goal is required');

    const inserted = await this.dbService.db
      .insert(agentTasks)
      .values({
        userId: input.userId,
        status: 'queued',
        goal,
        memory: isRecord(input.memory) ? input.memory : {},
        waiting: null,
        lastError: null,
        updatedAt: sql`now()`,
      })
      .returning({ id: agentTasks.id });

    const id = inserted[0]?.id;
    if (!id) throw new Error('createTask: insert returned no id');

    return id;
  }

  async getTask(taskId: number): Promise<AgentTaskRow | null> {
    const rows = await this.dbService.db
      .select({
        id: agentTasks.id,
        userId: agentTasks.userId,
        status: agentTasks.status,
        goal: agentTasks.goal,
        memory: agentTasks.memory,
        waiting: agentTasks.waiting,
        lastError: agentTasks.lastError,
      })
      .from(agentTasks)
      .where(eq(agentTasks.id, taskId))
      .limit(1);

    const r = rows[0];
    if (!r) return null;

    return {
      id: r.id,
      userId: r.userId,
      status: String(r.status),
      goal: String(r.goal),
      memory: isRecord(r.memory) ? r.memory : {},
      waiting: isRecord(r.waiting) ? r.waiting : null,
      lastError: typeof r.lastError === 'string' ? r.lastError : null,
    };
  }

  async setStatus(
    taskId: number,
    status: 'queued' | 'running' | 'waiting' | 'completed' | 'failed',
    lastError?: string | null,
  ): Promise<void> {
    await this.dbService.db
      .update(agentTasks)
      .set({
        status,
        lastError: typeof lastError === 'string' ? lastError : null,
        updatedAt: sql`now()`,
      })
      .where(eq(agentTasks.id, taskId));
  }

  async setWaiting(taskId: number, waiting: Record<string, unknown> | null): Promise<void> {
    await this.dbService.db
      .update(agentTasks)
      .set({ waiting, updatedAt: sql`now()` })
      .where(eq(agentTasks.id, taskId));
  }

  /**
   * Used when resuming a waiting task (gmail tick, or advisor reply in UI).
   * Atomically flips waiting->queued so duplicate enqueues are avoided.
   */
  async claimWaitingTask(taskId: number): Promise<boolean> {
    const res = await this.dbService.db
      .update(agentTasks)
      .set({
        status: 'queued',
        waiting: null,
        lastError: null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(agentTasks.id, taskId), eq(agentTasks.status, 'waiting')))
      .returning({ id: agentTasks.id });

    return res.length > 0;
  }

  async mergeMemory(
    taskId: number,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const task = await this.getTask(taskId);
    const current = task?.memory ?? {};
    const merged: Record<string, unknown> = { ...current, ...patch };

    await this.dbService.db
      .update(agentTasks)
      .set({ memory: merged, updatedAt: sql`now()` })
      .where(eq(agentTasks.id, taskId));

    return merged;
  }

  async appendMessage(input: {
    taskId: number;
    userId: number;
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    toolName?: string | null;
    toolCallId?: string | null;
  }): Promise<void> {
    await this.dbService.db.insert(agentTaskMessages).values({
      taskId: input.taskId,
      userId: input.userId,
      role: input.role,
      content: input.content,
      toolName: input.toolName ?? null,
      toolCallId: input.toolCallId ?? null,
    });
  }

  async logToolCall(input: {
    taskId: number;
    userId: number;
    toolName: string;
    toolCallId: string;
    status: 'ok' | 'error' | 'await';
    inputJson: Record<string, unknown>;
    outputJson?: Record<string, unknown> | null;
    error?: string | null;
  }): Promise<void> {
    await this.dbService.db.insert(agentTaskToolCalls).values({
      taskId: input.taskId,
      userId: input.userId,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      input: input.inputJson,
      output: input.outputJson ?? null,
      status: input.status,
      error: input.error ?? null,
    });
  }

  async getMessagesForUi(taskId: number): Promise<AgentUiMessage[]> {
    const rows = await this.dbService.db
      .select({
        id: agentTaskMessages.id,
        role: agentTaskMessages.role,
        content: agentTaskMessages.content,
        toolName: agentTaskMessages.toolName,
        toolCallId: agentTaskMessages.toolCallId,
      })
      .from(agentTaskMessages)
      .where(eq(agentTaskMessages.taskId, taskId))
      .orderBy(agentTaskMessages.id);

    return rows.map((r) => ({
      id: r.id,
      role: toRole(String(r.role)),
      content: String(r.content ?? ''),
      toolName: typeof r.toolName === 'string' ? r.toolName : null,
      toolCallId: typeof r.toolCallId === 'string' ? r.toolCallId : null,
    }));
  }

  /**
   * IMPORTANT: OpenAI-ready history.
   * Rebuilds assistant `tool_calls` so tool messages have valid `tool_call_id` references on resume.
   */
  async getMessagesForOpenAi(taskId: number): Promise<OpenAiChatMessage[]> {
    const [msgRows, toolRows] = await Promise.all([
      this.dbService.db
        .select({
          id: agentTaskMessages.id,
          role: agentTaskMessages.role,
          content: agentTaskMessages.content,
          toolName: agentTaskMessages.toolName,
          toolCallId: agentTaskMessages.toolCallId,
        })
        .from(agentTaskMessages)
        .where(eq(agentTaskMessages.taskId, taskId))
        .orderBy(agentTaskMessages.id),

      this.dbService.db
        .select({
          toolName: agentTaskToolCalls.toolName,
          toolCallId: agentTaskToolCalls.toolCallId,
          input: agentTaskToolCalls.input,
        })
        .from(agentTaskToolCalls)
        .where(eq(agentTaskToolCalls.taskId, taskId))
        .orderBy(agentTaskToolCalls.id),
    ]);

    const toolByCallId = new Map<string, { name: string; argumentsJson: string }>();
    for (const t of toolRows) {
      const id = String(t.toolCallId ?? '').trim();
      if (!id) continue;

      const name = String(t.toolName ?? '').trim();
      const argsJson = safeJsonStringify(isRecord(t.input) ? t.input : {});
      toolByCallId.set(id, { name, argumentsJson: argsJson });
    }

    const out: OpenAiChatMessage[] = [];

    for (const r of msgRows) {
      const role = toRole(String(r.role));
      const content = String(r.content ?? '');

      if (role !== 'tool') {
        if (content.trim().length === 0 && role !== 'assistant') continue;
        out.push({ role, content });
        continue;
      }

      const toolName = typeof r.toolName === 'string' ? r.toolName : '';
      const toolCallId = typeof r.toolCallId === 'string' ? r.toolCallId : '';

      const prev = out[out.length - 1];
      if (!prev || prev.role !== 'assistant') {
        out.push({ role: 'assistant', content: '', tool_calls: [] });
      }

      const assistant = out[out.length - 1];
      if (assistant.role === 'assistant') {
        if (!Array.isArray(assistant.tool_calls)) assistant.tool_calls = [];

        const tcInfo = toolByCallId.get(toolCallId);
        assistant.tool_calls.push({
          id: toolCallId,
          type: 'function',
          function: {
            name: tcInfo?.name || toolName,
            arguments: tcInfo?.argumentsJson || '{}',
          },
        });
      }

      out.push({
        role: 'tool',
        name: toolName || undefined,
        tool_call_id: toolCallId || undefined,
        content,
      });
    }

    return out;
  }

  async listWaitingTasksForUser(userId: number, limit: number): Promise<AgentTaskRow[]> {
    const rows = await this.dbService.db
      .select({
        id: agentTasks.id,
        userId: agentTasks.userId,
        status: agentTasks.status,
        goal: agentTasks.goal,
        memory: agentTasks.memory,
        waiting: agentTasks.waiting,
        lastError: agentTasks.lastError,
      })
      .from(agentTasks)
      .where(and(eq(agentTasks.userId, userId), eq(agentTasks.status, 'waiting')))
      .orderBy(agentTasks.updatedAt)
      .limit(clampInt(limit, 1, 500));

    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      status: String(r.status),
      goal: String(r.goal),
      memory: isRecord(r.memory) ? r.memory : {},
      waiting: isRecord(r.waiting) ? r.waiting : null,
      lastError: typeof r.lastError === 'string' ? r.lastError : null,
    }));
  }

  async listWaitingTasks(limit: number): Promise<AgentTaskRow[]> {
    const rows = await this.dbService.db
      .select({
        id: agentTasks.id,
        userId: agentTasks.userId,
        status: agentTasks.status,
        goal: agentTasks.goal,
        memory: agentTasks.memory,
        waiting: agentTasks.waiting,
        lastError: agentTasks.lastError,
      })
      .from(agentTasks)
      .where(eq(agentTasks.status, 'waiting'))
      .orderBy(agentTasks.updatedAt)
      .limit(clampInt(limit, 1, 1000));

    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      status: String(r.status),
      goal: String(r.goal),
      memory: isRecord(r.memory) ? r.memory : {},
      waiting: isRecord(r.waiting) ? r.waiting : null,
      lastError: typeof r.lastError === 'string' ? r.lastError : null,
    }));
  }
}

function toRole(s: string): OpenAiChatMessageRole {
  if (s === 'system' || s === 'user' || s === 'assistant' || s === 'tool') return s;
  return 'user';
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  const x = Math.trunc(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v ?? null, null, 2);
  } catch {
    return 'null';
  }
}
