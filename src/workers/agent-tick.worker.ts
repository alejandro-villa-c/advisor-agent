import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { PgBossService } from '../jobs/pgboss.service';
import { DbService } from '../db/db.service';
import { agentTasks, calendarEvents } from '../db/schema';
import { AGENT_RUN_TASK_JOB, AGENT_TICK_JOB } from '../jobs/job.constants';
import { GmailApiService } from '../modules/integrations/google/gmail-api.service';
import { AgentTasksService, type AgentTaskRow } from '../modules/agent/agent-tasks.service';

type PgBossJob<T> = { id: string | number; data: T };

/**
 * AgentTickWorker - Periodically checks waiting tasks and resumes them when conditions are met.
 *
 * Supports multiple wait types:
 * - gmail_reply: Wait for a reply in a Gmail thread
 * - calendar_event: Wait until a calendar event starts (or N minutes before)
 * - user_message: Wait for user input (handled by chat, not this worker)
 *
 * This worker runs on a cron schedule (e.g., every minute) and checks all waiting tasks.
 */
@Injectable()
export class AgentTickWorker implements OnModuleInit {
  private readonly logger = new Logger(AgentTickWorker.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly dbService: DbService,
    private readonly tasks: AgentTasksService,
    private readonly gmailApi: GmailApiService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.pgBoss.client.work(
      AGENT_TICK_JOB,
      { batchSize: 1 },
      async (jobs: PgBossJob<Record<string, unknown>>[]) => {
        for (const job of jobs) await this.handleOne(job);
      },
    );

    this.logger.log(`Registered worker: ${AGENT_TICK_JOB}`);
  }

