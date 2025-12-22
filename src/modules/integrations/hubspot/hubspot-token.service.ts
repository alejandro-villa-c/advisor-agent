import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../../../db/db.service';
import { oauthAccounts } from '../../../db/schema';
import { HubspotOAuthService } from './hubspot-oauth.service';

const DEFAULT_SKEW_SECONDS = 120; // refresh a bit early

function secondsFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

@Injectable()
export class HubspotTokenService {
  constructor(
    private readonly dbService: DbService,
    private readonly hubspotOAuth: HubspotOAuthService,
  ) {}

  /**
   * Always returns a valid access token. Refreshes automatically if expired (or close to expiring).
   */
  async getValidAccessToken(userId: number): Promise<string> {
    const skewSeconds = this.getSkewSeconds();

    const rows = await this.dbService.db
      .select({
        id: oauthAccounts.id,
        accessToken: oauthAccounts.accessToken,
        refreshToken: oauthAccounts.refreshToken,
        expiresAt: oauthAccounts.expiresAt,
      })
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, 'hubspot')))
      .limit(1);

    const row = rows[0];
    if (!row) {
      throw new Error('HubSpot not connected for this user.');
    }

    // If we have a token that is still valid beyond the skew, use it.
    const expiresAt = row.expiresAt;
    if (expiresAt && expiresAt.getTime() - Date.now() > skewSeconds * 1000) {
      return row.accessToken;
    }

    // Otherwise refresh.
    if (!row.refreshToken) {
      throw new Error('HubSpot refresh token missing. Please reconnect HubSpot.');
    }

    const refreshed = await this.hubspotOAuth.refreshAccessToken(row.refreshToken);

    const newExpiresAt = secondsFromNow(refreshed.expiresIn);

    await this.dbService.db
      .update(oauthAccounts)
      .set({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? row.refreshToken, // keep old if provider didn’t rotate it
        expiresAt: newExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(oauthAccounts.id, row.id));

    return refreshed.accessToken;
  }

  private getSkewSeconds(): number {
    const raw = process.env.HUBSPOT_TOKEN_REFRESH_SKEW_SECONDS;
    if (!raw) return DEFAULT_SKEW_SECONDS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SKEW_SECONDS;
  }
}
