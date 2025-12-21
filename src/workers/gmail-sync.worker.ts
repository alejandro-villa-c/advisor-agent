import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PgBossService } from '../jobs/pgboss.service';
import { DbService } from '../db/db.service';
import { documentChunks, documents, gmailMessages, integrationStates } from '../db/schema';
import { GmailApiService } from '../modules/integrations/google/gmail-api.service';
import {
  AGENT_REACT_JOB,
  GMAIL_SYNC_MESSAGES_JOB,
  RAG_EMBED_DOCUMENTS_JOB,
} from '../jobs/job.constants';

export type GmailSyncJobData = {
  userId: number;
  mode?: 'initial' | 'incremental' | 'backfill';
  daysBack?: number;
  q?: string;
  maxPages?: number;
  maxMessages?: number;
  pageToken?: string | null;
};

type PgBossJob<T> = {
  id: string | number;
  data: T;
};

type BackfillState = {
  done: boolean;
  nextPageToken: string | null;
  lastRunAt: string | null;
};

type GmailMessageResult = {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDateMs?: number;
  headers: {
    from?: string;
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    date?: string;
  };
  bodyText?: string;
  bodyHtml?: string;
};

@Injectable()
export class GmailSyncWorker implements OnModuleInit {
  private readonly logger = new Logger(GmailSyncWorker.name);

