import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull, sql, isNotNull, gt } from 'drizzle-orm';
import { PgBossService } from '../jobs/pgboss.service';
import { DbService } from '../db/db.service';
import { documents, documentChunks } from '../db/schema';
import { RAG_EMBED_DOCUMENTS_JOB, RAG_REPAIR_JOB } from '../jobs/job.constants';

export type RagRepairJobData = {
  userId?: number; // If not provided, repairs all users
  batchSize?: number;
};

type PgBossJob<T> = {
  id: string | number;
  data: T;
};

/**
 * RagRepairWorker - Finds and fixes orphaned documents
 *
 * An orphaned document is one that:
 * 1. Has text content (LENGTH(text) > 0)
 * 2. Has NO chunks in document_chunks
 *
 * This can happen due to:
 * - Failed chunking jobs
 * - Race conditions during sync
 * - Interrupted transactions
 *
 * This worker runs periodically (every 15 minutes by default) to ensure
 * all documents are properly chunked and embedded.
 *
 * NOTE: This is the ONLY place RAG_REPAIR_JOB should be scheduled.
 * SyncSchedulerService should NOT schedule this job.
 */
@Injectable()
export class RagRepairWorker implements OnModuleInit {
  private readonly logger = new Logger(RagRepairWorker.name);
  private readonly ragRepairCron: string;

  constructor(
    private readonly pgBossService: PgBossService,
    private readonly dbService: DbService,
    private readonly config: ConfigService,
  ) {
    // Default to every 15 minutes - repair is not urgent
    this.ragRepairCron = this.config.get<string>('RAG_REPAIR_CRON', '*/15 * * * *');
  }

