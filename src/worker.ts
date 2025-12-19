import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PgBossService } from './jobs/pgboss.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);

  // Just ensuring pg-boss starts in the worker process as well.
  // Later we’ll register job handlers here (boss.work(...)).
  app.get(PgBossService);

  // Keep process alive (Nest app context will stay running).
}
bootstrap();