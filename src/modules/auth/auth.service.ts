import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../../db/db.service';
import { oauthAccounts, users } from '../../db/schema';

type UpsertGoogleUserInput = {
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
  providerAccountId: string; // Google "sub"
  accessToken: string;
  refreshToken?: string | null;
  scope?: string | null;
  tokenType?: string | null;
  expiresAt?: Date | null;
};

@Injectable()
export class AuthService {
  constructor(private readonly dbService: DbService) {}

  async upsertGoogleUser(input: UpsertGoogleUserInput): Promise<{ userId: number }> {
    const db = this.dbService.db;

    // 1) Find or create user by email
    const existingUsers = await db
      .select()
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);

    let userId: number;

    if (existingUsers.length === 0) {
      const created = await db
        .insert(users)
        .values({
          email: input.email,
          name: input.name ?? null,
          avatarUrl: input.avatarUrl ?? null,
        })
        .returning({ id: users.id });

      userId = created[0].id;
    } else {
      userId = existingUsers[0].id;

      // Keep profile fresh
      await db
        .update(users)
        .set({
          name: input.name ?? existingUsers[0].name,
          avatarUrl: input.avatarUrl ?? existingUsers[0].avatarUrl,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    }

    // 2) Upsert oauth account for google
    const existingAccount = await db
      .select()
      .from(oauthAccounts)
      .where(
        and(
          eq(oauthAccounts.provider, 'google'),
          eq(oauthAccounts.providerAccountId, input.providerAccountId),
        ),
      )
      .limit(1);

    if (existingAccount.length === 0) {
      await db.insert(oauthAccounts).values({
        userId,
        provider: 'google',
        providerAccountId: input.providerAccountId,
        accountEmail: input.email,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? null,
        tokenType: input.tokenType ?? null,
        scope: input.scope ?? null,
        expiresAt: input.expiresAt ?? null,
        meta: null,
      });
    } else {
      await db
        .update(oauthAccounts)
        .set({
          userId,
          accountEmail: input.email,
          accessToken: input.accessToken,
          refreshToken: input.refreshToken ?? existingAccount[0].refreshToken,
          tokenType: input.tokenType ?? existingAccount[0].tokenType,
          scope: input.scope ?? existingAccount[0].scope,
          expiresAt: input.expiresAt ?? existingAccount[0].expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(oauthAccounts.id, existingAccount[0].id));
    }

    return { userId };
  }

  async getGoogleConnection(userId: number): Promise<boolean> {
    const db = this.dbService.db;

    const account = await db
      .select({ id: oauthAccounts.id })
      .from(oauthAccounts)
      .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, 'google')))
      .limit(1);

    return account.length > 0;
  }
}
