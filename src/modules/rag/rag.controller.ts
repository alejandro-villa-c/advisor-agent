import { Controller, Get, Query, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { RagSearchRow, RagService } from './rag.service';

@Controller('/api/rag')
export class RagController {
  constructor(private readonly rag: RagService) {}

  @Get('/search')
  async search(
    @Req() req: Request,
    @Query('q') q: string,
    @Query('k') k?: string,
  ): Promise<{ results: RagSearchRow[] }> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    const results = await this.rag.search({
      userId,
      query: q ?? '',
      k: k ? Number(k) : undefined,
    });

    return { results };
  }
}
