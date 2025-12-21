import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '../../db/db.service';
import {
  calendarEvents,
  documentChunks,
  documents,
  gmailMessages,
  hubspotContacts,
  hubspotNotes,
  integrationStates,
  oauthAccounts,
  threads,
} from '../../db/schema';
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
  backfill?: { done?: boolean; lastRunAt?: string | null } | null;
};

type Flash = { type: 'success' | 'error'; message: string };

type HubspotDebugView = {
  hubDomain: string;
  hubId: string;
  hubUserEmail: string;
  expiresIn: number | string;
  scopes: string[];
};

type PgBossSend = (
  name: string,
  data?: unknown,
  options?: Record<string, unknown>,
) => Promise<unknown>;

@Controller()
export class WebController {
  constructor(
    private readonly dbService: DbService,
    private readonly pgBoss: PgBossService,
    private readonly hubspotTokenService: HubspotTokenService,
    private readonly hubspotOAuthService: HubspotOAuthService,
  ) {}

  private async enqueueJob(
    name: string,
    data: unknown,
    options?: Record<string, unknown>,
  ): Promise<void> {
    const send = getPgBossSend(this.pgBoss.client as unknown);
    await send(name, data, options);
  }

  private requireAuth(req: Request, res: Response): number | null {
    const userId = readSessionUserId(req);
    if (!userId) {
      res.redirect('/login');
      return null;
    }
    return userId;
  }

  private popFlash(req: Request): Flash | null {
    const session = getSessionRecord(req);
    if (!session) return null;

    const flash = parseFlash(session['flash']);
    if (flash) delete session['flash'];

    return flash;
  }

  private setFlash(req: Request, flash: Flash): void {
    const session = getSessionRecord(req);
    if (!session) return;
    session['flash'] = flash;
  }

  @Get('/')
  root(@Req() req: Request, @Res() res: Response): void {
    if (readSessionUserId(req)) {
      res.redirect('/chat');
      return;
    }
    res.redirect('/login');
  }

  @Get('/login')
  login(@Req() req: Request, @Res() res: Response): void {
    if (readSessionUserId(req)) {
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

    const flash = this.popFlash(req);

    const accounts = await db
      .select({
        provider: oauthAccounts.provider,
        scope: oauthAccounts.scope,
        meta: oauthAccounts.meta,
        expiresAt: oauthAccounts.expiresAt,
      })
      .from(oauthAccounts)
      .where(eq(oauthAccounts.userId, userId));

    const connections = {
      google: accounts.some((a) => a.provider === 'google'),
      hubspot: accounts.some((a) => a.provider === 'hubspot'),
    };

    const stateRows = await db
      .select({
        integration: integrationStates.integration,
        state: integrationStates.state,
        updatedAt: integrationStates.updatedAt,
      })
      .from(integrationStates)
      .where(eq(integrationStates.userId, userId));

    const syncState: {
      gmail?: SyncStateView;
      calendar?: SyncStateView;
      hubspotContacts?: SyncStateView;
      hubspotNotes?: SyncStateView;
    } = {};

    for (const r of stateRows) {
      const integration = String(r.integration);

      const stateUnknown: unknown = r.state;
      const state = isRecord(stateUnknown) ? stateUnknown : {};

      const lastSyncedAt = typeof state['lastSyncedAt'] === 'string' ? state['lastSyncedAt'] : null;

      const lastRunUnknown = state['lastRun'];
      const lastRun = isRecord(lastRunUnknown) ? lastRunUnknown : null;

      const backfillUnknown = state['backfill'];
      const backfill = isRecord(backfillUnknown)
        ? {
            done:
              typeof backfillUnknown['done'] === 'boolean' ? backfillUnknown['done'] : undefined,
            lastRunAt:
              typeof backfillUnknown['lastRunAt'] === 'string'
                ? backfillUnknown['lastRunAt']
                : null,
          }
        : null;

      const view: SyncStateView = {
        lastSyncedAt,
        updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
        lastRun,
        backfill,
      };

      if (integration === 'gmail') syncState.gmail = view;
      if (integration === 'calendar') syncState.calendar = view;
      if (integration === 'hubspot_contacts') syncState.hubspotContacts = view;
      if (integration === 'hubspot_notes') syncState.hubspotNotes = view;
    }

    const counts = await this.loadIngestedCounts(userId);

    let hubspotDebug: HubspotDebugView | null = null;
    const hubspotRow = accounts.find((a) => a.provider === 'hubspot');
    if (hubspotRow) {
      const scopes = String(hubspotRow.scope ?? '')
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);

      const expiresIn = hubspotRow.expiresAt
        ? Math.max(0, Math.floor((hubspotRow.expiresAt.getTime() - Date.now()) / 1000))
        : null;

      const metaUnknown: unknown = hubspotRow.meta;
      const meta = isRecord(metaUnknown) ? metaUnknown : {};

      const hubDomain = typeof meta['hubDomain'] === 'string' ? meta['hubDomain'] : '—';
      const hubId =
        typeof meta['hubId'] === 'string'
          ? meta['hubId']
          : typeof meta['portalId'] === 'string'
            ? meta['portalId']
            : '—';

      const hubUserEmail =
        typeof meta['hubUserEmail'] === 'string'
          ? meta['hubUserEmail']
          : typeof meta['accountEmail'] === 'string'
            ? meta['accountEmail']
            : '—';

      hubspotDebug = {
        hubDomain,
        hubId,
        hubUserEmail,
        expiresIn: expiresIn ?? '—',
        scopes,
      };
    }

    res.render('pages/settings', {
      flash,
      connections,
      syncState,
      hubspotDebug,
      counts,
    });
  }

