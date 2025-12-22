import { Module } from '@nestjs/common';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { OpenAiEmbeddingsService } from './openai-embeddings.service';
import { OpenAiModule } from '../integrations/openai/openai.module';

@Module({
  imports: [OpenAiModule],
  controllers: [RagController],
  providers: [RagService, OpenAiEmbeddingsService],
  exports: [RagService, OpenAiEmbeddingsService],
})
export class RagModule {}
