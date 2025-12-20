import { Body, Controller, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { PgBossService } from './pgboss.service';
import {
  CALENDAR_SYNC_EVENTS_JOB,
  GMAIL_SYNC_MESSAGES_JOB,
  HUBSPOT_SYNC_CONTACTS_JOB,
  HUBSPOT_SYNC_NOTES_JOB,
} from './job.constants';

@Controller('/api/jobs')
export class JobsController {
  constructor(private readonly bossService: PgBossService) {}

  @Post('/hubspot/import-contacts')
  async importHubspotContacts(@Req() req: Request): Promise<{ ok: true }> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    await this.bossService.client.send(HUBSPOT_SYNC_CONTACTS_JOB, { userId });
    return { ok: true };
  }

  @Post('/hubspot/import-notes')
  async importHubspotNotes(@Req() req: Request): Promise<{ ok: true }> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    await this.bossService.client.send(HUBSPOT_SYNC_NOTES_JOB, { userId });
    return { ok: true };
  }

  @Post('/gmail/import')
  async importGmail(
    @Req() req: Request,
    @Body() body: { maxMessages?: unknown; query?: unknown },
  ): Promise<{ ok: true }> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    await this.bossService.client.send(GMAIL_SYNC_MESSAGES_JOB, {
      userId,
      maxMessages: toOptionalInt(body?.maxMessages),
      q: toOptionalString(body?.query),
    });

    return { ok: true };
  }

  @Post('/calendar/import')
  async importCalendar(
    @Req() req: Request,
    @Body() body: { calendarId?: unknown; daysPast?: unknown; daysFuture?: unknown },
  ): Promise<{ ok: true }> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    await this.bossService.client.send(CALENDAR_SYNC_EVENTS_JOB, {
      userId,
      calendarId: toOptionalString(body?.calendarId),
      daysPast: toOptionalInt(body?.daysPast),
      daysFuture: toOptionalInt(body?.daysFuture),
    });

    return { ok: true };
  }
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  return undefined;
}

function toOptionalInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return undefined;
}
