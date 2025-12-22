import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../../../db/db.service';
import { oauthAccounts } from '../../../db/schema';

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

@Injectable()
export class GoogleTokenService {
  constructor(private readonly dbService: DbService) {}

  /**
   * Returns the scopes we have stored for this user's connected Google account.
   * NOTE: Google refresh responses often omit "scope", so persisted scope from initial OAuth grant matters.
   */
  async getGrantedScopes(userId: number): Promise<Set<string>> {
    const account = await this.getGoogleAccountRow(userId);
    return parseGoogleScopes(account.scope);
  }

  /**
   * Fail fast if the account is connected but does not include required scopes.
   * This prevents confusing 403 errors later when calling Gmail/Calendar write APIs.
   */
  async assertHasScopes(userId: number, requiredScopes: string[]): Promise<void> {
    const required = Array.from(new Set((requiredScopes ?? []).map((s) => String(s ?? '').trim())))
      .filter(Boolean)
      .sort();

    if (required.length === 0) return;

    const granted = await this.getGrantedScopes(userId);

    const missing = required.filter((s) => !granted.has(s));
    if (missing.length > 0) {
      throw new Error(
        `Google account is connected but missing required scopes: ${missing.join(
          ', ',
        )}. Reconnect Google OAuth and approve these permissions.`,
      );
    }
  }

  async getValidAccessToken(userId: number): Promise<string> {
    const db = this.dbService.db;
    const account = await this.getGoogleAccountRow(userId);

    // If token is valid for at least 60s, use it.
    if (account.expiresAt) {
      const msLeft = account.expiresAt.getTime() - Date.now();
      if (msLeft > 60_000 && account.accessToken) return account.accessToken;
    } else {
      // If we have no expiresAt, it's safer to refresh (if possible) than to assume validity forever.
      if (account.accessToken && !account.refreshToken) return account.accessToken;
    }

    if (!account.refreshToken) {
      throw new Error(
        'Google refresh token missing. Reconnect Google (OAuth) to obtain offline access.',
      );
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not set');
    if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET is not set');

    const refreshed = await this.refreshAccessToken({
      clientId,
      clientSecret,
      refreshToken: account.refreshToken,
    });

    const accessToken = refreshed.access_token;
    if (!accessToken) {
      const msg = refreshed.error_description || refreshed.error || 'unknown error';
      throw new Error(`Google token refresh failed: ${msg}`);
    }

    const expiresInSec = typeof refreshed.expires_in === 'number' ? refreshed.expires_in : 3600;
    const expiresAt = new Date(Date.now() + expiresInSec * 1000);

    await db
      .update(oauthAccounts)
      .set({
        accessToken,
        expiresAt,
        tokenType: refreshed.token_type ?? account.tokenType ?? null,
        scope: refreshed.scope ?? account.scope ?? null,
        updatedAt: new Date(),
      })
      .where(eq(oauthAccounts.id, account.id));

    return accessToken;
  }

  private async getGoogleAccountRow(userId: number): Promise<{
    id: number;
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: Date | null;
    scope: string | null;
    tokenType: string | null;
  }> {
    const db = this.dbService.db;

    const rows = await db
      .select({
        id: oauthAccounts.id,
        accessToken: oauthAccounts.accessToken,
        refreshToken: oauthAccounts.refreshToken,
        expiresAt: oauthAccounts.expiresAt,
        scope: oauthAccounts.scope,
        tokenType: oauthAccounts.tokenType,
      })
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, 'google')))
      .limit(1);

    const account = rows[0];
    if (!account) throw new Error('Google account not connected.');

    return account;
  }

  private async refreshAccessToken(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<GoogleTokenResponse> {
    const body = new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: 'refresh_token',
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const text = await res.text();
    const json = safeJson(text) as GoogleTokenResponse;

    if (!res.ok) {
      const msg = json.error_description || json.error || `${res.status} ${res.statusText}`;
      throw new Error(`Google token refresh HTTP error: ${msg}`);
    }

    return json;
  }
}

function safeJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function parseGoogleScopes(scope: string | null): Set<string> {
  const s = String(scope ?? '').trim();
  if (!s) return new Set();
  // Google typically space-delimits scopes
  const parts = s
    .split(/\s+/g)
    .map((x) => x.trim())
    .filter(Boolean);
  return new Set(parts);
}
