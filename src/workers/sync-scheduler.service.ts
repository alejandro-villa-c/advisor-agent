import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgBossService } from '../jobs/pgboss.service';
import { AGENT_TICK_JOB, SYNC_TICK_JOB } from '../jobs/job.constants';

@Injectable()
export class SyncSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SyncSchedulerService.name);

  constructor(private readonly pgBoss: PgBossService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.pgBoss.client.schedule(SYNC_TICK_JOB, '*/3 * * * *', {});
      this.logger.log(`Scheduled ${SYNC_TICK_JOB} every 3 minutes`);

      await this.pgBoss.client.send(SYNC_TICK_JOB, { reason: 'startup' });
      this.logger.log(`Enqueued ${SYNC_TICK_JOB} immediately (startup)`);

      // Agent tick scheduler
      await this.pgBoss.client.schedule(AGENT_TICK_JOB, '*/2 * * * *', {});
      this.logger.log(`Scheduled ${AGENT_TICK_JOB} every 2 minutes`);

      await this.pgBoss.client.send(AGENT_TICK_JOB, { reason: 'startup' });
      this.logger.log(`Enqueued ${AGENT_TICK_JOB} immediately (startup)`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to schedule jobs: ${message}`);
    }
  }
}
