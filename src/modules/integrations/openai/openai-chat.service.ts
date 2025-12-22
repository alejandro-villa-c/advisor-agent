import { Injectable } from '@nestjs/common';

type ChatCompletionResponse = {
  choices?: Array<{
    message?: { role?: string; content?: string };
  }>;
  error?: { message?: string };
};

export type OpenAiChatMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type OpenAiChatMessage = {
  role: OpenAiChatMessageRole;
  content: string;
};

@Injectable()
export class OpenAiChatService {
  private readonly apiKey = process.env.OPENAI_API_KEY ?? '';
  private readonly model = process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini';
  private readonly timeoutMs = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS ?? '60000');

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(input: { messages: OpenAiChatMessage[]; temperature?: number }): Promise<string> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not set (needed for chat).');

    const messages = (input.messages ?? [])
      .map((m) => ({
        role: m.role,
        content: String(m.content ?? '').trim(),
      }))
      .filter((m) => Boolean(m.role) && Boolean(m.content));

    if (messages.length === 0) return '(no response)';

    const controller = new AbortController();
    const t = Number.isFinite(this.timeoutMs) && this.timeoutMs > 0 ? this.timeoutMs : 60000;
    const timeout = setTimeout(() => controller.abort(), t);

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          temperature: typeof input.temperature === 'number' ? input.temperature : 0.2,
          messages,
        }),
      });

      const text = await res.text();
      const json: unknown = safeJson(text);

      if (!res.ok) {
        const msg =
          isRecord(json) && isRecord(json.error) && typeof json.error.message === 'string'
            ? json.error.message
            : `${res.status} ${res.statusText}`;
        throw new Error(`OpenAI chat error: ${msg}`);
      }

      const parsed = json as ChatCompletionResponse;
      const content = parsed.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) return '(no response)';
      return content.trim();
    } finally {
      clearTimeout(timeout);
    }
  }
}

function safeJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
