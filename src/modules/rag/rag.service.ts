import { Injectable } from '@nestjs/common';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { DbService } from '../../db/db.service';
import { documentChunks, documents } from '../../db/schema';
import { OpenAiEmbeddingsService } from './openai-embeddings.service';

type Chunk = { text: string; meta: { start: number; end: number } };

@Injectable()
export class RagService {
  constructor(
    private readonly dbService: DbService,
    private readonly embeddings: OpenAiEmbeddingsService,
  ) {}

  /**
   * Basic overlapping char chunker (good enough for the challenge).
   */
  chunkText(
    input: string,
    opts?: { chunkSize?: number; overlap?: number; maxChunks?: number },
  ): Chunk[] {
    const text = (input ?? '').trim();
    if (!text) return [];

    const chunkSize = opts?.chunkSize ?? 900;
    const overlap = opts?.overlap ?? 120;
    const maxChunks = opts?.maxChunks ?? 80;

    const out: Chunk[] = [];
    let start = 0;

    while (start < text.length && out.length < maxChunks) {
      let end = Math.min(start + chunkSize, text.length);

      // Try to avoid splitting in the middle of a word if we can.
      if (end < text.length) {
        const windowStart = Math.max(start, end - 200);
        const slice = text.slice(windowStart, end);
        const lastSpace = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
        if (lastSpace > 40) {
          end = windowStart + lastSpace;
        }
      }

      if (end <= start) {
        // Safety to avoid infinite loop
        end = Math.min(start + chunkSize, text.length);
      }

      const chunk = text.slice(start, end).trim();
      if (chunk) {
        out.push({ text: chunk, meta: { start, end } });
      }

      if (end >= text.length) break;

      start = Math.max(0, end - overlap);
    }

    return out;
  }

  /**
   * Rebuilds chunks for all documents for a user (or a subset).
   * Deletes existing chunks for each document and recreates them.
   */
  async rebuildChunksForUser(input: {
    userId: number;
    documentIds?: number[];
  }): Promise<{ documentsProcessed: number; chunksInserted: number }> {
    const userId = input.userId;

    const docs = await this.dbService.db
      .select({
        id: documents.id,
        text: documents.text,
        title: documents.title,
        source: documents.source,
        sourceId: documents.sourceId,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(
        input.documentIds?.length
          ? and(eq(documents.userId, userId), sql`${documents.id} = ANY(${input.documentIds})`)
          : eq(documents.userId, userId),
      );

    let chunksInserted = 0;

    for (const d of docs) {
      const chunks = this.chunkText(d.text);

      // Wipe existing chunks
      await this.dbService.db.delete(documentChunks).where(eq(documentChunks.documentId, d.id));

      if (chunks.length === 0) continue;

      const rows = chunks.map((c, idx) => ({
        userId,
        documentId: d.id,
        chunkIndex: idx,
        text: c.text,
        embedding: null,
        embeddingModel: null,
        meta: {
          documentTitle: d.title ?? null,
          source: d.source,
          sourceId: d.sourceId,
          start: c.meta.start,
          end: c.meta.end,
          documentUpdatedAt: d.updatedAt?.toISOString?.() ?? null,
        },
      }));

      await this.dbService.db.insert(documentChunks).values(rows);
      chunksInserted += rows.length;
    }

    return { documentsProcessed: docs.length, chunksInserted };
  }

  /**
   * Embeds all chunks missing embeddings for a user.
   */
  async embedMissingChunksForUser(input: {
    userId: number;
    batchSize?: number;
  }): Promise<{ chunksEmbedded: number; modelUsed: string | null }> {
    const userId = input.userId;
    const batchSize = clampInt(input.batchSize ?? 64, 1, 256);

    if (!this.embeddings.isConfigured()) {
      // Still “functional”: you can chunk + keyword search, but semantic search won’t work.
      return { chunksEmbedded: 0, modelUsed: null };
    }

    let chunksEmbedded = 0;
    let modelUsed: string | null = null;

    while (true) {
      const batch = await this.dbService.db
        .select({
          id: documentChunks.id,
          text: documentChunks.text,
        })
        .from(documentChunks)
        .where(and(eq(documentChunks.userId, userId), sql`${documentChunks.embedding} IS NULL`))
        .limit(batchSize);

      if (batch.length === 0) break;

      const { model, vectors } = await this.embeddings.embedMany(batch.map((b) => b.text));
      modelUsed = model;

      for (let i = 0; i < batch.length; i += 1) {
        await this.dbService.db
          .update(documentChunks)
          .set({
            embedding: vectors[i],
            embeddingModel: model,
          })
          .where(eq(documentChunks.id, batch[i].id));
      }

      chunksEmbedded += batch.length;

      // dev safety cap
      if (chunksEmbedded >= 5000) break;
    }

    return { chunksEmbedded, modelUsed };
  }

  /**
   * Semantic search (falls back to keyword search if embeddings not configured).
   */
  async search(input: { userId: number; query: string; k?: number }): Promise<
    Array<{
      chunkId: number;
      documentId: number;
      title: string | null;
      source: string;
      sourceId: string;
      chunkText: string;
      distance: number | null;
    }>
  > {
    const userId = input.userId;
    const q = (input.query ?? '').trim();
    const k = clampInt(input.k ?? 8, 1, 25);
    if (!q) return [];

    // Fallback: keyword search
    if (!this.embeddings.isConfigured()) {
      const rows = await this.dbService.db
        .select({
          chunkId: documentChunks.id,
          documentId: documents.id,
          title: documents.title,
          source: documents.source,
          sourceId: documents.sourceId,
          chunkText: documentChunks.text,
        })
        .from(documentChunks)
        .innerJoin(documents, eq(documentChunks.documentId, documents.id))
        .where(
          and(
            eq(documentChunks.userId, userId),
            sql`${documentChunks.text} ILIKE ${'%' + q + '%'}`,
          ),
        )
        .limit(k);

      return rows.map((r) => ({ ...r, distance: null }));
    }

    const { vector } = await this.embeddings.embedOne(q);
    const vectorLiteral = `[${vector.join(',')}]`;

    // cosine distance: embedding <=> query_vector
    const distanceExpr = sql<number>`${documentChunks.embedding} <=> ${vectorLiteral}::vector`;

    const rows = await this.dbService.db
      .select({
        chunkId: documentChunks.id,
        documentId: documents.id,
        title: documents.title,
        source: documents.source,
        sourceId: documents.sourceId,
        chunkText: documentChunks.text,
        distance: distanceExpr,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(and(eq(documentChunks.userId, userId), isNotNull(documentChunks.embedding)))
      .orderBy(distanceExpr)
      .limit(k);

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
