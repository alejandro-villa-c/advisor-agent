import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PgBossService } from '../jobs/pgboss.service';
import { DbService } from '../db/db.service';
import { documentChunks, documents, hubspotNotes, integrationStates } from '../db/schema';
import { HubspotApiService } from '../modules/integrations/hubspot/hubspot-api.service';
import { HUBSPOT_SYNC_NOTES_JOB, RAG_EMBED_DOCUMENTS_JOB } from '../jobs/job.constants';

export type HubspotSyncNotesJobData = {
  userId: number;
};

type PgBossJob<T> = {
  id: string | number;
  data: T;
};

@Injectable()
export class HubspotNotesSyncWorker implements OnModuleInit {
  private readonly logger = new Logger(HubspotNotesSyncWorker.name);

  constructor(
    private readonly pgBossService: PgBossService,
    private readonly dbService: DbService,
    private readonly hubspotApiService: HubspotApiService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.pgBossService.client.createQueue(HUBSPOT_SYNC_NOTES_JOB);
    } catch (err: unknown) {
      this.logger.warn(
        `createQueue(${HUBSPOT_SYNC_NOTES_JOB}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await this.pgBossService.client.work(
      HUBSPOT_SYNC_NOTES_JOB,
      { batchSize: 1 },
      async (jobs: PgBossJob<HubspotSyncNotesJobData>[]) => {
        for (const job of jobs) await this.handleOne(job);
      },
    );

    this.logger.log(`Registered worker: ${HUBSPOT_SYNC_NOTES_JOB}`);
  }

  private async handleOne(job: PgBossJob<HubspotSyncNotesJobData>): Promise<void> {
    const userId = job.data.userId;

    this.logger.log(`[${HUBSPOT_SYNC_NOTES_JOB}] start job=${String(job.id)} userId=${userId}`);

    let after: string | null = null;
    let total = 0;
    let page = 0;

    const changedSourceIds: string[] = [];

    while (true) {
      page += 1;

      const { results, nextAfter } = await this.hubspotApiService.listNotesPage(userId, {
        limit: 100,
        after,
      });

      total += results.length;

      this.logger.log(
        `[${HUBSPOT_SYNC_NOTES_JOB}] page=${page} fetched=${results.length} total=${total}`,
      );

      if (results.length > 0) {
        await this.upsertNotes(userId, results);

        const pageChanged = await this.upsertNoteDocumentsIfChanged(userId, results);
        changedSourceIds.push(...pageChanged);
      }

      if (!nextAfter) break;
      after = nextAfter;

      if (page >= 50) {
        this.logger.warn(`[${HUBSPOT_SYNC_NOTES_JOB}] safety stop at page=${page}`);
        break;
      }
    }

    // 1) Normal behavior: embed docs that changed this run
    await this.enqueueEmbedForChangedDocs({
      userId,
      source: 'hubspot_note',
      changedSourceIds,
    });

    // 2) “repair mode” — if any hubspot_note docs exist without chunks, force-queue embedding
    // This solves the "notes exist, but have 0 chunks forever" deadlock.
    const missingChunkDocIds = await this.findHubspotNoteDocumentIdsMissingChunks({ userId });

    if (missingChunkDocIds.length > 0) {
      await this.enqueueEmbedForDocumentIds({ userId, documentIds: missingChunkDocIds });

      this.logger.warn(
        `[${HUBSPOT_SYNC_NOTES_JOB}] repair: queued embed for hubspot_note docs missing chunks count=${missingChunkDocIds.length}`,
      );
    }

    const uniqueChangedSourceIds = Array.from(new Set(changedSourceIds)).filter(Boolean);

    await this.dbService.db
      .insert(integrationStates)
      .values({
        userId,
        integration: 'hubspot_notes',
        state: {
          lastSyncedAt: new Date().toISOString(),
          totalImported: total,
          page,
          changedDocuments: uniqueChangedSourceIds.length,
          missingChunkDocumentsQueued: missingChunkDocIds.length,
        },
      })
      .onConflictDoUpdate({
        target: [integrationStates.userId, integrationStates.integration],
        set: {
          state: sql`excluded.state`,
          updatedAt: sql`now()`,
        },
      });

    this.logger.log(
      `[${HUBSPOT_SYNC_NOTES_JOB}] done job=${String(job.id)} totalNotes=${total} changedDocs=${uniqueChangedSourceIds.length} missingChunkDocsQueued=${missingChunkDocIds.length}`,
    );
  }

  private async upsertNotes(
    userId: number,
    notes: Array<{
      id: string;
      hubspotContactId?: string;
      body?: string;
      timestamp?: string;
    }>,
  ): Promise<void> {
    const rows = notes.map((n) => {
      const occurredAt = toOccurredAtForDb(n.timestamp);

      return {
        userId,
        hubspotNoteId: n.id,
        hubspotContactId: n.hubspotContactId ?? 'unknown',
        body: n.body ?? null,
        occurredAt,
        raw: {
          id: n.id,
          hubspotContactId: n.hubspotContactId ?? null,
          body: n.body ?? null,
          timestamp: n.timestamp ?? null,
        },
      };
    });

    await this.dbService.db
      .insert(hubspotNotes)
      .values(rows)
      .onConflictDoUpdate({
        target: [hubspotNotes.userId, hubspotNotes.hubspotNoteId],
        set: {
          hubspotContactId: sql`excluded.hubspot_contact_id`,
          body: sql`excluded.body`,
          occurredAt: sql`excluded.occurred_at`,
          raw: sql`excluded.raw`,
          updatedAt: sql`now()`,
        },
      });
  }

  private async upsertNoteDocumentsIfChanged(
    userId: number,
    notes: Array<{
      id: string;
      hubspotContactId?: string;
      body?: string;
      timestamp?: string;
    }>,
  ): Promise<string[]> {
    const sourceIds = notes.map((n) => n.id).filter(Boolean);
    const existing = await this.loadExistingDocsMap({
      userId,
      source: 'hubspot_note',
      sourceIds,
    });

    const changedSourceIds: string[] = [];

    for (const n of notes) {
      const contactId = (n.hubspotContactId ?? 'unknown').trim() || 'unknown';

      const title = `HubSpot Note (${contactId})`;

      // IMPORTANT: only include time fields if HubSpot provided a stable timestamp
      const stableIso = toOccurredAtIsoForDoc(n.timestamp);

      const textValue = [
        `HubSpot note`,
        `Note ID: ${n.id}`,
        `Contact ID: ${contactId}`,
        n.timestamp ? `Timestamp: ${n.timestamp}` : null,
        stableIso ? `Occurred At: ${stableIso}` : null,
        '',
        (n.body ?? '').trim() || '(empty note)',
      ]
        .filter(Boolean)
        .join('\n');

      const docText = capText(textValue, 40_000);

      const prev = existing.get(n.id);
      const unchanged = prev && prev.title === title && prev.text === docText;

      if (!unchanged) {
        changedSourceIds.push(n.id);

        await this.dbService.db
          .insert(documents)
          .values({
            userId,
            source: 'hubspot_note',
            sourceId: n.id,
            title,
            text: docText,
            meta: {
              hubspotNoteId: n.id,
              hubspotContactId: n.hubspotContactId ?? null,
              timestamp: n.timestamp ?? null,
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
    }

    return changedSourceIds;
  }

  private async loadExistingDocsMap(input: {
    userId: number;
    source: 'hubspot_note' | 'hubspot_contact' | 'gmail_email' | 'calendar_event';
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
    source: 'hubspot_note' | 'hubspot_contact' | 'gmail_email' | 'calendar_event';
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

    await this.enqueueEmbedForDocumentIds({ userId: input.userId, documentIds });
  }

  private async enqueueEmbedForDocumentIds(input: {
    userId: number;
    documentIds: number[];
  }): Promise<void> {
    const unique = Array.from(new Set(input.documentIds))
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0);

    if (unique.length === 0) return;

    // pg-boss payload size safety
    for (const chunk of chunkArray(unique, 1000)) {
      await this.pgBossService.client.send(RAG_EMBED_DOCUMENTS_JOB, {
        userId: input.userId,
        documentIds: chunk,
      });
    }
  }

  private async findHubspotNoteDocumentIdsMissingChunks(input: {
    userId: number;
  }): Promise<number[]> {
    // We consider a document "chunked" if it has chunkIndex=0.
    // If chunkIndex=0 is missing, the doc has no chunks (or chunking failed).
    const rows = await this.dbService.db
      .select({ id: documents.id })
      .from(documents)
      .leftJoin(
        documentChunks,
        and(
          eq(documentChunks.userId, input.userId),
          eq(documentChunks.documentId, documents.id),
          eq(documentChunks.chunkIndex, 0),
        ),
      )
      .where(
        and(
          eq(documents.userId, input.userId),
          eq(documents.source, 'hubspot_note'),
          sql`${documentChunks.id} IS NULL`,
        ),
      )
      .limit(5000);

    return rows.map((r) => r.id);
  }
}

function toOccurredAtForDb(ts: string | undefined): Date {
  // If HubSpot gives nothing, we still need *something* for the table column.
  // But we must NOT use "now()" in the *document text* (that would cause re-embed each run).
  if (!ts) return new Date(0);

  const asNum = Number(ts);
  if (Number.isFinite(asNum) && asNum > 0) return new Date(asNum);

  const parsed = Date.parse(ts);
  if (Number.isFinite(parsed)) return new Date(parsed);

  return new Date(0);
}

function toOccurredAtIsoForDoc(ts: string | undefined): string | null {
  if (!ts) return null;

  const asNum = Number(ts);
  if (Number.isFinite(asNum) && asNum > 0) return new Date(asNum).toISOString();

  const parsed = Date.parse(ts);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();

  return null;
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
