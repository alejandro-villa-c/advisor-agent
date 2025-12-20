import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module';
import { WebModule } from './modules/web/web.module';
import { AuthModule } from './modules/auth/auth.module';
import { HubspotModule } from './modules/integrations/hubspot/hubspot.module';
import { JobsModule } from './jobs/jobs.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DbModule,
    WebModule,
    AuthModule,
    HubspotModule,
    JobsModule,
  ],
})
export class AppModule {}
