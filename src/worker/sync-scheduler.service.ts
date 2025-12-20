import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgBossService } from '../jobs/pgboss.service';
import { SYNC_TICK_JOB } from '../jobs/job.constants';

@Injectable()
export class SyncSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SyncSchedulerService.name);

  constructor(private readonly pgBoss: PgBossService) {}

  async onModuleInit(): Promise<void> {
    try {
      // Schedule the job itself. pg-boss stores schedules in DB; re-calling is typically safe.
      await this.pgBoss.client.schedule(SYNC_TICK_JOB, '*/10 * * * *', {});
      this.logger.log(`Scheduled ${SYNC_TICK_JOB} every 10 minutes`);

      await this.pgBoss.client.send(SYNC_TICK_JOB, { reason: 'startup' });
      this.logger.log(`Enqueued ${SYNC_TICK_JOB} immediately (startup)`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to schedule ${SYNC_TICK_JOB}: ${message}`);
    }
  }
}
