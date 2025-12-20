import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PgBossService } from '../jobs/pgboss.service';
import { DbService } from '../db/db.service';
import { documents, hubspotContacts } from '../db/schema';
import { HubspotApiService } from '../modules/integrations/hubspot/hubspot-api.service';

export type ImportContactsJobData = {
  userId: number;
};

export const HUBSPOT_IMPORT_CONTACTS_JOB = 'hubspot.importContacts';

/**
 * pg-boss passes a batch (array) of jobs to the handler.
 * Even if batchSize=1, you still get an array.
 */
type PgBossJob<T> = {
  id: string | number;
  data: T;
};

@Injectable()
export class HubspotImportWorker implements OnModuleInit {
  private readonly logger = new Logger(HubspotImportWorker.name);

  constructor(
    private readonly pgBossService: PgBossService,
    private readonly dbService: DbService,
    private readonly hubspotApiService: HubspotApiService,
  ) {}

  async onModuleInit(): Promise<void> {
    // IMPORTANT: In pg-boss v12, a queue must exist before you can work it.
    // If the worker boots before any job is ever sent, the queue might not exist yet.
    try {
      await this.pgBossService.client.createQueue(HUBSPOT_IMPORT_CONTACTS_JOB);
    } catch (err: unknown) {
      // createQueue is usually idempotent; if it errors, we'll still try to work.
      this.logger.warn(
        `createQueue(${HUBSPOT_IMPORT_CONTACTS_JOB}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await this.pgBossService.client.work(
      HUBSPOT_IMPORT_CONTACTS_JOB,
      { batchSize: 1 },
      async (jobs: PgBossJob<ImportContactsJobData>[]) => {
        for (const job of jobs) {
          await this.handleOne(job);
        }
      },
    );

    this.logger.log(`Registered worker: ${HUBSPOT_IMPORT_CONTACTS_JOB}`);
  }

  private async handleOne(job: PgBossJob<ImportContactsJobData>): Promise<void> {
    const userId = job.data.userId;

    this.logger.log(
      `[${HUBSPOT_IMPORT_CONTACTS_JOB}] start job=${String(job.id)} userId=${userId}`,
    );

    let after: string | null = null;
    let total = 0;
    let page = 0;

    while (true) {
      page += 1;

      const { results, nextAfter } = await this.hubspotApiService.listContactsPage(userId, {
        limit: 100,
        after,
      });

      total += results.length;

      this.logger.log(
        `[${HUBSPOT_IMPORT_CONTACTS_JOB}] page=${page} fetched=${results.length} total=${total}`,
      );

      if (results.length > 0) {
        await this.upsertContacts(userId, results);
        await this.upsertContactDocuments(userId, results);
      }

      if (!nextAfter) break;
      after = nextAfter;

      // safety cap (avoid infinite loops during dev)
      if (page >= 50) {
        this.logger.warn(`[${HUBSPOT_IMPORT_CONTACTS_JOB}] safety stop at page=${page}`);
        break;
      }
    }

    this.logger.log(
      `[${HUBSPOT_IMPORT_CONTACTS_JOB}] done job=${String(job.id)} totalContacts=${total}`,
    );
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

  private async upsertContactDocuments(
    userId: number,
    contacts: Array<{ id: string; email?: string; firstName?: string; lastName?: string }>,
  ): Promise<void> {
    const rows = contacts.map((c) => {
      const fullName = [c.firstName ?? '', c.lastName ?? ''].join(' ').trim();
      const email = c.email ?? '';

      const title = fullName ? `HubSpot Contact: ${fullName}` : `HubSpot Contact: ${c.id}`;

      const textValue = [
        `HubSpot contact`,
        `ID: ${c.id}`,
        email ? `Email: ${email}` : null,
        fullName ? `Name: ${fullName}` : null,
      ]
        .filter(Boolean)
        .join('\n');

      return {
        userId,
        source: 'hubspot_contact' as const,
        sourceId: c.id,
        title,
        text: textValue,
        meta: {
          hubspotContactId: c.id,
          email: c.email ?? null,
          firstName: c.firstName ?? null,
          lastName: c.lastName ?? null,
        },
      };
    });

    await this.dbService.db
      .insert(documents)
      .values(rows)
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
