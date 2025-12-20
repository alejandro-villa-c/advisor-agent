import { Injectable } from '@nestjs/common';
import { GoogleTokenService } from './google-token.service';

export type GmailMessageSummary = {
  id: string;
  threadId?: string;
  internalDateMs?: number;
  snippet?: string;
  headers: {
    subject?: string;
    from?: string;
    to?: string;
    cc?: string;
    bcc?: string;
    date?: string;
    messageId?: string;
  };
  bodyText?: string;
  bodyHtml?: string;
};

@Injectable()
export class GmailApiService {
  private readonly baseUrl = 'https://gmail.googleapis.com/gmail/v1';

  constructor(private readonly googleTokenService: GoogleTokenService) {}

  /**
   * New: paginated listing (needed so we can safely sync many emails without duplicates).
   */
  async listMessagesPage(
    userId: number,
    input?: { q?: string; maxResults?: number; pageToken?: string | null },
  ): Promise<{ ids: string[]; nextPageToken: string | undefined }> {
    const maxResults = clampInt(input?.maxResults ?? 100, 1, 500);

    const qs = new URLSearchParams({ maxResults: String(maxResults) });
    if (input?.q?.trim()) qs.set('q', input.q.trim());
    if (input?.pageToken) qs.set('pageToken', input.pageToken);

    const data = await this.gmailRequest(userId, 'GET', `/users/me/messages?${qs.toString()}`);

    const messages = readArray(data, 'messages');
    const ids: string[] = [];

    for (const m of messages) {
      const id = readString(m, 'id');
      if (id) ids.push(id);
    }

    const nextPageToken = readString(data, 'nextPageToken') ?? undefined;

    return { ids, nextPageToken };
  }

  /**
   * Backwards-compatible: first page only.
   */
  async listMessageIds(
    userId: number,
    input?: { q?: string; maxResults?: number },
  ): Promise<string[]> {
    const page = await this.listMessagesPage(userId, {
      q: input?.q,
      maxResults: input?.maxResults ?? 50,
      pageToken: null,
    });
    return page.ids;
  }

  async getMessage(userId: number, messageId: string): Promise<GmailMessageSummary> {
    const data = await this.gmailRequest(
      userId,
      'GET',
      `/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    );

    const id = readString(data, 'id') ?? messageId;
    const threadId = readString(data, 'threadId') ?? undefined;

    const internalDateStr = readString(data, 'internalDate');
    const internalDateMs = internalDateStr ? Number(internalDateStr) : undefined;

    const snippet = readString(data, 'snippet') ?? undefined;

    const payload = readRecord(data, 'payload');
    const headersArr = payload ? readArray(payload, 'headers') : [];

    const headersMap = toHeaderMap(headersArr);

    // extract bodies
    const body = payload ? extractBodies(payload) : { text: undefined, html: undefined };

    return {
      id,
      threadId,
      internalDateMs: Number.isFinite(internalDateMs ?? NaN) ? internalDateMs : undefined,
      snippet,
      headers: {
        subject: headersMap['subject'],
        from: headersMap['from'],
        to: headersMap['to'],
        cc: headersMap['cc'],
        bcc: headersMap['bcc'],
        date: headersMap['date'],
        messageId: headersMap['message-id'],
      },
      bodyText: body.text,
      bodyHtml: body.html,
    };
  }

  private async gmailRequest(
    userId: number,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const token = await this.googleTokenService.getValidAccessToken(userId);

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const json: unknown = safeJson(text);

    if (!res.ok) {
      const msg = extractGoogleError(json) ?? `${res.status} ${res.statusText}`;
      throw new Error(`Gmail API error: ${msg}`);
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

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function readRecord(obj: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(obj)) return null;
  const v = obj[key];
  return isRecord(v) ? v : null;
}

function readArray(obj: unknown, key: string): unknown[] {
  if (!isRecord(obj)) return [];
  const v = obj[key];
  return Array.isArray(v) ? v : [];
}

function readString(obj: unknown, key: string): string | null {
  if (!isRecord(obj)) return null;
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  const x = Math.trunc(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function extractGoogleError(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const err = json['error'];
  if (!isRecord(err)) return null;

  const msg = err['message'];
  if (typeof msg === 'string') return msg;

  return null;
}

function toHeaderMap(headersArr: unknown[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const h of headersArr) {
    if (!isRecord(h)) continue;
    const name = h['name'];
    const value = h['value'];
    if (typeof name === 'string' && typeof value === 'string') {
      out[name.toLowerCase()] = value;
    }
  }
  return out;
}

function extractBodies(payload: Record<string, unknown>): { text?: string; html?: string } {
  // Gmail payload: { mimeType, body: { data }, parts: [...] }
  const found: { text?: string; html?: string } = {};

  const walk = (node: Record<string, unknown>): void => {
    const mimeType = typeof node['mimeType'] === 'string' ? node['mimeType'] : '';
    const body = isRecord(node['body']) ? node['body'] : null;
    const data = body && typeof body['data'] === 'string' ? body['data'] : null;

    if (data) {
      const decoded = decodeBase64Url(data);
      if (mimeType === 'text/plain' && !found.text) found.text = decoded;
      if (mimeType === 'text/html' && !found.html) found.html = decoded;
    }

    const parts = Array.isArray(node['parts']) ? (node['parts'] as unknown[]) : [];
    for (const p of parts) {
      if (isRecord(p)) walk(p);
    }
  };

  walk(payload);

  // cap to keep docs sane
  if (found.text && found.text.length > 25_000) found.text = found.text.slice(0, 25_000);
  if (found.html && found.html.length > 25_000) found.html = found.html.slice(0, 25_000);

  return found;
}

function decodeBase64Url(b64url: string): string {
  // base64url → base64
  let s = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad === 2) s += '==';
  else if (pad === 3) s += '=';
  else if (pad !== 0) {
    // weird length; try anyway
  }

  try {
    return Buffer.from(s, 'base64').toString('utf8');
  } catch {
    return '';
  }
}
