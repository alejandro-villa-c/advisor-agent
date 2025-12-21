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
    const allHubspotNoteIds: string[] = [];

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
        const ids = results.map((r) => r.id).filter(Boolean);
        allHubspotNoteIds.push(...ids);

        await this.upsertNotes(userId, results);

        const pageChanged = await this.upsertNoteDocumentsIfChanged(userId, results);
        changedSourceIds.push(...pageChanged);
      }

      if (!nextAfter) break;
      after = nextAfter;

      if (page >= 100) {
        this.logger.warn(`[${HUBSPOT_SYNC_NOTES_JOB}] safety stop at page=${page}`);
        break;
      }
    }

    const uniqueChangedSourceIds = Array.from(new Set(changedSourceIds)).filter(Boolean);

    // DELETION HANDLING: Remove notes that no longer exist in HubSpot
    const deletedCount = await this.deleteRemovedNotes(userId, allHubspotNoteIds);

    // Repair behavior: include docs missing chunkIndex=0 even if unchanged
    const repairDocIds = await this.loadDocumentIdsMissingChunksForSourceIds({
      userId,
      source: 'hubspot_note',
      sourceIds: allHubspotNoteIds,
    });

    await this.enqueueEmbedForDocumentIds({
      userId,
      documentIds: [
        ...(await this.loadDocumentIdsForSourceIds({
          userId,
          source: 'hubspot_note',
          sourceIds: uniqueChangedSourceIds,
        })),
        ...repairDocIds,
      ],
    });

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
          missingChunkDocumentsQueued: repairDocIds.length,
          deletedNotes: deletedCount,
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
      `[${HUBSPOT_SYNC_NOTES_JOB}] done job=${String(job.id)} totalNotes=${total} changedDocs=${uniqueChangedSourceIds.length} repairedDocs=${repairDocIds.length} deletedNotes=${deletedCount}`,
    );
  }

  /**
   * Delete notes (and their documents/chunks) that no longer exist in HubSpot.
   */
  private async deleteRemovedNotes(
    userId: number,
    currentHubspotNoteIds: string[],
  ): Promise<number> {
    const uniqueIds = Array.from(new Set(currentHubspotNoteIds)).filter(Boolean);

    // If we got zero notes from HubSpot, don't delete everything - could be an API issue
    if (uniqueIds.length === 0) {
      // Check if we have any local notes - if so, this might be suspicious
      const localCount = await this.dbService.db
        .select({ count: sql<number>`count(*)::int` })
        .from(hubspotNotes)
        .where(eq(hubspotNotes.userId, userId));

      const existingCount = localCount[0]?.count ?? 0;

      if (existingCount > 0) {
        this.logger.warn(
          `[${HUBSPOT_SYNC_NOTES_JOB}] skipping deletion - received 0 notes from HubSpot but have ${existingCount} locally`,
        );
      }

      return 0;
    }

    // Find local notes not in the current HubSpot list
    const localNotes = await this.dbService.db
      .select({ hubspotNoteId: hubspotNotes.hubspotNoteId })
      .from(hubspotNotes)
      .where(eq(hubspotNotes.userId, userId));

    const localIds = localNotes.map((n) => n.hubspotNoteId);
    const hubspotIdSet = new Set(uniqueIds);
    const toDelete = localIds.filter((id) => !hubspotIdSet.has(id));

    if (toDelete.length === 0) return 0;

    // Safety check: don't delete more than 50% of notes in one sync
    const deletionRatio = toDelete.length / localIds.length;
    if (deletionRatio > 0.5 && toDelete.length > 10) {
      this.logger.warn(
        `[${HUBSPOT_SYNC_NOTES_JOB}] skipping deletion - would delete ${toDelete.length}/${localIds.length} notes (${Math.round(deletionRatio * 100)}%)`,
      );
      return 0;
    }

    let deletedCount = 0;

    for (const batch of chunkArray(toDelete, 100)) {
      // 1. Delete document chunks for these notes
      const docIds = await this.loadDocumentIdsForSourceIds({
        userId,
        source: 'hubspot_note',
        sourceIds: batch,
      });

      if (docIds.length > 0) {
        await this.dbService.db
          .delete(documentChunks)
          .where(
            and(eq(documentChunks.userId, userId), inArray(documentChunks.documentId, docIds)),
          );
      }

      // 2. Delete documents
      await this.dbService.db
        .delete(documents)
        .where(
          and(
            eq(documents.userId, userId),
            eq(documents.source, 'hubspot_note'),
            inArray(documents.sourceId, batch),
          ),
        );

      // 3. Delete notes from mirror table
      await this.dbService.db
        .delete(hubspotNotes)
        .where(and(eq(hubspotNotes.userId, userId), inArray(hubspotNotes.hubspotNoteId, batch)));

      deletedCount += batch.length;

      this.logger.log(`[${HUBSPOT_SYNC_NOTES_JOB}] deleted batch of ${batch.length} removed notes`);
    }

    return deletedCount;
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

    for (const batch of chunkArray(rows, 500)) {
      await this.dbService.db
        .insert(hubspotNotes)
        .values(batch)
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
    const changedRows: Array<{
      userId: number;
      source: 'hubspot_note';
      sourceId: string;
      title: string;
      text: string;
      meta: Record<string, unknown>;
    }> = [];

    for (const n of notes) {
      const contactId = (n.hubspotContactId ?? 'unknown').trim() || 'unknown';
      const title = `HubSpot Note (${contactId})`;

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

        changedRows.push({
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
        });
      }
    }

    for (const batch of chunkArray(changedRows, 500)) {
      await this.dbService.db
        .insert(documents)
        .values(batch)
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
    source: 'hubspot_note' | 'hubspot_contact' | 'gmail_email' | 'calendar_event';
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
    source: 'hubspot_note' | 'hubspot_contact' | 'gmail_email' | 'calendar_event';
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

    for (const batch of chunkArray(unique, 200)) {
      await this.pgBossService.client.send(RAG_EMBED_DOCUMENTS_JOB, {
        userId: input.userId,
        documentIds: batch,
      });
    }
  }
}

function toOccurredAtForDb(ts: string | undefined): Date {
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
  const a = arr ?? [];
  if (a.length === 0) return [];
  if (a.length <= size) return [a];
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += size) out.push(a.slice(i, i + size));
  return out;
}
