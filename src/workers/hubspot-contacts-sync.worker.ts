import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PgBossService } from '../jobs/pgboss.service';
import { DbService } from '../db/db.service';
import { documentChunks, documents, hubspotContacts, integrationStates } from '../db/schema';
import { HubspotApiService } from '../modules/integrations/hubspot/hubspot-api.service';
import { HUBSPOT_SYNC_CONTACTS_JOB, RAG_EMBED_DOCUMENTS_JOB } from '../jobs/job.constants';

export type HubspotSyncContactsJobData = {
  userId: number;
};

type PgBossJob<T> = {
  id: string | number;
  data: T;
};

@Injectable()
export class HubspotContactsSyncWorker implements OnModuleInit {
  private readonly logger = new Logger(HubspotContactsSyncWorker.name);

  constructor(
    private readonly pgBossService: PgBossService,
    private readonly dbService: DbService,
    private readonly hubspotApiService: HubspotApiService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.pgBossService.client.createQueue(HUBSPOT_SYNC_CONTACTS_JOB);
    } catch (err: unknown) {
      this.logger.warn(
        `createQueue(${HUBSPOT_SYNC_CONTACTS_JOB}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await this.pgBossService.client.work(
      HUBSPOT_SYNC_CONTACTS_JOB,
      { batchSize: 1 },
      async (jobs: PgBossJob<HubspotSyncContactsJobData>[]) => {
        for (const job of jobs) await this.handleOne(job);
      },
    );

    this.logger.log(`Registered worker: ${HUBSPOT_SYNC_CONTACTS_JOB}`);
  }

  private async handleOne(job: PgBossJob<HubspotSyncContactsJobData>): Promise<void> {
    const userId = job.data.userId;

    this.logger.log(`[${HUBSPOT_SYNC_CONTACTS_JOB}] start job=${String(job.id)} userId=${userId}`);

    let after: string | null = null;
    let total = 0;
    let page = 0;

    const changedSourceIds: string[] = [];
    const allHubspotIds: string[] = [];

    while (true) {
      page += 1;

      const { results, nextAfter } = await this.hubspotApiService.listContactsPage(userId, {
        limit: 100,
        after,
      });

      total += results.length;

      this.logger.log(
        `[${HUBSPOT_SYNC_CONTACTS_JOB}] page=${page} fetched=${results.length} total=${total}`,
      );

      if (results.length > 0) {
        const pageIds = results.map((r) => r.id).filter(Boolean);
        allHubspotIds.push(...pageIds);

        await this.upsertContacts(userId, results);

        const pageChanged = await this.upsertContactDocumentsIfChanged(userId, results);
        changedSourceIds.push(...pageChanged);
      }

      if (!nextAfter) break;
      after = nextAfter;

      if (page >= 100) {
        this.logger.warn(`[${HUBSPOT_SYNC_CONTACTS_JOB}] safety stop at page=${page}`);
        break;
      }
    }

    // DELETION HANDLING: Remove contacts that no longer exist in HubSpot
    const deletedCount = await this.deleteRemovedContacts(userId, allHubspotIds);

    // Save integration state
    await this.dbService.db
      .insert(integrationStates)
      .values({
        userId,
        integration: 'hubspot_contacts',
        state: {
          lastSyncedAt: new Date().toISOString(),
          totalImported: total,
          page,
          changedDocuments: Array.from(new Set(changedSourceIds)).length,
          deletedContacts: deletedCount,
        },
      })
      .onConflictDoUpdate({
        target: [integrationStates.userId, integrationStates.integration],
        set: {
          state: sql`excluded.state`,
          updatedAt: sql`now()`,
        },
      });

    // FIX: Only embed CHANGED documents
    // RagRepairWorker handles orphaned documents separately
    const changedDocIds = await this.loadDocumentIdsForSourceIds({
      userId,
      source: 'hubspot_contact',
      sourceIds: changedSourceIds,
    });

    if (changedDocIds.length > 0) {
      await this.enqueueEmbedForDocumentIds({
        userId,
        documentIds: changedDocIds,
      });
    }

    this.logger.log(
      `[${HUBSPOT_SYNC_CONTACTS_JOB}] done job=${String(job.id)} totalContacts=${total} changedDocs=${Array.from(new Set(changedSourceIds)).length} deletedContacts=${deletedCount}`,
    );
  }

  /**
   * Delete contacts (and their documents/chunks) that no longer exist in HubSpot.
   */
  private async deleteRemovedContacts(
    userId: number,
    currentHubspotIds: string[],
  ): Promise<number> {
    const uniqueIds = Array.from(new Set(currentHubspotIds)).filter(Boolean);

    if (uniqueIds.length === 0) {
      this.logger.warn(
        `[${HUBSPOT_SYNC_CONTACTS_JOB}] skipping deletion - received 0 contacts from HubSpot`,
      );
      return 0;
    }

    const localContacts = await this.dbService.db
      .select({ hubspotContactId: hubspotContacts.hubspotContactId })
      .from(hubspotContacts)
      .where(eq(hubspotContacts.userId, userId));

    const localIds = localContacts.map((c) => c.hubspotContactId);
    const hubspotIdSet = new Set(uniqueIds);
    const toDelete = localIds.filter((id) => !hubspotIdSet.has(id));

    if (toDelete.length === 0) return 0;

    const deletionRatio = toDelete.length / localIds.length;
    if (deletionRatio > 0.5 && toDelete.length > 10) {
      this.logger.warn(
        `[${HUBSPOT_SYNC_CONTACTS_JOB}] skipping deletion - would delete ${toDelete.length}/${localIds.length} contacts (${Math.round(deletionRatio * 100)}%)`,
      );
      return 0;
    }

    let deletedCount = 0;

    for (const batch of chunkArray(toDelete, 100)) {
      const docIds = await this.loadDocumentIdsForSourceIds({
        userId,
        source: 'hubspot_contact',
        sourceIds: batch,
      });

      if (docIds.length > 0) {
        await this.dbService.db
          .delete(documentChunks)
          .where(
            and(eq(documentChunks.userId, userId), inArray(documentChunks.documentId, docIds)),
          );
      }

      await this.dbService.db
        .delete(documents)
        .where(
          and(
            eq(documents.userId, userId),
            eq(documents.source, 'hubspot_contact'),
            inArray(documents.sourceId, batch),
          ),
        );

      await this.dbService.db
        .delete(hubspotContacts)
        .where(
          and(eq(hubspotContacts.userId, userId), inArray(hubspotContacts.hubspotContactId, batch)),
        );

      deletedCount += batch.length;

      this.logger.log(
        `[${HUBSPOT_SYNC_CONTACTS_JOB}] deleted batch of ${batch.length} removed contacts`,
      );
    }

    return deletedCount;
  }

  private async upsertContacts(
    userId: number,
    contacts: Array<{ id: string; email?: string; firstName?: string; lastName?: string }>,
  ): Promise<void> {
    const rows = contacts.map((c) => ({
      userId,
      hubspotContactId: c.id,
      email: c.email ?? null,
      firstName: c.firstName ?? null,
      lastName: c.lastName ?? null,
      raw: {
        id: c.id,
        email: c.email ?? null,
        firstName: c.firstName ?? null,
        lastName: c.lastName ?? null,
      },
    }));

    await this.dbService.db
      .insert(hubspotContacts)
      .values(rows)
      .onConflictDoUpdate({
        target: [hubspotContacts.userId, hubspotContacts.hubspotContactId],
        set: {
          email: sql`excluded.email`,
          firstName: sql`excluded.first_name`,
          lastName: sql`excluded.last_name`,
          raw: sql`excluded.raw`,
          updatedAt: sql`now()`,
        },
      });
  }

  private async upsertContactDocumentsIfChanged(
    userId: number,
    contacts: Array<{ id: string; email?: string; firstName?: string; lastName?: string }>,
  ): Promise<string[]> {
    const sourceIds = contacts.map((c) => c.id).filter(Boolean);
    const existing = await this.loadExistingDocsMap({
      userId,
      source: 'hubspot_contact',
      sourceIds,
    });

    const changedSourceIds: string[] = [];
    const changedRows: Array<{
      userId: number;
      source: 'hubspot_contact';
      sourceId: string;
      title: string;
      text: string;
      meta: Record<string, unknown>;
    }> = [];

    for (const c of contacts) {
      const fullName = [c.firstName ?? '', c.lastName ?? ''].join(' ').trim();
      const email = (c.email ?? '').trim();

      const title = fullName ? `HubSpot Contact: ${fullName}` : `HubSpot Contact: ${c.id}`;

      const textValue = [
        `HubSpot contact`,
        `ID: ${c.id}`,
        email ? `Email: ${email}` : null,
        fullName ? `Name: ${fullName}` : null,
      ]
        .filter(Boolean)
        .join('\n');

      const docText = capText(textValue, 40_000);

      const prev = existing.get(c.id);
      const unchanged = prev && prev.title === title && prev.text === docText;

      if (!unchanged) {
        changedSourceIds.push(c.id);
        changedRows.push({
          userId,
          source: 'hubspot_contact',
          sourceId: c.id,
          title,
          text: docText,
          meta: {
            hubspotContactId: c.id,
            email: c.email ?? null,
            firstName: c.firstName ?? null,
            lastName: c.lastName ?? null,
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
    source: 'hubspot_contact' | 'hubspot_note' | 'gmail_email' | 'calendar_event';
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
    source: 'hubspot_contact' | 'hubspot_note' | 'gmail_email' | 'calendar_event';
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

  private async enqueueEmbedForDocumentIds(input: {
    userId: number;
    documentIds: number[];
  }): Promise<void> {
    const unique = Array.from(new Set(input.documentIds))
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0);

    if (unique.length === 0) return;

    for (const batch of chunkArray(unique, 100)) {
      await this.pgBossService.client.send(
        RAG_EMBED_DOCUMENTS_JOB,
        {
          userId: input.userId,
          documentIds: batch,
        },
        {
          singletonKey: `rag.embed.hubspot-contacts:${input.userId}`,
          singletonSeconds: 30,
        },
      );
    }
  }
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
