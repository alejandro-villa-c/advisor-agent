import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import {
  AGENT_REACT_JOB,
  AGENT_RUN_TASK_JOB,
  AGENT_TICK_JOB,
  CALENDAR_SYNC_EVENTS_JOB,
  GMAIL_SYNC_MESSAGES_JOB,
  HUBSPOT_SYNC_CONTACTS_JOB,
  HUBSPOT_SYNC_NOTES_JOB,
  RAG_EMBED_DOCUMENTS_JOB,
  SYNC_TICK_JOB,
} from './job.constants';

@Injectable()
export class PgBossService implements OnModuleInit, OnModuleDestroy {
  private boss: PgBoss | null = null;

  get client(): PgBoss {
    if (!this.boss) throw new Error('PgBoss not initialized yet.');
    return this.boss;
  }

  async onModuleInit(): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL is not set. Put it in your .env locally, or in Render environment variables.',
      );
    }

    this.boss = new PgBoss({
      connectionString: databaseUrl,
    });

    this.boss.on('error', (err) => {
      console.error('[pg-boss] error event:', err);
    });

    await this.boss.start();

    // Ensure queues exist in BOTH web + worker processes (prevents early-send failures).
    const queues: string[] = [
      HUBSPOT_SYNC_CONTACTS_JOB,
      HUBSPOT_SYNC_NOTES_JOB,
      GMAIL_SYNC_MESSAGES_JOB,
      CALENDAR_SYNC_EVENTS_JOB,
      RAG_EMBED_DOCUMENTS_JOB,
      SYNC_TICK_JOB,
      AGENT_TICK_JOB,
      AGENT_REACT_JOB,
      AGENT_RUN_TASK_JOB,
    ];

    for (const queueName of queues) {
      try {
        await this.boss.createQueue(queueName);
      } catch (err: unknown) {
        // createQueue is usually idempotent; warn and continue.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[pg-boss] createQueue(${queueName}) failed: ${message}`);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.boss) {
      await this.boss.stop();
      this.boss = null;
    }
  }
}
