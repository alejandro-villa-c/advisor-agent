import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import { PgBossService } from '../jobs/pgboss.service';
import { DbService } from '../db/db.service';
import { integrationStates, oauthAccounts } from '../db/schema';
import {
  AGENT_TICK_JOB,
  CALENDAR_SYNC_EVENTS_JOB,
  GMAIL_SYNC_MESSAGES_JOB,
  HUBSPOT_SYNC_CONTACTS_JOB,
  HUBSPOT_SYNC_NOTES_JOB,
  SYNC_TICK_JOB,
} from '../jobs/job.constants';

type PgBossJob<T> = {
  id: string | number;
  data: T;
};

@Injectable()
export class SyncTickWorker implements OnModuleInit {
  private readonly logger = new Logger(SyncTickWorker.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly dbService: DbService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.pgBoss.client.work(
      SYNC_TICK_JOB,
      { batchSize: 1 },
      async (jobs: PgBossJob<Record<string, unknown>>[]) => {
        for (const job of jobs) await this.handleOne(job);
      },
    );

    this.logger.log(`Registered worker: ${SYNC_TICK_JOB}`);
  }

  private async handleOne(job: PgBossJob<Record<string, unknown>>): Promise<void> {
    this.logger.log(`[${SYNC_TICK_JOB}] start job=${String(job.id)}`);

    const db = this.dbService.db;

    const accounts = await db
      .select({ userId: oauthAccounts.userId, provider: oauthAccounts.provider })
      .from(oauthAccounts)
      .where(sql`${oauthAccounts.provider} IN ('google', 'hubspot')`);

    const byUser = new Map<number, { hasGoogle: boolean; hasHubspot: boolean }>();
    for (const row of accounts) {
      const userId = Number(row.userId);
      const current = byUser.get(userId) ?? { hasGoogle: false, hasHubspot: false };
      if (row.provider === 'google') current.hasGoogle = true;
      if (row.provider === 'hubspot') current.hasHubspot = true;
      byUser.set(userId, current);
    }

    const userIds = Array.from(byUser.keys());
    if (userIds.length === 0) {
      this.logger.log(`[${SYNC_TICK_JOB}] no connected users`);

      // Still tick agent (waiting tasks can exist even if no integrations are connected now)
      await this.pgBoss.client.send(AGENT_TICK_JOB, { reason: 'sync_tick_no_users' });

      return;
    }

    const stateRows = await db
      .select({
        userId: integrationStates.userId,
        integration: integrationStates.integration,
        state: integrationStates.state,
      })
      .from(integrationStates)
      .where(inArray(integrationStates.userId, userIds));

    const lastSyncedAtByUserIntegration = new Map<string, Date>();

    for (const row of stateRows) {
      const userId = Number(row.userId);
      const integration = String(row.integration);
      const lastSyncedAt = readLastSyncedAt(row.state);
      if (lastSyncedAt) lastSyncedAtByUserIntegration.set(`${userId}:${integration}`, lastSyncedAt);
    }

    let enqueued = 0;

    for (const userId of userIds) {
      const flags = byUser.get(userId);
      if (!flags) continue;

      if (flags.hasGoogle) {
        // Gmail: frequent incremental
        if (shouldRun(lastSyncedAtByUserIntegration.get(`${userId}:gmail`), 8)) {
          await this.pgBoss.client.send(GMAIL_SYNC_MESSAGES_JOB, {
            userId,
            maxMessages: 200,
            mode: 'incremental',
          });
          enqueued += 1;
        }

        // Calendar: less frequent
        if (shouldRun(lastSyncedAtByUserIntegration.get(`${userId}:calendar`), 360)) {
          await this.pgBoss.client.send(CALENDAR_SYNC_EVENTS_JOB, {
            userId,
            calendarId: 'primary',
            maxPages: 10,
            daysPast: 60,
            daysFuture: 60,
          });
          enqueued += 1;
        }
      }

      if (flags.hasHubspot) {
        // HubSpot notes: somewhat frequent
        if (shouldRun(lastSyncedAtByUserIntegration.get(`${userId}:hubspot_notes`), 25)) {
          await this.pgBoss.client.send(HUBSPOT_SYNC_NOTES_JOB, { userId });
          enqueued += 1;
        }

        // HubSpot contacts: infrequent
        if (shouldRun(lastSyncedAtByUserIntegration.get(`${userId}:hubspot_contacts`), 360)) {
          await this.pgBoss.client.send(HUBSPOT_SYNC_CONTACTS_JOB, { userId });
          enqueued += 1;
        }
      }
    }

    // Backup agent tick (even though we separately schedule it every 2 min)
    await this.pgBoss.client.send(AGENT_TICK_JOB, { reason: 'sync_tick' });

    this.logger.log(`[${SYNC_TICK_JOB}] done job=${String(job.id)} enqueued=${enqueued}`);
  }
}

function shouldRun(lastSyncedAt: Date | undefined, minMinutes: number): boolean {
  if (!lastSyncedAt) return true;
  const ageMs = Date.now() - lastSyncedAt.getTime();
  return ageMs >= minMinutes * 60_000;
}

function readLastSyncedAt(state: unknown): Date | null {
  if (!state || typeof state !== 'object') return null;
  const maybe = (state as { lastSyncedAt?: unknown }).lastSyncedAt;
  if (typeof maybe !== 'string') return null;
  const ms = Date.parse(maybe);
  return Number.isFinite(ms) ? new Date(ms) : null;
}
