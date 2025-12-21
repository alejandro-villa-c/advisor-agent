import { Injectable, Logger } from '@nestjs/common';
import { OpenAiChatService } from '../integrations/openai/openai-chat.service';
import type { OpenAiChatMessage } from '../integrations/openai/openai-chat.service';

export type AgentIntent = 'agent' | 'chat';

export type AgentIntentResult = {
  intent: AgentIntent;
  confidence: number; // 0..1
  reason: string;
  method: 'llm' | 'heuristic';
};

@Injectable()
export class AgentIntentService {
  private readonly logger = new Logger(AgentIntentService.name);

  constructor(private readonly llm: OpenAiChatService) {}

  async classify(input: {
    userText: string;
    history: OpenAiChatMessage[];
  }): Promise<AgentIntentResult> {
    const text = String(input.userText ?? '').trim();
    if (!text) {
      return { intent: 'chat', confidence: 0.2, reason: 'Empty message.', method: 'heuristic' };
    }

    // If LLM is not configured, fall back to deterministic routing.
    if (!this.llm.isConfigured()) return this.classifyHeuristic(text);

    const sys =
      `You are a router for a financial-advisor assistant.\n` +
      `Decide whether the user message should be handled by:\n` +
      `- "agent": taking actions using tools (email, calendar, HubSpot/CRM, follow-ups, scheduling, creating notes), possibly waiting for replies.\n` +
      `- "chat": informational Q&A, explanations, brainstorming, writing, or general assistance with no external actions.\n\n` +
      `Return ONLY valid JSON matching this schema:\n` +
      `{\n` +
      `  "intent": "agent" | "chat",\n` +
      `  "confidence": number,  // 0 to 1\n` +
      `  "reason": string\n` +
      `}\n\n` +
      `Guidelines:\n` +
      `- If the user asks to schedule/book/set up a meeting, email someone, follow up, add something to calendar, update HubSpot, or do a multi-step workflow => "agent".\n` +
      `- If the user is asking "what is/why/how" or wants an explanation/advice only => "chat".\n` +
      `- If ambiguous, prefer "chat" unless there is a clear action request.\n`;

    const recent = (input.history ?? [])
      .slice(-12)
      .map((m) => `${m.role.toUpperCase()}: ${String(m.content ?? '').trim()}`)
      .filter(Boolean)
      .join('\n');

    const user =
      `Conversation context (most recent last):\n${recent || '(none)'}\n\n` +
      `Latest user message:\n${text}\n`;

    try {
      const raw = await this.llm.complete({
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        temperature: 0.0,
      });

      const parsed = safeJson(raw);
      if (!isRecord(parsed)) return this.classifyHeuristic(text);

      const intent = parsed.intent === 'agent' ? 'agent' : 'chat';
      const confidence =
        typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
          ? clamp01(parsed.confidence)
          : 0.5;
      const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';

      // Guardrail: don’t route to agent on weak signal.
      if (intent === 'agent' && confidence < 0.55) {
        const fallback = this.classifyHeuristic(text);
        return fallback.intent === 'agent'
          ? fallback
          : {
              intent: 'chat',
              confidence: Math.max(0.51, confidence),
              reason: reason || 'Ambiguous; defaulting to chat.',
              method: 'llm',
            };
      }

      return {
        intent,
        confidence,
        reason: reason || '(no reason provided)',
        method: 'llm',
      };
    } catch (err: unknown) {
      this.logger.warn(
        `Intent classify failed; using heuristic. ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.classifyHeuristic(text);
    }
  }

  private classifyHeuristic(text: string): AgentIntentResult {
    const s = text.toLowerCase();

    // Strong action verbs / workflows.
    const strongAction = containsAny(s, [
      'schedule',
      'book',
      'set up a meeting',
      'set up meeting',
      'appointment',
      'meeting',
      'follow up',
      'email ',
      'send an email',
      'reply to',
      'reach out',
      'contact ',
      'call ',
      'text ',
      'add to calendar',
      'create event',
      'calendar',
      'hubspot',
      'crm',
      'create a note',
      'log a note',
      'remind ',
      'draft and send',
    ]);

    // Pure information questions are usually chat.
    const looksLikeInfo =
      /^\s*(what|why|how|explain|help me understand|tell me about)\b/i.test(text) &&
      !containsAny(s, ['email', 'schedule', 'book', 'calendar', 'hubspot', 'follow up', 'contact']);

    if (strongAction && !looksLikeInfo) {
      return {
        intent: 'agent',
        confidence: 0.75,
        reason: 'Detected an action/workflow request.',
        method: 'heuristic',
      };
    }

    return {
      intent: 'chat',
      confidence: 0.65,
      reason: 'Looks like an informational request.',
      method: 'heuristic',
    };
  }
}

function safeJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function containsAny(haystack: string, needles: string[]): boolean {
  for (const n of needles) {
    if (haystack.includes(n)) return true;
  }
  return false;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
