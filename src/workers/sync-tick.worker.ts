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

type GmailBackfill = {
  done: boolean;
  nextPageToken: string | null;
  lastRunAt: Date | null;
};

type PgBossSend = (
  name: string,
  data?: unknown,
  options?: Record<string, unknown>,
) => Promise<unknown>;

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

  private async enqueueJob(
    name: string,
    data?: unknown,
    options?: Record<string, unknown>,
  ): Promise<void> {
    // IMPORTANT: call as a method so `this` binding is preserved
    const client = this.pgBoss.client as unknown as { send: PgBossSend };
    await client.send(name, data, options);
  }

  private async handleOne(job: PgBossJob<Record<string, unknown>>): Promise<void> {
    this.logger.log(`[${SYNC_TICK_JOB}] start job=${String(job.id)}`);

    try {
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
        await this.enqueueJob(AGENT_TICK_JOB, { reason: 'sync_tick_no_users' });
        this.logger.log(`[${SYNC_TICK_JOB}] done job=${String(job.id)} enqueued=0`);
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

      const stateByKey = new Map<string, unknown>();
      const lastSyncedAtByKey = new Map<string, Date>();

      for (const row of stateRows) {
        const userId = Number(row.userId);
        const integration = String(row.integration);

        const stateUnknown: unknown = row.state;
        stateByKey.set(`${userId}:${integration}`, stateUnknown);

        const lastSyncedAt = readLastSyncedAt(stateUnknown);
        if (lastSyncedAt) lastSyncedAtByKey.set(`${userId}:${integration}`, lastSyncedAt);
      }

      let enqueued = 0;

      for (const userId of userIds) {
        const flags = byUser.get(userId);
        if (!flags) continue;

        if (flags.hasGoogle) {
          const gmailBackfill = readGmailBackfill(stateByKey.get(`${userId}:gmail`));
          const backfillLast = gmailBackfill.lastRunAt ?? lastSyncedAtByKey.get(`${userId}:gmail`);

          // Keep your existing "best-effort" gating; once Gmail worker chains, this is just a safety net.
          if (!gmailBackfill.done && shouldRun(backfillLast, 10)) {
            await this.enqueueJob(
              GMAIL_SYNC_MESSAGES_JOB,
              {
                userId,
                mode: 'backfill',
                maxPages: 25,
                maxMessages: 4000,
                pageToken: gmailBackfill.nextPageToken,
              },
              {
                singletonKey: `gmail_backfill:${userId}`,
                singletonSeconds: 600,
              },
            );
            enqueued += 1;
          }

          if (shouldRun(lastSyncedAtByKey.get(`${userId}:gmail`), 3)) {
            await this.enqueueJob(
              GMAIL_SYNC_MESSAGES_JOB,
              {
                userId,
                mode: 'incremental',
                maxPages: 10,
                maxMessages: 500,
              },
              {
                singletonKey: `gmail_incremental:${userId}`,
                singletonSeconds: 180,
              },
            );
            enqueued += 1;
          }

          if (shouldRun(lastSyncedAtByKey.get(`${userId}:calendar`), 60)) {
            await this.enqueueJob(
              CALENDAR_SYNC_EVENTS_JOB,
              {
                userId,
                calendarId: 'primary',
                maxPages: 20,
                daysPast: 365,
                daysFuture: 365,
              },
              {
                singletonKey: `calendar_sync:${userId}`,
                singletonSeconds: 3600,
              },
            );
            enqueued += 1;
          }
        }

        if (flags.hasHubspot) {
          if (shouldRun(lastSyncedAtByKey.get(`${userId}:hubspot_notes`), 15)) {
            await this.enqueueJob(
              HUBSPOT_SYNC_NOTES_JOB,
              { userId },
              { singletonKey: `hubspot_notes:${userId}`, singletonSeconds: 900 },
            );
            enqueued += 1;
          }

          if (shouldRun(lastSyncedAtByKey.get(`${userId}:hubspot_contacts`), 15)) {
            await this.enqueueJob(
              HUBSPOT_SYNC_CONTACTS_JOB,
              { userId },
              { singletonKey: `hubspot_contacts:${userId}`, singletonSeconds: 21600 },
            );
            enqueued += 1;
          }
        }
      }

      await this.enqueueJob(
        AGENT_TICK_JOB,
        { reason: 'sync_tick' },
        { singletonKey: `agent_tick`, singletonSeconds: 60 },
      );

      this.logger.log(`[${SYNC_TICK_JOB}] done job=${String(job.id)} enqueued=${enqueued}`);
    } catch (err: unknown) {
      this.logger.error(
        `[${SYNC_TICK_JOB}] FAILED job=${String(job.id)} ` +
          (err instanceof Error ? err.stack : String(err)),
      );
      throw err;
    }
  }
}

function shouldRun(lastSyncedAt: Date | undefined | null, minMinutes: number): boolean {
  if (!lastSyncedAt) return true;
  const ageMs = Date.now() - lastSyncedAt.getTime();
  return ageMs >= minMinutes * 60_000;
}

function readLastSyncedAt(state: unknown): Date | null {
  if (!isRecord(state)) return null;
  const maybe = state['lastSyncedAt'];
  if (typeof maybe !== 'string') return null;
  const ms = Date.parse(maybe);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function readGmailBackfill(state: unknown): GmailBackfill {
  if (!isRecord(state)) return { done: false, nextPageToken: null, lastRunAt: null };

  const backfill = state['backfill'];
  if (!isRecord(backfill)) return { done: false, nextPageToken: null, lastRunAt: null };

  const done = Boolean(backfill['done']);

  const nextPageTokenRaw = backfill['nextPageToken'];
  const nextPageToken = typeof nextPageTokenRaw === 'string' ? nextPageTokenRaw : null;

  const lastRunAtRaw = backfill['lastRunAt'];
  const lastRunAtStr = typeof lastRunAtRaw === 'string' ? lastRunAtRaw : null;
  const lastRunAtMs = lastRunAtStr ? Date.parse(lastRunAtStr) : NaN;

  return {
    done,
    nextPageToken,
    lastRunAt: Number.isFinite(lastRunAtMs) ? new Date(lastRunAtMs) : null,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
