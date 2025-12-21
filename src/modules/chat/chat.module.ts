import { Module } from '@nestjs/common';
import { DbModule } from '../../db/db.module';
import { RagModule } from '../rag/rag.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { OpenAiChatService } from './openai-chat.service';
import { OpenAiToolChatService } from './openai-tool-chat.service';

@Module({
  imports: [DbModule, RagModule],
  controllers: [ChatController],
  providers: [ChatService, OpenAiChatService, OpenAiToolChatService],
  exports: [OpenAiToolChatService],
})
export class ChatModule {}
