import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../../db/db.service';
import { oauthAccounts } from '../../db/schema';

@Controller()
export class WebController {
  constructor(private readonly dbService: DbService) {}

  @Get('/')
  root(@Req() req: Request, @Res() res: Response): void {
    if (req.session.userId) {
      res.redirect('/chat');
      return;
    }
    res.redirect('/login');
  }

  @Get('/login')
  login(@Req() req: Request, @Res() res: Response): void {
    if (req.session.userId) {
      res.redirect('/chat');
      return;
    }
    res.render('pages/login', {});
  }

  @Get('/chat')
  chat(@Res() res: Response): void {
    res.render('pages/chat', {});
  }

  @Get('/threads')
  threads(@Res() res: Response): void {
    res.render('pages/threads', {});
  }

  @Get('/settings')
  async settings(@Req() req: Request, @Res() res: Response): Promise<void> {
    const userId = req.session.userId!;
    const db = this.dbService.db;

    const google = await db
      .select({ id: oauthAccounts.id })
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, 'google')))
      .limit(1);

    const hubspot = await db
      .select({ id: oauthAccounts.id })
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, 'hubspot')))
      .limit(1);

    res.render('pages/settings', {
      connections: {
        google: google.length > 0,
        hubspot: hubspot.length > 0,
      },
    });
  }
}