  constructor(
    private readonly pgBossService: PgBossService,
    private readonly dbService: DbService,
    private readonly gmailApi: GmailApiService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.pgBossService.client.createQueue(GMAIL_SYNC_MESSAGES_JOB);
    } catch (err: unknown) {
      this.logger.warn(
        `createQueue(${GMAIL_SYNC_MESSAGES_JOB}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await this.pgBossService.client.work(
      GMAIL_SYNC_MESSAGES_JOB,
      { batchSize: 1 },
      async (jobs: PgBossJob<GmailSyncJobData>[]) => {
        for (const job of jobs) {
          try {
            await this.handleOne(job);
          } catch (err) {
            this.logger.error(
              `[${GMAIL_SYNC_MESSAGES_JOB}] FAILED job=${String(job.id)} userId=${job.data?.userId} ` +
                (err instanceof Error ? err.stack : String(err)),
            );
            throw err;
          }
        }
      },
    );

    this.logger.log(`Registered worker: ${GMAIL_SYNC_MESSAGES_JOB}`);
  }

  private async handleOne(job: PgBossJob<GmailSyncJobData>): Promise<void> {
    const userId = job.data.userId;
    const mode = job.data.mode ?? 'incremental';

    // MEMORY FIX: Reduced batch sizes to prevent OOM
    // Process fewer messages per job, but chain jobs faster
    const maxPagesDefault = mode === 'backfill' ? 10 : mode === 'initial' ? 10 : 5;
    const maxMessagesDefault = mode === 'backfill' ? 500 : mode === 'initial' ? 500 : 200;

    const maxPages = clampInt(job.data.maxPages ?? maxPagesDefault, 1, 20);
    const maxMessages = clampInt(job.data.maxMessages ?? maxMessagesDefault, 1, 1000);

    this.logger.log(
      `[${GMAIL_SYNC_MESSAGES_JOB}] start job=${String(job.id)} userId=${userId} mode=${mode} maxPages=${maxPages} maxMessages=${maxMessages}`,
    );

    const state = await this.getIntegrationState(userId);

    const baseQueryFromState =
      typeof state?.baseQuery === 'string'
        ? state.baseQuery
        : typeof state?.query === 'string' && !hasTimeFilter(state.query)
          ? state.query
          : 'in:inbox -in:spam -in:trash -in:chats';

    const query = buildGmailQuery({
      mode,
      overrideQuery: job.data.q,
      baseQuery: baseQueryFromState,
      lastSyncedAt: typeof state?.lastSyncedAt === 'string' ? state.lastSyncedAt : undefined,
      daysBack: job.data.daysBack,
    });

    const startPageToken = typeof job.data.pageToken === 'string' ? job.data.pageToken : null;

    this.logger.log(
      `[${GMAIL_SYNC_MESSAGES_JOB}] using query="${query}" pageToken=${startPageToken ? 'YES' : 'NO'}`,
    );

    const quota = new QuotaLimiter({ unitsPerMinute: 10_000, burstUnits: 2_000 });

    let pageToken: string | null = startPageToken;
    let pages = 0;

    const messageIds: string[] = [];
    let lastNextPageToken: string | undefined;

    // Phase 1: Collect message IDs (lightweight)
    while (pages < maxPages && messageIds.length < maxMessages) {
      pages += 1;

      await quota.takeUnits(5);

      const page = await withRetry(this.logger, 'listMessagesPage', async () =>
        this.gmailApi.listMessagesPage(userId, {
          q: query,
          maxResults: Math.min(100, maxMessages - messageIds.length),
          pageToken,
        }),
      );

      if (page.ids.length === 0) break;

      messageIds.push(...page.ids);
      lastNextPageToken = page.nextPageToken;

      this.logger.log(
        `[${GMAIL_SYNC_MESSAGES_JOB}] page=${pages} fetchedIds=${page.ids.length} totalIds=${messageIds.length} nextToken=${page.nextPageToken ? 'YES' : 'NO'}`,
      );

      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }

    const uniqueIds = Array.from(new Set(messageIds)).slice(0, maxMessages);

    // Phase 2: Process messages in small batches to limit memory
    // MEMORY FIX: Process in chunks of 50 instead of all at once
    const PROCESS_BATCH_SIZE = 50;
    const concurrency = mode === 'backfill' ? 5 : 3;

    const touchedThreadIds = new Set<string>();
    const changedSourceIds: string[] = [];
    let totalProcessed = 0;
    let totalMirrorInserted = 0;

    for (const idBatch of chunkArray(uniqueIds, PROCESS_BATCH_SIZE)) {
      // Fetch existing docs for this batch
      const existingBySourceId = await this.loadExistingDocsMap({
        userId,
        source: 'gmail_email',
        sourceIds: idBatch,
      });

      // Fetch messages for this batch
      const messages = await mapWithConcurrency(idBatch, concurrency, async (id) => {
        await quota.takeUnits(5);
        const msg = await withRetry(this.logger, 'getMessage', async () =>
          this.gmailApi.getMessage(userId, id),
        );
        if (msg.threadId) touchedThreadIds.add(msg.threadId);
        return msg;
      });

      // Process and upsert this batch
      const { mirrorInserted, changedIds } = await this.processMessageBatch({
        userId,
        messages,
        existingBySourceId,
      });

      totalMirrorInserted += mirrorInserted;
      changedSourceIds.push(...changedIds);
      totalProcessed += messages.length;

      this.logger.log(
        `[${GMAIL_SYNC_MESSAGES_JOB}] batch processed=${totalProcessed}/${uniqueIds.length} mirrorUpserts=${totalMirrorInserted}`,
      );

      // MEMORY FIX: Allow GC between batches
      await sleep(10);
    }

    const nowIso = new Date().toISOString();

    const backfillState: BackfillState | null =
      mode === 'backfill'
        ? {
            done: !lastNextPageToken,
            nextPageToken: lastNextPageToken ?? null,
            lastRunAt: nowIso,
          }
        : null;

    await this.setIntegrationState(userId, {
      ...(state ?? {}),
      baseQuery: baseQueryFromState,
      lastSyncedAt: nowIso,
      lastQueryUsed: query,
      ...(backfillState ? { backfill: backfillState } : {}),
      lastRun: {
        at: nowIso,
        mode,
        pages,
        idsFetched: uniqueIds.length,
        processed: totalProcessed,
        changedDocuments: Array.from(new Set(changedSourceIds)).length,
        mirrorUpserts: totalMirrorInserted,
        backfillNextPageToken: backfillState?.nextPageToken ?? null,
        backfillDone: backfillState?.done ?? null,
      },
    });

    // Repair + embed (process in smaller batches)
    const repairDocIds = await this.loadDocumentIdsMissingChunksForSourceIds({
      userId,
      source: 'gmail_email',
      sourceIds: uniqueIds,
    });

    const changedDocIds = await this.loadDocumentIdsForSourceIds({
      userId,
      source: 'gmail_email',
      sourceIds: changedSourceIds,
    });

    await this.enqueueEmbedForDocumentIds({
      userId,
      documentIds: [...changedDocIds, ...repairDocIds],
    });

    // Wake agent for touched threads (batch to avoid large payloads)
    const threads = Array.from(touchedThreadIds).filter(Boolean);
    for (const batch of chunkArray(threads, 50)) {
      await this.pgBossService.client.send(AGENT_REACT_JOB, {
        userId,
        gmailThreadIds: batch,
      });
    }

    // Chain next backfill page immediately if more pages exist
    let didEnqueueNextBackfill = false;

    if (mode === 'backfill' && lastNextPageToken) {
      const tokenKeyPart = hashSingletonKeyPart(lastNextPageToken);

      await this.pgBossService.client.send(
        GMAIL_SYNC_MESSAGES_JOB,
        {
          userId,
          mode: 'backfill',
          maxPages,
          maxMessages,
          pageToken: lastNextPageToken,
        },
        {
          singletonKey: `gmail_backfill_page:${userId}:${tokenKeyPart}`,
          singletonSeconds: 3600,
        },
      );

      didEnqueueNextBackfill = true;
    }

    this.logger.log(
      `[${GMAIL_SYNC_MESSAGES_JOB}] done job=${String(job.id)} userId=${userId} mode=${mode} processed=${totalProcessed} pages=${pages} changedDocs=${Array.from(new Set(changedSourceIds)).length} repairedDocs=${repairDocIds.length} touchedThreads=${threads.length} backfillDone=${backfillState?.done ?? 'n/a'} enqueuedNextBackfill=${didEnqueueNextBackfill}`,
    );
  }

  private async processMessageBatch(input: {
    userId: number;
    messages: GmailMessageResult[];
    existingBySourceId: Map<string, { title: string; text: string }>;
  }): Promise<{ mirrorInserted: number; changedIds: string[] }> {
    const { userId, messages, existingBySourceId } = input;

    const changedIds: string[] = [];
    const changedDocRows: Array<{
      userId: number;
      source: 'gmail_email';
      sourceId: string;
      title: string;
      text: string;
      meta: Record<string, unknown>;
    }> = [];

    // Batch upsert mirror table
    const mirrorRows = messages.map((msg) => {
      const sentAt =
        typeof msg.internalDateMs === 'number' && Number.isFinite(msg.internalDateMs)
          ? new Date(msg.internalDateMs)
          : null;

      return {
        userId,
        gmailMessageId: msg.id,
        gmailThreadId: msg.threadId ?? null,
        from: msg.headers.from ?? null,
        to: msg.headers.to ?? null,
        cc: msg.headers.cc ?? null,
        bcc: msg.headers.bcc ?? null,
        subject: msg.headers.subject ?? null,
        snippet: msg.snippet ?? null,
        sentAt,
        raw: {
          id: msg.id,
          threadId: msg.threadId ?? null,
          internalDateMs: msg.internalDateMs ?? null,
          headers: msg.headers,
          snippet: msg.snippet ?? null,
          bodyText: msg.bodyText ?? null,
          bodyHtml: msg.bodyHtml ?? null,
        },
      };
    });

    await this.dbService.db
      .insert(gmailMessages)
      .values(mirrorRows)
      .onConflictDoUpdate({
        target: [gmailMessages.userId, gmailMessages.gmailMessageId],
        set: {
          gmailThreadId: sql`excluded.gmail_thread_id`,
          from: sql`excluded."from"`,
          to: sql`excluded."to"`,
          cc: sql`excluded.cc`,
          bcc: sql`excluded.bcc`,
          subject: sql`excluded.subject`,
          snippet: sql`excluded.snippet`,
          sentAt: sql`excluded.sent_at`,
          raw: sql`excluded.raw`,
          updatedAt: sql`now()`,
        },
      });

    // Build document rows
    for (const msg of messages) {
      const sentAt =
        typeof msg.internalDateMs === 'number' && Number.isFinite(msg.internalDateMs)
          ? new Date(msg.internalDateMs)
          : null;

      const docTitle = msg.headers.subject?.trim()
        ? `Email: ${msg.headers.subject.trim()}`
        : `Email: ${msg.id}`;

      const bodyText = msg.bodyText?.trim() || '';
      const snippet = msg.snippet?.trim() || '';

      const docTextRaw = [
        `Gmail email`,
        msg.headers.date ? `Date: ${msg.headers.date}` : null,
        msg.headers.from ? `From: ${msg.headers.from}` : null,
        msg.headers.to ? `To: ${msg.headers.to}` : null,
        msg.headers.cc ? `Cc: ${msg.headers.cc}` : null,
        msg.headers.subject ? `Subject: ${msg.headers.subject}` : null,
        '',
        bodyText || snippet ? bodyText || snippet : '',
      ]
        .filter((x) => x !== null)
        .join('\n')
        .trim();

      const docText = capText(docTextRaw || docTitle, 40_000);

      const existing = existingBySourceId.get(msg.id);
      const unchanged = existing && existing.title === docTitle && existing.text === docText;

      if (!unchanged) {
        changedIds.push(msg.id);
        changedDocRows.push({
          userId,
          source: 'gmail_email',
          sourceId: msg.id,
          title: docTitle,
          text: docText,
          meta: {
            gmailMessageId: msg.id,
            gmailThreadId: msg.threadId ?? null,
            sentAt: sentAt ? sentAt.toISOString() : null,
            from: msg.headers.from ?? null,
            to: msg.headers.to ?? null,
            subject: msg.headers.subject ?? null,
          },
        });
      }
    }

    // Batch upsert documents
    if (changedDocRows.length > 0) {
      await this.dbService.db
        .insert(documents)
        .values(changedDocRows)
        .onConflictDoUpdate({
          target: [documents.userId, documents.source, documents.sourceId],
          set: {
            title: sql`excluded.title`,
            text: sql`excluded.text`,
            meta: sql`excluded.meta`,
            updatedAt: sql`now()`,
          },
        });
    }

    return { mirrorInserted: mirrorRows.length, changedIds };
  }

  private async loadExistingDocsMap(input: {
    userId: number;
    source: 'gmail_email' | 'calendar_event' | 'hubspot_contact' | 'hubspot_note';
    sourceIds: string[];
  }): Promise<Map<string, { title: string; text: string }>> {
    const map = new Map<string, { title: string; text: string }>();

    const ids = Array.from(new Set(input.sourceIds)).filter(Boolean);
    if (ids.length === 0) return map;

    for (const chunk of chunkArray(ids, 500)) {
      const rows = await this.dbService.db
        .select({ sourceId: documents.sourceId, title: documents.title, text: documents.text })
        .from(documents)
        .where(
          and(
            eq(documents.userId, input.userId),
            eq(documents.source, input.source),
            inArray(documents.sourceId, chunk),
          ),
        );

      for (const r of rows) {
        map.set(String(r.sourceId), { title: r.title ?? '', text: r.text ?? '' });
      }
    }

    return map;
  }

  private async loadDocumentIdsForSourceIds(input: {
    userId: number;
    source: 'gmail_email' | 'calendar_event' | 'hubspot_contact' | 'hubspot_note';
    sourceIds: string[];
  }): Promise<number[]> {
    const ids = Array.from(new Set(input.sourceIds)).filter(Boolean);
    if (ids.length === 0) return [];

    const out: number[] = [];

    for (const chunk of chunkArray(ids, 500)) {
      const rows = await this.dbService.db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.userId, input.userId),
            eq(documents.source, input.source),
            inArray(documents.sourceId, chunk),
          ),
        );

      for (const r of rows) out.push(r.id);
    }

    return out;
  }

  private async loadDocumentIdsMissingChunksForSourceIds(input: {
    userId: number;
    source: 'gmail_email' | 'calendar_event' | 'hubspot_contact' | 'hubspot_note';
    sourceIds: string[];
  }): Promise<number[]> {
    const ids = Array.from(new Set(input.sourceIds)).filter(Boolean);
    if (ids.length === 0) return [];

    const out: number[] = [];

    for (const chunk of chunkArray(ids, 500)) {
      const rows = await this.dbService.db
        .select({ id: documents.id })
        .from(documents)
        .leftJoin(
          documentChunks,
          and(
            eq(documentChunks.userId, documents.userId),
            eq(documentChunks.documentId, documents.id),
            eq(documentChunks.chunkIndex, 0),
          ),
        )
        .where(
          and(
            eq(documents.userId, input.userId),
            eq(documents.source, input.source),
            inArray(documents.sourceId, chunk),
            sql`${documentChunks.id} IS NULL`,
          ),
        );

      for (const r of rows) out.push(r.id);
    }

    return out;
  }

  private async enqueueEmbedForDocumentIds(input: {
    userId: number;
    documentIds: number[];
  }): Promise<void> {
    const unique = Array.from(new Set(input.documentIds))
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0);

    if (unique.length === 0) return;

    // MEMORY FIX: Smaller batches for embed jobs
    for (const batch of chunkArray(unique, 200)) {
      await this.pgBossService.client.send(RAG_EMBED_DOCUMENTS_JOB, {
        userId: input.userId,
        documentIds: batch,
      });
    }
  }

  private async getIntegrationState(userId: number): Promise<Record<string, unknown> | null> {
    const rows = await this.dbService.db
      .select({ state: integrationStates.state })
      .from(integrationStates)
      .where(and(eq(integrationStates.userId, userId), eq(integrationStates.integration, 'gmail')))
      .limit(1);

    return (rows[0]?.state as Record<string, unknown> | undefined) ?? null;
  }

  private async setIntegrationState(userId: number, state: Record<string, unknown>): Promise<void> {
    await this.dbService.db
      .insert(integrationStates)
      .values({
        userId,
        integration: 'gmail',
        state,
      })
      .onConflictDoUpdate({
        target: [integrationStates.userId, integrationStates.integration],
        set: {
          state: sql`excluded.state`,
          updatedAt: sql`now()`,
        },
      });
  }
}

function buildGmailQuery(input: {
  mode: 'initial' | 'incremental' | 'backfill';
  overrideQuery?: string;
  baseQuery?: string;
  lastSyncedAt?: string;
  daysBack?: number;
}): string {
  const base =
    input.overrideQuery?.trim() ||
    input.baseQuery?.trim() ||
    'in:inbox -in:spam -in:trash -in:chats';

  if (input.mode === 'backfill') return base;
  if (hasTimeFilter(base)) return base;

  if (input.mode === 'initial') {
    const daysBack = clampInt(input.daysBack ?? 90, 1, 36500);
    return `${base} newer_than:${daysBack}d`;
  }

  if (input.lastSyncedAt) {
    const lastMs = Date.parse(input.lastSyncedAt);
    if (Number.isFinite(lastMs)) {
      const afterDate = new Date(lastMs - 86_400_000);
      const after = formatGmailAfterDate(afterDate);
      return `${base} after:${after}`;
    }
  }

  return `${base} newer_than:30d`;
}

function formatGmailAfterDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
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

function chunkArray<T>(arr: T[], size: number): T[][] {
  const a = arr ?? [];
  if (a.length === 0) return [];
  if (a.length <= size) return [a];
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += size) out.push(a.slice(i, i + size));
  return out;
}

function hasTimeFilter(q: string): boolean {
  return (
    /\bnewer_than:\d+[dmy]\b/i.test(q) ||
    /\bolder_than:\d+[dmy]\b/i.test(q) ||
    /\bafter:\S+/i.test(q) ||
    /\bbefore:\S+/i.test(q)
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const list = items ?? [];
  if (list.length === 0) return [];

  const out = new Array<R>(list.length);
  let index = 0;

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const i = index;
      index += 1;
      if (i >= list.length) break;
      out[i] = await fn(list[i]);
    }
  });

  await Promise.all(workers);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitLikeError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;

  const status = typeof e['status'] === 'number' ? e['status'] : undefined;
  const code = typeof e['code'] === 'number' ? e['code'] : undefined;
  const httpStatus = status ?? code;

  if (httpStatus === 429) return true;

  if (httpStatus === 403) {
    const message = typeof e['message'] === 'string' ? e['message'] : '';
    if (/rate limit|userRateLimitExceeded|quota|resource has been exhausted/i.test(message)) {
      return true;
    }
  }

  return false;
}

async function withRetry<T>(logger: Logger, label: string, fn: () => Promise<T>): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      attempt += 1;
      if (!isRateLimitLikeError(err) || attempt >= 8) throw err;

      const base = Math.min(10_000, 250 * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 250);
      const waitMs = base + jitter;

      logger.warn(
        `[gmail] rate-limited during ${label}, retrying in ${waitMs}ms (attempt ${attempt})`,
      );

      await sleep(waitMs);
    }
  }
}

class QuotaLimiter {
  private availableUnits: number;
  private lastRefillMs: number;

  constructor(private readonly config: { unitsPerMinute: number; burstUnits: number }) {
    this.availableUnits = Math.max(1, Math.floor(config.burstUnits));
    this.lastRefillMs = Date.now();
  }

  async takeUnits(costUnits: number): Promise<void> {
    const cost = Math.max(1, Math.floor(costUnits));

    while (true) {
      this.refill();

      if (this.availableUnits >= cost) {
        this.availableUnits -= cost;
        return;
      }

      await sleep(50);
    }
  }

  private refill(): void {
    const nowMs = Date.now();
    const elapsedMs = nowMs - this.lastRefillMs;
    if (elapsedMs <= 0) return;

    const unitsPerMs = this.config.unitsPerMinute / 60_000;
    const add = elapsedMs * unitsPerMs;

    if (add >= 1) {
      const burst = Math.max(1, Math.floor(this.config.burstUnits));
      this.availableUnits = Math.min(burst, this.availableUnits + Math.floor(add));
      this.lastRefillMs = nowMs;
    }
  }
}

function hashSingletonKeyPart(value: string): string {
  let hash = 2166136261;

  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const unsigned = hash >>> 0;
  return unsigned.toString(36);
}
