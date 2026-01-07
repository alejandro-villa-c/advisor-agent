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

// Rate limiting: Max embedding calls per minute to stay under OpenAI limits
// With 10,000 RPD limit: ~7 requests per minute is safe
// We add delays between batches to spread out the load
const BATCH_DELAY_MS = 2000; // 2 seconds between embedding batches

@Injectable()
export class RagEmbedWorker implements OnModuleInit {
  private readonly logger = new Logger(RagEmbedWorker.name);

  constructor(
    private readonly pgBossService: PgBossService,
    private readonly rag: RagService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.pgBossService.client.createQueue(RAG_EMBED_DOCUMENTS_JOB);
    } catch (err: unknown) {
      this.logger.warn(
        `createQueue(${RAG_EMBED_DOCUMENTS_JOB}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

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
            throw err;
          }
        }
      },
    );

    this.logger.log(`Registered worker: ${RAG_EMBED_DOCUMENTS_JOB}`);
  }

  private async handleOne(job: PgBossJob<RagEmbedJobData>): Promise<void> {
    const { userId, documentIds } = job.data;

    this.logger.log(
      `[${RAG_EMBED_DOCUMENTS_JOB}] start job=${String(job.id)} userId=${userId} docs=${documentIds?.length ?? 'ALL'}`,
    );

    // Rebuild chunks (this doesn't call OpenAI - just text processing)
    const rebuilt = await this.rag.rebuildChunksForUser({ userId, documentIds });
    this.logger.log(
      `[${RAG_EMBED_DOCUMENTS_JOB}] rebuilt documents=${rebuilt.documentsProcessed} chunks=${rebuilt.chunksInserted}`,
    );

    // Only proceed with embedding if there are chunks to embed
    if (rebuilt.chunksInserted === 0) {
      this.logger.log(`[${RAG_EMBED_DOCUMENTS_JOB}] no new chunks to embed, skipping OpenAI call`);
      this.logger.log(`[${RAG_EMBED_DOCUMENTS_JOB}] done job=${String(job.id)} userId=${userId}`);
      return;
    }

    // Rate limiting: Add delay before embedding to prevent API overload
    await sleep(BATCH_DELAY_MS);

    // Embed with smaller batch size to reduce API load
    const embedded = await this.rag.embedMissingChunksForUser({
      userId,
      batchSize: 32, // Reduced from 64 to spread out API calls
      documentIds,
    });

    this.logger.log(
      `[${RAG_EMBED_DOCUMENTS_JOB}] embedded chunks=${embedded.chunksEmbedded} model=${embedded.modelUsed ?? 'NONE'}`,
    );

    this.logger.log(`[${RAG_EMBED_DOCUMENTS_JOB}] done job=${String(job.id)} userId=${userId}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
