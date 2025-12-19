import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import expressLayouts from 'express-ejs-layouts';
import { createSessionMiddleware } from './config/session';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const isProd = process.env.NODE_ENV === 'production';

  // Important when deployed behind a proxy (Render/Fly/etc.)
  app.set('trust proxy', 1);

  // Sessions must be registered before routes.
  app.use(createSessionMiddleware());

  // Views + static assets (always from project root)
  const root = process.cwd();
  app.useStaticAssets(join(root, 'public'));
  app.setBaseViewsDir(join(root, 'views'));
  app.setViewEngine('ejs');

  // EJS layouts
  app.use(expressLayouts);
  app.set('layout', 'layouts/main');

  // Set locals on the underlying Express instance (typed correctly)
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.locals.isProd = isProd;

  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
bootstrap();
