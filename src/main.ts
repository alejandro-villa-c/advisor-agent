import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import expressLayouts from 'express-ejs-layouts';
import { createSessionMiddleware } from './config/session';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions, Server as IOServer } from 'socket.io';
import type { RequestHandler, Request, Response } from 'express';

interface EngineRequest {
  _query?: { EIO?: string; transport?: string };
}

interface ServerWithEngine {
  engine: {
    use: (fn: (req: EngineRequest, res: unknown, next: () => void) => void) => void;
  };
}

class SessionIoAdapter extends IoAdapter {
  private sessionMiddleware: RequestHandler;

  constructor(app: NestExpressApplication, sessionMiddleware: RequestHandler) {
    super(app);
    this.sessionMiddleware = sessionMiddleware;
  }

  createIOServer(port: number, options?: Partial<ServerOptions>): IOServer {
    const server = super.createIOServer(port, {
      ...options,
      cors: {
        origin: '*',
        credentials: true,
      },
    }) as IOServer & ServerWithEngine;

    // Wrap session middleware to work with Socket.IO
    server.engine.use((req: EngineRequest, res: unknown, next: () => void) => {
      const isHandshake = req._query?.EIO === '4';
      if (isHandshake) {
        this.sessionMiddleware(req as unknown as Request, res as Response, next);
      } else {
        next();
      }
    });

    return server;
  }
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const isProd = process.env.NODE_ENV === 'production';

  // Important when deployed behind a proxy (Render/Fly/etc.)
  app.set('trust proxy', 1);

  // Sessions must be registered before routes.
  const sessionMiddleware = createSessionMiddleware();
  app.use(sessionMiddleware);

  // Configure Socket.IO adapter with session support
  app.useWebSocketAdapter(new SessionIoAdapter(app, sessionMiddleware));

  // Views + static assets (always from project root)
  const root = process.cwd();
  app.useStaticAssets(join(root, 'public'));
  app.setBaseViewsDir(join(root, 'views'));
  app.setViewEngine('ejs');

  // EJS layouts
  app.use(expressLayouts);
  app.set('layout', 'layouts/main');

  // Set locals on the underlying Express instance
  const expressApp = app.getHttpAdapter().getInstance() as { locals: Record<string, unknown> };
  expressApp.locals.isProd = isProd;

  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
