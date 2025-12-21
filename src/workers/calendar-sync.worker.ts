import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PgBossService } from '../jobs/pgboss.service';
import { DbService } from '../db/db.service';
import { calendarEvents, documentChunks, documents, integrationStates } from '../db/schema';
import { CalendarApiService } from '../modules/integrations/google/calendar-api.service';
import { CALENDAR_SYNC_EVENTS_JOB, RAG_EMBED_DOCUMENTS_JOB } from '../jobs/job.constants';

export type CalendarSyncJobData = {
  userId: number;
  calendarId?: string; // default 'primary'
  maxPages?: number; // default 10
  daysPast?: number; // default 180
  daysFuture?: number; // default 365
};

type PgBossJob<T> = {
  id: string | number;
  data: T;
};

@Injectable()
export class CalendarSyncWorker implements OnModuleInit {
  private readonly logger = new Logger(CalendarSyncWorker.name);

  constructor(
    private readonly pgBossService: PgBossService,
    private readonly dbService: DbService,
    private readonly calendarApi: CalendarApiService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.pgBossService.client.createQueue(CALENDAR_SYNC_EVENTS_JOB);
    } catch (err: unknown) {
      this.logger.warn(
        `createQueue(${CALENDAR_SYNC_EVENTS_JOB}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await this.pgBossService.client.work(
      CALENDAR_SYNC_EVENTS_JOB,
      { batchSize: 1 },
      async (jobs: PgBossJob<CalendarSyncJobData>[]) => {
        for (const job of jobs) {
          try {
            await this.handleOne(job);
          } catch (err) {
            this.logger.error(
              `[${CALENDAR_SYNC_EVENTS_JOB}] FAILED job=${String(job.id)} userId=${job.data?.userId} ` +
                (err instanceof Error ? err.stack : String(err)),
            );
            throw err; // keep the job marked failed so pg-boss retry rules apply
          }
        }
      },
    );

    this.logger.log(`Registered worker: ${CALENDAR_SYNC_EVENTS_JOB}`);
  }

  private async handleOne(job: PgBossJob<CalendarSyncJobData>): Promise<void> {
    const userId = job.data.userId;
    const calendarId = job.data.calendarId ?? 'primary';

    const maxPages = clampInt(job.data.maxPages ?? 10, 1, 50);
    const daysPast = clampInt(job.data.daysPast ?? 180, 1, 3650);
    const daysFuture = clampInt(job.data.daysFuture ?? 365, 1, 3650);

    this.logger.log(
      `[${CALENDAR_SYNC_EVENTS_JOB}] start job=${String(job.id)} userId=${userId} calendarId=${calendarId}`,
    );

    const state = await this.getIntegrationState(userId);

    const now = Date.now();
    const timeMinIso = new Date(now - daysPast * 86_400_000).toISOString();
    const timeMaxIso = new Date(now + daysFuture * 86_400_000).toISOString();

    let pageToken: string | null = null;
    let pages = 0;
    let processed = 0;

    const changedSourceIds: string[] = [];
    const processedSourceIds: string[] = [];

    while (pages < maxPages) {
      pages += 1;

      const page = await this.calendarApi.listEventsPage(userId, {
        calendarId,
        timeMinIso,
        timeMaxIso,
        maxResults: 2500,
        pageToken,
      });

      if (page.events.length === 0) break;

      const pageSourceIds = page.events.map((ev) => `${calendarId}:${ev.id}`);
      processedSourceIds.push(...pageSourceIds);

      const existingBySourceId = await this.loadExistingDocsMap({
        userId,
        source: 'calendar_event',
        sourceIds: pageSourceIds,
      });

      for (const ev of page.events) {
        const startAt = ev.startIso ? safeDate(ev.startIso) : null;
        const endAt = ev.endIso ? safeDate(ev.endIso) : null;

        await this.dbService.db
          .insert(calendarEvents)
          .values({
            userId,
            calendarId,
            googleEventId: ev.id,
            summary: ev.summary ?? null,
            description: ev.description ?? null,
            location: ev.location ?? null,
            startAt,
            endAt,
            attendees: ev.attendees ?? null,
            raw: ev.raw,
          })
          .onConflictDoUpdate({
            target: [
              calendarEvents.userId,
              calendarEvents.calendarId,
              calendarEvents.googleEventId,
            ],
            set: {
              summary: sql`excluded.summary`,
              description: sql`excluded.description`,
              location: sql`excluded.location`,
              startAt: sql`excluded.start_at`,
              endAt: sql`excluded.end_at`,
              attendees: sql`excluded.attendees`,
              raw: sql`excluded.raw`,
              updatedAt: sql`now()`,
            },
          });

        const title = ev.summary?.trim() ? `Calendar: ${ev.summary.trim()}` : `Calendar: ${ev.id}`;

        const docTextRaw = [
          `Google Calendar event`,
          `Calendar: ${calendarId}`,
          `Event ID: ${ev.id}`,
          ev.summary ? `Summary: ${ev.summary}` : null,
          ev.location ? `Location: ${ev.location}` : null,
          ev.startIso ? `Start: ${ev.startIso}` : null,
          ev.endIso ? `End: ${ev.endIso}` : null,
          ev.attendees && ev.attendees.length > 0
            ? `Attendees: ${ev.attendees
                .map((a) => a.email || a.displayName || '')
                .filter(Boolean)
                .join(', ')}`
            : null,
          '',
          ev.description ? ev.description : '',
        ]
          .filter((x) => x !== null)
          .join('\n')
          .trim();

        const docText = capText(docTextRaw || title, 40_000);

        const sourceId = `${calendarId}:${ev.id}`;

        const existing = existingBySourceId.get(sourceId);
        const unchanged = existing && existing.title === title && existing.text === docText;

        if (!unchanged) {
          changedSourceIds.push(sourceId);

          await this.dbService.db
            .insert(documents)
            .values({
              userId,
              source: 'calendar_event',
              sourceId,
              title,
              text: docText,
              meta: {
                calendarId,
                googleEventId: ev.id,
                startIso: ev.startIso ?? null,
                endIso: ev.endIso ?? null,
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

        if (processed % 100 === 0) {
          this.logger.log(`[${CALENDAR_SYNC_EVENTS_JOB}] processed=${processed}`);
        }
      }

      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }

    const nowIso = new Date().toISOString();

    await this.setIntegrationState(userId, {
      ...(state ?? {}),
      lastSyncedAt: nowIso,
      lastRun: {
        at: nowIso,
        pages,
        processed,
        calendarId,
        timeMinIso,
        timeMaxIso,
        changedDocuments: Array.from(new Set(changedSourceIds)).length,
      },
    });

    // Repair behavior: include docs that are missing chunks, even if unchanged
    const repairDocIds = await this.loadDocumentIdsMissingChunksForSourceIds({
      userId,
      source: 'calendar_event',
      sourceIds: processedSourceIds,
    });

    await this.enqueueEmbedForDocumentIds({
      userId,
      documentIds: [
        ...(await this.loadDocumentIdsForSourceIds({
          userId,
          source: 'calendar_event',
          sourceIds: changedSourceIds,
        })),
        ...repairDocIds,
      ],
    });

    this.logger.log(
      `[${CALENDAR_SYNC_EVENTS_JOB}] done job=${String(job.id)} userId=${userId} processed=${processed} pages=${pages} changedDocs=${Array.from(new Set(changedSourceIds)).length} repairedDocs=${repairDocIds.length}`,
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

  private async loadDocumentIdsForSourceIds(input: {
    userId: number;
    source: 'gmail_email' | 'calendar_event' | 'hubspot_contact' | 'hubspot_note';
    sourceIds: string[];
  }): Promise<number[]> {
    const ids = Array.from(new Set(input.sourceIds)).filter(Boolean);
    if (ids.length === 0) return [];

    const out: number[] = [];

    for (const chunk of chunkArray(ids, 1000)) {
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

    for (const chunk of chunkArray(ids, 1000)) {
      const rows = await this.dbService.db
        .select({ id: documents.id })
        .from(documents)
        .leftJoin(
          documentChunks,
          and(
            eq(documentChunks.userId, documents.userId),
            eq(documentChunks.documentId, documents.id),
          ),
        )
        .where(
          and(
            eq(documents.userId, input.userId),
            eq(documents.source, input.source),
            inArray(documents.sourceId, chunk),
          ),
        )
        .groupBy(documents.id)
        .having(sql`count(${documentChunks.id}) = 0`);

      for (const r of rows) out.push(r.id);
    }

    return out;
  }

  private async enqueueEmbedForDocumentIds(input: {
    userId: number;
    documentIds: number[];
  }): Promise<void> {
    const unique = Array.from(new Set(input.documentIds)).filter((x) => Number.isFinite(x));
    if (unique.length === 0) return;

    for (const batch of chunkArray(unique, 1000)) {
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
      .where(
        and(eq(integrationStates.userId, userId), eq(integrationStates.integration, 'calendar')),
      )
      .limit(1);

    return (rows[0]?.state as Record<string, unknown> | undefined) ?? null;
  }

  private async setIntegrationState(userId: number, state: Record<string, unknown>): Promise<void> {
    await this.dbService.db
      .insert(integrationStates)
      .values({
        userId,
        integration: 'calendar',
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

function safeDate(isoOrDate: string): Date | null {
  const ms = Date.parse(isoOrDate);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
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
  if (a.length <= size) return [a];
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += size) out.push(a.slice(i, i + size));
  return out;
}
