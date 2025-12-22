import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { DbService } from '../../db/db.service';
import { agentInstructions, messages, threads } from '../../db/schema';
import { RagService, type RagSearchRow } from '../rag/rag.service';
import {
  OpenAiChatService,
  type OpenAiChatMessage,
} from '../integrations/openai/openai-chat.service';
import { AgentIntentService } from '../agent/agent-intent.service';
import { AgentTasksService } from '../agent/agent-tasks.service';
import { InstructionsService } from '../instructions/instructions.service';
import { PgBossService } from '../../jobs/pgboss.service';
import { AGENT_RUN_TASK_JOB } from '../../jobs/job.constants';

type ChatCitation = {
  chunkId: number;
  documentId: number;
  title: string | null;
  source: string;
  sourceId: string;
  excerpt: string;
};

type ChatDebugCitation = {
  chunkId: number;
  documentId: number;
  similarity: number | null;
  distance: number | null;
};

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly dbService: DbService,
    private readonly rag: RagService,
    private readonly llm: OpenAiChatService,
    private readonly agentIntent: AgentIntentService,
    private readonly agentTasks: AgentTasksService,
    private readonly instructionsService: InstructionsService,
    private readonly pgBoss: PgBossService,
  ) {}

  async sendMessage(input: {
    userId: number;
    threadId?: number;
    text: string;
  }): Promise<{ threadId: number; assistant: string }> {
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

    const insertedUser = await this.dbService.db
      .insert(messages)
      .values({ userId, threadId, role: 'user', content: text, meta: null })
      .returning({ id: messages.id });

    const userMessageId = insertedUser[0]?.id;

    if (threadTitleAtStart === 'New thread') {
      if (isNewThread) {
        await this.setThreadTitleFromPrompt({ userId, threadId, prompt: text });
      } else if (typeof userMessageId === 'number') {
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

    // Check for waiting agent task
    const resumed = await this.tryResumeWaitingUserMessageTask({
      userId,
      threadId,
      advisorReplyText: text,
    });

    if (resumed) {
      return { threadId, assistant: '' };
    }

    // Load ongoing instructions
    const instrRows = await this.dbService.db
      .select({ instruction: agentInstructions.instruction })
      .from(agentInstructions)
      .where(and(eq(agentInstructions.userId, userId), eq(agentInstructions.isActive, true)));

    const instructions = instrRows.map((r) => r.instruction).filter(Boolean);

    // Load conversation history
    const history = await this.loadThreadHistoryForLlm({
      userId,
      threadId,
      maxMessages: readHistoryMaxMessages(),
      maxCharsPerMessage: readHistoryMaxCharsPerMessage(),
    });

    // Classify intent
    const intent = await this.agentIntent.classify({ userText: text, history });

    // ========================================================================
    // HANDLE ONGOING INSTRUCTION
    // ========================================================================
    if (intent.intent === 'ongoing_instruction') {
      const instructionText = intent.instructionText || text;
      const result = await this.instructionsService.createInstruction(userId, instructionText);

      let assistant: string;

      if (result.conflict?.hasConflict) {
        const conflictingText =
          result.conflict.conflictingInstruction?.instruction ?? 'an existing instruction';
        const reason = result.conflict.reason ?? 'These instructions might contradict each other.';

        assistant =
          `I noticed this instruction might conflict with one you already have:\n\n` +
          `**Existing:** "${conflictingText}"\n\n` +
          `**Reason:** ${reason}\n\n` +
          `The instruction was not added.`;
      } else if (result.id > 0) {
        assistant =
          `✅ I've set up this ongoing instruction:\n\n` +
          `"${instructionText}"\n\n` +
          `I'll automatically apply this rule when relevant events happen.`;
      } else {
        assistant = `Something went wrong while saving the instruction. Please try again.`;
      }

      await this.dbService.db.insert(messages).values({
        userId,
        threadId,
        role: 'assistant',
        content: assistant,
        meta: { kind: 'ongoing_instruction_response', intent },
      });

      return { threadId, assistant };
    }

    // ========================================================================
    // HANDLE AGENT INTENT
    // ========================================================================
    if (intent.intent === 'agent') {
      const taskId = await this.startAgentTask({ userId, threadId, userText: text });

      const assistant = `Got it — I'll handle that for you. You'll be notified here when there are updates.`;

      await this.dbService.db.insert(messages).values({
        userId,
        threadId,
        role: 'assistant',
        content: assistant,
        meta: { agentTaskId: taskId, kind: 'agent_started', intent },
      });

      return { threadId, assistant };
    }

    // ========================================================================
    // HANDLE CHAT INTENT (RAG)
    // ========================================================================

    // IMPROVED: Use the user's query directly for RAG
    // Don't over-process or rewrite queries that mention specific names
    const ragQuery = text; // Use original query - it contains the name!

    this.logger.debug(`[Chat] RAG query: "${ragQuery}"`);

    // Search with improved hybrid search
    const searchResults = await this.rag.searchHybrid({
      userId,
      query: ragQuery,
      take: readRagTake(),
      semanticCandidates: readRagSemanticCandidates(),
      lexicalCandidates: readRagLexicalCandidates(),
    });

    this.logger.debug(`[Chat] RAG returned ${searchResults.length} results`);

    // Debug: Check if target content is in results
    const lowerQuery = text.toLowerCase();
    const queryTerms = lowerQuery.split(/\s+/).filter((t) => t.length > 2);

    const matchingResults = searchResults.filter((r) => {
      const content = ((r.title ?? '') + ' ' + (r.chunkText ?? '')).toLowerCase();
      return queryTerms.some((term) => content.includes(term));
    });

    this.logger.debug(
      `[Chat] Results matching query terms: ${matchingResults.length}/${searchResults.length}`,
    );

    if (matchingResults.length > 0) {
      this.logger.debug(`[Chat] Top matching result: "${matchingResults[0].title}"`);
    }

    // Build citations for LLM
    const systemCitations = toCitations(
      searchResults.slice(0, readSystemCitationsMax()),
      readSystemExcerptMaxChars(),
    );

    const debugCitations = toDebugCitations(searchResults.slice(0, readDebugCitationsMax()));

    // Build system prompt
    const system = buildSystemPrompt({ instructions, citations: systemCitations });

    // Call LLM
    const llmMessages: OpenAiChatMessage[] = [{ role: 'system', content: system }, ...history];

    const assistant = this.llm.isConfigured()
      ? await this.llm.complete({ messages: llmMessages, temperature: 0.2 })
      : 'LLM is not configured (OPENAI_API_KEY missing).';

    await this.dbService.db.insert(messages).values({
      userId,
      threadId,
      role: 'assistant',
      content: assistant,
      meta: { citations: debugCitations },
    });

    return { threadId, assistant };
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  private async tryResumeWaitingUserMessageTask(input: {
    userId: number;
    threadId: number;
    advisorReplyText: string;
  }): Promise<{ taskId: number } | null> {
    const waiting = await this.agentTasks.listWaitingTasksForUser(input.userId, 50);

    const match = waiting.find((t) => {
      if (!isRecord(t.waiting)) return false;
      const kind = typeof t.waiting.kind === 'string' ? t.waiting.kind : '';
      if (kind !== 'user_message') return false;

      const mem = t.memory ?? {};
      const chatBridge = isRecord(mem['chatBridge']) ? mem['chatBridge'] : null;
      const taskThreadId =
        chatBridge && typeof chatBridge['threadId'] === 'number' ? chatBridge['threadId'] : null;

      return taskThreadId === input.threadId;
    });

    if (!match) return null;

    const claimed = await this.agentTasks.claimWaitingTask(match.id);
    if (!claimed) return null;

    await this.agentTasks.appendMessage({
      taskId: match.id,
      userId: input.userId,
      role: 'user',
      content: input.advisorReplyText,
    });

    await this.pgBoss.client.send(
      AGENT_RUN_TASK_JOB,
      { taskId: match.id },
      { singletonKey: `agent.runTask:${match.id}:${Date.now()}`, singletonSeconds: 5 },
    );

    return { taskId: match.id };
  }

  private async startAgentTask(input: {
    userId: number;
    threadId: number;
    userText: string;
  }): Promise<number> {
    const memory: Record<string, unknown> = {
      chatBridge: {
        threadId: input.threadId,
        lastPushedAgentMessageId: 0,
        didPushTerminalStatus: false,
      },
    };

    const taskId = await this.agentTasks.createTask({
      userId: input.userId,
      goal: input.userText,
      memory,
    });

    await this.agentTasks.appendMessage({
      taskId,
      userId: input.userId,
      role: 'user',
      content: input.userText,
    });

    await this.pgBoss.client.send(
      AGENT_RUN_TASK_JOB,
      { taskId },
      { singletonKey: `agent.runTask:${taskId}`, singletonSeconds: 60 },
    );

    return taskId;
  }

  private async loadThreadHistoryForLlm(input: {
    userId: number;
    threadId: number;
    maxMessages: number;
    maxCharsPerMessage: number;
  }): Promise<OpenAiChatMessage[]> {
    const maxMessages = clampInt(input.maxMessages, 2, 60);
    const maxChars = clampInt(input.maxCharsPerMessage, 200, 20_000);

    const rows = await this.dbService.db
      .select({
        role: messages.role,
        content: messages.content,
      })
      .from(messages)
      .where(
        and(
          eq(messages.userId, input.userId),
          eq(messages.threadId, input.threadId),
          inArray(messages.role, ['user', 'assistant']),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(maxMessages);

    const chronological = rows.slice().reverse();

    const out: OpenAiChatMessage[] = [];
    for (const r of chronological) {
      const role = r.role === 'user' ? 'user' : r.role === 'assistant' ? 'assistant' : null;
      if (!role) continue;

      const content = capText(String(r.content ?? ''), maxChars).trim();
      if (!content) continue;

      out.push({ role, content });
    }

    return out;
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

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

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

  return collapsed.length > 200 ? collapsed.slice(0, 200) : collapsed;
}

function buildSystemPrompt(input: { instructions: string[]; citations: ChatCitation[] }): string {
  const instructionsBlock = input.instructions.length
    ? `Your ongoing instructions:\n- ${input.instructions.join('\n- ')}\n\n`
    : '';

  const contextBlock = input.citations.length
    ? `Retrieved context:\n${input.citations
        .map((c, i) => {
          const sourceLabel = c.source === 'gmail_email' ? 'Email' : c.source;
          return `[${i + 1}] ${sourceLabel}: ${c.title ?? 'Untitled'}\n${c.excerpt}`;
        })
        .join('\n\n')}\n\n`
    : 'No relevant context found.\n\n';

  return (
    `You are an AI assistant with access to the user's emails, calendar, contacts, and notes.\n\n` +
    `Use the retrieved context to answer questions thoroughly. ` +
    `When multiple relevant items exist, summarize all of them. ` +
    `If the context doesn't contain relevant information, say so.\n\n` +
    instructionsBlock +
    contextBlock
  );
}

function toCitations(rows: RagSearchRow[], excerptMaxChars: number): ChatCitation[] {
  const max = clampInt(excerptMaxChars, 120, 5000);

  return rows.map((r) => ({
    chunkId: r.chunkId,
    documentId: r.documentId,
    title: r.title ?? null,
    source: r.source,
    sourceId: r.sourceId,
    excerpt: excerptText(r.chunkText, max),
  }));
}

function toDebugCitations(rows: RagSearchRow[]): ChatDebugCitation[] {
  return rows.map((r) => ({
    chunkId: r.chunkId,
    documentId: r.documentId,
    similarity: r.distance != null ? 1 - r.distance : null,
    distance: r.distance,
  }));
}

function excerptText(text: string, maxChars: number): string {
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars).trim() + '...';
}

function readHistoryMaxMessages(): number {
  return Number(process.env.CHAT_HISTORY_MAX_MESSAGES ?? '16') || 16;
}

function readHistoryMaxCharsPerMessage(): number {
  return Number(process.env.CHAT_HISTORY_MAX_CHARS ?? '2000') || 2000;
}

function readSystemExcerptMaxChars(): number {
  return Number(process.env.RAG_SYSTEM_EXCERPT_MAX_CHARS ?? '800') || 800;
}

function readSystemCitationsMax(): number {
  return Number(process.env.RAG_SYSTEM_CITATIONS_MAX ?? '30') || 30;
}

function readDebugCitationsMax(): number {
  return Number(process.env.RAG_DEBUG_CITATIONS_MAX ?? '50') || 50;
}

function readRagTake(): number {
  return Number(process.env.RAG_TAKE ?? '100') || 100;
}

function readRagSemanticCandidates(): number {
  return Number(process.env.RAG_SEMANTIC_CANDIDATES ?? '500') || 500;
}

function readRagLexicalCandidates(): number {
  return Number(process.env.RAG_LEXICAL_CANDIDATES ?? '200') || 200;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  const x = Math.trunc(n);
  return x < min ? min : x > max ? max : x;
}

function capText(s: string, maxLen: number): string {
  const t = (s ?? '').trim();
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
