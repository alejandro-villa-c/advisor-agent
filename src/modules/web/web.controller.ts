import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DbService } from '../../db/db.service';
import { integrationStates, oauthAccounts, threads } from '../../db/schema';
import { PgBossService } from '../../jobs/pgboss.service';
import { HubspotTokenService } from '../integrations/hubspot/hubspot-token.service';
import { HubspotOAuthService } from '../integrations/hubspot/hubspot-oauth.service';
import {
  HUBSPOT_SYNC_CONTACTS_JOB,
  HUBSPOT_SYNC_NOTES_JOB,
  GMAIL_SYNC_MESSAGES_JOB,
  CALENDAR_SYNC_EVENTS_JOB,
  RAG_REBUILD_EMBED_JOB,
} from '../../jobs/job.constants';

type SyncStateView = {
  lastSyncedAt?: string | null;
  updatedAt?: string | null;
  lastRun?: Record<string, unknown> | null;
};

type IntegrationStateRow = {
  integration: string;
  state: unknown;
  updatedAt: Date | null;
};

@Controller()
export class WebController {
  constructor(
    private readonly dbService: DbService,
    private readonly pgBoss: PgBossService,
    private readonly hubspotTokenService: HubspotTokenService,
    private readonly hubspotOAuthService: HubspotOAuthService,
  ) {}

  private requireAuth(req: Request, res: Response): number | null {
    const userId = req.session.userId;
    if (!userId) {
      res.redirect('/login');
      return null;
    }
    return userId;
  }

  @Get('/')
  root(@Req() req: Request, @Res() res: Response): void {
    if (req.session.userId) {
      res.redirect('/chat');
      return;
    }
    res.redirect('/login');
  }

  @Get('/login')
  login(@Req() req: Request, @Res() res: Response): void {
    if (req.session.userId) {
      res.redirect('/chat');
      return;
    }
    res.render('pages/login', {});
  }

  @Get('/chat')
  async chat(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    const db = this.dbService.db;

    const threadParam = typeof req.query.thread === 'string' ? Number(req.query.thread) : null;
    const requestedThreadId =
      threadParam && Number.isFinite(threadParam) && threadParam > 0 ? threadParam : null;

    if (requestedThreadId) {
      const found = await db
        .select({ id: threads.id, title: threads.title })
        .from(threads)
        .where(and(eq(threads.id, requestedThreadId), eq(threads.userId, userId)))
        .limit(1);

      if (found.length > 0) {
        res.render('pages/chat', { threadId: found[0].id, threadTitle: found[0].title });
        return;
      }
    }

    const latest = await db
      .select({ id: threads.id, title: threads.title })
      .from(threads)
      .where(eq(threads.userId, userId))
      .orderBy(desc(threads.updatedAt))
      .limit(1);

    if (latest.length > 0) {
      res.redirect(`/chat?thread=${latest[0].id}`);
      return;
    }

    const created = await db
      .insert(threads)
      .values({ userId, title: 'New thread' })
      .returning({ id: threads.id });

    res.redirect(`/chat?thread=${created[0].id}`);
  }

  @Get('/threads')
  threads(@Req() req: Request, @Res() res: Response): void {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    res.render('pages/threads', {});
  }

