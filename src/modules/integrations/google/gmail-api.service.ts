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
    references?: string;
    inReplyTo?: string;
  };
  bodyText?: string;
  bodyHtml?: string;
};

export type GmailSendEmailInput = {
  to: string;
  subject: string;
  bodyText: string;

  cc?: string;
  bcc?: string;

  threadId?: string;
  inReplyToMessageId?: string;
  references?: string;

  replyTo?: string;
};

export type GmailSendEmailResult = {
  id: string;
  threadId?: string;
};

@Injectable()
export class GmailApiService {
  private readonly baseUrl = 'https://gmail.googleapis.com/gmail/v1';

  constructor(private readonly googleTokenService: GoogleTokenService) {}

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

    return await this.parseGmailMessageFull(userId, data, messageId);
  }

  /**
   * Fetch full thread and return parsed message summaries.
   */
  async getThreadMessages(userId: number, threadId: string): Promise<GmailMessageSummary[]> {
    const tid = (threadId ?? '').trim();
    if (!tid) return [];

    const data = await this.gmailRequest(
      userId,
      'GET',
      `/users/me/threads/${encodeURIComponent(tid)}?format=full`,
    );

    const msgs = readArray(data, 'messages');
    const out: GmailMessageSummary[] = [];

    for (const m of msgs) {
      if (!isRecord(m)) continue;
      const messageId = readString(m, 'id') ?? '';
      if (!messageId) continue;

      const parsed = await this.parseGmailMessageFull(userId, m, messageId);
      out.push(parsed);
    }

    out.sort((a, b) => (a.internalDateMs ?? 0) - (b.internalDateMs ?? 0));
    return out;
  }

  async sendEmail(userId: number, input: GmailSendEmailInput): Promise<GmailSendEmailResult> {
    const to = (input.to ?? '').trim();
    const subject = (input.subject ?? '').trim();
    const bodyText = (input.bodyText ?? '').trim();

    if (!to) throw new Error('Gmail: sendEmail missing "to"');
    if (!subject) throw new Error('Gmail: sendEmail missing "subject"');
    if (!bodyText) throw new Error('Gmail: sendEmail missing "bodyText"');

    const threadId = input.threadId?.trim() ? input.threadId.trim() : undefined;

    // if replying to a thread, auto-set In-Reply-To and References when missing
    let inReplyToMessageId = input.inReplyToMessageId?.trim()
      ? input.inReplyToMessageId.trim()
      : undefined;

    let references = input.references?.trim() ? input.references.trim() : undefined;

    if (threadId && !inReplyToMessageId) {
      const hdrs = await this.getThreadReplyHeaders(userId, threadId);
      if (!inReplyToMessageId && hdrs.inReplyToMessageId)
        inReplyToMessageId = hdrs.inReplyToMessageId;
      if (!references && hdrs.references) references = hdrs.references;
    }

    const rawMime = buildRawMimeEmail({
      to,
      cc: input.cc,
      bcc: input.bcc,
      subject,
      bodyText,
      replyTo: input.replyTo,
      inReplyToMessageId,
      references,
    });

    const raw = encodeBase64Url(rawMime);

    const body: Record<string, unknown> = { raw };
    if (threadId) body.threadId = threadId;

    const data = await this.gmailRequest(userId, 'POST', `/users/me/messages/send`, body);

    const id = readString(data, 'id') ?? '';
    const returnedThreadId = readString(data, 'threadId') ?? undefined;

    if (!id) throw new Error('Gmail: sendEmail succeeded but returned no id');

    return { id, threadId: returnedThreadId };
  }

  /**
   * derive reply headers for Gmail threading.
   */
  private async getThreadReplyHeaders(
    userId: number,
    threadId: string,
  ): Promise<{ inReplyToMessageId?: string; references?: string }> {
    const msgs = await this.getThreadMessages(userId, threadId);
    if (msgs.length === 0) return {};

    // newest message
    const newest = msgs[msgs.length - 1];
    const newestMsgId = normalizeMessageId(newest.headers.messageId);

    const messageIds = msgs
      .map((m) => normalizeMessageId(m.headers.messageId))
      .filter((x): x is string => Boolean(x));

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const mid of messageIds) {
      const key = mid.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(mid);
    }

    // Prefer thread-derived chain; it’s deterministic and avoids relying on References being present.
    const refs = deduped.length > 0 ? deduped.join(' ') : undefined;

    return {
      inReplyToMessageId: newestMsgId ?? undefined,
      references: refs,
    };
  }

  private async parseGmailMessageFull(
    userId: number,
    data: unknown,
    fallbackMessageId: string,
  ): Promise<GmailMessageSummary> {
    const id = readString(data, 'id') ?? fallbackMessageId;
    const threadId = readString(data, 'threadId') ?? undefined;

    const internalDateStr = readString(data, 'internalDate');
    const internalDateMs = internalDateStr ? Number(internalDateStr) : undefined;

    const snippet = readString(data, 'snippet') ?? undefined;

    const payload = readRecord(data, 'payload');
    const headersArr = payload ? readArray(payload, 'headers') : [];
    const headersMap = toHeaderMap(headersArr);

    const bodyInfo = payload ? extractBodiesAndAttachmentIds(payload) : null;

    let bodyText = bodyInfo?.text;
    let bodyHtml = bodyInfo?.html;

    if ((!bodyText || !bodyText.trim()) && bodyInfo?.textAttachmentId) {
      const fetched = await this.getAttachmentData(userId, id, bodyInfo.textAttachmentId);
      if (fetched) bodyText = fetched;
    }

    if ((!bodyHtml || !bodyHtml.trim()) && bodyInfo?.htmlAttachmentId) {
      const fetched = await this.getAttachmentData(userId, id, bodyInfo.htmlAttachmentId);
      if (fetched) bodyHtml = fetched;
    }

    if (bodyText && bodyText.length > 25_000) bodyText = bodyText.slice(0, 25_000);
    if (bodyHtml && bodyHtml.length > 25_000) bodyHtml = bodyHtml.slice(0, 25_000);

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
        references: headersMap['references'],
        inReplyTo: headersMap['in-reply-to'],
      },
      bodyText: bodyText ?? undefined,
      bodyHtml: bodyHtml ?? undefined,
    };
  }

  private async getAttachmentData(
    userId: number,
    messageId: string,
    attachmentId: string,
  ): Promise<string | null> {
    const data = await this.gmailRequest(
      userId,
      'GET',
      `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );

    const b64url = readString(data, 'data');
    if (!b64url) return null;
    const decoded = decodeBase64Url(b64url);
    return decoded || null;
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

function normalizeMessageId(v?: string): string | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  // Ensure it has angle brackets; Gmail usually returns them, but be safe.
  if (s.startsWith('<') && s.endsWith('>')) return s;
  return `<${s.replace(/^<+/, '').replace(/>+$/, '')}>`;
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

function extractBodiesAndAttachmentIds(payload: Record<string, unknown>): {
  text?: string;
  html?: string;
  textAttachmentId?: string;
  htmlAttachmentId?: string;
} {
  const found: {
    text?: string;
    html?: string;
    textAttachmentId?: string;
    htmlAttachmentId?: string;
  } = {};

  const walk = (node: Record<string, unknown>): void => {
    const mimeType = typeof node['mimeType'] === 'string' ? node['mimeType'] : '';
    const body = isRecord(node['body']) ? node['body'] : null;
    const data = body && typeof body['data'] === 'string' ? body['data'] : null;
    const attachmentId =
      body && typeof body['attachmentId'] === 'string' ? body['attachmentId'] : null;

    if (data) {
      const decoded = decodeBase64Url(data);
      if (mimeType === 'text/plain' && !found.text) found.text = decoded;
      if (mimeType === 'text/html' && !found.html) found.html = decoded;
    } else if (attachmentId) {
      if (mimeType === 'text/plain' && !found.textAttachmentId)
        found.textAttachmentId = attachmentId;
      if (mimeType === 'text/html' && !found.htmlAttachmentId)
        found.htmlAttachmentId = attachmentId;
    }

    const parts = Array.isArray(node['parts']) ? (node['parts'] as unknown[]) : [];
    for (const p of parts) {
      if (isRecord(p)) walk(p);
    }
  };

  walk(payload);
  return found;
}

function decodeBase64Url(b64url: string): string {
  let s = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad === 2) s += '==';
  else if (pad === 3) s += '=';
  else if (pad !== 0) {
    // try anyway
  }

  try {
    return Buffer.from(s, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function encodeBase64Url(raw: string): string {
  const b64 = Buffer.from(raw, 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function sanitizeHeaderValue(v: string): string {
  return String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function needsRfc2047Encoding(v: string): boolean {
  for (let i = 0; i < v.length; i += 1) {
    if (v.charCodeAt(i) > 127) return true;
  }
  return false;
}

function encodeRfc2047IfNeeded(value: string): string {
  const v = sanitizeHeaderValue(value);
  if (!v) return v;
  if (!needsRfc2047Encoding(v)) return v;
  const b64 = Buffer.from(v, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

function buildRawMimeEmail(input: {
  to: string;
  subject: string;
  bodyText: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  inReplyToMessageId?: string;
  references?: string;
}): string {
  const lines: string[] = [];

  lines.push(`To: ${sanitizeHeaderValue(input.to)}`);
  if (input.cc?.trim()) lines.push(`Cc: ${sanitizeHeaderValue(input.cc.trim())}`);
  if (input.bcc?.trim()) lines.push(`Bcc: ${sanitizeHeaderValue(input.bcc.trim())}`);

  lines.push(`Subject: ${encodeRfc2047IfNeeded(input.subject)}`);

  if (input.replyTo?.trim()) lines.push(`Reply-To: ${sanitizeHeaderValue(input.replyTo.trim())}`);

  if (input.inReplyToMessageId?.trim()) {
    lines.push(`In-Reply-To: ${sanitizeHeaderValue(input.inReplyToMessageId.trim())}`);
  }

  if (input.references?.trim()) {
    lines.push(`References: ${sanitizeHeaderValue(input.references.trim())}`);
  }

  lines.push(`Date: ${new Date().toUTCString()}`);

  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: 8bit');

  lines.push('');
  lines.push(input.bodyText.replace(/\r?\n/g, '\r\n'));

  return lines.join('\r\n');
}
