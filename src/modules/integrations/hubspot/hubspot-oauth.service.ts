import { Injectable } from '@nestjs/common';

type HubspotTokenResponseSnake = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
};

type HubspotTokenResponseCamel = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType?: string;
};

export type HubspotTokenResponse = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number; // seconds
  tokenType?: string;
};

type HubspotAccessTokenMeta = {
  token: string;
  user: string; // email
  hub_domain: string;
  scopes: string[];
  hub_id: number;
  app_id: number;
  expires_in: number;
  user_id: number;
  token_type: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseHubspotTokenResponse(value: unknown): HubspotTokenResponse {
  if (!isRecord(value)) throw new Error('HubSpot token response is not an object.');

  // Support both snake_case and camelCase variants (HubSpot docs show both in different places).
  if (typeof value.access_token === 'string' && typeof value.expires_in === 'number') {
    const v = value as HubspotTokenResponseSnake;
    return {
      accessToken: v.access_token,
      refreshToken: v.refresh_token,
      expiresIn: v.expires_in,
      tokenType: v.token_type,
    };
  }

  if (typeof value.accessToken === 'string' && typeof value.expiresIn === 'number') {
    const v = value as HubspotTokenResponseCamel;
    return {
      accessToken: v.accessToken,
      refreshToken: v.refreshToken,
      expiresIn: v.expiresIn,
      tokenType: v.tokenType,
    };
  }

  throw new Error('HubSpot token response missing required fields.');
}

function assertHubspotAccessTokenMeta(value: unknown): asserts value is HubspotAccessTokenMeta {
  if (!isRecord(value)) throw new Error('HubSpot access token meta is not an object.');

  const requiredString = ['token', 'user', 'hub_domain', 'token_type'] as const;
  for (const k of requiredString) {
    if (typeof value[k] !== 'string') throw new Error(`HubSpot token meta missing ${k}.`);
  }

  const requiredNumber = ['hub_id', 'app_id', 'expires_in', 'user_id'] as const;
  for (const k of requiredNumber) {
    if (typeof value[k] !== 'number') throw new Error(`HubSpot token meta missing ${k}.`);
  }

  if (!Array.isArray(value.scopes) || value.scopes.some((s) => typeof s !== 'string')) {
    throw new Error('HubSpot token meta missing scopes array.');
  }
}

@Injectable()
export class HubspotOAuthService {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly scopes: string;

  constructor() {
    const clientId = process.env.HUBSPOT_CLIENT_ID;
    const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
    const redirectUri = process.env.HUBSPOT_REDIRECT_URI;
    const scopes = process.env.HUBSPOT_SCOPES;

    if (!clientId) throw new Error('HUBSPOT_CLIENT_ID is not set.');
    if (!clientSecret) throw new Error('HUBSPOT_CLIENT_SECRET is not set.');
    if (!redirectUri) throw new Error('HUBSPOT_REDIRECT_URI is not set.');
    if (!scopes) throw new Error('HUBSPOT_SCOPES is not set.');

    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.scopes = scopes;
  }

  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: this.scopes,
      state,
    });

    return `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string): Promise<HubspotTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      code,
    });

    return this.postToken(body);
  }

  // Refresh flow: POST /oauth/v1/token with grant_type=refresh_token and refresh_token. :contentReference[oaicite:1]{index=1}
  async refreshAccessToken(refreshToken: string): Promise<HubspotTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      refresh_token: refreshToken,
    });

    return this.postToken(body);
  }

  async getAccessTokenMeta(accessToken: string): Promise<HubspotAccessTokenMeta> {
    const res = await fetch(
      `https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`,
      { method: 'GET' },
    );

    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`HubSpot token meta returned non-JSON: ${text}`);
    }

    if (!res.ok) {
      throw new Error(`HubSpot token meta failed (${res.status}): ${text}`);
    }

    assertHubspotAccessTokenMeta(json);
    return json;
  }

  private async postToken(body: URLSearchParams): Promise<HubspotTokenResponse> {
    const res = await fetch('https://api.hubapi.com/oauth/v1/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`HubSpot token endpoint returned non-JSON: ${text}`);
    }

    if (!res.ok) {
      throw new Error(`HubSpot token endpoint failed (${res.status}): ${text}`);
    }

    return parseHubspotTokenResponse(json);
  }
}
