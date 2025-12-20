import { Module } from '@nestjs/common';
import { RagController } from './rag.controller';
import { RagService } from './rag.service';
import { OpenAiEmbeddingsService } from './openai-embeddings.service';

@Module({
  controllers: [RagController],
  providers: [RagService, OpenAiEmbeddingsService],
  exports: [RagService, OpenAiEmbeddingsService],
})
export class RagModule {}
