import session from 'express-session';
import type { RequestHandler } from 'express';
import connectPgSimple from 'connect-pg-simple';
import { Pool } from 'pg';

let pool: Pool | null = null;

export function createSessionMiddleware(): RequestHandler {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set (needed for Postgres-backed sessions).');
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error('SESSION_SECRET is not set. Put it in your .env locally or Render env vars.');
  }

  const isProd = process.env.NODE_ENV === 'production';

  // Create a singleton pool so we don't open multiple pools during dev reloads
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      ssl: isProd ? { rejectUnauthorized: false } : undefined,
    });
  }

  const PgSessionStore = connectPgSimple(session);

  return session({
    name: 'advisor.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,

    // Behind Render's proxy, this helps cookie + secure behavior.
    proxy: isProd,

    store: new PgSessionStore({
      pool,
      tableName: 'user_sessions',
      createTableIfMissing: true,
    }),

    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd, // requires HTTPS (Render is HTTPS)
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
  });
}
