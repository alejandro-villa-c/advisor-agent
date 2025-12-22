import { Injectable, Logger } from '@nestjs/common';
import { OpenAiChatService } from '../integrations/openai/openai-chat.service';
import type { OpenAiChatMessage } from '../integrations/openai/openai-chat.service';

export type AgentIntent = 'agent' | 'chat' | 'ongoing_instruction';

export type AgentIntentResult = {
  intent: AgentIntent;
  confidence: number; // 0..1
  reason: string;
  method: 'llm' | 'heuristic';
  // For ongoing_instruction intent, the cleaned instruction text
  instructionText?: string;
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
      `- "agent": taking actions using tools (email, calendar, HubSpot/CRM, follow-ups, scheduling, creating notes), possibly waiting for replies. ONE-TIME actions.\n` +
      `- "ongoing_instruction": setting up a PERSISTENT rule that should be remembered and applied automatically in the future when certain events happen. These are triggered by events like receiving emails, calendar changes, contact updates.\n` +
      `- "chat": informational Q&A, explanations, brainstorming, writing, or general assistance with no external actions.\n\n` +
      `Return ONLY valid JSON matching this schema:\n` +
      `{\n` +
      `  "intent": "agent" | "ongoing_instruction" | "chat",\n` +
      `  "confidence": number,  // 0 to 1\n` +
      `  "reason": string,\n` +
      `  "instructionText": string | null  // Only for ongoing_instruction: the cleaned instruction\n` +
      `}\n\n` +
      `Guidelines for "ongoing_instruction":\n` +
      `- User says "When...", "Whenever...", "If someone...", "Every time...", "Always...", "From now on..."\n` +
      `- It's about something that should happen automatically in the FUTURE\n` +
      `- Triggered by EVENTS (email received, calendar event created, contact added, etc.)\n` +
      `- Examples:\n` +
      `  - "When someone emails me that's not in HubSpot, create a contact" -> ongoing_instruction\n` +
      `  - "Whenever I add a contact, send them a welcome email" -> ongoing_instruction\n` +
      `  - "If a client asks about our next meeting, look it up and respond" -> ongoing_instruction\n` +
      `  - "From now on, when I create a calendar event, email the attendees" -> ongoing_instruction\n` +
      `  - "Always add a note when someone replies to my scheduling emails" -> ongoing_instruction\n\n` +
      `Guidelines for "agent" (one-time action):\n` +
      `- User wants something done NOW, not as a persistent rule\n` +
      `- Examples:\n` +
      `  - "Schedule a meeting with John" -> agent\n` +
      `  - "Send an email to Sara" -> agent\n` +
      `  - "Create a contact for bob@example.com" -> agent\n` +
      `  - "Follow up with my last client" -> agent\n\n` +
      `Guidelines for "chat" (informational):\n` +
      `- User is asking a question or wants information\n` +
      `- Examples:\n` +
      `  - "Who mentioned their kid plays baseball?" -> chat\n` +
      `  - "What did Greg say about AAPL?" -> chat\n` +
      `  - "How many contacts do I have?" -> chat\n`;

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

      const intent =
        parsed.intent === 'agent'
          ? 'agent'
          : parsed.intent === 'ongoing_instruction'
            ? 'ongoing_instruction'
            : 'chat';

      const confidence =
        typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
          ? clamp01(parsed.confidence)
          : 0.5;

      const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';

      const instructionText =
        intent === 'ongoing_instruction' && typeof parsed.instructionText === 'string'
          ? parsed.instructionText.trim()
          : undefined;

      // Guardrail: don't route to agent on weak signal.
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

      // Guardrail for ongoing_instruction
      if (intent === 'ongoing_instruction' && confidence < 0.6) {
        const fallback = this.classifyHeuristic(text);
        if (fallback.intent === 'ongoing_instruction') {
          return fallback;
        }
        return {
          intent: 'chat',
          confidence: Math.max(0.51, confidence),
          reason: reason || 'Ambiguous ongoing instruction; defaulting to chat.',
          method: 'llm',
        };
      }

      return {
        intent,
        confidence,
        reason: reason || '(no reason provided)',
        method: 'llm',
        instructionText,
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

    // Check for ongoing instruction patterns FIRST
    const ongoingPatterns = [
      /^when(ever)?\s+/i,
      /^if\s+(someone|a\s+client|a\s+contact|anyone|i\s+receive|i\s+get|i\s+create|i\s+add)/i,
      /^every\s+time\s+/i,
      /^always\s+/i,
      /^from\s+now\s+on/i,
      /^going\s+forward/i,
      /^in\s+the\s+future/i,
      /^automatically\s+/i,
    ];

    for (const pattern of ongoingPatterns) {
      if (pattern.test(text)) {
        return {
          intent: 'ongoing_instruction',
          confidence: 0.8,
          reason: 'Detected ongoing/conditional instruction pattern.',
          method: 'heuristic',
          instructionText: text,
        };
      }
    }

    // Check for phrases that indicate persistent behavior
    const persistentPhrases = [
      'whenever i',
      'when someone',
      'when anyone',
      'when a client',
      'when i receive',
      'when i get',
      'when i create',
      'when i add',
      'each time',
      'every time',
      'always do',
      'always send',
      'always create',
      'always add',
      'from now on',
    ];

    for (const phrase of persistentPhrases) {
      if (s.includes(phrase)) {
        return {
          intent: 'ongoing_instruction',
          confidence: 0.75,
          reason: `Detected persistent behavior phrase: "${phrase}".`,
          method: 'heuristic',
          instructionText: text,
        };
      }
    }

    // Strong action verbs / workflows for one-time agent tasks
    const strongAction = containsAny(s, [
      'schedule',
      'book',
      'set up a meeting',
      'set up meeting',
      'appointment',
      'meeting with',
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
      'create a contact',
      'add a contact',
      'hubspot',
      'crm',
      'create a note',
      'log a note',
      'remind ',
      'draft and send',
    ]);

    // Pure information questions are usually chat.
    const looksLikeInfo =
      /^\s*(what|why|how|explain|help me understand|tell me about|who|which)\b/i.test(text) &&
      !containsAny(s, [
        'email',
        'schedule',
        'book',
        'calendar',
        'hubspot',
        'follow up',
        'contact',
        'when',
        'whenever',
      ]);

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
