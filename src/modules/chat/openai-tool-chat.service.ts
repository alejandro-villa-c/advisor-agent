import { Injectable } from '@nestjs/common';

export type OpenAiChatMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type OpenAiToolCall = {
  id: string;
  name: string;
  argumentsJson: string;
};

export type OpenAiChatToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type OpenAiChatMessage = {
  role: OpenAiChatMessageRole;
  content: string;

  // tool messages
  name?: string;
  tool_call_id?: string;

  // assistant messages that trigger tools
  tool_calls?: OpenAiChatToolCall[];
};

export type OpenAiToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

type ChatCompletionsResponse = {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  error?: { message?: string };
};

export type OpenAiToolChatResult =
  | { kind: 'final'; text: string }
  | { kind: 'tool_calls'; assistantText: string; toolCalls: OpenAiToolCall[] };

@Injectable()
export class OpenAiToolChatService {
  private readonly apiKey = process.env.OPENAI_API_KEY ?? '';
  private readonly model = process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini';
  private readonly timeoutMs = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS ?? '60000');

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async completeWithTools(input: {
    messages: OpenAiChatMessage[];
    tools: OpenAiToolDefinition[];
    temperature?: number;
  }): Promise<OpenAiToolChatResult> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not set (needed for tool chat).');

    const messages = (input.messages ?? [])
      .map((m) => {
        const base: Record<string, unknown> = {
          role: m.role,
          content: typeof m.content === 'string' ? m.content : '',
        };

        if (m.role === 'tool') {
          if (typeof m.name === 'string' && m.name) base.name = m.name;
          if (typeof m.tool_call_id === 'string' && m.tool_call_id)
            base.tool_call_id = m.tool_call_id;
        }

        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          base.tool_calls = m.tool_calls;
          // OpenAI allows content to be null when tool_calls exist, but '' is generally fine.
          // Keep it as string for your internal types.
        }

        return base;
      })
      .filter((m) => typeof m.role === 'string');

    if (messages.length === 0) return { kind: 'final', text: '(no response)' };

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
          tools: input.tools ?? [],
          tool_choice: 'auto',
        }),
      });

      const text = await res.text();
      const json: unknown = safeJson(text);

      if (!res.ok) {
        const msg =
          isRecord(json) && isRecord(json.error) && typeof json.error.message === 'string'
            ? json.error.message
            : `${res.status} ${res.statusText}`;
        throw new Error(`OpenAI tool chat error: ${msg}`);
      }

      const parsed = json as ChatCompletionsResponse;
      const msg = parsed.choices?.[0]?.message;

      const assistantText = typeof msg?.content === 'string' ? msg.content : '';

      const toolCallsRaw = Array.isArray(msg?.tool_calls) ? msg?.tool_calls : [];
      const toolCalls: OpenAiToolCall[] = [];

      for (const tc of toolCallsRaw) {
        const id = typeof tc?.id === 'string' ? tc.id : '';
        const name = typeof tc?.function?.name === 'string' ? tc.function.name : '';
        const args = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : '{}';
        if (id && name) toolCalls.push({ id, name, argumentsJson: args });
      }

      if (toolCalls.length > 0) {
        return { kind: 'tool_calls', assistantText: assistantText ?? '', toolCalls };
      }

      const final = (assistantText ?? '').trim();
      return { kind: 'final', text: final || '(no response)' };
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
