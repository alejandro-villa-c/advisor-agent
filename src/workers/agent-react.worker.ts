import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { PgBossService } from '../jobs/pgboss.service';
import { AGENT_REACT_JOB, AGENT_RUN_TASK_JOB } from '../jobs/job.constants';
import { AgentTasksService, type AgentTaskRow } from '../modules/agent/agent-tasks.service';
import { GmailApiService } from '../modules/integrations/google/gmail-api.service';
import { DbService } from '../db/db.service';
import { agentTasks } from '../db/schema';

type PgBossJob<T> = { id: string | number; data: T };

export type AgentReactJobData = {
  userId: number;
  reason?: string;
};

@Injectable()
export class AgentReactWorker implements OnModuleInit {
  private readonly logger = new Logger(AgentReactWorker.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly tasks: AgentTasksService,
    private readonly gmailApi: GmailApiService,
    private readonly dbService: DbService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.pgBoss.client.work(
      AGENT_REACT_JOB,
      { batchSize: 1 },
      async (jobs: PgBossJob<AgentReactJobData>[]) => {
        for (const job of jobs) await this.handleOne(job);
      },
    );

    this.logger.log(`Registered worker: ${AGENT_REACT_JOB}`);
  }

  private async handleOne(job: PgBossJob<AgentReactJobData>): Promise<void> {
    const userId = Number(job.data?.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      this.logger.warn(`[${AGENT_REACT_JOB}] invalid userId in job=${String(job.id)}`);
      return;
    }

    const reason = typeof job.data?.reason === 'string' ? job.data.reason : '';
    this.logger.log(
      `[${AGENT_REACT_JOB}] start job=${String(job.id)} userId=${userId} reason=${reason}`,
    );

    const waitingTasks = await this.tasks.listWaitingTasksForUser(userId, 250);

    let resumed = 0;
    for (const t of waitingTasks) {
      const didResume = await this.tryResumeWaitingTask(t);
      if (didResume) resumed += 1;
    }

    this.logger.log(
      `[${AGENT_REACT_JOB}] done job=${String(job.id)} userId=${userId} waiting=${waitingTasks.length} resumed=${resumed}`,
    );
  }

  private async tryResumeWaitingTask(task: AgentTaskRow): Promise<boolean> {
    const waiting = task.waiting;
    if (!isRecord(waiting)) return false;

    const kind = typeof waiting.kind === 'string' ? waiting.kind : '';
    if (kind !== 'gmail_reply') return false;

    const threadId = typeof waiting.threadId === 'string' ? waiting.threadId.trim() : '';
    const fromEmailRaw = typeof waiting.fromEmail === 'string' ? waiting.fromEmail.trim() : '';
    const sinceIso = typeof waiting.sinceIso === 'string' ? waiting.sinceIso.trim() : '';
    if (!threadId || !sinceIso) return false;

    const sinceMs = Date.parse(sinceIso);
    if (!Number.isFinite(sinceMs)) return false;

    const messages = await this.gmailApi.getThreadMessages(task.userId, threadId);

    const fromEmail = fromEmailRaw ? fromEmailRaw.toLowerCase() : '';
    let best: { msgId: string; internalDateMs: number; content: string } | null = null;

    for (const m of messages) {
      const internalDateMs = typeof m.internalDateMs === 'number' ? m.internalDateMs : NaN;
      if (!Number.isFinite(internalDateMs) || internalDateMs <= sinceMs) continue;

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

    const claimed = await this.claimWaitingTask(task.id);
    if (!claimed) return false;

    await this.tasks.appendMessage({
      taskId: task.id,
      userId: task.userId,
      role: 'user',
      content: best.content,
    });

    await this.pgBoss.client.send(
      AGENT_RUN_TASK_JOB,
      { taskId: task.id },
      {
        singletonKey: `agent.runTask:${task.id}`,
        singletonSeconds: 60,
      },
    );

    this.logger.log(
      `[${AGENT_REACT_JOB}] resumed taskId=${task.id} via gmail_reply threadId=${threadId} msgId=${best.msgId}`,
    );

    return true;
  }

  private async claimWaitingTask(taskId: number): Promise<boolean> {
    const db = this.dbService.db;

    const res = await db
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

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

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
    lines.push(body.length > 8000 ? body.slice(0, 8000) : body);
  } else if (input.snippet?.trim()) {
    lines.push(input.snippet.trim());
  } else {
    lines.push('(no body text available)');
  }

  return lines.join('\n');
}
