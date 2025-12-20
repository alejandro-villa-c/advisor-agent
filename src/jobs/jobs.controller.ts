import { Controller, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { PgBossService } from './pgboss.service';
import { HUBSPOT_IMPORT_CONTACTS_JOB } from '../worker/hubspot-import.worker';
import { RAG_EMBED_DOCUMENTS_JOB } from '../worker/rag-embed.worker';

@Controller('/api/jobs')
export class JobsController {
  constructor(private readonly bossService: PgBossService) {}

  @Post('/hubspot/import-contacts')
  async importHubspotContacts(@Req() req: Request): Promise<{ ok: true }> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    await this.bossService.client.send(HUBSPOT_IMPORT_CONTACTS_JOB, { userId });
    return { ok: true };
  }

  @Post('/rag/embed-documents')
  async embedDocuments(@Req() req: Request): Promise<{ ok: true }> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    await this.bossService.client.send(RAG_EMBED_DOCUMENTS_JOB, { userId });
    return { ok: true };
  }
}
