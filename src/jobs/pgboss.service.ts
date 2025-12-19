import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';

@Injectable()
export class PgBossService implements OnModuleInit, OnModuleDestroy {
  private boss: PgBoss | null = null;

  get client(): PgBoss {
    if (!this.boss) {
      throw new Error('PgBoss not initialized yet.');
    }
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
      // optional: schema: 'pgboss',
    });

    // Creates/updates pg-boss tables automatically as needed
    await this.boss.start();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.boss) {
      await this.boss.stop();
      this.boss = null;
    }
  }
}
