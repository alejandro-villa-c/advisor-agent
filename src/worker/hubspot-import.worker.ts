import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgBossService } from '../jobs/pgboss.service';
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
    private readonly hubspotApiService: HubspotApiService,
  ) {}

  async onModuleInit(): Promise<void> {
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
}
