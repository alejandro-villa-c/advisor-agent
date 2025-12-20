import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgBossService } from '../jobs/pgboss.service';
import { RagService } from '../modules/rag/rag.service';
import { RAG_REBUILD_EMBED_JOB } from '../jobs/job.constants';

export type RagRebuildEmbedJobData = {
  userId: number;
  embedBatchSize?: number; // default 64
};

type PgBossJob<T> = {
  id: string | number;
  data: T;
};

@Injectable()
export class RagRebuildEmbedWorker implements OnModuleInit {
  private readonly logger = new Logger(RagRebuildEmbedWorker.name);

  constructor(
    private readonly pgBossService: PgBossService,
    private readonly rag: RagService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.pgBossService.client.createQueue(RAG_REBUILD_EMBED_JOB);
    } catch (err: unknown) {
      this.logger.warn(
        `createQueue(${RAG_REBUILD_EMBED_JOB}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await this.pgBossService.client.work(
      RAG_REBUILD_EMBED_JOB,
      { batchSize: 1 },
      async (jobs: PgBossJob<RagRebuildEmbedJobData>[]) => {
        for (const job of jobs) {
          try {
            await this.handleOne(job);
          } catch (err) {
            this.logger.error(
              `[${RAG_REBUILD_EMBED_JOB}] FAILED job=${String(job.id)} userId=${job.data?.userId} ` +
                (err instanceof Error ? err.stack : String(err)),
            );
            throw err; // keep the job marked failed so pg-boss retry rules apply
          }
        }
      },
    );

    this.logger.log(`Registered worker: ${RAG_REBUILD_EMBED_JOB}`);
  }

  private async handleOne(job: PgBossJob<RagRebuildEmbedJobData>): Promise<void> {
    const userId = job.data.userId;
    const embedBatchSize = clampInt(job.data.embedBatchSize ?? 64, 1, 256);

    this.logger.log(`[${RAG_REBUILD_EMBED_JOB}] start job=${String(job.id)} userId=${userId}`);

    const rebuilt = await this.rag.rebuildChunksForUser({ userId });

    this.logger.log(
      `[${RAG_REBUILD_EMBED_JOB}] chunks rebuilt documents=${rebuilt.documentsProcessed} chunksInserted=${rebuilt.chunksInserted}`,
    );

    const embedded = await this.rag.embedMissingChunksForUser({
      userId,
      batchSize: embedBatchSize,
    });

    this.logger.log(
      `[${RAG_REBUILD_EMBED_JOB}] embed done chunksEmbedded=${embedded.chunksEmbedded} model=${embedded.modelUsed ?? 'null'}`,
    );

    this.logger.log(`[${RAG_REBUILD_EMBED_JOB}] done job=${String(job.id)} userId=${userId}`);
  }
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  const x = Math.trunc(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}
