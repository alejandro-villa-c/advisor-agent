import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { HubspotOAuthService } from './hubspot-oauth.service';
import { DbService } from '../../../db/db.service';
import { oauthAccounts } from '../../../db/schema';

@Controller('auth/hubspot')
export class HubspotAuthController {
  constructor(
    private readonly hubspotOAuth: HubspotOAuthService,
    private readonly dbService: DbService,
  ) {}

  @Get()
  start(@Req() req: Request, @Res() res: Response): void {
    if (!req.session.userId) {
      res.redirect('/login');
      return;
    }

    const state = randomBytes(16).toString('hex');
    req.session.hubspotOauthState = state;

    const url = this.hubspotOAuth.buildAuthorizeUrl(state);
    res.redirect(url);
  }

  @Get('callback')
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
  ): Promise<void> {
    const userId = req.session.userId;
    if (!userId) {
      res.redirect('/login');
      return;
    }

    if (!code) {
      res.status(400).send('Missing code.');
      return;
    }

    const expectedState = req.session.hubspotOauthState;
    req.session.hubspotOauthState = undefined;

    if (!expectedState || !state || state !== expectedState) {
      res.status(400).send('Invalid state.');
      return;
    }

    const tokens = await this.hubspotOAuth.exchangeCodeForTokens(code);
    const meta = await this.hubspotOAuth.getAccessTokenMeta(tokens.accessToken);

    const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

    // store useful info for later (debug + future API calls)
    const metaForDb = {
      hubId: meta.hub_id,
      hubDomain: meta.hub_domain,
      hubUserEmail: meta.user,
      hubUserId: meta.user_id,
      scopes: meta.scopes,
    };

    const existing = await this.dbService.db
      .select({ id: oauthAccounts.id })
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, 'hubspot')))
      .limit(1);

    if (existing.length > 0) {
      await this.dbService.db
        .update(oauthAccounts)
        .set({
          providerAccountId: String(meta.hub_id),
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          scope: meta.scopes.join(' '),
          expiresAt,
          meta: metaForDb,
          updatedAt: new Date(),
        })
        .where(eq(oauthAccounts.id, existing[0].id));
    } else {
      await this.dbService.db.insert(oauthAccounts).values({
        userId,
        provider: 'hubspot',
        providerAccountId: String(meta.hub_id),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        scope: meta.scopes.join(' '),
        expiresAt,
        meta: metaForDb,
      });
    }

    res.redirect('/settings');
  }
}
