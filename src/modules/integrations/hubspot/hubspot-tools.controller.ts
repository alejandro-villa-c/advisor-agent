import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { HubspotApiService } from './hubspot-api.service';

interface ContactListQuery {
  limit?: string;
  after?: string;
}

interface CreateContactBody {
  email: string;
  firstName?: string;
  lastName?: string;
}

interface CreateNoteBody {
  text: string;
}

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

  @Get('/contacts')
  async listContacts(@Req() req: Request, @Query() query: ContactListQuery): Promise<unknown> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    const limit = query.limit ? parseLimit(query.limit) : 50;
    const after = query.after || null;

    const response = await this.hubspotApi.listContactsPage(userId, { limit, after });

    return {
      contacts: response.results,
      nextAfter: response.nextAfter,
      hasMore: !!response.nextAfter,
    };
  }

  @Get('/contacts/:contactId')
  async getContact(@Req() req: Request, @Param('contactId') contactId: string): Promise<unknown> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    const contact = await this.hubspotApi.getContact(userId, contactId);
    return { contact };
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
  async createContact(@Req() req: Request, @Body() body: CreateContactBody): Promise<unknown> {
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

  @Delete('/contacts/:contactId')
  async deleteContact(
    @Req() req: Request,
    @Param('contactId') contactId: string,
  ): Promise<unknown> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    await this.hubspotApi.deleteContact(userId, contactId);
    return { success: true, contactId };
  }

  @Post('/contacts/:contactId/notes')
  async createNote(
    @Req() req: Request,
    @Param('contactId') contactId: string,
    @Body() body: CreateNoteBody,
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

  @Delete('/notes/:noteId')
  async deleteNote(@Req() req: Request, @Param('noteId') noteId: string): Promise<unknown> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    await this.hubspotApi.deleteNote(userId, noteId);
    return { success: true, noteId };
  }
}

function parseLimit(raw?: string): number {
  if (!raw) return 10;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 10;
  const x = Math.trunc(n);
  if (x < 1) return 1;
  if (x > 100) return 100;
  return x;
}
