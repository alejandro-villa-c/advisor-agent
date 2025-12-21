import { Module } from '@nestjs/common';
import { DbModule } from '../../db/db.module';
import { RagModule } from '../rag/rag.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { OpenAiModule } from '../integrations/openai/openai.module';
import { AgentModule } from '../agent/agent.module';
import { JobsModule } from '../../jobs/jobs.module';

@Module({
  imports: [DbModule, RagModule, AgentModule, OpenAiModule, JobsModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [],
})
export class ChatModule {}
