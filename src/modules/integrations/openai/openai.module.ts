import { Module } from '@nestjs/common';
import { OpenAiChatService } from './openai-chat.service';
import { OpenAiToolChatService } from './openai-tool-chat.service';

@Module({
  imports: [],
  providers: [OpenAiChatService, OpenAiToolChatService],
  exports: [OpenAiChatService, OpenAiToolChatService],
})
export class OpenAiModule {}
