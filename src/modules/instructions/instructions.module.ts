import { Module } from '@nestjs/common';
import { DbModule } from '../../db/db.module';
import { JobsModule } from '../../jobs/jobs.module';
import { OpenAiModule } from '../integrations/openai/openai.module';
import { GoogleModule } from '../integrations/google/google.module';
import { HubspotModule } from '../integrations/hubspot/hubspot.module';

import { InstructionsService } from './instructions.service';
import { InstructionsController } from './instructions.controller';
import { InstructionExecutorService } from './instruction-executor.service';
import { ConfigModule } from '@nestjs/config';
import { WebSocketModule } from '../websocket/websocket.module';

@Module({
  imports: [
    DbModule,
    JobsModule,
    OpenAiModule,
    GoogleModule,
    HubspotModule,
    ConfigModule,
    WebSocketModule,
  ],
  controllers: [InstructionsController],
  providers: [InstructionsService, InstructionExecutorService],
  exports: [InstructionsService, InstructionExecutorService],
})
export class InstructionsModule {}