  async onModuleInit(): Promise<void> {
    // Create the queue
    try {
      await this.pgBossService.client.createQueue(RAG_REPAIR_JOB);
    } catch (err: unknown) {
      this.logger.warn(
        `createQueue(${RAG_REPAIR_JOB}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Register the worker
    await this.pgBossService.client.work(
      RAG_REPAIR_JOB,
      { batchSize: 1 },
      async (jobs: PgBossJob<RagRepairJobData>[]) => {
        for (const job of jobs) {
          try {
            await this.handleOne(job);
          } catch (err) {
            this.logger.error(
              `[${RAG_REPAIR_JOB}] FAILED job=${String(job.id)}: ${err instanceof Error ? err.stack : String(err)}`,
            );
            throw err;
          }
        }
      },
    );

    this.logger.log(`Registered worker: ${RAG_REPAIR_JOB}`);

    // Schedule periodic repair job
    await this.schedulePeriodicRepair();
  }

  private async schedulePeriodicRepair(): Promise<void> {
    try {
      await this.pgBossService.client.schedule(
        RAG_REPAIR_JOB,
        this.ragRepairCron,
        {},
        {
          tz: 'UTC',
        },
      );
      this.logger.log(`Scheduled ${RAG_REPAIR_JOB} with cron: ${this.ragRepairCron}`);
    } catch (err) {
      // Schedule might already exist
      this.logger.warn(
        `Failed to schedule ${RAG_REPAIR_JOB}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async handleOne(job: PgBossJob<RagRepairJobData>): Promise<void> {
    const userId = job.data.userId;
    const batchSize = clampInt(job.data.batchSize ?? 50, 10, 200); // Reduced batch size

    this.logger.log(
      `[${RAG_REPAIR_JOB}] start job=${String(job.id)} userId=${userId ?? 'ALL'} batchSize=${batchSize}`,
    );

    // Find orphaned documents (have text but no chunks)
    const orphanedDocs = await this.findOrphanedDocuments({ userId, limit: batchSize });

    if (orphanedDocs.length === 0) {
      this.logger.log(`[${RAG_REPAIR_JOB}] No orphaned documents found`);
      return;
    }

    this.logger.log(`[${RAG_REPAIR_JOB}] Found ${orphanedDocs.length} orphaned documents`);

    // Group by userId for efficient job dispatch
    const byUser = new Map<number, number[]>();
    for (const doc of orphanedDocs) {
      const list = byUser.get(doc.userId) ?? [];
      list.push(doc.id);
      byUser.set(doc.userId, list);
    }

    // Enqueue embed jobs for each user's orphaned documents
    let jobsEnqueued = 0;
    for (const [uid, docIds] of byUser) {
      // Use stable singleton key to prevent duplicate jobs
      await this.pgBossService.client.send(
        RAG_EMBED_DOCUMENTS_JOB,
        { userId: uid, documentIds: docIds },
        {
          singletonKey: `rag.repair.embed:${uid}`,
          singletonSeconds: 300, // 5 minutes - prevents rapid re-queueing
        },
      );
      jobsEnqueued++;

      this.logger.log(
        `[${RAG_REPAIR_JOB}] Enqueued embed job for userId=${uid} with ${docIds.length} documents`,
      );
    }

    // Also find documents with chunks but missing embeddings (but limit to avoid API overload)
    const missingEmbeddings = await this.findDocumentsWithMissingEmbeddings({
      userId,
      limit: Math.min(batchSize, 25), // Smaller limit for embedding repairs
    });

    if (missingEmbeddings.length > 0) {
      this.logger.log(
        `[${RAG_REPAIR_JOB}] Found ${missingEmbeddings.length} documents with missing embeddings`,
      );

      const byUserEmbed = new Map<number, number[]>();
      for (const doc of missingEmbeddings) {
        const list = byUserEmbed.get(doc.userId) ?? [];
        list.push(doc.id);
        byUserEmbed.set(doc.userId, list);
      }

      for (const [uid, docIds] of byUserEmbed) {
        await this.pgBossService.client.send(
          RAG_EMBED_DOCUMENTS_JOB,
          { userId: uid, documentIds: docIds },
          {
            singletonKey: `rag.repair.missing-embed:${uid}`,
            singletonSeconds: 300,
          },
        );
        jobsEnqueued++;
      }
    }

    this.logger.log(
      `[${RAG_REPAIR_JOB}] done job=${String(job.id)} orphanedDocs=${orphanedDocs.length} missingEmbeddings=${missingEmbeddings.length} jobsEnqueued=${jobsEnqueued}`,
    );
  }

  /**
   * Find documents that have text but no chunks
   */
  private async findOrphanedDocuments(input: {
    userId?: number;
    limit: number;
  }): Promise<Array<{ id: number; userId: number }>> {
    const conditions = [isNotNull(documents.text), gt(sql`LENGTH(${documents.text})`, 0)];

    if (input.userId) {
      conditions.push(eq(documents.userId, input.userId));
    }

    // Find documents with no chunks
    const rows = await this.dbService.db
      .select({
        id: documents.id,
        userId: documents.userId,
      })
      .from(documents)
      .leftJoin(
        documentChunks,
        and(
          eq(documentChunks.documentId, documents.id),
          eq(documentChunks.chunkIndex, 0), // Just check for first chunk
        ),
      )
      .where(and(...conditions, isNull(documentChunks.id)))
      .limit(input.limit);

    return rows;
  }

  /**
   * Find documents that have chunks but those chunks are missing embeddings
   */
  private async findDocumentsWithMissingEmbeddings(input: {
    userId?: number;
    limit: number;
  }): Promise<Array<{ id: number; userId: number }>> {
    const conditions = [isNull(documentChunks.embedding)];

    if (input.userId) {
      conditions.push(eq(documentChunks.userId, input.userId));
    }

    const rows = await this.dbService.db
      .selectDistinct({
        id: documents.id,
        userId: documents.userId,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documents.id, documentChunks.documentId))
      .where(and(...conditions))
      .limit(input.limit);

    return rows;
  }
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  const x = Math.trunc(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}
