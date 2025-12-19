import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { GetTokenResponse } from 'google-auth-library/build/src/auth/oauth2client';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private getOAuthClient(): OAuth2Client {
    const baseUrl = process.env.APP_BASE_URL;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!baseUrl) throw new Error('APP_BASE_URL is not set');
    if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not set');
    if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET is not set');

    const redirectUri = `${baseUrl}/auth/google/callback`;

    // google.auth.OAuth2 is a constructor that returns an OAuth2Client
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  @Get('google')
  googleStart(@Req() req: Request, @Res() res: Response): void {
    const oauth2Client: OAuth2Client = this.getOAuthClient();

    const state = randomBytes(16).toString('hex');
    req.session.oauthState = state;

    const scopes: string[] = [
      // Identity
      'openid',
      'email',
      'profile',

      // Gmail read + send
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',

      // Calendar read/write
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

    if (!state || state !== req.session.oauthState) {
      res.status(400).send('Invalid state');
      return;
    }

    req.session.oauthState = undefined;

    const tokenResponse: GetTokenResponse = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokenResponse.tokens);

    const accessToken = tokenResponse.tokens.access_token ?? null;
    if (!accessToken) {
      res.status(400).send('Missing access_token');
      return;
    }

    // Fetch profile
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const meResponse = await oauth2.userinfo.get();

    const email = meResponse.data.email ?? null;
    const name = meResponse.data.name ?? null;
    const avatarUrl = meResponse.data.picture ?? null;

    // Stable Google ID is `id` in this endpoint
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

    res.redirect('/chat');
  }

  @Get('logout')
  logout(@Req() req: Request, @Res() res: Response): void {
    req.session.destroy(() => {
      res.redirect('/login');
    });
  }
}
