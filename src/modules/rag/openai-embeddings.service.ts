import { Injectable } from '@nestjs/common';

type OpenAiEmbeddingResponse = {
  data?: Array<{ embedding?: number[]; index?: number }>;
  model?: string;
};

@Injectable()
export class OpenAiEmbeddingsService {
  private readonly apiKey = process.env.OPENAI_API_KEY ?? '';
  private readonly model = process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small';
  private readonly dimensions = Number(process.env.OPENAI_EMBEDDING_DIMENSIONS ?? '1536');

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Returns embeddings in the same order as inputs.
   */
  async embedMany(inputs: string[]): Promise<{ model: string; vectors: number[][] }> {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY is not set (needed for embeddings).');
    }
    if (!Number.isFinite(this.dimensions) || this.dimensions <= 0) {
      throw new Error('OPENAI_EMBEDDING_DIMENSIONS must be a positive number.');
    }

    const cleaned = inputs.map((s) => (s ?? '').trim());
    if (cleaned.some((s) => !s)) {
      throw new Error('Embeddings input contained an empty string.');
    }

    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: cleaned,
        encoding_format: 'float',
        // Supported for text-embedding-3+ per API docs
        dimensions: this.dimensions,
      }),
    });

    const text = await res.text();
    let json: unknown = {};
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      const msg = extractOpenAiErrorMessage(json) ?? `${res.status} ${res.statusText}`;
      throw new Error(`OpenAI embeddings error: ${msg}`);
    }

    const parsed = json as OpenAiEmbeddingResponse;
    const model = parsed.model ?? this.model;

    const data = Array.isArray(parsed.data) ? parsed.data : [];
    if (data.length !== cleaned.length) {
      throw new Error(
        `OpenAI embeddings returned ${data.length} items for ${cleaned.length} inputs.`,
      );
    }

    const vectors: number[][] = data.map((d, i) => {
      const v = d?.embedding;
      if (!Array.isArray(v)) throw new Error(`Embedding ${i} missing/invalid.`);
      if (v.length !== this.dimensions) {
        throw new Error(
          `Embedding ${i} length ${v.length} != expected ${this.dimensions}. ` +
            `Check OPENAI_EMBEDDING_DIMENSIONS / model.`,
        );
      }
      return v;
    });

    return { model, vectors };
  }

  async embedOne(input: string): Promise<{ model: string; vector: number[] }> {
    const { model, vectors } = await this.embedMany([input]);
    return { model, vector: vectors[0] };
  }
}

// -----------------------
// Tiny “safe” helpers (avoid any / unsafe member access)
// -----------------------
function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function extractOpenAiErrorMessage(json: unknown): string | null {
  if (!isRecord(json)) return null;

  const err = json['error'];
  if (!isRecord(err)) return null;

  const msg = err['message'];
  return typeof msg === 'string' ? msg : null;
}
