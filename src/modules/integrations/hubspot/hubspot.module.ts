import { Module } from '@nestjs/common';
import { DbModule } from '../../../db/db.module';
import { JobsModule } from '../../../jobs/jobs.module';
import { HubspotOAuthService } from './hubspot-oauth.service';
import { HubspotTokenService } from './hubspot-token.service';
import { HubspotAuthController } from './hubspot-oauth.controller';
import { HubspotApiService } from './hubspot-api.service';
import { HubspotToolsController } from './hubspot-tools.controller';

@Module({
  imports: [DbModule, JobsModule],
  controllers: [HubspotAuthController, HubspotToolsController],
  providers: [HubspotOAuthService, HubspotTokenService, HubspotApiService],
  exports: [HubspotOAuthService, HubspotTokenService, HubspotApiService],
})
export class HubspotModule {}