  @Get('/settings')
  async settings(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    const db = this.dbService.db;

    const google = await db
      .select({ id: oauthAccounts.id })
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, 'google')))
      .limit(1);

    const hubspot = await db
      .select({ id: oauthAccounts.id })
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, 'hubspot')))
      .limit(1);

    const stateRows = (await db
      .select({
        integration: integrationStates.integration,
        state: integrationStates.state,
        updatedAt: integrationStates.updatedAt,
      })
      .from(integrationStates)
      .where(
        and(
          eq(integrationStates.userId, userId),
          inArray(integrationStates.integration, [
            'gmail',
            'calendar',
            'hubspot_contacts',
            'hubspot_notes',
          ]),
        ),
      )) as unknown as IntegrationStateRow[];

    const map = new Map<string, { state: unknown; updatedAt: Date | null }>();
    for (const r of stateRows) {
      map.set(r.integration, { state: r.state, updatedAt: r.updatedAt });
    }

    const syncState: {
      gmail: SyncStateView;
      calendar: SyncStateView;
      hubspotContacts: SyncStateView;
      hubspotNotes: SyncStateView;
    } = {
      gmail: toSyncStateView(map.get('gmail')),
      calendar: toSyncStateView(map.get('calendar')),
      hubspotContacts: toSyncStateView(map.get('hubspot_contacts')),
      hubspotNotes: toSyncStateView(map.get('hubspot_notes')),
    };

    const flash = req.session.flash;
    req.session.flash = undefined;

    const hubspotDebug = req.session.hubspotDebug;
    req.session.hubspotDebug = undefined;

    res.render('pages/settings', {
      connections: {
        google: google.length > 0,
        hubspot: hubspot.length > 0,
      },
      syncState,
      flash,
      hubspotDebug,
    });
  }

  // ----------------------------
  // Manual sync endpoints (optional)
  // These match your settings.ejs forms.
  // ----------------------------

  @Post('/settings/sync/hubspot/contacts')
  async syncHubspotContacts(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    const ok = await this.hasConnection(userId, 'hubspot');
    if (!ok) {
      req.session.flash = { type: 'error', message: 'HubSpot not connected.' };
      res.redirect('/settings');
      return;
    }

    await this.pgBoss.client.send(HUBSPOT_SYNC_CONTACTS_JOB, { userId });
    req.session.flash = { type: 'success', message: 'Queued HubSpot contacts sync.' };
    res.redirect('/settings');
  }

  @Post('/settings/sync/hubspot/notes')
  async syncHubspotNotes(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    const ok = await this.hasConnection(userId, 'hubspot');
    if (!ok) {
      req.session.flash = { type: 'error', message: 'HubSpot not connected.' };
      res.redirect('/settings');
      return;
    }

    await this.pgBoss.client.send(HUBSPOT_SYNC_NOTES_JOB, { userId });
    req.session.flash = { type: 'success', message: 'Queued HubSpot notes sync.' };
    res.redirect('/settings');
  }

  @Post('/settings/sync/gmail')
  async syncGmail(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    const ok = await this.hasConnection(userId, 'google');
    if (!ok) {
      req.session.flash = { type: 'error', message: 'Google not connected.' };
      res.redirect('/settings');
      return;
    }

    // Conservative initial window (matches your UI confirm)
    await this.pgBoss.client.send(GMAIL_SYNC_MESSAGES_JOB, {
      userId,
      mode: 'initial',
      daysBack: 90,
      maxPages: 10,
      maxMessages: 500,
    });

    req.session.flash = { type: 'success', message: 'Queued Gmail sync (90 days, up to 500).' };
    res.redirect('/settings');
  }

  @Post('/settings/sync/calendar')
  async syncCalendar(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    const ok = await this.hasConnection(userId, 'google');
    if (!ok) {
      req.session.flash = { type: 'error', message: 'Google not connected.' };
      res.redirect('/settings');
      return;
    }

    await this.pgBoss.client.send(CALENDAR_SYNC_EVENTS_JOB, {
      userId,
      calendarId: 'primary',
      maxPages: 10,
      daysPast: 180,
      daysFuture: 365,
    });

    req.session.flash = { type: 'success', message: 'Queued Calendar sync.' };
    res.redirect('/settings');
  }

  @Post('/settings/rag/rebuild-and-embed')
  async rebuildAndEmbed(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    await this.pgBoss.client.send(RAG_REBUILD_EMBED_JOB, { userId });

    req.session.flash = { type: 'success', message: 'Queued RAG rebuild + embed.' };
    res.redirect('/settings');
  }

  // ----------------------------
  // HubSpot utilities
  // ----------------------------

  @Post('/settings/hubspot/test')
  async testHubspot(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    try {
      const accessToken = await this.hubspotTokenService.getValidAccessToken(userId);
      const meta = await this.hubspotOAuthService.getAccessTokenMeta(accessToken);

      req.session.hubspotDebug = {
        hubDomain: meta.hub_domain,
        hubUserEmail: meta.user,
        hubId: meta.hub_id,
        scopes: meta.scopes,
        expiresIn: meta.expires_in,
      };

      req.session.flash = {
        type: 'success',
        message: 'HubSpot connection OK (token valid + refresh working).',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'HubSpot test failed.';
      req.session.flash = { type: 'error', message };
    }

    res.redirect('/settings');
  }

  @Post('/settings/hubspot/disconnect')
  async disconnectHubspot(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    await this.dbService.db
      .delete(oauthAccounts)
      .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, 'hubspot')));

    req.session.flash = { type: 'success', message: 'HubSpot disconnected.' };
    res.redirect('/settings');
  }

  // ----------------------------
  // Helpers
  // ----------------------------

  private async hasConnection(userId: number, provider: 'google' | 'hubspot'): Promise<boolean> {
    const rows = await this.dbService.db
      .select({ id: oauthAccounts.id })
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)))
      .limit(1);

    return rows.length > 0;
  }
}

function toSyncStateView(
  row: { state: unknown; updatedAt: Date | null } | undefined,
): SyncStateView {
  if (!row) return {};

  const stateObj = isRecord(row.state) ? row.state : null;

  const lastSyncedAt =
    stateObj && typeof stateObj.lastSyncedAt === 'string' ? stateObj.lastSyncedAt : null;

  const lastRun = stateObj && isRecord(stateObj.lastRun) ? stateObj.lastRun : null;

  return {
    lastSyncedAt,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    lastRun,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
