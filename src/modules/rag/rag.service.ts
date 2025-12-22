import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { DbService } from '../../db/db.service';
import { documentChunks, documents } from '../../db/schema';
import { OpenAiEmbeddingsService } from './openai-embeddings.service';
import { OpenAiChatService } from '../integrations/openai/openai-chat.service';

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

type SearchPlan = {
  strategy: 'lexical_first' | 'semantic_first';
  searchTerms: string[];
  semanticQuery: string;
};

/**
 * RagService - Improved search quality with LLM-driven strategy selection
 */
@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    private readonly dbService: DbService,
    private readonly embeddings: OpenAiEmbeddingsService,
    private readonly llm: OpenAiChatService,
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
        await this.dbService.db
          .delete(documentChunks)
          .where(and(eq(documentChunks.userId, userId), eq(documentChunks.documentId, d.id)));
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

      await this.dbService.db.transaction(async (tx) => {
        await tx
          .delete(documentChunks)
          .where(and(eq(documentChunks.userId, userId), eq(documentChunks.documentId, d.id)));

        if (chunks.length === 0) return;

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

        await tx
          .insert(documentChunks)
          .values(rows)
          .onConflictDoNothing({
            target: [documentChunks.documentId, documentChunks.chunkIndex],
          });

        chunksInserted += rows.length;
      });
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

  /**
   * IMPROVED HYBRID SEARCH - ALWAYS DO BOTH, MERGE INTELLIGENTLY
   *
   * The LLM decides:
   * 1. Which strategy to PRIORITIZE (lexical vs semantic)
   * 2. What search terms to use
   * 3. How to rewrite the query for semantic search
   *
   * But we ALWAYS run both searches and merge results.
   * This ensures we don't miss relevant content either way.
   */
  async searchHybrid(input: {
    userId: number;
    query: string;
    take?: number;
    semanticCandidates?: number;
    lexicalCandidates?: number;
  }): Promise<RagSearchRow[]> {
    const userId = input.userId;
    const query = (input.query ?? '').trim();
    if (!query) return [];

    const take = clampInt(input.take ?? 50, 1, 500);
    const semanticK = clampInt(input.semanticCandidates ?? 300, 50, 2000);
    const lexicalK = clampInt(input.lexicalCandidates ?? 200, 50, 1000);

    this.logger.debug(`[RAG] searchHybrid query="${query}" take=${take}`);

    // Ask LLM to plan the search
    const plan = await this.planSearch(query);
    this.logger.debug(
      `[RAG] Search plan: strategy=${plan.strategy}, terms=[${plan.searchTerms.join(', ')}], semanticQuery="${plan.semanticQuery}"`,
    );

    // ALWAYS run both searches
    const [semanticResults, lexicalResults] = await Promise.all([
      this.semanticSearch(userId, plan.semanticQuery, semanticK),
      plan.searchTerms.length > 0
        ? this.lexicalSearch(userId, query, plan.searchTerms, lexicalK)
        : Promise.resolve([]),
    ]);

    this.logger.debug(`[RAG] Semantic results: ${semanticResults.length}`);
    this.logger.debug(`[RAG] Lexical results: ${lexicalResults.length}`);

    if (semanticResults.length > 0) {
      this.logger.debug(
        `[RAG] Top 3 semantic: ${semanticResults
          .slice(0, 3)
          .map((r) => `${r.title?.slice(0, 50)} (d=${r.distance?.toFixed(3)})`)
          .join(', ')}`,
      );
    }

    // Build lookup sets
    const lexicalChunkIds = new Set(lexicalResults.map((r) => r.chunkId));
    const semanticByChunkId = new Map(semanticResults.map((r) => [r.chunkId, r]));

    // Score ALL results
    type ScoredRow = RagSearchRow & {
      score: number;
      inLexical: boolean;
      inSemantic: boolean;
      termMatches: number;
    };

    const allChunkIds = new Set([
      ...semanticResults.map((r) => r.chunkId),
      ...lexicalResults.map((r) => r.chunkId),
    ]);

    const scored: ScoredRow[] = [];

    for (const chunkId of allChunkIds) {
      // Get the row from whichever search found it
      const semanticRow = semanticByChunkId.get(chunkId);
      const lexicalRow = lexicalResults.find((r) => r.chunkId === chunkId);
      const row = semanticRow ?? lexicalRow;

      if (!row) continue;

      const inLexical = lexicalChunkIds.has(chunkId);
      const inSemantic = semanticByChunkId.has(chunkId);

      // Count term matches
      const content = ((row.title ?? '') + ' ' + (row.chunkText ?? '')).toLowerCase();
      const termMatches = plan.searchTerms.filter((t) => content.includes(t.toLowerCase())).length;

      // Calculate score based on strategy
      let score = 0;

      if (plan.strategy === 'lexical_first') {
        // Lexical-first: prioritize term matches, then semantic distance
        if (inLexical) {
          score += 1.0 + termMatches * 0.2; // Base boost + term bonus
        }
        if (inSemantic && semanticRow?.distance != null) {
          score += Math.max(0, 0.5 - semanticRow.distance / 2); // Smaller semantic bonus
        }
      } else {
        // Semantic-first: prioritize semantic similarity, boost lexical matches
        if (inSemantic && semanticRow?.distance != null) {
          score += Math.max(0, 1.0 - semanticRow.distance); // Convert distance to score
        }
        if (inLexical) {
          score += 0.3 + termMatches * 0.1; // Lexical boost
        }
      }

      // Bonus for appearing in BOTH searches (strong relevance signal)
      if (inLexical && inSemantic) {
        score += 0.5;
      }

      scored.push({
        ...row,
        distance: semanticRow?.distance ?? null,
        score,
        inLexical,
        inSemantic,
        termMatches,
      });
    }

    // Sort by score (highest first)
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tie-breaker: prefer items in both searches
      if (a.inLexical && a.inSemantic && !(b.inLexical && b.inSemantic)) return -1;
      if (b.inLexical && b.inSemantic && !(a.inLexical && a.inSemantic)) return 1;
      // Then by distance if available
      const ad = a.distance ?? 1;
      const bd = b.distance ?? 1;
      return ad - bd;
    });

    // Debug output
    const inBoth = scored.filter((r) => r.inLexical && r.inSemantic).length;
    const lexicalOnly = scored.filter((r) => r.inLexical && !r.inSemantic).length;
    const semanticOnly = scored.filter((r) => !r.inLexical && r.inSemantic).length;

    this.logger.debug(
      `[RAG] Merged: ${scored.length} total (${inBoth} in both, ${lexicalOnly} lexical-only, ${semanticOnly} semantic-only)`,
    );

    if (scored.length > 0) {
      this.logger.debug(
        `[RAG] Top result: "${scored[0].title}" (score=${scored[0].score.toFixed(2)}, lexical=${scored[0].inLexical}, semantic=${scored[0].inSemantic})`,
      );
    }

    // Return top results
    const results = scored.slice(0, take).map((r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      title: r.title,
      source: r.source,
      sourceId: r.sourceId,
      chunkText: r.chunkText,
      distance: r.distance,
    }));

    this.logger.debug(`[RAG] Returning ${results.length} results`);
    return results;
  }

  /**
   * Ask the LLM to plan the search strategy
   */
  private async planSearch(query: string): Promise<SearchPlan> {
    const defaultPlan: SearchPlan = {
      strategy: 'semantic_first',
      searchTerms: extractSearchTerms(query),
      semanticQuery: query,
    };

    if (!this.llm.isConfigured()) {
      return defaultPlan;
    }

    try {
      const systemPrompt = `You are a search query planner for a RAG system that searches emails, calendar events, contacts, and notes.

Given a user query, output a JSON search plan:
{
  "strategy": "lexical_first" | "semantic_first",
  "searchTerms": ["term1", "term2", ...],
  "semanticQuery": "expanded query for embedding search"
}

STRATEGY:
- "lexical_first": Query mentions a specific person, company, or entity BY NAME
- "semantic_first": Query is about topics, concepts, categories, or aggregations

SEARCH TERMS (CRITICAL):
- Each term must be a SINGLE WORD, lowercase
- Split names into separate words: "John Smith" → ["john", "smith"]
- Include 3-10 single-word terms that would appear in relevant documents
- Think about what words would actually exist in emails, receipts, calendar events, etc.
- For multilingual content, include equivalent terms in likely languages

SEMANTIC QUERY:
- Expand with synonyms and related concepts
- Describe what the matching documents would contain

Respond with ONLY valid JSON, no markdown.`;

      const response = await this.llm.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        temperature: 0,
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

        // Post-process search terms: split any multi-word terms and lowercase
        let searchTerms: string[] = [];
        if (Array.isArray(parsed.searchTerms)) {
          for (const term of parsed.searchTerms) {
            if (typeof term === 'string') {
              // Split multi-word terms into individual words
              const words = term.toLowerCase().split(/\s+/).filter(Boolean);
              searchTerms.push(...words);
            }
          }
          // Deduplicate
          searchTerms = [...new Set(searchTerms)];
        }

        return {
          strategy: parsed.strategy === 'lexical_first' ? 'lexical_first' : 'semantic_first',
          searchTerms: searchTerms.length > 0 ? searchTerms : defaultPlan.searchTerms,
          semanticQuery:
            typeof parsed.semanticQuery === 'string' && parsed.semanticQuery.trim()
              ? parsed.semanticQuery.trim()
              : query,
        };
      }
    } catch (err) {
      this.logger.warn(
        `[RAG] Search planning failed, using defaults: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return defaultPlan;
  }

  /**
   * Pure semantic search using vector similarity
   */
  private async semanticSearch(userId: number, query: string, k: number): Promise<RagSearchRow[]> {
    if (!this.embeddings.isConfigured()) {
      this.logger.warn('[RAG] Embeddings not configured, falling back to lexical only');
      return [];
    }

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

  /**
   * Lexical search using full-text search + ILIKE fallback
   */
  private async lexicalSearch(
    userId: number,
    query: string,
    terms: string[],
    k: number,
  ): Promise<RagSearchRow[]> {
    // Try full-text search first
    const ftsResults = await this.fullTextSearch(userId, query, k);

    if (ftsResults.length >= k / 2) {
      return ftsResults;
    }

    // Supplement with ILIKE if FTS didn't find enough
    const ilikeResults = await this.ilikeSearch(userId, terms, k - ftsResults.length);

    // Merge, preferring FTS results
    const seen = new Set(ftsResults.map((r) => r.chunkId));
    const merged = [...ftsResults];

    for (const r of ilikeResults) {
      if (!seen.has(r.chunkId)) {
        merged.push(r);
        seen.add(r.chunkId);
      }
    }

    return merged.slice(0, k);
  }

  private async fullTextSearch(userId: number, query: string, k: number): Promise<RagSearchRow[]> {
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

  private async ilikeSearch(userId: number, terms: string[], k: number): Promise<RagSearchRow[]> {
    if (terms.length === 0) return [];

    // Build ILIKE clauses for each term
    const likeClauses = terms.map((t) => {
      const pat = `%${t}%`;
      return sql`(${documentChunks.text} ILIKE ${pat} OR ${documents.title} ILIKE ${pat})`;
    });

    // Use OR logic - match ANY of the terms
    // This is more permissive but ensures we find relevant content
    const whereClause = sql`(${sql.join(likeClauses, sql` OR `)})`;

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
      .where(and(eq(documentChunks.userId, userId), whereClause))
      .limit(k);

    // Score results by how many terms they match, return sorted
    const scored = rows.map((r) => {
      const content = ((r.title ?? '') + ' ' + (r.chunkText ?? '')).toLowerCase();
      let matchCount = 0;
      for (const t of terms) {
        if (content.includes(t.toLowerCase())) matchCount++;
      }
      return { ...r, matchCount };
    });

    // Sort by match count descending
    scored.sort((a, b) => b.matchCount - a.matchCount);

    return scored.map((r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      title: r.title,
      source: r.source,
      sourceId: r.sourceId,
      chunkText: r.chunkText,
      distance: null,
    }));
  }

  /**
   * Simple semantic-only search (for when you just want vector similarity)
   */
  async search(input: { userId: number; query: string; k?: number }): Promise<RagSearchRow[]> {
    const userId = input.userId;
    const q = (input.query ?? '').trim();
    const k = clampInt(input.k ?? 10, 1, 100);
    if (!q) return [];

    return this.semanticSearch(userId, q, k);
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

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

/**
 * Extract meaningful search terms from a query.
 * Used as fallback when LLM planning fails.
 */
function extractSearchTerms(input: string): string[] {
  const raw = (input ?? '').toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9'.-]+/g, ' ');

  const parts = cleaned
    .split(' ')
    .map((x) => x.trim().replace(/^[.']+|[.']+$/g, ''))
    .filter(Boolean);

  const stopwords = new Set([
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
    'what',
    'who',
    'when',
    'where',
    'why',
    'how',
    'which',
    'tell',
    'told',
    'said',
    'says',
    'say',
    'about',
    'has',
    'have',
  ]);

  const unique: string[] = [];
  const seen = new Set<string>();

  for (const p of parts) {
    if (unique.length >= 10) break;
    if (p.length < 2) continue;
    if (stopwords.has(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    unique.push(p);
  }

  return unique;
}
