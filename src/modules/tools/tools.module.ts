import { Module } from '@nestjs/common';
import { GoogleModule } from '../integrations/google/google.module';
import { HubspotModule } from '../integrations/hubspot/hubspot.module';

import { ToolExecutorService } from './tools-executor.service';
import { SyncedDataToolsService } from './synced-data-tools.service';
import { InstructionsModule } from '../instructions/instructions.module';

@Module({
  imports: [GoogleModule, HubspotModule, InstructionsModule],
  providers: [SyncedDataToolsService, ToolExecutorService],
  exports: [ToolExecutorService],
})
export class ToolsModule {}
