import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';
import { PgBossService } from '../jobs/pgboss.service';
import { AGENT_REACT_JOB } from '../jobs/job.constants';
import { DbService } from '../db/db.service';
import { agentTaskMessages, agentTasks, messages, threads } from '../db/schema';
import { AgentTasksService } from '../modules/agent/agent-tasks.service';
import { WebSocketEmitterService } from '../modules/websocket/websocket-emitter.service';

type PgBossJob<T> = { id: string | number; data: T };

type AgentReactJobData = {
  taskId: number;
};

@Injectable()
export class AgentReactWorker implements OnModuleInit {
  private readonly logger = new Logger(AgentReactWorker.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly dbService: DbService,
    private readonly tasks: AgentTasksService,
    private readonly wsEmitter: WebSocketEmitterService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.pgBoss.client.createQueue(AGENT_REACT_JOB);
    } catch (err: unknown) {
      this.logger.warn(
        `createQueue(${AGENT_REACT_JOB}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

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
    const taskId = Number(job.data?.taskId);
    if (!Number.isFinite(taskId) || taskId <= 0) {
      this.logger.warn(`[${AGENT_REACT_JOB}] invalid taskId in job=${String(job.id)}`);
      return;
    }

    const task = await this.tasks.getTask(taskId);
    if (!task) return;

    const chatBridge = isRecord(task.memory?.['chatBridge']) ? task.memory['chatBridge'] : null;
    const threadId =
      chatBridge && typeof chatBridge['threadId'] === 'number' ? chatBridge['threadId'] : null;

    if (!threadId || !Number.isFinite(threadId) || threadId <= 0) return;

    // Safety: ensure thread belongs to user.
    const owned = await this.dbService.db
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.userId, task.userId)))
      .limit(1);

    if (!owned[0]) return;

    const lastPushed =
      chatBridge && typeof chatBridge['lastPushedAgentMessageId'] === 'number'
        ? chatBridge['lastPushedAgentMessageId']
        : 0;

    const terminalPushed =
      chatBridge && typeof chatBridge['didPushTerminalStatus'] === 'boolean'
        ? chatBridge['didPushTerminalStatus']
        : false;

    const newAssistantRows = await this.dbService.db
      .select({
        id: agentTaskMessages.id,
        content: agentTaskMessages.content,
      })
      .from(agentTaskMessages)
      .where(
        and(
          eq(agentTaskMessages.taskId, taskId),
          eq(agentTaskMessages.role, 'assistant'),
          gt(agentTaskMessages.id, lastPushed),
        ),
      )
      .orderBy(agentTaskMessages.id)
      .limit(100);

    let newestAgentMessageId = lastPushed;

    for (const r of newAssistantRows) {
      const content = String(r.content ?? '').trim();
      if (!content) continue;

      await this.dbService.db.insert(messages).values({
        userId: task.userId,
        threadId,
        role: 'assistant',
        content,
        meta: {
          agentTaskId: taskId,
          agentTaskMessageId: r.id,
          agentStatus: task.status,
        },
      });

      // Emit WebSocket event via HTTP to web server
      await this.wsEmitter.emitNewMessage(task.userId, threadId, {
        role: 'assistant',
        content,
      });

      newestAgentMessageId = r.id;
    }

    // If the task ended but produced no assistant text, push a terminal status once.
    let didPushTerminalStatus = terminalPushed;

    if (newAssistantRows.length === 0 && !terminalPushed) {
      if (task.status === 'failed' && task.lastError) {
        const failureContent = `⚠️ Agent task failed: ${task.lastError}`;

        await this.dbService.db.insert(messages).values({
          userId: task.userId,
          threadId,
          role: 'assistant',
          content: failureContent,
          meta: { agentTaskId: taskId, agentStatus: task.status },
        });

        await this.wsEmitter.emitNewMessage(task.userId, threadId, {
          role: 'assistant',
          content: failureContent,
        });

        didPushTerminalStatus = true;
      }

      if (task.status === 'completed') {
        const completedContent = `✅ Done.`;

        await this.dbService.db.insert(messages).values({
          userId: task.userId,
          threadId,
          role: 'assistant',
          content: completedContent,
          meta: { agentTaskId: taskId, agentStatus: task.status },
        });

        await this.wsEmitter.emitNewMessage(task.userId, threadId, {
          role: 'assistant',
          content: completedContent,
        });

        didPushTerminalStatus = true;
      }
    }

    // Update task memory with new bridge pointer.
    const currentMemory = isRecord(task.memory) ? task.memory : {};
    const currentBridge = isRecord(currentMemory['chatBridge']) ? currentMemory['chatBridge'] : {};

    const nextMemory: Record<string, unknown> = {
      ...currentMemory,
      chatBridge: {
        ...currentBridge,
        threadId,
        lastPushedAgentMessageId: newestAgentMessageId,
        didPushTerminalStatus,
      },
    };

    await this.dbService.db
      .update(agentTasks)
      .set({
        memory: nextMemory,
        updatedAt: sql`now()`,
      })
      .where(eq(agentTasks.id, taskId));
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}