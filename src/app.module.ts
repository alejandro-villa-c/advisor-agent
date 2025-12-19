import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JobsModule } from './jobs/jobs.module';
import { WebModule } from './modules/web/web.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), JobsModule, WebModule],
})
export class AppModule {}
