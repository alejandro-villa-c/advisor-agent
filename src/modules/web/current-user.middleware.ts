import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { DbService } from '../../db/db.service';
import { users } from '../../db/schema';

type CurrentUser = {
  id: number;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  initials: string;
};

function computeInitials(nameOrEmail: string): string {
  const cleaned = nameOrEmail.trim();
  if (!cleaned) return 'U';

  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

@Injectable()
export class CurrentUserMiddleware implements NestMiddleware {
  constructor(private readonly dbService: DbService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const userId = req.session.userId;

    if (!userId) {
      res.locals.currentUser = null as CurrentUser | null;
      next();
      return;
    }

    const db = this.dbService.db;

    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const user = rows[0];

    if (!user) {
      // session points to a missing user; clear it to be safe
      req.session.userId = undefined;
      res.locals.currentUser = null as CurrentUser | null;
      next();
      return;
    }

    const displayName = user.name ?? user.email;
    res.locals.currentUser = {
      ...user,
      initials: computeInitials(displayName),
    } satisfies CurrentUser;

    next();
  }
}
