import { Module } from '@nestjs/common';
import { DbModule } from '../../../db/db.module';
import { HubspotOAuthService } from './hubspot-oauth.service';
import { HubspotTokenService } from './hubspot-token.service';
import { HubspotAuthController } from './hubspot-oauth.controller';

@Module({
  imports: [DbModule],
  controllers: [HubspotAuthController],
  providers: [HubspotOAuthService, HubspotTokenService],
  exports: [HubspotOAuthService, HubspotTokenService],
})
export class HubspotModule {}
