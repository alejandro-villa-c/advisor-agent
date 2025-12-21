import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '../../db/db.service';
import { messages, threads } from '../../db/schema';

export type ThreadMessageDto = {
  id: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: string;
};

export type ThreadListDto = {
  id: number;
  title: string;
  displayTitle: string;
  lastMessageAt: string | null;
};

@Injectable()
export class ThreadsService {
  constructor(private readonly db: DbService) {}

  async createThread(userId: number, title?: string): Promise<number> {
    const t = (title ?? '').trim() || 'New thread';

    const rows = await this.db.db
      .insert(threads)
      .values({
        userId,
        title: t,
      })
      .returning({ id: threads.id });

    return rows[0].id;
  }

  async listThreads(userId: number): Promise<ThreadListDto[]> {
    const lastMessageAtExpr = sql<Date | null>`max(${messages.createdAt})`;

    const rows = await this.db.db
      .select({
        id: threads.id,
        title: threads.title,
        updatedAt: threads.updatedAt,
        lastMessageAt: lastMessageAtExpr,
      })
      .from(threads)
      .leftJoin(messages, and(eq(messages.threadId, threads.id), eq(messages.userId, userId)))
      .where(eq(threads.userId, userId))
      .groupBy(threads.id, threads.title, threads.updatedAt)
      .orderBy(desc(sql`coalesce(${lastMessageAtExpr}, ${threads.updatedAt})`));

    return rows.map((r) => ({
      id: r.id,
      title: r.title ?? 'New thread',
      displayTitle: r.title ?? 'New thread',
      lastMessageAt: r.lastMessageAt ? new Date(r.lastMessageAt).toISOString() : null,
    }));
  }

  async assertThreadOwned(userId: number, threadId: number): Promise<void> {
    const rows = await this.db.db
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
      .limit(1);

    if (!rows[0]) throw new NotFoundException('Thread not found');
  }

  async deleteThread(userId: number, threadId: number): Promise<void> {
    await this.assertThreadOwned(userId, threadId);

    // messages.thread_id has ON DELETE CASCADE, so this deletes related messages too.
    await this.db.db
      .delete(threads)
      .where(and(eq(threads.id, threadId), eq(threads.userId, userId)));
  }

  async listMessages(userId: number, threadId: number): Promise<ThreadMessageDto[]> {
    await this.assertThreadOwned(userId, threadId);

    // IMPORTANT: We intentionally do NOT select/return `meta` to avoid leaking debug data to the client.
    const rows = await this.db.db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.userId, userId)))
      .orderBy(asc(messages.createdAt), asc(messages.id));

    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