  private async handleOne(job: PgBossJob<Record<string, unknown>>): Promise<void> {
    this.logger.debug(`[${AGENT_TICK_JOB}] start job=${String(job.id)}`);

    const waitingTasks = await this.tasks.listWaitingTasks(250);

    let resumed = 0;

    for (const t of waitingTasks) {
      try {
        const didResume = await this.tryResumeWaitingTask(t);
        if (didResume) resumed += 1;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[${AGENT_TICK_JOB}] taskId=${t.id} resume failed: ${msg}`);
      }
    }

    this.logger.log(
      `[${AGENT_TICK_JOB}] done job=${String(job.id)} waiting=${waitingTasks.length} resumed=${resumed}`,
    );
  }

  /**
   * Try to resume a waiting task based on its wait type.
   */
  private async tryResumeWaitingTask(task: AgentTaskRow): Promise<boolean> {
    const waiting = task.waiting;
    if (!isRecord(waiting)) return false;

    const kind = typeof waiting.kind === 'string' ? waiting.kind : '';

    switch (kind) {
      case 'gmail_reply':
        return await this.tryResumeGmailReply(task, waiting);

      case 'calendar_event':
        return await this.tryResumeCalendarEvent(task, waiting);

      case 'user_message':
        // User messages are handled by the chat service, not this worker
        return false;

      default:
        this.logger.warn(`[${AGENT_TICK_JOB}] Unknown wait kind: ${kind} for taskId=${task.id}`);
        return false;
    }
  }

  /**
   * Check for new Gmail replies in the watched thread.
   */
  private async tryResumeGmailReply(
    task: AgentTaskRow,
    waiting: Record<string, unknown>,
  ): Promise<boolean> {
    const threadId = typeof waiting.threadId === 'string' ? waiting.threadId.trim() : '';
    const fromEmailRaw = typeof waiting.fromEmail === 'string' ? waiting.fromEmail.trim() : '';

    // Get baseline - prefer Gmail internal timestamp
    const sinceInternalDateMsRaw =
      typeof waiting.sinceInternalDateMs === 'number' ? waiting.sinceInternalDateMs : NaN;
    const sinceIso = typeof waiting.sinceIso === 'string' ? waiting.sinceIso.trim() : '';
    const sinceIsoMs = sinceIso ? Date.parse(sinceIso) : NaN;

    if (!threadId) return false;

    // Fetch thread messages
    const messages = await this.gmailApi.getThreadMessages(task.userId, threadId);

    const fromEmail = fromEmailRaw ? fromEmailRaw.toLowerCase() : '';
    const baselineInternalMs = Number.isFinite(sinceInternalDateMsRaw)
      ? sinceInternalDateMsRaw
      : null;
    const baselineIsoMs = Number.isFinite(sinceIsoMs) ? sinceIsoMs : null;

    // Find the newest message that arrived after our baseline
    let best: { msgId: string; internalDateMs: number; content: string } | null = null;

    for (const m of messages) {
      const internalDateMs = typeof m.internalDateMs === 'number' ? m.internalDateMs : NaN;
      if (!Number.isFinite(internalDateMs)) continue;

      // Compare using Gmail timeline when possible
      if (baselineInternalMs !== null) {
        if (internalDateMs <= baselineInternalMs) continue;
      } else if (baselineIsoMs !== null) {
        if (internalDateMs <= baselineIsoMs) continue;
      } else {
        // No baseline - be conservative
        continue;
      }

      // Filter by sender if specified
      const fromHeader = (m.headers.from ?? '').toLowerCase();
      if (fromEmail && !fromHeader.includes(fromEmail)) continue;

      const content = formatIncomingEmailForAgent({
        threadId,
        messageId: m.id,
        from: m.headers.from,
        to: m.headers.to,
        subject: m.headers.subject,
        date: m.headers.date,
        snippet: m.snippet,
        bodyText: m.bodyText,
      });

      if (!best || internalDateMs > best.internalDateMs) {
        best = { msgId: m.id, internalDateMs, content };
      }
    }

    if (!best) return false;

    // Atomically claim the task
    const claimed = await this.claimWaitingTask(task.id);
    if (!claimed) return false;

    // Add the email as a user message so the agent can see it
    await this.tasks.appendMessage({
      taskId: task.id,
      userId: task.userId,
      role: 'user',
      content: best.content,
    });

    // Enqueue the task to run
    await this.pgBoss.client.send(
      AGENT_RUN_TASK_JOB,
      { taskId: task.id },
      {
        singletonKey: `agent.runTask:${task.id}`,
        singletonSeconds: 60,
      },
    );

    this.logger.log(
      `[${AGENT_TICK_JOB}] resumed taskId=${task.id} via gmail_reply threadId=${threadId} msgId=${best.msgId}`,
    );

    return true;
  }

  /**
   * Check if a calendar event is about to start (or has started).
   */
  private async tryResumeCalendarEvent(
    task: AgentTaskRow,
    waiting: Record<string, unknown>,
  ): Promise<boolean> {
    const eventId = typeof waiting.eventId === 'string' ? waiting.eventId.trim() : '';
    const triggerMinutesBefore =
      typeof waiting.triggerMinutesBefore === 'number' ? waiting.triggerMinutesBefore : 0;
    const purpose = typeof waiting.purpose === 'string' ? waiting.purpose : '';

    if (!eventId) return false;

    // Look up the event in our local calendar_events table
    const eventRows = await this.dbService.db
      .select({
        id: calendarEvents.id,
        googleEventId: calendarEvents.googleEventId,
        summary: calendarEvents.summary,
        startAt: calendarEvents.startAt,
        endAt: calendarEvents.endAt,
      })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.userId, task.userId), eq(calendarEvents.googleEventId, eventId)))
      .limit(1);

    const event = eventRows[0];
    if (!event || !event.startAt) {
      // Event not found or no start time - this might be an error
      // For now, skip and keep waiting (maybe event hasn't synced yet)
      return false;
    }

    const eventStartMs = new Date(event.startAt).getTime();
    const triggerTimeMs = eventStartMs - triggerMinutesBefore * 60 * 1000;
    const nowMs = Date.now();

    // Check if we should trigger
    if (nowMs < triggerTimeMs) {
      // Not yet time
      return false;
    }

    // Time to resume!
    const claimed = await this.claimWaitingTask(task.id);
    if (!claimed) return false;

    // Format event info for the agent
    const eventInfo = formatCalendarEventTrigger({
      eventId,
      summary: event.summary ?? 'Untitled Event',
      startAt: event.startAt.toISOString(),
      endAt: event.endAt?.toISOString(),
      purpose,
      triggeredAt: new Date().toISOString(),
      minutesBefore: triggerMinutesBefore,
    });

    await this.tasks.appendMessage({
      taskId: task.id,
      userId: task.userId,
      role: 'user',
      content: eventInfo,
    });

    // Enqueue the task to run
    await this.pgBoss.client.send(
      AGENT_RUN_TASK_JOB,
      { taskId: task.id },
      {
        singletonKey: `agent.runTask:${task.id}`,
        singletonSeconds: 60,
      },
    );

    this.logger.log(
      `[${AGENT_TICK_JOB}] resumed taskId=${task.id} via calendar_event eventId=${eventId}`,
    );

    return true;
  }

  /**
   * Atomically claim a waiting task (set status to queued).
   */
  private async claimWaitingTask(taskId: number): Promise<boolean> {
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
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Format an incoming email for the agent to process.
 */
function formatIncomingEmailForAgent(input: {
  threadId: string;
  messageId: string;
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  snippet?: string;
  bodyText?: string;
}): string {
  const lines: string[] = [];

  lines.push('INCOMING_EMAIL_REPLY');
  lines.push(`threadId: ${input.threadId}`);
  lines.push(`messageId: ${input.messageId}`);
  if (input.from) lines.push(`from: ${input.from}`);
  if (input.to) lines.push(`to: ${input.to}`);
  if (input.subject) lines.push(`subject: ${input.subject}`);
  if (input.date) lines.push(`date: ${input.date}`);
  lines.push('');

  const body = (input.bodyText ?? '').trim();
  if (body) {
    // Truncate very long bodies
    lines.push(body.length > 8000 ? body.slice(0, 8000) + '\n\n[truncated]' : body);
  } else if (input.snippet?.trim()) {
    lines.push(input.snippet.trim());
  } else {
    lines.push('(no body text available)');
  }

  return lines.join('\n');
}

/**
 * Format a calendar event trigger for the agent to process.
 */
function formatCalendarEventTrigger(input: {
  eventId: string;
  summary: string;
  startAt: string;
  endAt?: string;
  purpose: string;
  triggeredAt: string;
  minutesBefore: number;
}): string {
  const lines: string[] = [];

  lines.push('CALENDAR_EVENT_TRIGGER');
  lines.push(`eventId: ${input.eventId}`);
  lines.push(`summary: ${input.summary}`);
  lines.push(`startAt: ${input.startAt}`);
  if (input.endAt) lines.push(`endAt: ${input.endAt}`);
  lines.push(`triggeredAt: ${input.triggeredAt}`);
  lines.push(`minutesBefore: ${input.minutesBefore}`);
  lines.push('');

  if (input.purpose) {
    lines.push(`Purpose: ${input.purpose}`);
  } else {
    lines.push('The calendar event is about to start. Continue with any planned actions.');
  }

  return lines.join('\n');
}
