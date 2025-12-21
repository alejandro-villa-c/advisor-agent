import { Injectable, Logger } from '@nestjs/common';
import { OpenAiChatService } from '../integrations/openai/openai-chat.service';

export type SchedulingIntent = {
  isSchedulingRequest: boolean;
  contactName: string | null;
  durationMinutes: number | null;
  preferredTimeframe: string | null; // e.g., "next week", "tomorrow afternoon"
  confidence: number;
};

export type UserResponseIntent = {
  type: 'approval' | 'rejection' | 'duration' | 'email' | 'other';
  approved?: boolean;
  durationMinutes?: number;
  email?: string;
  rawText: string;
  confidence: number;
};

@Injectable()
export class AgentNlpService {
  private readonly logger = new Logger(AgentNlpService.name);

  constructor(private readonly llm: OpenAiChatService) {}

  /**
   * Analyze a user's goal to determine if it's a scheduling request
   * and extract relevant entities.
   */
  async parseSchedulingGoal(goal: string): Promise<SchedulingIntent> {
    // Fast fallback if LLM not configured
    if (!this.llm.isConfigured()) {
      return this.parseSchedulingGoalHeuristic(goal);
    }

    const systemPrompt = `You are a natural language parser for a scheduling assistant.
Analyze the user's request and extract scheduling information.

Return ONLY valid JSON matching this schema:
{
  "isSchedulingRequest": boolean,
  "contactName": string | null,
  "durationMinutes": number | null,
  "preferredTimeframe": string | null,
  "confidence": number (0-1)
}

Examples:
- "Schedule a meeting with Sara Smith" -> {"isSchedulingRequest": true, "contactName": "Sara Smith", "durationMinutes": null, "preferredTimeframe": null, "confidence": 0.95}
- "Book a 30 minute call with John next week" -> {"isSchedulingRequest": true, "contactName": "John", "durationMinutes": 30, "preferredTimeframe": "next week", "confidence": 0.95}
- "Set up an hour-long meeting with Dr. Jane Doe tomorrow afternoon" -> {"isSchedulingRequest": true, "contactName": "Dr. Jane Doe", "durationMinutes": 60, "preferredTimeframe": "tomorrow afternoon", "confidence": 0.95}
- "Can you arrange a call with the marketing team?" -> {"isSchedulingRequest": true, "contactName": "the marketing team", "durationMinutes": null, "preferredTimeframe": null, "confidence": 0.85}
- "What's the weather today?" -> {"isSchedulingRequest": false, "contactName": null, "durationMinutes": null, "preferredTimeframe": null, "confidence": 0.95}
- "Send an email to Bob" -> {"isSchedulingRequest": false, "contactName": null, "durationMinutes": null, "preferredTimeframe": null, "confidence": 0.9}

Be flexible with how people phrase requests. "Set up time with", "arrange a call with", "find time to meet with", "schedule a chat with" are all scheduling requests.`;

    try {
      const raw = await this.llm.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: goal },
        ],
        temperature: 0.0,
      });

      const parsed = safeJsonParse(raw);
      if (!isRecord(parsed)) {
        return this.parseSchedulingGoalHeuristic(goal);
      }

      return {
        isSchedulingRequest: parsed.isSchedulingRequest === true,
        contactName:
          typeof parsed.contactName === 'string' ? parsed.contactName.trim() || null : null,
        durationMinutes:
          typeof parsed.durationMinutes === 'number' && parsed.durationMinutes > 0
            ? parsed.durationMinutes
            : null,
        preferredTimeframe:
          typeof parsed.preferredTimeframe === 'string'
            ? parsed.preferredTimeframe.trim() || null
            : null,
        confidence: typeof parsed.confidence === 'number' ? clamp01(parsed.confidence) : 0.5,
      };
    } catch (err) {
      this.logger.warn(`parseSchedulingGoal LLM failed, using heuristic: ${err}`);
      return this.parseSchedulingGoalHeuristic(goal);
    }
  }

  /**
   * Analyze a user's response in the context of what the agent asked for.
   */
  async parseUserResponse(input: {
    userMessage: string;
    agentAskedFor: 'duration' | 'approval' | 'email' | 'general';
  }): Promise<UserResponseIntent> {
    const { userMessage, agentAskedFor } = input;

    // Fast fallback if LLM not configured
    if (!this.llm.isConfigured()) {
      return this.parseUserResponseHeuristic(userMessage);
    }

    const contextHint = {
      duration: 'The assistant just asked the user how long the meeting should be.',
      approval:
        'The assistant just showed the user some proposed time slots and asked if they look good to send.',
      email: 'The assistant just asked the user for an email address.',
      general: 'The assistant is waiting for user input.',
    }[agentAskedFor];

    const systemPrompt = `You are analyzing a user's response to an assistant.
${contextHint}

Determine what the user is communicating and extract any relevant information.

Return ONLY valid JSON matching this schema:
{
  "type": "approval" | "rejection" | "duration" | "email" | "other",
  "approved": boolean | null (only for approval/rejection),
  "durationMinutes": number | null (only if user specified a duration),
  "email": string | null (only if user provided an email),
  "confidence": number (0-1)
}

Examples when asked for approval:
- "yes" -> {"type": "approval", "approved": true, "durationMinutes": null, "email": null, "confidence": 0.95}
- "looks good, send it" -> {"type": "approval", "approved": true, "durationMinutes": null, "email": null, "confidence": 0.95}
- "perfect, go ahead" -> {"type": "approval", "approved": true, "durationMinutes": null, "email": null, "confidence": 0.95}
- "no, find different times" -> {"type": "rejection", "approved": false, "durationMinutes": null, "email": null, "confidence": 0.9}
- "actually, can we do earlier in the day?" -> {"type": "rejection", "approved": false, "durationMinutes": null, "email": null, "confidence": 0.85}

Examples when asked for duration:
- "30 minutes" -> {"type": "duration", "approved": null, "durationMinutes": 30, "email": null, "confidence": 0.95}
- "about an hour" -> {"type": "duration", "approved": null, "durationMinutes": 60, "email": null, "confidence": 0.9}
- "half an hour should be fine" -> {"type": "duration", "approved": null, "durationMinutes": 30, "email": null, "confidence": 0.9}
- "let's do 45 min" -> {"type": "duration", "approved": null, "durationMinutes": 45, "email": null, "confidence": 0.95}

Examples when asked for email:
- "sara@example.com" -> {"type": "email", "approved": null, "durationMinutes": null, "email": "sara@example.com", "confidence": 0.95}
- "her email is jane.doe@company.org" -> {"type": "email", "approved": null, "durationMinutes": null, "email": "jane.doe@company.org", "confidence": 0.95}`;

    try {
      const raw = await this.llm.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.0,
      });

      const parsed = safeJsonParse(raw);
      if (!isRecord(parsed)) {
        return this.parseUserResponseHeuristic(userMessage);
      }

      const type = ['approval', 'rejection', 'duration', 'email', 'other'].includes(
        String(parsed.type),
      )
        ? (parsed.type as UserResponseIntent['type'])
        : 'other';

      return {
        type,
        approved: typeof parsed.approved === 'boolean' ? parsed.approved : undefined,
        durationMinutes:
          typeof parsed.durationMinutes === 'number' && parsed.durationMinutes > 0
            ? parsed.durationMinutes
            : undefined,
        email:
          typeof parsed.email === 'string' && parsed.email.includes('@')
            ? parsed.email.trim()
            : undefined,
        rawText: userMessage,
        confidence: typeof parsed.confidence === 'number' ? clamp01(parsed.confidence) : 0.5,
      };
    } catch (err) {
      this.logger.warn(`parseUserResponse LLM failed, using heuristic: ${err}`);
      return this.parseUserResponseHeuristic(userMessage);
    }
  }

  // ============ HEURISTIC FALLBACKS ============

  private parseSchedulingGoalHeuristic(goal: string): SchedulingIntent {
    const g = String(goal ?? '').toLowerCase();

    // Check if it's a scheduling request
    const schedulingVerbs = ['schedule', 'book', 'set up', 'arrange', 'find time', 'plan'];
    const meetingWords = ['meeting', 'call', 'chat', 'appointment', 'session', 'sync'];

    const hasSchedulingVerb = schedulingVerbs.some((v) => g.includes(v));
    const hasMeetingWord = meetingWords.some((w) => g.includes(w));
    const hasWithPerson = /\bwith\s+\w+/.test(g);

    const isSchedulingRequest =
      (hasSchedulingVerb && hasMeetingWord) || (hasSchedulingVerb && hasWithPerson);

    if (!isSchedulingRequest) {
      return {
        isSchedulingRequest: false,
        contactName: null,
        durationMinutes: null,
        preferredTimeframe: null,
        confidence: 0.7,
      };
    }

    // Extract contact name
    const contactName = this.extractContactNameHeuristic(goal);

    // Extract duration
    const durationMinutes = this.extractDurationHeuristic(goal);

    return {
      isSchedulingRequest: true,
      contactName,
      durationMinutes,
      preferredTimeframe: null,
      confidence: 0.6,
    };
  }

  private extractContactNameHeuristic(goal: string): string | null {
    const g = String(goal ?? '').trim();

    // More flexible patterns
    const patterns = [
      /(?:schedule|book|set\s*up|arrange|plan)\s+(?:a\s+)?(?:meeting|call|chat|appointment|session|sync|time)\s+with\s+(.+?)(?:\s+for\s+\d|\s+at\s+|\s+on\s+|\s+next\s+|\s+tomorrow|\s+this\s+|$)/i,
      /(?:find\s+time|meet)\s+with\s+(.+?)(?:\s+for\s+\d|\s+at\s+|\s+on\s+|\s+next\s+|\s+tomorrow|\s+this\s+|$)/i,
      /with\s+(.+?)(?:\s+for\s+\d|\s+at\s+|\s+on\s+|\s+next\s+|\s+tomorrow|\s+this\s+|$)/i,
    ];

    for (const pattern of patterns) {
      const m = g.match(pattern);
      if (m && m[1]) {
        return m[1]
          .trim()
          .replace(/[.?!,]+$/g, '')
          .trim();
      }
    }

    return null;
  }

  private extractDurationHeuristic(text: string): number | null {
    const s = String(text ?? '').toLowerCase();

    // Patterns for duration
    const patterns: Array<{ regex: RegExp; multiplier: number }> = [
      { regex: /(\d+)\s*(?:minute|minutes|min|mins)\b/, multiplier: 1 },
      { regex: /(\d+)\s*(?:hour|hours|hr|hrs)\b/, multiplier: 60 },
      { regex: /half\s*(?:an\s*)?hour/, multiplier: 30 }, // Special case
      { regex: /quarter\s*(?:of\s*an?\s*)?hour/, multiplier: 15 }, // Special case
    ];

    // Check for "half hour" first
    if (/half\s*(?:an\s*)?hour/.test(s)) {
      return 30;
    }

    if (/quarter\s*(?:of\s*an?\s*)?hour/.test(s)) {
      return 15;
    }

    for (const { regex, multiplier } of patterns) {
      const m = s.match(regex);
      if (m && m[1]) {
        return Number(m[1]) * multiplier;
      }
    }

    return null;
  }

  private parseUserResponseHeuristic(userMessage: string): UserResponseIntent {
    const s = String(userMessage ?? '').trim();
    const lower = s.toLowerCase();

    // Check for email
    const emailMatch = s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (emailMatch) {
      return {
        type: 'email',
        email: emailMatch[0],
        rawText: s,
        confidence: 0.9,
      };
    }

    // Check for duration
    const duration = this.extractDurationHeuristic(s);
    if (duration !== null) {
      return {
        type: 'duration',
        durationMinutes: duration,
        rawText: s,
        confidence: 0.8,
      };
    }

    // Check for approval/rejection
    const approvalWords = [
      'yes',
      'yep',
      'yeah',
      'ok',
      'okay',
      'sure',
      'approved',
      'approve',
      'confirm',
      'confirmed',
      'looks good',
      'look good',
      'good',
      'go ahead',
      'send',
      'perfect',
      'great',
      'sounds good',
      'works for me',
    ];
    const rejectionWords = [
      'no',
      'nope',
      'nah',
      'different',
      'other',
      'change',
      'not these',
      "doesn't work",
      "don't work",
      "won't work",
      'cannot',
      "can't",
    ];

    const hasApproval = approvalWords.some((w) => lower.includes(w));
    const hasRejection = rejectionWords.some((w) => lower.includes(w));

    if (hasApproval && !hasRejection) {
      return {
        type: 'approval',
        approved: true,
        rawText: s,
        confidence: 0.75,
      };
    }

    if (hasRejection) {
      return {
        type: 'rejection',
        approved: false,
        rawText: s,
        confidence: 0.75,
      };
    }

    return {
      type: 'other',
      rawText: s,
      confidence: 0.3,
    };
  }
}

function safeJsonParse(text: string): unknown {
  if (!text) return null;
  try {
    // Handle potential markdown code blocks
    const cleaned = text
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
