import { Global, Module } from '@nestjs/common';
import { GoogleTokenService } from './google-token.service';
import { GmailApiService } from './gmail-api.service';
import { CalendarApiService } from './calendar-api.service';

@Global()
@Module({
  providers: [GoogleTokenService, GmailApiService, CalendarApiService],
  exports: [GoogleTokenService, GmailApiService, CalendarApiService],
})
export class GoogleModule {}
