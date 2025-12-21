import { Module } from '@nestjs/common';
import { DbModule } from '../../db/db.module';
import { JobsModule } from '../../jobs/jobs.module';
import { AgentToolsService } from './agent-tools.service';
import { AgentSyncedDataToolsService } from './agent-synced-data-tools.service';
import { AgentTasksService } from './agent-tasks.service';
import { AgentRunnerService } from './agent-runner.service';
import { GoogleModule } from '../integrations/google/google.module';
import { HubspotModule } from '../integrations/hubspot/hubspot.module';
import { AgentIntentService } from './agent-intent.service';
import { OpenAiModule } from '../integrations/openai/openai.module';

@Module({
  imports: [DbModule, JobsModule, GoogleModule, HubspotModule, OpenAiModule],
  providers: [
    AgentToolsService,
    AgentSyncedDataToolsService,
    AgentTasksService,
    AgentRunnerService,
    AgentIntentService,
  ],
  exports: [AgentTasksService, AgentRunnerService, AgentIntentService],
})
export class AgentModule {}
