import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PgBossService } from '../jobs/pgboss.service';
import { DbService } from '../db/db.service';
import { documents, gmailMessages, integrationStates } from '../db/schema';
import { GmailApiService } from '../modules/integrations/google/gmail-api.service';
import { GMAIL_SYNC_MESSAGES_JOB, RAG_EMBED_DOCUMENTS_JOB } from '../jobs/job.constants';

export type GmailSyncJobData = {
  userId: number;
  mode?: 'initial' | 'incremental';
  daysBack?: number;
  q?: string;
  maxPages?: number; // default 10
  maxMessages?: number; // default 500
};

type PgBossJob<T> = {
  id: string | number;
  data: T;
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
        `createQueue(${GMAIL_SYNC_MESSAGES_JOB}) failed: ${err instanceof Error ? err.message : String(err)}`,
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
            throw err; // keep the job marked failed so pg-boss retry rules apply
          }
        }
      },
    );

    this.logger.log(`Registered worker: ${GMAIL_SYNC_MESSAGES_JOB}`);
  }

  private async handleOne(job: PgBossJob<GmailSyncJobData>): Promise<void> {
    const userId = job.data.userId;

    const mode = job.data.mode ?? 'incremental';
    const maxPages = clampInt(job.data.maxPages ?? 10, 1, 50);
    const maxMessages = clampInt(job.data.maxMessages ?? 500, 1, 5000);

    this.logger.log(
      `[${GMAIL_SYNC_MESSAGES_JOB}] start job=${String(job.id)} userId=${userId} mode=${mode}`,
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

    this.logger.log(`[${GMAIL_SYNC_MESSAGES_JOB}] using query="${query}"`);

    let pageToken: string | null = null;
    let pages = 0;

    const messageIds: string[] = [];

    while (pages < maxPages && messageIds.length < maxMessages) {
      pages += 1;

      const page = await this.gmailApi.listMessagesPage(userId, {
        q: query,
        maxResults: Math.min(500, maxMessages - messageIds.length),
        pageToken,
      });

      if (page.ids.length === 0) break;

      messageIds.push(...page.ids);

      this.logger.log(
        `[${GMAIL_SYNC_MESSAGES_JOB}] page=${pages} fetchedIds=${page.ids.length} totalIds=${messageIds.length}`,
      );

      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }

    const uniqueIds = Array.from(new Set(messageIds)).slice(0, maxMessages);

    const existingBySourceId = await this.loadExistingDocsMap({
      userId,
      source: 'gmail_email',
      sourceIds: uniqueIds,
    });

    const changedSourceIds: string[] = [];

    let processed = 0;

    for (const id of uniqueIds) {
      const msg = await this.gmailApi.getMessage(userId, id);

      const sentAt =
        typeof msg.internalDateMs === 'number' && Number.isFinite(msg.internalDateMs)
          ? new Date(msg.internalDateMs)
          : null;

      // Mirror table (always upsert)
      await this.dbService.db
        .insert(gmailMessages)
        .values({
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
        })
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

      // Only upsert documents if changed (prevents pointless re-embedding)
      const existing = existingBySourceId.get(msg.id);
      const unchanged = existing && existing.title === docTitle && existing.text === docText;

      if (!unchanged) {
        changedSourceIds.push(msg.id);

        await this.dbService.db
          .insert(documents)
          .values({
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
          })
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

      processed += 1;

      if (processed % 25 === 0) {
        this.logger.log(`[${GMAIL_SYNC_MESSAGES_JOB}] processed=${processed}/${uniqueIds.length}`);
      }
    }

    const nowIso = new Date().toISOString();

    await this.setIntegrationState(userId, {
      ...(state ?? {}),
      baseQuery: baseQueryFromState,
      lastSyncedAt: nowIso,
      lastQueryUsed: query,
      lastRun: {
        at: nowIso,
        mode,
        pages,
        idsFetched: uniqueIds.length,
        processed,
        changedDocuments: Array.from(new Set(changedSourceIds)).length,
      },
    });

    // Enqueue RAG embed for changed docs (but embedMissingChunks runs user-wide in your RagEmbedWorker anyway)
    await this.enqueueEmbedForChangedDocs({
      userId,
      source: 'gmail_email',
      changedSourceIds,
    });

    this.logger.log(
      `[${GMAIL_SYNC_MESSAGES_JOB}] done job=${String(job.id)} userId=${userId} processed=${processed} pages=${pages} changedDocs=${Array.from(new Set(changedSourceIds)).length}`,
    );
  }

  private async loadExistingDocsMap(input: {
    userId: number;
    source: 'gmail_email' | 'calendar_event' | 'hubspot_contact' | 'hubspot_note';
    sourceIds: string[];
  }): Promise<Map<string, { title: string; text: string }>> {
    const map = new Map<string, { title: string; text: string }>();

    const ids = Array.from(new Set(input.sourceIds)).filter(Boolean);
    if (ids.length === 0) return map;

    for (const chunk of chunkArray(ids, 1000)) {
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

  private async enqueueEmbedForChangedDocs(input: {
    userId: number;
    source: 'gmail_email' | 'calendar_event' | 'hubspot_contact' | 'hubspot_note';
    changedSourceIds: string[];
  }): Promise<void> {
    const uniqueChanged = Array.from(new Set(input.changedSourceIds)).filter(Boolean);
    if (uniqueChanged.length === 0) return;

    const documentIds: number[] = [];

    for (const chunk of chunkArray(uniqueChanged, 1000)) {
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

      for (const r of rows) documentIds.push(r.id);
    }

    if (documentIds.length === 0) return;

    await this.pgBossService.client.send(RAG_EMBED_DOCUMENTS_JOB, {
      userId: input.userId,
      documentIds,
    });
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
  mode: 'initial' | 'incremental';
  overrideQuery?: string;
  baseQuery?: string;
  lastSyncedAt?: string;
  daysBack?: number;
}): string {
  const base =
    input.overrideQuery?.trim() ||
    input.baseQuery?.trim() ||
    'in:inbox -in:spam -in:trash -in:chats';

  const hasTime =
    /\bnewer_than:\d+[dmy]\b/i.test(base) ||
    /\bafter:\S+/i.test(base) ||
    /\bbefore:\S+/i.test(base);

  if (hasTime) return base;

  if (input.mode === 'initial') {
    const daysBack = clampInt(input.daysBack ?? 90, 1, 3650);
    return `${base} newer_than:${daysBack}d`;
  }

  if (input.lastSyncedAt) {
    const last = Date.parse(input.lastSyncedAt);
    if (Number.isFinite(last)) {
      const days = Math.ceil((Date.now() - last) / 86_400_000);
      const newerThanDays = clampInt(days + 1, 1, 365);
      return `${base} newer_than:${newerThanDays}d`;
    }
  }

  return `${base} newer_than:30d`;
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
  if (arr.length <= size) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function hasTimeFilter(q: string): boolean {
  return /\bnewer_than:\d+[dmy]\b/i.test(q) || /\bafter:\S+/i.test(q) || /\bbefore:\S+/i.test(q);
}
