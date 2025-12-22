import { Module } from '@nestjs/common';
import { DbModule } from '../../db/db.module';
import { JobsModule } from '../../jobs/jobs.module';
import { GoogleModule } from '../integrations/google/google.module';
import { HubspotModule } from '../integrations/hubspot/hubspot.module';
import { OpenAiModule } from '../integrations/openai/openai.module';

// Services
import { ToolsModule } from '../tools/tools.module';
import { AgentToolsService } from './agent-tools.service';
import { AgentTasksService } from './agent-tasks.service';
import { AgentRunnerService } from './agent-runner.service';
import { AgentIntentService } from './agent-intent.service';

/**
 * AgentModule - Provides the autonomous agent capabilities.
 *
 * The agent can:
 * - Execute one-time tasks requested by the user (via chat or API)
 * - Use tools dynamically based on the goal
 * - Wait for external events (email replies, calendar events)
 * - Resume automatically when waiting conditions are met
 *
 * Key services:
 * - AgentToolsService: Tool definitions and system prompts
 * - AgentRunnerService: LLM-driven task execution loop
 * - AgentTasksService: Task persistence and message history
 * - AgentIntentService: Classifies user intent (chat vs agent vs instruction)
 */
@Module({
  imports: [DbModule, JobsModule, GoogleModule, HubspotModule, OpenAiModule, ToolsModule],
  providers: [AgentToolsService, AgentTasksService, AgentRunnerService, AgentIntentService],
  exports: [AgentTasksService, AgentRunnerService, AgentIntentService],
})
export class AgentModule {}
