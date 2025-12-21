import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgBossService } from '../jobs/pgboss.service';
import { RagService } from '../modules/rag/rag.service';
import { RAG_EMBED_DOCUMENTS_JOB } from '../jobs/job.constants';

export type RagEmbedJobData = {
  userId: number;
  documentIds?: number[];
};

type PgBossJob<T> = {
  id: string | number;
  data: T;
};

@Injectable()
export class RagEmbedWorker implements OnModuleInit {
  private readonly logger = new Logger(RagEmbedWorker.name);

  constructor(
    private readonly pgBossService: PgBossService,
    private readonly rag: RagService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.pgBossService.client.work(
      RAG_EMBED_DOCUMENTS_JOB,
      { batchSize: 1 },
      async (jobs: PgBossJob<RagEmbedJobData>[]) => {
        for (const job of jobs) {
          try {
            await this.handleOne(job);
          } catch (err) {
            this.logger.error(
              `[${RAG_EMBED_DOCUMENTS_JOB}] FAILED job=${String(job.id)} userId=${job.data?.userId} ` +
                (err instanceof Error ? err.stack : String(err)),
            );
            throw err; // keep the job marked failed so pg-boss retry rules apply
          }
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

    const embedded = await this.rag.embedMissingChunksForUser({
      userId,
      batchSize: 64,
      documentIds,
    });
    this.logger.log(
      `[${RAG_EMBED_DOCUMENTS_JOB}] embedded chunks=${embedded.chunksEmbedded} model=${embedded.modelUsed ?? 'NONE'}`,
    );

    this.logger.log(`[${RAG_EMBED_DOCUMENTS_JOB}] done job=${String(job.id)} userId=${userId}`);
  }
}
