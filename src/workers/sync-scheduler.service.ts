import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgBossService } from '../jobs/pgboss.service';
import { AGENT_TICK_JOB, SYNC_TICK_JOB, INSTRUCTION_TICK_JOB } from '../jobs/job.constants';

@Injectable()
export class SyncSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SyncSchedulerService.name);

  constructor(private readonly pgBoss: PgBossService) {}

  async onModuleInit(): Promise<void> {
    try {
      // Sync tick - runs every 3 minutes
      await this.pgBoss.client.schedule(SYNC_TICK_JOB, '*/3 * * * *', {});
      this.logger.log(`Scheduled ${SYNC_TICK_JOB} every 3 minutes`);

      await this.pgBoss.client.send(SYNC_TICK_JOB, { reason: 'startup' });
      this.logger.log(`Enqueued ${SYNC_TICK_JOB} immediately (startup)`);

      // Agent tick - runs every 1 minute
      await this.pgBoss.client.schedule(AGENT_TICK_JOB, '*/1 * * * *', {});
      this.logger.log(`Scheduled ${AGENT_TICK_JOB} every 1 minute`);

      await this.pgBoss.client.send(AGENT_TICK_JOB, { reason: 'startup' });
      this.logger.log(`Enqueued ${AGENT_TICK_JOB} immediately (startup)`);

      // =====================================================================
      // NEW: Instruction tick - runs every 2 minutes
      // This polls for triggers and processes ongoing instructions
      // =====================================================================
      await this.pgBoss.client.schedule(INSTRUCTION_TICK_JOB, '*/2 * * * *', {});
      this.logger.log(`Scheduled ${INSTRUCTION_TICK_JOB} every 2 minutes`);

      await this.pgBoss.client.send(INSTRUCTION_TICK_JOB, { reason: 'startup' });
      this.logger.log(`Enqueued ${INSTRUCTION_TICK_JOB} immediately (startup)`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to schedule jobs: ${message}`);
    }
  }
}
