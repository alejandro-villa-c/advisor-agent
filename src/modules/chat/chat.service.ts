import { Injectable, NotFoundException } from '@nestjs/common';
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

type RetrievalPlan = {
  query: string;
  mode: 'standard' | 'bulk';
  expandedQueries: string[];
};

@Injectable()
export class ChatService {
  constructor(
    private readonly dbService: DbService,
    private readonly rag: RagService,
    private readonly llm: OpenAiChatService,
    private readonly agentIntent: AgentIntentService,
    private readonly agentTasks: AgentTasksService,
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

    // Store user message in thread
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

    // 1) If there is a waiting task asking the advisor for info, treat this message as the reply.
    const resumed = await this.tryResumeWaitingUserMessageTask({
      userId,
      threadId,
      advisorReplyText: text,
    });

    if (resumed) {
      const assistant = `Got it — continuing that task now.`;
      await this.dbService.db.insert(messages).values({
        userId,
        threadId,
        role: 'assistant',
        content: assistant,
        meta: { agentTaskId: resumed.taskId, kind: 'agent_resume' },
      });
      return { threadId, assistant };
    }

    // Memory (ongoing instructions)
    const instrRows = await this.dbService.db
      .select({ instruction: agentInstructions.instruction })
      .from(agentInstructions)
      .where(and(eq(agentInstructions.userId, userId), eq(agentInstructions.isActive, true)));

    const instructions = instrRows.map((r) => r.instruction).filter(Boolean);

    // Multi-turn: include last N messages from the thread (user + assistant)
    const history = await this.loadThreadHistoryForLlm({
      userId,
      threadId,
      maxMessages: readHistoryMaxMessages(),
      maxCharsPerMessage: readHistoryMaxCharsPerMessage(),
    });

    // 2) Decide: agent workflow vs normal chat
    const intent = await this.agentIntent.classify({ userText: text, history });

    if (intent.intent === 'agent') {
      const taskId = await this.startAgentTask({
        userId,
        threadId,
        userText: text,
      });

      const assistant =
        `✅ Okay — I’ll handle that as an agent task (email/calendar/HubSpot as needed).\n` +
        `Task ID: ${taskId}`;

      await this.dbService.db.insert(messages).values({
        userId,
        threadId,
        role: 'assistant',
        content: assistant,
        meta: { agentTaskId: taskId, kind: 'agent_started', intent },
      });

      return { threadId, assistant };
    }

    // ---------------- existing RAG flow below (unchanged) ----------------

    const ragQuery = await this.buildRagQueryFromRecentUserTurns({
      userId,
      threadId,
      fallback: text,
      maxUserTurns: readRagQueryUserTurns(),
      maxChars: readRagQueryMaxChars(),
    });

    const plan = await this.planRetrieval({
      userText: text,
      ragQuery,
      history,
    });

    const retrievalTake = plan.mode === 'bulk' ? readRagBulkTake() : readRagStandardTake();

    const base = await this.rag.searchHybrid({
      userId,
      query: plan.query,
      take: retrievalTake,
      semanticCandidates: readRagSemanticCandidates(),
      lexicalCandidates: readRagLexicalCandidates(),
    });

    const expanded = await this.runExpandedQueries({
      userId,
      expandedQueries: plan.expandedQueries,
      takeEach: Math.max(25, Math.floor(retrievalTake / 3)),
    });

    const merged = mergeUniqueByChunkIdPreferBest([...base, ...expanded]);
    const ranked = rankRowsBestToWorst(merged);

    const systemCitations = toCitations(
      ranked.slice(0, readSystemCitationsMax()),
      readSystemExcerptMaxChars(),
    );

    const debugCitations = toDebugCitations(ranked.slice(0, readDebugCitationsMax()));

    const system = buildSystemPrompt({ instructions, citations: systemCitations });

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

  private async tryResumeWaitingUserMessageTask(input: {
    userId: number;
    threadId: number;
    advisorReplyText: string;
  }): Promise<{ taskId: number } | null> {
    const waiting = await this.agentTasks.listWaitingTasksForUser(input.userId, 50);

    const match = waiting.find((t) => {
      if (!isRecord(t.waiting)) return false;
      const kind = typeof t.waiting.kind === 'string' ? t.waiting.kind : '';
      return kind === 'user_message';
    });

    if (!match) return null;

    // Claim waiting->queued so we don’t double enqueue.
    const claimed = await this.agentTasks.claimWaitingTask(match.id);
    if (!claimed) return null;

    // Append the advisor reply into the agent task conversation.
    await this.agentTasks.appendMessage({
      taskId: match.id,
      userId: input.userId,
      role: 'user',
      content: input.advisorReplyText,
    });

    // Enqueue the agent run.
    await this.pgBoss.client.send(
      AGENT_RUN_TASK_JOB,
      { taskId: match.id },
      {
        singletonKey: `agent.runTask:${match.id}`,
        singletonSeconds: 60,
      },
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

    // Seed the agent conversation with the same user request.
    await this.agentTasks.appendMessage({
      taskId,
      userId: input.userId,
      role: 'user',
      content: input.userText,
    });

    await this.pgBoss.client.send(
      AGENT_RUN_TASK_JOB,
      { taskId },
      {
        singletonKey: `agent.runTask:${taskId}`,
        singletonSeconds: 60,
      },
    );

    return taskId;
  }

  private async runExpandedQueries(input: {
    userId: number;
    expandedQueries: string[];
    takeEach: number;
  }): Promise<RagSearchRow[]> {
    const qs = Array.isArray(input.expandedQueries) ? input.expandedQueries : [];
    const cleaned = qs
      .map((q) => String(q ?? '').trim())
      .filter(Boolean)
      .slice(0, 4);
    if (cleaned.length === 0) return [];

    const out: RagSearchRow[] = [];

    for (const q of cleaned) {
      const rows = await this.rag.searchHybrid({
        userId: input.userId,
        query: q,
        take: clampInt(input.takeEach, 10, 2000),
        semanticCandidates: readRagSemanticCandidates(),
        lexicalCandidates: readRagLexicalCandidates(),
      });
      out.push(...rows);
    }

    return out;
  }

  private async planRetrieval(input: {
    userText: string;
    ragQuery: string;
    history: OpenAiChatMessage[];
  }): Promise<RetrievalPlan> {
    if (!this.llm.isConfigured() || readDisablePlanner()) {
      return { query: input.ragQuery, mode: 'standard', expandedQueries: [] };
    }

    const sys =
      `You plan retrieval queries for a RAG-powered assistant.\n` +
      `Return ONLY valid JSON.\n\n` +
      `Schema:\n` +
      `{\n` +
      `  "query": string,\n` +
      `  "mode": "standard"|"bulk",\n` +
      `  "expandedQueries": string[]\n` +
      `}\n\n` +
      `Guidelines:\n` +
      `- Use BULK when the user asks for totals, summaries over many items, a full list, or the request likely spans many documents.\n` +
      `- Do NOT mention any specific company or keywords unless they come from the user conversation.\n`;

    const convo = input.history
      .filter((m) => m.role === 'user')
      .map((m) => `- ${m.content}`)
      .slice(-6)
      .join('\n');

    const user =
      `Recent user messages:\n${convo || '(none)'}\n\n` +
      `Latest user message:\n${input.userText}\n\n` +
      `Fallback combined query:\n${input.ragQuery}\n`;

    const raw = await this.llm.complete({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      temperature: 0.0,
    });

    const parsed = safeJson(raw);
    if (!isRecord(parsed)) return { query: input.ragQuery, mode: 'standard', expandedQueries: [] };

    const query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
    const mode = parsed.mode === 'bulk' ? 'bulk' : 'standard';
    const expandedQueries = Array.isArray(parsed.expandedQueries)
      ? parsed.expandedQueries
          .map((x) => String(x ?? '').trim())
          .filter(Boolean)
          .slice(0, 4)
      : [];

    return {
      query: query || input.ragQuery,
      mode,
      expandedQueries,
    };
  }

  private async buildRagQueryFromRecentUserTurns(input: {
    userId: number;
    threadId: number;
    fallback: string;
    maxUserTurns: number;
    maxChars: number;
  }): Promise<string> {
    const maxTurns = clampInt(input.maxUserTurns, 1, 12);
    const maxChars = clampInt(input.maxChars, 200, 20_000);

    const rows = await this.dbService.db
      .select({
        content: messages.content,
        createdAt: messages.createdAt,
        id: messages.id,
      })
      .from(messages)
      .where(
        and(
          eq(messages.userId, input.userId),
          eq(messages.threadId, input.threadId),
          eq(messages.role, 'user'),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(maxTurns);

    const chronological = rows.slice().reverse();
    const combined = chronological
      .map((r) => String(r.content ?? '').trim())
      .filter(Boolean)
      .join('\n');

    const q = capText(combined || input.fallback, maxChars).trim();
    return q || input.fallback;
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
        createdAt: messages.createdAt,
        id: messages.id,
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

// --- helpers below unchanged from your current file ---

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
    ? `Ongoing instructions (memory):\n- ${input.instructions.join('\n- ')}\n\n`
    : '';

  const contextBlock = input.citations.length
    ? `Context (RAG excerpts):\n${input.citations
        .map((c, i) => {
          const label = `[${i + 1}] ${c.source} ${c.title ?? ''} (${c.sourceId})`.trim();
          return `${label}\n${c.excerpt}`;
        })
        .join('\n\n')}\n\n`
    : 'Context (RAG excerpts):\n(no relevant excerpts found)\n\n';

  return (
    `You are an AI assistant for financial advisors.\n` +
    `Use the provided context to answer accurately.\n` +
    `If the context is insufficient, say so and ask a concise follow-up question.\n` +
    `Be helpful and practical.\n\n` +
    instructionsBlock +
    contextBlock +
    `Return a clear answer.\n`
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
  return rows.map((r) => {
    const distance = extractDistance(r);
    const similarity = extractSimilarity(r, distance);

    return {
      chunkId: r.chunkId,
      documentId: r.documentId,
      similarity,
      distance,
    };
  });
}

function rankRowsBestToWorst(rows: RagSearchRow[]): RagSearchRow[] {
  return rows.slice().sort((a, b) => compareRowsBestFirst(a, b));
}

function mergeUniqueByChunkIdPreferBest(rows: RagSearchRow[]): RagSearchRow[] {
  const m = new Map<number, RagSearchRow>();

  for (const r of rows) {
    const existing = m.get(r.chunkId);
    if (!existing) {
      m.set(r.chunkId, r);
      continue;
    }

    if (compareRowsBestFirst(r, existing) < 0) {
      m.set(r.chunkId, r);
    }
  }

  return Array.from(m.values());
}

function compareRowsBestFirst(a: RagSearchRow, b: RagSearchRow): number {
  const ad = extractDistance(a);
  const bd = extractDistance(b);

  const aHasD = typeof ad === 'number';
  const bHasD = typeof bd === 'number';

  if (aHasD && !bHasD) return -1;
  if (!aHasD && bHasD) return 1;

  if (aHasD && bHasD) {
    if (ad !== bd) return ad - bd;
    return a.chunkId - b.chunkId;
  }

  const as = extractSimilarity(a, null);
  const bs = extractSimilarity(b, null);

  const aHasS = typeof as === 'number';
  const bHasS = typeof bs === 'number';

  if (aHasS && !bHasS) return -1;
  if (!aHasS && bHasS) return 1;

  if (aHasS && bHasS) {
    if (as !== bs) return bs - as;
    return a.chunkId - b.chunkId;
  }

  return a.chunkId - b.chunkId;
}

function extractDistance(row: RagSearchRow): number | null {
  const r = row as unknown as Record<string, unknown>;

  const candidates = [r.distance, r.semanticDistance, r.vectorDistance, r.embeddingDistance];

  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }

  return null;
}

function extractSimilarity(row: RagSearchRow, distance: number | null): number | null {
  const r = row as unknown as Record<string, unknown>;

  const candidates = [
    r.similarity,
    r.score,
    r.semanticSimilarity,
    r.relevance,
    r.hybridScore,
    r.lexicalScore,
    r.bm25Score,
    r.rankScore,
  ];

  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }

  if (typeof distance === 'number' && Number.isFinite(distance)) {
    return 1 - distance;
  }

  return null;
}

function excerptText(text: string, maxChars: number): string {
  const max = clampInt(maxChars, 80, 5000);
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (t.length <= max) return t;
  return t.slice(0, max).trim();
}

function readHistoryMaxMessages(): number {
  const raw = Number(process.env.CHAT_HISTORY_MAX_MESSAGES ?? '16');
  return Number.isFinite(raw) ? raw : 16;
}

function readHistoryMaxCharsPerMessage(): number {
  const raw = Number(process.env.CHAT_HISTORY_MAX_CHARS ?? '2000');
  return Number.isFinite(raw) ? raw : 2000;
}

function readSystemExcerptMaxChars(): number {
  const raw = Number(process.env.RAG_SYSTEM_EXCERPT_MAX_CHARS ?? '650');
  return Number.isFinite(raw) ? raw : 650;
}

function readSystemCitationsMax(): number {
  const raw = Number(process.env.RAG_SYSTEM_CITATIONS_MAX ?? '40');
  return Number.isFinite(raw) ? clampInt(raw, 1, 400) : 40;
}

function readDebugCitationsMax(): number {
  const raw = Number(process.env.RAG_DEBUG_CITATIONS_MAX ?? '300');
  return Number.isFinite(raw) ? clampInt(raw, 0, 5000) : 300;
}

function readRagStandardTake(): number {
  const raw = Number(process.env.RAG_STANDARD_TAKE ?? '200');
  return Number.isFinite(raw) ? clampInt(raw, 10, 5000) : 200;
}

function readRagBulkTake(): number {
  const raw = Number(process.env.RAG_BULK_TAKE ?? '1200');
  return Number.isFinite(raw) ? clampInt(raw, 50, 5000) : 1200;
}

function readRagSemanticCandidates(): number {
  const raw = Number(process.env.RAG_SEMANTIC_CANDIDATES ?? '800');
  return Number.isFinite(raw) ? clampInt(raw, 50, 5000) : 800;
}

function readRagLexicalCandidates(): number {
  const raw = Number(process.env.RAG_LEXICAL_CANDIDATES ?? '800');
  return Number.isFinite(raw) ? clampInt(raw, 50, 5000) : 800;
}

function readRagQueryUserTurns(): number {
  const raw = Number(process.env.RAG_QUERY_USER_TURNS ?? '5');
  return Number.isFinite(raw) ? clampInt(raw, 1, 12) : 5;
}

function readRagQueryMaxChars(): number {
  const raw = Number(process.env.RAG_QUERY_MAX_CHARS ?? '4000');
  return Number.isFinite(raw) ? clampInt(raw, 200, 20_000) : 4000;
}

function readDisablePlanner(): boolean {
  return String(process.env.RAG_DISABLE_PLANNER ?? '').trim() === '1';
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  const x = Math.trunc(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function capText(s: string, maxLen: number): string {
  const t = (s ?? '').trim();
  if (!t) return '';
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

function safeJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
