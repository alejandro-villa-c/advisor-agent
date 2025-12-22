import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { GetTokenResponse } from 'google-auth-library/build/src/auth/oauth2client';
import { AuthService } from './auth.service';
import { PgBossService } from '../../jobs/pgboss.service';
import { CALENDAR_SYNC_EVENTS_JOB, GMAIL_SYNC_MESSAGES_JOB } from '../../jobs/job.constants';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly pgBoss: PgBossService,
  ) {}

  /**
   * Get current user info from session
   * Used by WebSocket clients to get userId for registration
   */
  @Get('me')
  me(@Req() req: Request): { userId: number | null } {
    const userId = req.session?.userId ?? null;
    return { userId };
  }

  private getOAuthClient(): OAuth2Client {
    const baseUrl = process.env.APP_BASE_URL;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!baseUrl) throw new Error('APP_BASE_URL is not set');
    if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not set');
    if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET is not set');

    const redirectUri = `${baseUrl}/auth/google/callback`;
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  @Get('google')
  googleStart(@Req() req: Request, @Res() res: Response): void {
    const oauth2Client: OAuth2Client = this.getOAuthClient();

    const state = randomBytes(16).toString('hex');
    req.session.googleOauthState = state;

    const scopes: string[] = [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar',
    ];

    const url: string = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes,
      state,
    });

    res.redirect(url);
  }

  @Get('google/callback')
  async googleCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const oauth2Client: OAuth2Client = this.getOAuthClient();

    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const state = typeof req.query.state === 'string' ? req.query.state : null;

    if (!code) {
      res.status(400).send('Missing code');
      return;
    }

    if (!state || state !== req.session.googleOauthState) {
      res.status(400).send('Invalid state');
      return;
    }

    req.session.googleOauthState = undefined;

    const tokenResponse: GetTokenResponse = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokenResponse.tokens);

    const accessToken = tokenResponse.tokens.access_token ?? null;
    if (!accessToken) {
      res.status(400).send('Missing access_token');
      return;
    }

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const meResponse = await oauth2.userinfo.get();

    const email = meResponse.data.email ?? null;
    const name = meResponse.data.name ?? null;
    const avatarUrl = meResponse.data.picture ?? null;
    const providerAccountId = meResponse.data.id ?? null;

    if (!email || !providerAccountId) {
      res.status(400).send('Could not read user identity from Google');
      return;
    }

    const expiresAt =
      typeof tokenResponse.tokens.expiry_date === 'number'
        ? new Date(tokenResponse.tokens.expiry_date)
        : null;

    const { userId } = await this.authService.upsertGoogleUser({
      email,
      name,
      avatarUrl,
      providerAccountId,
      accessToken,
      refreshToken: tokenResponse.tokens.refresh_token ?? null,
      scope: tokenResponse.tokens.scope ?? null,
      tokenType: tokenResponse.tokens.token_type ?? null,
      expiresAt,
    });

    req.session.userId = userId;

    // Bootstrap sync (professional default): index last 90 days of Gmail + ±6 months calendar.
    // These are idempotent (upserts), and the workers will only embed changed docs (after the updates below).
    await this.pgBoss.client.send(GMAIL_SYNC_MESSAGES_JOB, {
      userId,
      mode: 'initial',
      daysBack: 90,
      maxMessages: 500,
      maxPages: 10,
    });

    await this.pgBoss.client.send(CALENDAR_SYNC_EVENTS_JOB, {
      userId,
      calendarId: 'primary',
      maxPages: 10,
      daysPast: 180,
      daysFuture: 180,
    });

    res.redirect('/chat');
  }

  @Get('logout')
  logout(@Req() req: Request, @Res() res: Response): void {
    req.session.destroy(() => {
      res.redirect('/login');
    });
  }
}
