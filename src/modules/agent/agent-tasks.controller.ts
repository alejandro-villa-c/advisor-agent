import { Body, Controller, Get, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { PgBossService } from '../../jobs/pgboss.service';
import { AGENT_RUN_TASK_JOB } from '../../jobs/job.constants';
import { AgentTasksService } from './agent-tasks.service';

@Controller('/api/agent/tasks')
export class AgentTasksController {
  constructor(
    private readonly tasks: AgentTasksService,
    private readonly boss: PgBossService,
  ) {}

  @Post()
  async createTask(
    @Req() req: Request,
    @Body() body: { goal?: string },
  ): Promise<{ taskId: number }> {
    const userId = requireUserId(req);
    const goal = String(body?.goal ?? '').trim();
    if (!goal) throw new Error('goal is required');

    const taskId = await this.tasks.createTask({
      userId,
      goal,
    });

    // Make the user request part of the conversation so the agent has a natural starting message.
    await this.tasks.appendMessage({
      taskId,
      userId,
      role: 'user',
      content: goal,
    });

    await this.boss.client.send(AGENT_RUN_TASK_JOB, { taskId });

    return { taskId };
  }

  @Get('/:taskId')
  async getTask(@Req() req: Request, @Param('taskId') taskIdStr: string): Promise<unknown> {
    const userId = requireUserId(req);
    const taskId = Number(taskIdStr);

    const task = await this.tasks.getTask(taskId);
    if (!task || task.userId !== userId) throw new UnauthorizedException();

    const messages = await this.tasks.getMessagesForUi(taskId);

    return { task, messages };
  }

  @Post('/:taskId/messages')
  async addUserMessage(
    @Req() req: Request,
    @Param('taskId') taskIdStr: string,
    @Body() body: { content?: string },
  ): Promise<{ ok: true }> {
    const userId = requireUserId(req);
    const taskId = Number(taskIdStr);

    const task = await this.tasks.getTask(taskId);
    if (!task || task.userId !== userId) throw new UnauthorizedException();

    const content = String(body?.content ?? '').trim();
    if (!content) throw new Error('content is required');

    await this.tasks.appendMessage({ taskId, userId, role: 'user', content });
    await this.tasks.setWaiting(taskId, null);
    await this.tasks.setStatus(taskId, 'queued', null);

    await this.boss.client.send(AGENT_RUN_TASK_JOB, { taskId });

    return { ok: true };
  }
}

function requireUserId(req: Request): number {
  const anyReq = req as unknown as Record<string, unknown>;

  const candidates: unknown[] = [
    anyReq['userId'],
    readNested(anyReq, 'user', 'id'),
    readNested(anyReq, 'user', 'userId'),
    readNested(anyReq, 'auth', 'userId'),
    readNested(anyReq, 'session', 'userId'),
  ];

  for (const c of candidates) {
    const n = toPositiveInt(c);
    if (n !== null) return n;
  }

  throw new UnauthorizedException('No userId on request.');
}

function readNested(obj: Record<string, unknown>, key1: string, key2: string): unknown {
  const v1 = obj[key1];
  if (!isRecord(v1)) return undefined;
  return v1[key2];
}

function toPositiveInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
