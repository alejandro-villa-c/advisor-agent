import { Injectable } from '@nestjs/common';

type ChatCompletionResponse = {
  choices?: Array<{
    message?: { role?: string; content?: string };
  }>;
  error?: { message?: string };
};

@Injectable()
export class OpenAiChatService {
  private readonly apiKey = process.env.OPENAI_API_KEY ?? '';
  private readonly model = process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini';

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(input: { system: string; user: string }): Promise<string> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not set (needed for chat).');

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
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
