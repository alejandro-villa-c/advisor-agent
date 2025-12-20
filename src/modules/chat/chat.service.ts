import { Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DbService } from '../../db/db.service';
import { agentInstructions, messages, threads } from '../../db/schema';
import { RagService } from '../rag/rag.service';
import { OpenAiChatService } from './openai-chat.service';

@Injectable()
export class ChatService {
  constructor(
    private readonly dbService: DbService,
    private readonly rag: RagService,
    private readonly llm: OpenAiChatService,
  ) {}

  async sendMessage(input: {
    userId: number;
    threadId?: number;
    text: string;
  }): Promise<{ threadId: number; assistant: string; citations: any[] }> {
    const userId = input.userId;
    const text = (input.text ?? '').trim();
    if (!text) throw new Error('Message text is empty.');

    let threadId: number;
    let threadTitleAtStart: string | null = null;
    let isNewThread = false;

    if (typeof input.threadId === 'number') {
      const tId = input.threadId;
      if (!Number.isFinite(tId) || tId <= 0) throw new Error('Invalid threadId.');

      const owned = await this.dbService.db
        .select({ id: threads.id, title: threads.title })
        .from(threads)
        .where(and(eq(threads.id, tId), eq(threads.userId, userId)))
        .limit(1);

      if (!owned[0]) throw new NotFoundException('Thread not found');

      threadId = owned[0].id;
      threadTitleAtStart = owned[0].title ?? null;
    } else {
      threadId = await this.createThread(userId);
      threadTitleAtStart = 'New thread';
      isNewThread = true;
    }

    // Store user message (return id so we can safely detect "first user message" when needed)
    const insertedUser = await this.dbService.db
      .insert(messages)
      .values({
        userId,
        threadId,
        role: 'user',
        content: text,
        meta: null,
      })
      .returning({ id: messages.id });

    const userMessageId = insertedUser[0]?.id;

    // Persist thread title from the first user prompt (only once)
    if (threadTitleAtStart === 'New thread') {
      if (isNewThread) {
        await this.setThreadTitleFromPrompt({ userId, threadId, prompt: text });
      } else if (typeof userMessageId === 'number') {
        // Only set it if this message is actually the first user message in that thread
        const firstUser = await this.dbService.db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.threadId, threadId),
              eq(messages.userId, userId),
              eq(messages.role, 'user'),
            ),
          )
          .orderBy(asc(messages.createdAt), asc(messages.id))
          .limit(1);

        if (firstUser[0]?.id === userMessageId) {
          await this.setThreadTitleFromPrompt({ userId, threadId, prompt: text });
        }
      }
    }

    // Memory (ongoing instructions)
    const instrRows = await this.dbService.db
      .select({ instruction: agentInstructions.instruction })
      .from(agentInstructions)
      .where(and(eq(agentInstructions.userId, userId), eq(agentInstructions.isActive, true)));

    const instructions = instrRows.map((r) => r.instruction).filter(Boolean);

    // RAG context
    const results = await this.rag.search({ userId, query: text, k: 10 });

    const citations = results.map((r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      title: r.title,
      source: r.source,
      sourceId: r.sourceId,
      distance: r.distance,
      chunkText: r.chunkText,
    }));

    const system = buildSystemPrompt({ instructions, citations });

    const assistant = this.llm.isConfigured()
      ? await this.llm.complete({ system, user: text })
      : 'LLM is not configured (OPENAI_API_KEY missing).';

    await this.dbService.db.insert(messages).values({
      userId,
      threadId,
      role: 'assistant',
      content: assistant,
      meta: { citations },
    });

    return { threadId, assistant, citations };
  }

  private async createThread(userId: number): Promise<number> {
    const created = await this.dbService.db
      .insert(threads)
      .values({ userId, title: 'New thread' })
      .returning({ id: threads.id });

    return created[0].id;
  }

  private async setThreadTitleFromPrompt(input: {
    userId: number;
    threadId: number;
    prompt: string;
  }): Promise<void> {
    const title = deriveThreadTitleFromPrompt(input.prompt);

    // Update only if still "New thread" (prevents overwriting a user-provided/custom title)
    await this.dbService.db
      .update(threads)
      .set({ title, updatedAt: new Date() })
      .where(
        and(
          eq(threads.id, input.threadId),
          eq(threads.userId, input.userId),
          eq(threads.title, 'New thread'),
        ),
      );
  }
}

function deriveThreadTitleFromPrompt(prompt: string): string {
  const raw = String(prompt ?? '').trim();
  if (!raw) return 'New thread';

  const firstNonEmptyLine =
    raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? raw;

  const collapsed = firstNonEmptyLine.replace(/\s+/g, ' ').trim();
  if (!collapsed) return 'New thread';

  // Keep it reasonably bounded for storage; UI truncation + hover handles display.
  return collapsed.length > 200 ? collapsed.slice(0, 200) : collapsed;
}

function buildSystemPrompt(input: {
  instructions: string[];
  citations: Array<{
    title: string | null;
    source: string;
    sourceId: string;
    chunkText: string;
  }>;
}): string {
  const instructionsBlock = input.instructions.length
    ? `Ongoing instructions (memory):\n- ${input.instructions.join('\n- ')}\n\n`
    : '';

  const contextBlock = input.citations.length
    ? `Context (RAG excerpts):\n${input.citations
        .map((c, i) => {
          const label = `[${i + 1}] ${c.source} ${c.title ?? ''} (${c.sourceId})`.trim();
          return `${label}\n${c.chunkText}`;
        })
        .join('\n\n')}\n\n`
    : 'Context (RAG excerpts):\n(no relevant excerpts found)\n\n';

  return (
    `You are an AI assistant for financial advisors.\n` +
    `Use the provided context to answer accurately. If the context is insufficient, say so and ask a concise follow-up.\n` +
    `When answering, be helpful and practical.\n\n` +
    instructionsBlock +
    contextBlock +
    `Return a clear answer.`
  );
}
