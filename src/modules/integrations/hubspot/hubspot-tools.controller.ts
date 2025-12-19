import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { HubspotApiService } from './hubspot-api.service';

@Controller('/api/hubspot')
export class HubspotToolsController {
  constructor(private readonly hubspotApi: HubspotApiService) {}

  @Get('/contacts/search')
  async searchContacts(@Req() req: Request, @Query('q') q: string): Promise<unknown> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    const results = await this.hubspotApi.searchContacts(userId, q ?? '');
    return { results };
  }

  @Get('/contacts/:contactId/notes')
  async listContactNotes(
    @Req() req: Request,
    @Param('contactId') contactId: string,
    @Query('limit') limitRaw?: string,
  ): Promise<unknown> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    const limit = parseLimit(limitRaw);

    const results = await this.hubspotApi.listNotesForContact(userId, {
      contactId,
      limit,
    });

    return { results };
  }

  @Post('/contacts')
  async createContact(
    @Req() req: Request,
    @Body() body: { email?: string; firstName?: string; lastName?: string },
  ): Promise<unknown> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();
    if (!body.email) throw new Error('email is required');

    const created = await this.hubspotApi.createContact(userId, {
      email: body.email,
      firstName: body.firstName,
      lastName: body.lastName,
    });

    return { created };
  }

  @Post('/contacts/:contactId/notes')
  async createNote(
    @Req() req: Request,
    @Param('contactId') contactId: string,
    @Body() body: { text?: string },
  ): Promise<unknown> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();
    if (!body.text) throw new Error('text is required');

    const created = await this.hubspotApi.createNoteOnContact(userId, {
      contactId,
      body: body.text,
    });

    return { created };
  }

  @Post('/import/contacts')
  enqueueImport(@Req() req: Request): unknown {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    // Worker step below will register this job name.
    // If you don’t have enqueue wired yet, this endpoint can come later.
    return {
      ok: true,
      note: 'Use /api/jobs/hubspot/import-contacts once worker is wired (next step).',
    };
  }
}

function parseLimit(raw?: string): number {
  if (!raw) return 10;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 10;
  const x = Math.trunc(n);
  if (x < 1) return 1;
  if (x > 50) return 50;
  return x;
}
