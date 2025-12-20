import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { JsonValue } from './threads.service';
import { ThreadsService } from './threads.service';

@Controller('/api/threads')
export class ThreadsController {
  constructor(private readonly threads: ThreadsService) {}

  @Get()
  async list(@Req() req: Request): Promise<{
    threads: { id: number; title: string; displayTitle: string; lastMessageAt: string | null }[];
  }> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    const rows = await this.threads.listThreads(userId);
    return { threads: rows };
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body() body: { title?: string } = {},
  ): Promise<{ threadId: number }> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    const threadId = await this.threads.createThread(userId, body?.title);
    return { threadId };
  }

  @Delete('/:threadId')
  async delete(@Req() req: Request, @Param('threadId') threadIdRaw: string): Promise<{ ok: true }> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    const threadId = Number(threadIdRaw);
    if (!Number.isFinite(threadId) || threadId <= 0) {
      throw new BadRequestException('Invalid threadId.');
    }

    await this.threads.deleteThread(userId, threadId);
    return { ok: true };
  }

  @Get('/:threadId/messages')
  async listMessages(
    @Req() req: Request,
    @Param('threadId') threadIdRaw: string,
  ): Promise<{
    messages: {
      id: number;
      role: string;
      content: string;
      createdAt: string;
      meta: JsonValue | null;
    }[];
  }> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    const threadId = Number(threadIdRaw);
    if (!Number.isFinite(threadId) || threadId <= 0) {
      return { messages: [] };
    }

    const msgs = await this.threads.listMessages(userId, threadId);
    return { messages: msgs };
  }
}
