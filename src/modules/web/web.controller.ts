import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../../db/db.service';
import { oauthAccounts } from '../../db/schema';
import { HubspotTokenService } from '../integrations/hubspot/hubspot-token.service';
import { HubspotOAuthService } from '../integrations/hubspot/hubspot-oauth.service';

@Controller()
export class WebController {
  constructor(
    private readonly dbService: DbService,
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
  chat(@Req() req: Request, @Res() res: Response): void {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    res.render('pages/chat', {});
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

    // one-time flash + debug payload
    const flash = req.session.flash;
    req.session.flash = undefined;

    const hubspotDebug = req.session.hubspotDebug;
    req.session.hubspotDebug = undefined;

    res.render('pages/settings', {
      connections: {
        google: google.length > 0,
        hubspot: hubspot.length > 0,
      },
      flash,
      hubspotDebug,
    });
  }

  @Post('/settings/hubspot/test')
  async testHubspot(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = this.requireAuth(req, res);
    if (!userId) return;

    try {
      // This will auto-refresh if needed (your polished behavior).
      const accessToken = await this.hubspotTokenService.getValidAccessToken(userId);

      // Proof call: token metadata endpoint (no HubSpot CRM calls yet).
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
}
