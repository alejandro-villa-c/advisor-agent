import { Injectable } from '@nestjs/common';
import { GoogleTokenService } from './google-token.service';

export type CalendarEventSummary = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  startIso?: string;
  endIso?: string;
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string }>;
  raw: unknown;
};

@Injectable()
export class CalendarApiService {
  private readonly baseUrl = 'https://www.googleapis.com/calendar/v3';

  constructor(private readonly googleTokenService: GoogleTokenService) {}

  /**
   * New: paginated listing.
   */
  async listEventsPage(
    userId: number,
    input: {
      calendarId?: string;
      timeMinIso: string;
      timeMaxIso: string;
      maxResults?: number;
      pageToken?: string | null;
    },
  ): Promise<{ events: CalendarEventSummary[]; nextPageToken: string | undefined }> {
    const calendarId = input.calendarId ?? 'primary';
    const maxResults = clampInt(input.maxResults ?? 250, 1, 2500);

    const qs = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: input.timeMinIso,
      timeMax: input.timeMaxIso,
      maxResults: String(maxResults),
    });

    if (input.pageToken) qs.set('pageToken', input.pageToken);

    const data = await this.calendarRequest(
      userId,
      'GET',
      `/calendars/${encodeURIComponent(calendarId)}/events?${qs.toString()}`,
    );

    const items = readArray(data, 'items');
    const out: CalendarEventSummary[] = [];

    for (const it of items) {
      const id = readString(it, 'id');
      if (!id) continue;

      const summary = readString(it, 'summary') ?? undefined;
      const description = readString(it, 'description') ?? undefined;
      const location = readString(it, 'location') ?? undefined;

      const start = readRecord(it, 'start');
      const end = readRecord(it, 'end');

      const startIso =
        (start ? readString(start, 'dateTime') : null) ??
        (start ? readString(start, 'date') : null) ??
        undefined;

      const endIso =
        (end ? readString(end, 'dateTime') : null) ??
        (end ? readString(end, 'date') : null) ??
        undefined;

      const attendeesRaw = readArray(it, 'attendees');
      const attendees = attendeesRaw
        .map((a) => {
          if (!isRecord(a)) return null;
          return {
            email: typeof a.email === 'string' ? a.email : undefined,
            displayName: typeof a.displayName === 'string' ? a.displayName : undefined,
            responseStatus: typeof a.responseStatus === 'string' ? a.responseStatus : undefined,
          };
        })
        .filter((x): x is NonNullable<typeof x> => Boolean(x));

      out.push({ id, summary, description, location, startIso, endIso, attendees, raw: it });
    }

    const nextPageToken = readString(data, 'nextPageToken') ?? undefined;

    return { events: out, nextPageToken };
  }

  /**
   * Backwards-compatible: one-shot list without paging.
   */
  async listEvents(
    userId: number,
    input: { calendarId?: string; timeMinIso: string; timeMaxIso: string; maxResults?: number },
  ): Promise<CalendarEventSummary[]> {
    const first = await this.listEventsPage(userId, {
      calendarId: input.calendarId,
      timeMinIso: input.timeMinIso,
      timeMaxIso: input.timeMaxIso,
      maxResults: input.maxResults,
      pageToken: null,
    });

    // If paging is needed, callers should use listEventsPage() loop.
    return first.events;
  }

  private async calendarRequest(
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
      throw new Error(`Calendar API error: ${msg}`);
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
  return typeof msg === 'string' ? msg : null;
}
