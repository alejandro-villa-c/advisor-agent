import { Module } from '@nestjs/common';
import { DbModule } from '../../db/db.module';
import { JobsModule } from '../../jobs/jobs.module';
import { ChatModule } from '../chat/chat.module';
import { AgentToolsService } from './agent-tools.service';
import { AgentSyncedDataToolsService } from './agent-synced-data-tools.service';
import { AgentTasksService } from './agent-tasks.service';
import { AgentRunnerService } from './agent-runner.service';
import { GoogleModule } from '../integrations/google/google.module';
import { HubspotModule } from '../integrations/hubspot/hubspot.module';

@Module({
  imports: [DbModule, JobsModule, ChatModule, GoogleModule, HubspotModule],
  providers: [
    AgentToolsService,
    AgentSyncedDataToolsService,
    AgentTasksService,
    AgentRunnerService,
  ],
  exports: [AgentTasksService, AgentRunnerService],
})
export class AgentModule {}
