import { Injectable, Logger } from '@nestjs/common';
import { OpenAiChatService } from '../integrations/openai/openai-chat.service';
import type { OpenAiChatMessage } from '../integrations/openai/openai-chat.service';

export type AgentIntent = 'agent' | 'chat' | 'ongoing_instruction';

export type AgentIntentResult = {
  intent: AgentIntent;
  confidence: number; // 0..1
  reason: string;
  method: 'llm';
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
      return { intent: 'chat', confidence: 1, reason: 'Empty message.', method: 'llm' };
    }

    if (!this.llm.isConfigured()) {
      // Default to agent if LLM not configured - better to attempt action than ignore
      return {
        intent: 'agent',
        confidence: 0.5,
        reason: 'LLM not configured, defaulting to agent.',
        method: 'llm',
      };
    }

    const sys = `You are a router for a financial-advisor assistant.

Decide whether the user message should be handled by:
- "agent": taking ONE-TIME actions using tools, possibly waiting for replies
- "ongoing_instruction": setting up a PERSISTENT rule for FUTURE automatic actions triggered by events
- "chat": informational Q&A, explanations, or general assistance with no external actions

AVAILABLE AGENT TOOLS:
- Gmail: send_email, reply, search, get_thread
- Calendar: create_event, update_event, delete_event, find_events, get_busy_times, suggest_times
- HubSpot: create_contact, update_contact, delete_contact, find_contacts, create_note, delete_note
- Instructions: list_instructions, delete_instruction, toggle_instruction (manage ongoing instructions)
- Flow: await_user_message, await_email_reply, await_calendar_event, complete_task

SUPPORTED ONGOING INSTRUCTION TRIGGERS:
- gmail_received: When user receives an email
- gmail_sent: When user sends an email  
- calendar_event_created: When a calendar event is created
- calendar_event_updated: When a calendar event is updated
- hubspot_contact_created: When a contact is created in HubSpot
- hubspot_contact_updated: When a contact is updated
- hubspot_note_created: When a note is added to a contact

CRITICAL RULES:
1. Short replies like "1", "2", "yes", "no", "30 minutes", "2 hours", "tomorrow" in context of an active task are ALWAYS "agent".
2. "Remove instruction", "delete instruction", "list my instructions", "undo that", "I didn't mean to create that" are ALWAYS "agent" (instruction management), NOT "ongoing_instruction".
3. Only classify as "ongoing_instruction" if user explicitly wants FUTURE automatic behavior triggered by events (uses words like "when", "whenever", "from now on", "always", "every time", "if someone").

Return ONLY valid JSON:
{
  "intent": "agent" | "ongoing_instruction" | "chat",
  "confidence": number,  // 0 to 1
  "reason": string,
  "instructionText": string | null  // Only for ongoing_instruction: the cleaned instruction text
}

EXAMPLES:

"ongoing_instruction" examples:
- "When someone emails me that's not in HubSpot, create a contact" -> ongoing_instruction
- "Whenever I add a contact, send them a welcome email" -> ongoing_instruction
- "From now on, when I create a calendar event, email the attendees" -> ongoing_instruction
- "If a client emails asking about our next meeting, look it up and respond" -> ongoing_instruction
- "Always add a note when someone replies to my scheduling emails" -> ongoing_instruction

"agent" examples (one-time actions):
- "Schedule a meeting with John" -> agent
- "Send an email to Sara" -> agent
- "Create a contact for bob@example.com" -> agent
- "30 minutes" (when asked about duration) -> agent
- "1" (when asked to pick an option) -> agent
- "yes" or "confirm" (when asked to confirm) -> agent
- "Remove that instruction" -> agent
- "Delete the last instruction" -> agent
- "What instructions do I have?" -> agent
- "List my instructions" -> agent
- "I didn't mean to create that" -> agent
- "Undo that" -> agent

"chat" examples (informational):
- "Who mentioned their kid plays baseball?" -> chat
- "What did Greg say about AAPL?" -> chat
- "How many contacts do I have?" -> chat
- "What's the weather like?" -> chat
- "Explain how HubSpot works" -> chat`;

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
      if (!isRecord(parsed)) {
        this.logger.warn('Failed to parse LLM response, defaulting to agent');
        return {
          intent: 'agent',
          confidence: 0.5,
          reason: 'Failed to parse LLM response.',
          method: 'llm',
        };
      }

      const intent =
        parsed.intent === 'agent'
          ? 'agent'
          : parsed.intent === 'ongoing_instruction'
            ? 'ongoing_instruction'
            : parsed.intent === 'chat'
              ? 'chat'
              : 'agent'; // Default to agent if unknown

      const confidence =
        typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
          ? clamp01(parsed.confidence)
          : 0.8;

      const reason =
        typeof parsed.reason === 'string' ? parsed.reason.trim() : '(no reason provided)';

      const instructionText =
        intent === 'ongoing_instruction' && typeof parsed.instructionText === 'string'
          ? parsed.instructionText.trim()
          : undefined;

      return {
        intent,
        confidence,
        reason,
        method: 'llm',
        instructionText,
      };
    } catch (err: unknown) {
      this.logger.error(
        `Intent classify failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Default to agent on error - better to attempt action than ignore user
      return {
        intent: 'agent',
        confidence: 0.5,
        reason: 'LLM error, defaulting to agent.',
        method: 'llm',
      };
    }
  }
}

function safeJson(text: string): unknown {
  if (!text) return {};
  try {
    // Handle markdown code blocks
    const cleaned = text
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();
    return JSON.parse(cleaned);
  } catch {
    return {};
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
