import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  // Application context: no HTTP server. Perfect for Render background worker.
  await NestFactory.createApplicationContext(WorkerModule);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
