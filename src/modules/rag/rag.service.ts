import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { DbService } from '../../db/db.service';
import { documentChunks, documents } from '../../db/schema';
import { OpenAiEmbeddingsService } from './openai-embeddings.service';

type Chunk = { text: string; meta: { start: number; end: number } };

export type RagSearchRow = {
  chunkId: number;
  documentId: number;
  title: string | null;
  source: string;
  sourceId: string;
  chunkText: string;
  distance: number | null;
};

type RankedRow = RagSearchRow & {
  rrfScore: number;
  titleTermHits: number;
  bodyTermHits: number;
};

@Injectable()
export class RagService {
  constructor(
    private readonly dbService: DbService,
    private readonly embeddings: OpenAiEmbeddingsService,
  ) {}

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

      if (end < text.length) {
        const windowStart = Math.max(start, end - 200);
        const slice = text.slice(windowStart, end);
        const lastSpace = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
        if (lastSpace > 40) end = windowStart + lastSpace;
      }

      if (end <= start) end = Math.min(start + chunkSize, text.length);

      const chunk = text.slice(start, end).trim();
      if (chunk) out.push({ text: chunk, meta: { start, end } });

      if (end >= text.length) break;
      start = Math.max(0, end - overlap);
    }

    return out;
  }

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

      for (const row of firstChunks) firstChunkMetaByDocId.set(row.documentId, row.meta);
    }

    let chunksInserted = 0;

    const chunkSize = 900;
    const overlap = 120;

    for (const d of docs) {
      const docText = (d.text ?? '').trim();
      if (!docText) {
        await this.dbService.db.delete(documentChunks).where(eq(documentChunks.documentId, d.id));
        continue;
      }

      const docHash = hashText(docText);

      const existingMeta = firstChunkMetaByDocId.get(d.id);
      const existingHash = readMetaString(existingMeta, 'documentTextHash');
      const existingChunkSize = readMetaNumber(existingMeta, 'chunkSize');
      const existingOverlap = readMetaNumber(existingMeta, 'overlap');

      if (
        existingHash &&
        existingHash === docHash &&
        existingChunkSize === chunkSize &&
        existingOverlap === overlap
      ) {
        continue;
      }

      const chunks = this.chunkText(docText, { chunkSize, overlap });

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

    if (!this.embeddings.isConfigured()) return { chunksEmbedded: 0, modelUsed: null };

    let chunksEmbedded = 0;
    let modelUsed: string | null = null;

    while (true) {
      const conditions = [
        eq(documentChunks.userId, userId),
        sql`${documentChunks.embedding} IS NULL`,
      ];
      if (documentIds) conditions.push(inArray(documentChunks.documentId, documentIds));

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
          .set({ embedding: vectors[i], embeddingModel: model })
          .where(eq(documentChunks.id, batch[i].id));
      }

      chunksEmbedded += batch.length;
      if (chunksEmbedded >= 5000) break;
    }

    return { chunksEmbedded, modelUsed };
  }

  async searchHybrid(input: {
    userId: number;
    query: string;
    take?: number;
    semanticCandidates?: number;
    lexicalCandidates?: number;
  }): Promise<RagSearchRow[]> {
    const userId = input.userId;
    const q = (input.query ?? '').trim();
    if (!q) return [];

    const take = clampInt(input.take ?? 25, 1, 5000);
    const semanticCandidates = clampInt(input.semanticCandidates ?? 300, 1, 5000);
    const lexicalCandidates = clampInt(input.lexicalCandidates ?? 300, 1, 5000);

    const terms = extractQueryTerms(q, 12);

    const semantic = await this.semanticCandidates(userId, q, semanticCandidates);
    const fts = await this.fullTextCandidates(userId, q, lexicalCandidates);
    const ilike =
      fts.length === 0 && terms.length > 0 ? await this.ilikeCandidates(userId, terms, 200) : [];

    const semanticRank = buildRankMap(semantic);
    const ftsRank = buildRankMap(fts);
    const ilikeRank = buildRankMap(ilike);

    const combined = new Map<number, RagSearchRow>();
    for (const r of semantic) combined.set(r.chunkId, r);
    for (const r of fts) if (!combined.has(r.chunkId)) combined.set(r.chunkId, r);
    for (const r of ilike) if (!combined.has(r.chunkId)) combined.set(r.chunkId, r);

    const rrfK = 60;
    const scored: RankedRow[] = [];

    for (const r of combined.values()) {
      const sRank = semanticRank.get(r.chunkId);
      const fRank = ftsRank.get(r.chunkId);
      const iRank = ilikeRank.get(r.chunkId);

      let rrfScore = 0;
      if (typeof sRank === 'number') rrfScore += 1 / (rrfK + sRank);
      if (typeof fRank === 'number') rrfScore += 1 / (rrfK + fRank);
      if (typeof iRank === 'number') rrfScore += 1 / (rrfK + iRank);

      const title = (r.title ?? '').toLowerCase();
      const body = (r.chunkText ?? '').toLowerCase();

      let titleTermHits = 0;
      let bodyTermHits = 0;

      for (const t of terms) {
        if (title.includes(t)) titleTermHits += 1;
        if (body.includes(t)) bodyTermHits += 1;
      }

      scored.push({ ...r, rrfScore, titleTermHits, bodyTermHits });
    }

    scored.sort((a, b) => {
      if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
      if (b.titleTermHits !== a.titleTermHits) return b.titleTermHits - a.titleTermHits;
      if (b.bodyTermHits !== a.bodyTermHits) return b.bodyTermHits - a.bodyTermHits;

      const ad = a.distance;
      const bd = b.distance;

      const aHas = typeof ad === 'number' && Number.isFinite(ad);
      const bHas = typeof bd === 'number' && Number.isFinite(bd);

      if (aHas && bHas) return ad - bd;
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;

      return a.chunkId - b.chunkId;
    });

    return scored.slice(0, take).map((r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      title: r.title,
      source: r.source,
      sourceId: r.sourceId,
      chunkText: r.chunkText,
      distance: r.distance,
    }));
  }

  async search(input: { userId: number; query: string; k?: number }): Promise<RagSearchRow[]> {
    const userId = input.userId;
    const q = (input.query ?? '').trim();
    const k = clampInt(input.k ?? 10, 1, 25);
    if (!q) return [];

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

  private async semanticCandidates(
    userId: number,
    query: string,
    k: number,
  ): Promise<RagSearchRow[]> {
    if (!this.embeddings.isConfigured()) return [];

    const { vector } = await this.embeddings.embedOne(query);
    const vectorLiteral = `[${vector.join(',')}]`;
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

  private async fullTextCandidates(
    userId: number,
    query: string,
    k: number,
  ): Promise<RagSearchRow[]> {
    const q = (query ?? '').trim();
    if (!q) return [];

    const vectorExpr = sql`to_tsvector('simple', coalesce(${documents.title}, '') || ' ' || ${documentChunks.text})`;
    const queryExpr = sql`plainto_tsquery('simple', ${q})`;
    const rankExpr = sql<number>`ts_rank_cd(${vectorExpr}, ${queryExpr})`;

    const rows = await this.dbService.db
      .select({
        chunkId: documentChunks.id,
        documentId: documents.id,
        title: documents.title,
        source: documents.source,
        sourceId: documents.sourceId,
        chunkText: documentChunks.text,
        rank: rankExpr,
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(and(eq(documentChunks.userId, userId), sql`${vectorExpr} @@ ${queryExpr}`))
      .orderBy(sql`${rankExpr} DESC`)
      .limit(k);

    return rows.map((r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      title: r.title,
      source: r.source,
      sourceId: r.sourceId,
      chunkText: r.chunkText,
      distance: null,
    }));
  }

  private async ilikeCandidates(
    userId: number,
    terms: string[],
    k: number,
  ): Promise<RagSearchRow[]> {
    if (terms.length === 0) return [];

    const likeClauses = terms.map((t) => {
      const pat = `%${t}%`;
      return sql`(${documentChunks.text} ILIKE ${pat} OR ${documents.title} ILIKE ${pat})`;
    });

    const whereLike = sql`(${sql.join(likeClauses, sql` OR `)})`;

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
      .where(and(eq(documentChunks.userId, userId), whereLike))
      .limit(k);

    return rows.map((r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      title: r.title,
      source: r.source,
      sourceId: r.sourceId,
      chunkText: r.chunkText,
      distance: null,
    }));
  }
}

function buildRankMap(rows: RagSearchRow[]): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < rows.length; i += 1) m.set(rows[i].chunkId, i + 1);
  return m;
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

function extractQueryTerms(input: string, maxTerms: number): string[] {
  const raw = (input ?? '').toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9]+/g, ' ');

  const parts = cleaned
    .split(' ')
    .map((x) => x.trim())
    .filter(Boolean);

  const stop = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'to',
    'of',
    'in',
    'for',
    'on',
    'at',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'with',
    'it',
    'this',
    'that',
    'i',
    'me',
    'my',
    'you',
    'your',
    'we',
    'our',
    'they',
    'their',
    'them',
    'he',
    'she',
    'his',
    'her',
    'as',
    'by',
    'from',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'can',
  ]);

  const unique: string[] = [];
  const seen = new Set<string>();

  for (const p of parts) {
    if (unique.length >= maxTerms) break;
    if (p.length < 3) continue;
    if (stop.has(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    unique.push(p);
  }

  return unique;
}
