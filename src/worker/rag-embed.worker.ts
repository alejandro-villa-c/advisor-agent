import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgBossService } from '../jobs/pgboss.service';
import { RagService } from '../modules/rag/rag.service';

export type RagEmbedJobData = {
  userId: number;
  documentIds?: number[];
};

export const RAG_EMBED_DOCUMENTS_JOB = 'rag.embedDocuments';

type PgBossJob<T> = {
  id: string | number;
  data: T;
};

@Injectable()
export class RagEmbedWorker implements OnModuleInit {
  private readonly logger = new Logger(RagEmbedWorker.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly rag: RagService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.pgBoss.client.createQueue(RAG_EMBED_DOCUMENTS_JOB);
    } catch (err: unknown) {
      this.logger.warn(
        `createQueue(${RAG_EMBED_DOCUMENTS_JOB}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.pgBoss.client.work(
      RAG_EMBED_DOCUMENTS_JOB,
      { batchSize: 1 },
      async (jobs: PgBossJob<RagEmbedJobData>[]) => {
        for (const job of jobs) {
          await this.handleOne(job);
        }
      },
    );

    this.logger.log(`Registered worker: ${RAG_EMBED_DOCUMENTS_JOB}`);
  }

  private async handleOne(job: PgBossJob<RagEmbedJobData>): Promise<void> {
    const { userId, documentIds } = job.data;

    this.logger.log(`[${RAG_EMBED_DOCUMENTS_JOB}] start job=${String(job.id)} userId=${userId}`);

    const rebuilt = await this.rag.rebuildChunksForUser({ userId, documentIds });
    this.logger.log(
      `[${RAG_EMBED_DOCUMENTS_JOB}] rebuilt documents=${rebuilt.documentsProcessed} chunks=${rebuilt.chunksInserted}`,
    );

    const embedded = await this.rag.embedMissingChunksForUser({ userId, batchSize: 64 });
    this.logger.log(
      `[${RAG_EMBED_DOCUMENTS_JOB}] embedded chunks=${embedded.chunksEmbedded} model=${embedded.modelUsed ?? 'NONE'}`,
    );

    this.logger.log(`[${RAG_EMBED_DOCUMENTS_JOB}] done job=${String(job.id)} userId=${userId}`);
  }
}