  @Post('/settings/hubspot/test')
  async hubspotTest(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    try {
      await this.hubspotTokenService.getValidAccessToken(userId);
      this.setFlash(req, { type: 'success', message: 'HubSpot token looks valid.' });
    } catch (err: unknown) {
      this.setFlash(req, {
        type: 'error',
        message: `HubSpot test failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    res.redirect('/settings');
  }

  @Post('/settings/hubspot/disconnect')
  async hubspotDisconnect(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    try {
      // await this.hubspotOAuthService.disconnect(userId);

      await this.dbService.db
        .delete(oauthAccounts)
        .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, 'hubspot')));

      this.setFlash(req, { type: 'success', message: 'HubSpot disconnected.' });
    } catch (err: unknown) {
      this.setFlash(req, {
        type: 'error',
        message: `Failed to disconnect HubSpot: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    res.redirect('/settings');
  }

  @Post('/settings/sync/hubspot/contacts')
  async syncHubspotContacts(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    await this.enqueueJob(
      HUBSPOT_SYNC_CONTACTS_JOB,
      { userId },
      { singletonKey: `hubspot_contacts_manual:${userId}`, singletonSeconds: 60 },
    );

    this.setFlash(req, { type: 'success', message: 'Queued HubSpot contacts sync.' });
    res.redirect('/settings');
  }

  @Post('/settings/sync/hubspot/notes')
  async syncHubspotNotes(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    await this.enqueueJob(
      HUBSPOT_SYNC_NOTES_JOB,
      { userId },
      { singletonKey: `hubspot_notes_manual:${userId}`, singletonSeconds: 60 },
    );

    this.setFlash(req, { type: 'success', message: 'Queued HubSpot notes sync.' });
    res.redirect('/settings');
  }

  @Post('/settings/sync/gmail')
  async syncGmail(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    await this.enqueueJob(
      GMAIL_SYNC_MESSAGES_JOB,
      {
        userId,
        mode: 'backfill',
        maxPages: 25,
        maxMessages: 4000,
        pageToken: null,
      },
      { singletonKey: `gmail_backfill_manual:${userId}`, singletonSeconds: 60 },
    );

    this.setFlash(req, { type: 'success', message: 'Queued Gmail backfill sync.' });
    res.redirect('/settings');
  }

  @Post('/settings/sync/calendar')
  async syncCalendar(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    await this.enqueueJob(
      CALENDAR_SYNC_EVENTS_JOB,
      {
        userId,
        calendarId: 'primary',
        maxPages: 20,
        daysPast: 365,
        daysFuture: 365,
      },
      { singletonKey: `calendar_manual:${userId}`, singletonSeconds: 60 },
    );

    this.setFlash(req, { type: 'success', message: 'Queued Calendar sync.' });
    res.redirect('/settings');
  }

  @Post('/settings/rag/rebuild-and-embed')
  async ragRebuildAndEmbed(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    await this.enqueueJob(
      RAG_REBUILD_EMBED_JOB,
      { userId },
      { singletonKey: `rag_rebuild_embed:${userId}`, singletonSeconds: 60 },
    );

    this.setFlash(req, { type: 'success', message: 'Queued RAG rebuild + embed.' });
    res.redirect('/settings');
  }

  private async loadIngestedCounts(userId: number): Promise<{
    gmailMessages: number;
    calendarEvents: number;
    hubspotContacts: number;
    hubspotNotes: number;
    documents: number;
    documentChunks: number;
  }> {
    const db = this.dbService.db;

    const gmail = await db
      .select({ c: sql<number>`count(*)` })
      .from(gmailMessages)
      .where(eq(gmailMessages.userId, userId));

    const cal = await db
      .select({ c: sql<number>`count(*)` })
      .from(calendarEvents)
      .where(eq(calendarEvents.userId, userId));

    const contacts = await db
      .select({ c: sql<number>`count(*)` })
      .from(hubspotContacts)
      .where(eq(hubspotContacts.userId, userId));

    const notes = await db
      .select({ c: sql<number>`count(*)` })
      .from(hubspotNotes)
      .where(eq(hubspotNotes.userId, userId));

    const docs = await db
      .select({ c: sql<number>`count(*)` })
      .from(documents)
      .where(eq(documents.userId, userId));

    const chunks = await db
      .select({ c: sql<number>`count(*)` })
      .from(documentChunks)
      .where(eq(documentChunks.userId, userId));

    return {
      gmailMessages: Number(gmail[0]?.c ?? 0),
      calendarEvents: Number(cal[0]?.c ?? 0),
      hubspotContacts: Number(contacts[0]?.c ?? 0),
      hubspotNotes: Number(notes[0]?.c ?? 0),
      documents: Number(docs[0]?.c ?? 0),
      documentChunks: Number(chunks[0]?.c ?? 0),
    };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function getSessionRecord(req: Request): Record<string, unknown> | null {
  const sessionUnknown: unknown = (req as unknown as { session?: unknown }).session;
  return isRecord(sessionUnknown) ? sessionUnknown : null;
}

function readSessionUserId(req: Request): number | null {
  const session = getSessionRecord(req);
  if (!session) return null;

  const raw = session['userId'];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;

  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseFlash(v: unknown): Flash | null {
  if (!isRecord(v)) return null;
  const type = v['type'];
  const message = v['message'];

  if (type !== 'success' && type !== 'error') return null;
  if (typeof message !== 'string') return null;

  return { type, message };
}

function getPgBossSend(client: unknown): PgBossSend {
  if (!isRecord(client)) throw new Error('PgBoss client is not an object');
  const send = client['send'];
  if (typeof send !== 'function') throw new Error('PgBoss client.send is not a function');
  return send as PgBossSend;
}
