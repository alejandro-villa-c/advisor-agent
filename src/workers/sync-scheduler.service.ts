import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PgBossService } from '../jobs/pgboss.service';
import { AGENT_TICK_JOB, SYNC_TICK_JOB, INSTRUCTION_TICK_JOB } from '../jobs/job.constants';

@Injectable()
export class SyncSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SyncSchedulerService.name);

  // Default cron expressions (can be overridden via env)
  private readonly syncTickCron: string;
  private readonly agentTickCron: string;
  private readonly instructionTickCron: string;

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly config: ConfigService,
  ) {
    // Load cron expressions from env or use defaults
    this.syncTickCron = this.config.get<string>('SYNC_TICK_CRON', '*/3 * * * *');
    this.agentTickCron = this.config.get<string>('AGENT_TICK_CRON', '*/1 * * * *');
    this.instructionTickCron = this.config.get<string>('INSTRUCTION_TICK_CRON', '*/2 * * * *');
  }

  async onModuleInit(): Promise<void> {
    try {
      // Sync tick
      await this.pgBoss.client.schedule(SYNC_TICK_JOB, this.syncTickCron, {});
      this.logger.log(`Scheduled ${SYNC_TICK_JOB} with cron: ${this.syncTickCron}`);

      await this.pgBoss.client.send(SYNC_TICK_JOB, { reason: 'startup' });
      this.logger.log(`Enqueued ${SYNC_TICK_JOB} immediately (startup)`);

      // Agent tick
      await this.pgBoss.client.schedule(AGENT_TICK_JOB, this.agentTickCron, {});
      this.logger.log(`Scheduled ${AGENT_TICK_JOB} with cron: ${this.agentTickCron}`);

      await this.pgBoss.client.send(AGENT_TICK_JOB, { reason: 'startup' });
      this.logger.log(`Enqueued ${AGENT_TICK_JOB} immediately (startup)`);

      // Instruction tick
      // This polls for triggers and processes ongoing instructions
      await this.pgBoss.client.schedule(INSTRUCTION_TICK_JOB, this.instructionTickCron, {});
      this.logger.log(`Scheduled ${INSTRUCTION_TICK_JOB} with cron: ${this.instructionTickCron}`);

      await this.pgBoss.client.send(INSTRUCTION_TICK_JOB, { reason: 'startup' });
      this.logger.log(`Enqueued ${INSTRUCTION_TICK_JOB} immediately (startup)`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to schedule jobs: ${message}`);
    }
  }
}
