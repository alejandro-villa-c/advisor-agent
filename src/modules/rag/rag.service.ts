import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
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
   * Basic overlapping char chunker.
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
   *
   * IMPORTANT: Now idempotent — if the document text hash + chunk params match, we skip rebuild
   * to avoid re-embedding unchanged docs (saves budget).
   */
  async rebuildChunksForUser(input: {
    userId: number;
    documentIds?: number[];
  }): Promise<{ documentsProcessed: number; chunksInserted: number }> {
    const userId = input.userId;

    const whereClause =
      input.documentIds && input.documentIds.length > 0
        ? and(eq(documents.userId, userId), inArray(documents.id, input.documentIds))
        : eq(documents.userId, userId);

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
      .where(whereClause);

    const docIds = docs.map((d) => d.id);
    const firstChunkMetaByDocId = new Map<number, unknown>();

    if (docIds.length > 0) {
      const firstChunks = await this.dbService.db
        .select({
          documentId: documentChunks.documentId,
          meta: documentChunks.meta,
        })
        .from(documentChunks)
        .where(
          and(
            eq(documentChunks.userId, userId),
            inArray(documentChunks.documentId, docIds),
            eq(documentChunks.chunkIndex, 0),
          ),
        );

      for (const row of firstChunks) {
        firstChunkMetaByDocId.set(row.documentId, row.meta);
      }
    }

    let chunksInserted = 0;

    // Keep the chunking params stable (so our "up-to-date" check is meaningful).
    const chunkSize = 900;
    const overlap = 120;

    for (const d of docs) {
      const docText = (d.text ?? '').trim();
      if (!docText) {
        // still wipe existing chunks if doc became empty
        await this.dbService.db.delete(documentChunks).where(eq(documentChunks.documentId, d.id));
        continue;
      }

      const docHash = hashText(docText);

      const existingMeta = firstChunkMetaByDocId.get(d.id);
      const existingHash = readMetaString(existingMeta, 'documentTextHash');
      const existingChunkSize = readMetaNumber(existingMeta, 'chunkSize');
      const existingOverlap = readMetaNumber(existingMeta, 'overlap');

      // If unchanged + same chunk settings, skip rebuild entirely.
      if (
        existingHash &&
        existingHash === docHash &&
        existingChunkSize === chunkSize &&
        existingOverlap === overlap
      ) {
        continue;
      }

      const chunks = this.chunkText(docText, { chunkSize, overlap });

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
          documentTextHash: docHash,
          chunkSize,
          overlap,
        },
      }));

      await this.dbService.db.insert(documentChunks).values(rows);
      chunksInserted += rows.length;
    }

    return { documentsProcessed: docs.length, chunksInserted };
  }

  /**
   * Embeds chunks missing embeddings for a user.
   * If documentIds is provided, only embeds chunks belonging to those documents (prevents huge surprise bills).
   */
  async embedMissingChunksForUser(input: {
    userId: number;
    batchSize?: number;
    documentIds?: number[];
  }): Promise<{ chunksEmbedded: number; modelUsed: string | null }> {
    const userId = input.userId;
    const batchSize = clampInt(input.batchSize ?? 64, 1, 256);

    const documentIds =
      input.documentIds && input.documentIds.length ? Array.from(new Set(input.documentIds)) : null;

    if (documentIds && documentIds.length === 0) {
      return { chunksEmbedded: 0, modelUsed: this.embeddings.isConfigured() ? 'unknown' : null };
    }

    if (!this.embeddings.isConfigured()) {
      // Still “functional”: you can chunk + keyword search, but semantic search won’t work.
      return { chunksEmbedded: 0, modelUsed: null };
    }

    let chunksEmbedded = 0;
    let modelUsed: string | null = null;

    while (true) {
      const conditions = [
        eq(documentChunks.userId, userId),
        sql`${documentChunks.embedding} IS NULL`,
      ];

      if (documentIds) {
        conditions.push(inArray(documentChunks.documentId, documentIds));
      }

      const batch = await this.dbService.db
        .select({
          id: documentChunks.id,
          text: documentChunks.text,
        })
        .from(documentChunks)
        .where(and(...conditions))
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
    const k = clampInt(input.k ?? 10, 1, 25);
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

function hashText(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function readMetaString(meta: unknown, key: string): string | null {
  if (!isRecord(meta)) return null;
  const v = meta[key];
  return typeof v === 'string' ? v : null;
}

function readMetaNumber(meta: unknown, key: string): number | null {
  if (!isRecord(meta)) return null;
  const v = meta[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
