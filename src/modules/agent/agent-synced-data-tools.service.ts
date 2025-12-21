import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '../../db/db.service';
import { calendarEvents, gmailMessages, hubspotContacts } from '../../db/schema';

@Injectable()
export class AgentSyncedDataToolsService {
  constructor(private readonly dbService: DbService) {}

  async findHubspotContactsLocal(input: {
    userId: number;
    query: string;
    limit: number;
  }): Promise<
    Array<{ id: string; email: string | null; firstName: string | null; lastName: string | null }>
  > {
    const q = (input.query ?? '').trim();
    if (!q) return [];

    const like = `%${escapeLike(q)}%`;

    const rows = await this.dbService.db
      .select({
        id: hubspotContacts.hubspotContactId,
        email: hubspotContacts.email,
        firstName: hubspotContacts.firstName,
        lastName: hubspotContacts.lastName,
      })
      .from(hubspotContacts)
      .where(
        and(
          eq(hubspotContacts.userId, input.userId),
          sql`(
            ${hubspotContacts.email} ILIKE ${like}
            OR ${hubspotContacts.firstName} ILIKE ${like}
            OR ${hubspotContacts.lastName} ILIKE ${like}
          )`,
        ),
      )
      .limit(clampInt(input.limit, 1, 25));

    return rows.map((r) => ({
      id: String(r.id),
      email: r.email ?? null,
      firstName: r.firstName ?? null,
      lastName: r.lastName ?? null,
    }));
  }

  async searchGmailMessagesLocal(input: { userId: number; query: string; limit: number }): Promise<
    Array<{
      gmailMessageId: string;
      gmailThreadId: string | null;
      from: string | null;
      to: string | null;
      subject: string | null;
      snippet: string | null;
      sentAtIso: string | null;
    }>
  > {
    const q = (input.query ?? '').trim();
    if (!q) return [];

    const like = `%${escapeLike(q)}%`;

    const rows = await this.dbService.db
      .select({
        gmailMessageId: gmailMessages.gmailMessageId,
        gmailThreadId: gmailMessages.gmailThreadId,
        from: gmailMessages.from,
        to: gmailMessages.to,
        subject: gmailMessages.subject,
        snippet: gmailMessages.snippet,
        sentAt: gmailMessages.sentAt,
      })
      .from(gmailMessages)
      .where(
        and(
          eq(gmailMessages.userId, input.userId),
          sql`(
            ${gmailMessages.subject} ILIKE ${like}
            OR ${gmailMessages.snippet} ILIKE ${like}
            OR ${gmailMessages.from} ILIKE ${like}
            OR ${gmailMessages.to} ILIKE ${like}
          )`,
        ),
      )
      .orderBy(sql`${gmailMessages.sentAt} DESC NULLS LAST`)
      .limit(clampInt(input.limit, 1, 25));

    return rows.map((r) => ({
      gmailMessageId: String(r.gmailMessageId),
      gmailThreadId: r.gmailThreadId ?? null,
      from: r.from ?? null,
      to: r.to ?? null,
      subject: r.subject ?? null,
      snippet: r.snippet ?? null,
      sentAtIso: r.sentAt ? new Date(r.sentAt).toISOString() : null,
    }));
  }

  async suggestCalendarTimesLocal(input: {
    userId: number;
    startIso: string;
    endIso: string;
    durationMinutes: number;
    workDayStartHour: number;
    workDayEndHour: number;
    timezoneOffsetMinutes: number;
    maxSuggestions: number;
  }): Promise<Array<{ startIso: string; endIso: string }>> {
    const startMs = Date.parse(input.startIso);
    const endMs = Date.parse(input.endIso);

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];

    const durationMs = clampInt(input.durationMinutes, 5, 24 * 60) * 60_000;
    const maxSuggestions = clampInt(input.maxSuggestions, 1, 50);

    const workStartHour = clampInt(input.workDayStartHour, 0, 23);
    const workEndHour = clampInt(input.workDayEndHour, 1, 24);
    const tzOffsetMin = clampInt(input.timezoneOffsetMinutes, -14 * 60, 14 * 60);

    // Load busy intervals from local calendar mirror
    const rows = await this.dbService.db
      .select({
        startAt: calendarEvents.startAt,
        endAt: calendarEvents.endAt,
      })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.userId, input.userId),
          sql`${calendarEvents.startAt} IS NOT NULL AND ${calendarEvents.endAt} IS NOT NULL`,
          sql`${calendarEvents.startAt} < ${new Date(endMs)} AND ${calendarEvents.endAt} > ${new Date(startMs)}`,
        ),
      )
      .orderBy(sql`${calendarEvents.startAt} ASC`);

    const busy = rows
      .map((r) => ({
        start: r.startAt ? new Date(r.startAt).getTime() : NaN,
        end: r.endAt ? new Date(r.endAt).getTime() : NaN,
      }))
      .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start);

    const mergedBusy = mergeIntervals(busy);

    const slots: Array<{ startIso: string; endIso: string }> = [];

    // iterate day-by-day in "local" time (via fixed offset)
    const dayMs = 86_400_000;
    let cursorDayLocal = floorToLocalDay(startMs, tzOffsetMin);

    while (slots.length < maxSuggestions) {
      const workStartUtc = localDayHourToUtc(cursorDayLocal, workStartHour, tzOffsetMin);
      const workEndUtc = localDayHourToUtc(cursorDayLocal, workEndHour, tzOffsetMin);

      const windowStart = Math.max(workStartUtc, startMs);
      const windowEnd = Math.min(workEndUtc, endMs);

      if (windowEnd > windowStart) {
        const stepMs = 30 * 60_000; // 30-min stepping (simple + stable)

        for (let t = windowStart; t + durationMs <= windowEnd; t += stepMs) {
          const candidate = { start: t, end: t + durationMs };
          if (!overlapsAny(candidate, mergedBusy)) {
            slots.push({
              startIso: new Date(candidate.start).toISOString(),
              endIso: new Date(candidate.end).toISOString(),
            });
            if (slots.length >= maxSuggestions) break;
          }
        }
      }

      cursorDayLocal += dayMs;
      if (localDayHourToUtc(cursorDayLocal, workStartHour, tzOffsetMin) >= endMs) break;
    }

    return slots;
  }
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  const x = Math.trunc(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

function escapeLike(s: string): string {
  // basic escaping for LIKE patterns
  return s.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function mergeIntervals(
  intervals: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  if (intervals.length <= 1) return intervals.slice();

  const sorted = intervals.slice().sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];

  let cur = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i];
    if (next.start <= cur.end) {
      cur.end = Math.max(cur.end, next.end);
    } else {
      out.push(cur);
      cur = { ...next };
    }
  }

  out.push(cur);
  return out;
}

function overlapsAny(
  x: { start: number; end: number },
  intervals: Array<{ start: number; end: number }>,
): boolean {
  // intervals sorted/merged
  for (const b of intervals) {
    if (b.end <= x.start) continue;
    if (b.start >= x.end) return false;
    return true;
  }
  return false;
}

function floorToLocalDay(utcMs: number, tzOffsetMinutes: number): number {
  const localMs = utcMs + tzOffsetMinutes * 60_000;
  const d = new Date(localMs);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function localDayHourToUtc(localDayStartMs: number, hour: number, tzOffsetMinutes: number): number {
  const localMs = localDayStartMs + hour * 60 * 60_000;
  return localMs - tzOffsetMinutes * 60_000;
}
