import { Injectable, Logger } from '@nestjs/common';
import { OpenAiChatService } from '../integrations/openai/openai-chat.service';

export type SchedulingIntent = {
  isSchedulingRequest: boolean;
  contactName: string | null;
  durationMinutes: number | null;
  preferredTimeframe: string | null;
  preferredTimeIso: string | null;
  confidence: number;
};

export type UserResponseIntent = {
  type:
    | 'approval'
    | 'rejection'
    | 'duration'
    | 'email'
    | 'cancellation'
    | 'change_contact'
    | 'other';
  approved?: boolean;
  durationMinutes?: number;
  email?: string;
  newContactName?: string;
  rawText: string;
  confidence: number;
};

export type FlowControlIntent = {
  intent: 'continue' | 'cancel' | 'change_contact' | 'restart';
  newContactName?: string;
  reason?: string;
  confidence: number;
};

export type ContactSelectionResult = {
  needsClarification: boolean;
  topCandidates: Array<{
    displayName: string;
    email: string | null;
    source: 'hubspot' | 'gmail';
    confidence: number;
  }>;
  reason?: string;
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
    if (!this.llm.isConfigured()) {
      return this.parseSchedulingGoalHeuristic(goal);
    }

    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });
    const currentHour = now.getHours();

    const systemPrompt = `You are a natural language parser for a scheduling assistant.
Analyze the user's request and extract scheduling information.

Current date/time: ${dayOfWeek}, ${today}, approximately ${currentHour}:00.

Return ONLY valid JSON matching this schema:
{
  "isSchedulingRequest": boolean,
  "contactName": string | null,
  "durationMinutes": number | null,
  "preferredTimeframe": string | null,
  "preferredTimeIso": string | null,
  "confidence": number (0-1)
}

For preferredTimeIso:
- Convert relative times to ISO 8601 format based on today's date
- "tomorrow at 3pm" -> calculate the actual date and return the ISO string
- "next Monday at 10am" -> calculate and return the ISO string
- "at 3pm" or "3 PM" (no date specified) -> assume TODAY if the time hasn't passed yet, otherwise assume TOMORROW. Return the full ISO string.
- "this afternoon" -> assume today around 14:00-15:00
- "this morning" -> assume today around 9:00-10:00
- "in the morning" -> assume today/tomorrow around 9:00
- "in the afternoon" -> assume today/tomorrow around 14:00
- Only return null if NO time preference is mentioned at all

Examples:
- "Schedule a meeting with Sara Smith" -> {"isSchedulingRequest": true, "contactName": "Sara Smith", "durationMinutes": null, "preferredTimeframe": null, "preferredTimeIso": null, "confidence": 0.95}
- "Schedule a meeting at 3pm" -> {"isSchedulingRequest": true, "contactName": null, "durationMinutes": null, "preferredTimeframe": "at 3pm", "preferredTimeIso": "${today}T15:00:00", "confidence": 0.95}
- "Book a 30 minute call with John tomorrow at 2pm" -> {"isSchedulingRequest": true, "contactName": "John", "durationMinutes": 30, "preferredTimeframe": "tomorrow at 2pm", "preferredTimeIso": "YYYY-MM-DDT14:00:00", "confidence": 0.95}
- "Set up an hour-long meeting with Dr. Jane Doe next Tuesday at 10am" -> {"isSchedulingRequest": true, "contactName": "Dr. Jane Doe", "durationMinutes": 60, "preferredTimeframe": "next Tuesday at 10am", "preferredTimeIso": "YYYY-MM-DDT10:00:00", "confidence": 0.95}
- "Can you arrange a call with Bob sometime next week?" -> {"isSchedulingRequest": true, "contactName": "Bob", "durationMinutes": null, "preferredTimeframe": "next week", "preferredTimeIso": null, "confidence": 0.85}
- "What's the weather today?" -> {"isSchedulingRequest": false, "contactName": null, "durationMinutes": null, "preferredTimeframe": null, "preferredTimeIso": null, "confidence": 0.95}
- "Meeting with John at 9am" -> {"isSchedulingRequest": true, "contactName": "John", "durationMinutes": null, "preferredTimeframe": "at 9am", "preferredTimeIso": "${today}T09:00:00", "confidence": 0.95}

Be flexible with how people phrase requests. "Set up time with", "arrange a call with", "find time to meet with", "schedule a chat with" are all scheduling requests.

IMPORTANT: When a specific time is mentioned (like "3pm", "10am", "at 2"), ALWAYS return a preferredTimeIso. Use today's date if the time hasn't passed, tomorrow if it has.`;

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
        preferredTimeIso:
          typeof parsed.preferredTimeIso === 'string'
            ? parsed.preferredTimeIso.trim() || null
            : null,
        confidence: typeof parsed.confidence === 'number' ? clamp01(parsed.confidence) : 0.5,
      };
    } catch (err) {
      this.logger.warn(`parseSchedulingGoal LLM failed, using heuristic: ${String(err)}`);
      return this.parseSchedulingGoalHeuristic(goal);
    }
  }

  /**
   * Check if the user wants to cancel the current flow or change to a different contact.
   * This should be called before processing any user response during a scheduling flow.
   */
  async parseFlowControlIntent(input: {
    userMessage: string;
    currentPhase: string;
    currentContactName?: string;
  }): Promise<FlowControlIntent> {
    if (!this.llm.isConfigured()) {
      return this.parseFlowControlHeuristic(input.userMessage);
    }

    const systemPrompt = `You are analyzing whether a user wants to continue, cancel, or change their current scheduling request.

Current state:
- Phase: ${input.currentPhase}
- Contact being scheduled with: ${input.currentContactName || 'not yet selected'}

Determine the user's intent. Return ONLY valid JSON matching this schema:
{
  "intent": "continue" | "cancel" | "change_contact" | "restart",
  "newContactName": string | null (only if intent is "change_contact"),
  "reason": string | null (brief explanation),
  "confidence": number (0-1)
}

Guidelines:
- "continue": User is providing information for the current flow (duration, approval, etc.)
- "cancel": User explicitly wants to stop/cancel/abort the scheduling process
- "change_contact": User wants to schedule with a different person instead
- "restart": User wants to start over completely

Examples:
- "never mind" -> {"intent": "cancel", "newContactName": null, "reason": "User said never mind", "confidence": 0.9}
- "cancel" -> {"intent": "cancel", "newContactName": null, "reason": "Explicit cancel", "confidence": 0.95}
- "stop" -> {"intent": "cancel", "newContactName": null, "reason": "User said stop", "confidence": 0.9}
- "forget it" -> {"intent": "cancel", "newContactName": null, "reason": "User wants to forget it", "confidence": 0.9}
- "I don't want to schedule anymore" -> {"intent": "cancel", "newContactName": null, "reason": "User no longer wants to schedule", "confidence": 0.95}
- "actually, schedule with Bob instead" -> {"intent": "change_contact", "newContactName": "Bob", "reason": "User wants different contact", "confidence": 0.95}
- "wait, I meant John Smith not Jane" -> {"intent": "change_contact", "newContactName": "John Smith", "reason": "User correcting contact name", "confidence": 0.9}
- "let's do Mike Johnson instead" -> {"intent": "change_contact", "newContactName": "Mike Johnson", "reason": "User changed mind on contact", "confidence": 0.95}
- "start over" -> {"intent": "restart", "newContactName": null, "reason": "User wants to restart", "confidence": 0.9}
- "30 minutes" -> {"intent": "continue", "newContactName": null, "reason": "User providing duration", "confidence": 0.95}
- "yes" -> {"intent": "continue", "newContactName": null, "reason": "User confirming", "confidence": 0.95}
- "looks good" -> {"intent": "continue", "newContactName": null, "reason": "User approving", "confidence": 0.95}
- "no, find different times" -> {"intent": "continue", "newContactName": null, "reason": "User wants different times but still scheduling", "confidence": 0.85}
- "their email is john@example.com" -> {"intent": "continue", "newContactName": null, "reason": "User providing email", "confidence": 0.95}

Be careful to distinguish between:
- Rejecting proposed times (intent: continue) vs canceling the whole process (intent: cancel)
- Providing alternative preferences (intent: continue) vs wanting a different contact (intent: change_contact)`;

    try {
      const raw = await this.llm.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: input.userMessage },
        ],
        temperature: 0.0,
      });

      const parsed = safeJsonParse(raw);
      if (!isRecord(parsed)) {
        return this.parseFlowControlHeuristic(input.userMessage);
      }

      const intent = ['continue', 'cancel', 'change_contact', 'restart'].includes(
        String(parsed.intent),
      )
        ? (parsed.intent as FlowControlIntent['intent'])
        : 'continue';

      return {
        intent,
        newContactName:
          typeof parsed.newContactName === 'string'
            ? parsed.newContactName.trim() || undefined
            : undefined,
        reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
        confidence: typeof parsed.confidence === 'number' ? clamp01(parsed.confidence) : 0.5,
      };
    } catch (err) {
      this.logger.warn(`parseFlowControlIntent LLM failed, using heuristic: ${String(err)}`);
      return this.parseFlowControlHeuristic(input.userMessage);
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
  "type": "approval" | "rejection" | "duration" | "email" | "cancellation" | "change_contact" | "other",
  "approved": boolean | null (only for approval/rejection),
  "durationMinutes": number | null (only if user specified a duration),
  "email": string | null (only if user provided an email),
  "newContactName": string | null (only if user wants to change contact),
  "confidence": number (0-1)
}

Examples when asked for approval:
- "yes" -> {"type": "approval", "approved": true, "durationMinutes": null, "email": null, "newContactName": null, "confidence": 0.95}
- "looks good, send it" -> {"type": "approval", "approved": true, "durationMinutes": null, "email": null, "newContactName": null, "confidence": 0.95}
- "perfect, go ahead" -> {"type": "approval", "approved": true, "durationMinutes": null, "email": null, "newContactName": null, "confidence": 0.95}
- "no, find different times" -> {"type": "rejection", "approved": false, "durationMinutes": null, "email": null, "newContactName": null, "confidence": 0.9}
- "actually, can we do earlier in the day?" -> {"type": "rejection", "approved": false, "durationMinutes": null, "email": null, "newContactName": null, "confidence": 0.85}
- "cancel this" -> {"type": "cancellation", "approved": null, "durationMinutes": null, "email": null, "newContactName": null, "confidence": 0.95}
- "never mind" -> {"type": "cancellation", "approved": null, "durationMinutes": null, "email": null, "newContactName": null, "confidence": 0.9}
- "schedule with Bob instead" -> {"type": "change_contact", "approved": null, "durationMinutes": null, "email": null, "newContactName": "Bob", "confidence": 0.95}

Examples when asked for duration:
- "30 minutes" -> {"type": "duration", "approved": null, "durationMinutes": 30, "email": null, "newContactName": null, "confidence": 0.95}
- "about an hour" -> {"type": "duration", "approved": null, "durationMinutes": 60, "email": null, "newContactName": null, "confidence": 0.9}
- "half an hour should be fine" -> {"type": "duration", "approved": null, "durationMinutes": 30, "email": null, "newContactName": null, "confidence": 0.9}
- "let's do 45 min" -> {"type": "duration", "approved": null, "durationMinutes": 45, "email": null, "newContactName": null, "confidence": 0.95}
- "forget it" -> {"type": "cancellation", "approved": null, "durationMinutes": null, "email": null, "newContactName": null, "confidence": 0.9}

Examples when asked for email:
- "sara@example.com" -> {"type": "email", "approved": null, "durationMinutes": null, "email": "sara@example.com", "newContactName": null, "confidence": 0.95}
- "her email is jane.doe@company.org" -> {"type": "email", "approved": null, "durationMinutes": null, "email": "jane.doe@company.org", "newContactName": null, "confidence": 0.95}
- "I don't have it, cancel" -> {"type": "cancellation", "approved": null, "durationMinutes": null, "email": null, "newContactName": null, "confidence": 0.85}`;

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

      const type = [
        'approval',
        'rejection',
        'duration',
        'email',
        'cancellation',
        'change_contact',
        'other',
      ].includes(String(parsed.type))
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
        newContactName:
          typeof parsed.newContactName === 'string'
            ? parsed.newContactName.trim() || undefined
            : undefined,
        rawText: userMessage,
        confidence: typeof parsed.confidence === 'number' ? clamp01(parsed.confidence) : 0.5,
      };
    } catch (err) {
      this.logger.warn(`parseUserResponse LLM failed, using heuristic: ${String(err)}`);
      return this.parseUserResponseHeuristic(userMessage);
    }
  }

  // ============ HEURISTIC FALLBACKS ============

  private parseSchedulingGoalHeuristic(goal: string): SchedulingIntent {
    const g = String(goal ?? '').toLowerCase();

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
        preferredTimeIso: null,
        confidence: 0.7,
      };
    }

    const contactName = this.extractContactNameHeuristic(goal);
    const durationMinutes = this.extractDurationHeuristic(goal);

    return {
      isSchedulingRequest: true,
      contactName,
      durationMinutes,
      preferredTimeframe: null,
      preferredTimeIso: null,
      confidence: 0.6,
    };
  }

  private extractContactNameHeuristic(goal: string): string | null {
    const g = String(goal ?? '').trim();

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

    if (/half\s*(?:an\s*)?hour/.test(s)) {
      return 30;
    }

    if (/quarter\s*(?:of\s*an?\s*)?hour/.test(s)) {
      return 15;
    }

    const minuteMatch = s.match(/(\d+)\s*(?:minute|minutes|min|mins)\b/);
    if (minuteMatch) {
      return Number(minuteMatch[1]);
    }

    const hourMatch = s.match(/(\d+)\s*(?:hour|hours|hr|hrs)\b/);
    if (hourMatch) {
      return Number(hourMatch[1]) * 60;
    }

    return null;
  }

  private parseFlowControlHeuristic(userMessage: string): FlowControlIntent {
    const s = String(userMessage ?? '')
      .trim()
      .toLowerCase();

    // Check for cancellation
    const cancelPatterns = [
      /\b(cancel|stop|abort|quit|exit|nevermind|never\s*mind|forget\s*it|don'?t\s+bother)\b/,
      /\b(i\s+don'?t\s+want\s+to|no\s+longer\s+want|not\s+anymore)\b/,
    ];

    for (const pattern of cancelPatterns) {
      if (pattern.test(s)) {
        return { intent: 'cancel', confidence: 0.8 };
      }
    }

    // Check for change contact
    const changePatterns = [
      /(?:schedule|book|meet)\s+(?:with\s+)?(.+?)\s+instead/i,
      /(?:actually|wait),?\s+(?:I\s+meant|schedule\s+with)\s+(.+)/i,
      /(?:let'?s?\s+do|switch\s+to)\s+(.+?)\s+instead/i,
    ];

    for (const pattern of changePatterns) {
      const match = userMessage.match(pattern);
      if (match && match[1]) {
        return {
          intent: 'change_contact',
          newContactName: match[1].trim(),
          confidence: 0.75,
        };
      }
    }

    // Check for restart
    if (/\b(start\s*over|restart|begin\s*again)\b/.test(s)) {
      return { intent: 'restart', confidence: 0.8 };
    }

    // Default to continue
    return { intent: 'continue', confidence: 0.7 };
  }

  private parseUserResponseHeuristic(userMessage: string): UserResponseIntent {
    const s = String(userMessage ?? '').trim();
    const lower = s.toLowerCase();

    // Check for cancellation first
    const cancelPatterns = [/\b(cancel|stop|abort|quit|nevermind|never\s*mind|forget\s*it)\b/];

    for (const pattern of cancelPatterns) {
      if (pattern.test(lower)) {
        return {
          type: 'cancellation',
          rawText: s,
          confidence: 0.8,
        };
      }
    }

    // Check for change contact
    const changePatterns = [
      /(?:schedule|book|meet)\s+(?:with\s+)?(.+?)\s+instead/i,
      /(?:actually|wait),?\s+(.+?)\s+instead/i,
    ];

    for (const pattern of changePatterns) {
      const match = s.match(pattern);
      if (match && match[1]) {
        return {
          type: 'change_contact',
          newContactName: match[1].trim(),
          rawText: s,
          confidence: 0.75,
        };
      }
    }

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

  /**
   * Use LLM to select the best contact match or determine if clarification is needed.
   */
  async selectBestContact(input: {
    queryName: string;
    candidates: Array<{
      displayName: string;
      email: string | null;
      source: 'hubspot' | 'gmail';
    }>;
  }): Promise<ContactSelectionResult> {
    if (input.candidates.length === 0) {
      return { needsClarification: false, topCandidates: [] };
    }

    if (input.candidates.length === 1) {
      return {
        needsClarification: false,
        topCandidates: [{ ...input.candidates[0], confidence: 0.9 }],
      };
    }

    // Quick check: if we have multiple candidates with different emails, we likely need clarification
    const uniqueEmails = new Set(
      input.candidates.filter((c) => c.email).map((c) => c.email!.toLowerCase()),
    );
    const hasMultipleEmails = uniqueEmails.size > 1;

    if (!this.llm.isConfigured()) {
      return this.selectBestContactHeuristic(input, hasMultipleEmails);
    }

    const candidateList = input.candidates
      .map(
        (c, i) =>
          `${i + 1}. "${c.displayName}" - email: ${c.email || 'none'} - source: ${c.source}`,
      )
      .join('\n');

    this.logger.debug(
      `selectBestContact: query="${input.queryName}", candidates:\n${candidateList}`,
    );

    const systemPrompt = `You are helping match a contact name to a list of candidates.

The user is looking for: "${input.queryName}"

Here are the candidates:
${candidateList}

Analyze the candidates and determine:
1. If there's a SINGLE clear best match (name matches exactly and there's only one valid email)
2. If multiple candidates could be the right person (ESPECIALLY if they have different emails), we MUST ask the user to clarify

IMPORTANT: If there are multiple candidates with DIFFERENT email addresses that could match the query name, you MUST set needsClarification to true. The user needs to choose which email address to use.

Return ONLY valid JSON matching this schema:
{
  "needsClarification": boolean,
  "topCandidates": [
    {
      "index": number (1-based index from the list),
      "confidence": number (0-1),
      "reason": string
    }
  ],
  "overallReason": string
}

Guidelines:
- If there are 2+ candidates with different emails that match the name well, ALWAYS set needsClarification: true
- noreply@ or automated emails should be ranked lower than personal emails
- A "via GitHub" or "via Slack" display name suggests an automated notification, not a real contact
- If one candidate is clearly a personal email (like john@gmail.com) and another is automated (noreply@github.com), prefer the personal one
- But if there are multiple plausible personal emails, ask for clarification

Examples:
- Query "Angel Reyes", candidates ["Angel Reyes (angel@gmail.com)", "Angel Reyes via GitHub (noreply@github.com)"] -> needsClarification: false, pick the gmail one (noreply is clearly automated)
- Query "Angel Reyes", candidates ["Angel Reyes (angel@gmail.com)", "Angel Reyes (angel.reyes@company.com)"] -> needsClarification: true (two valid personal emails)
- Query "John", candidates ["John Doe (john@x.com)", "John Smith (johns@y.com)"] -> needsClarification: true (different people)
- Query "Sara Smith", candidates ["Sara Smith (sara@x.com)", "Sarah Smithers (sarah@y.com)"] -> needsClarification: false, first is exact match`;

    try {
      const raw = await this.llm.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Find the best match for: "${input.queryName}"` },
        ],
        temperature: 0.0,
      });

      this.logger.debug(`selectBestContact LLM response: ${raw}`);

      const parsed = safeJsonParse(raw);
      if (!isRecord(parsed)) {
        return this.selectBestContactHeuristic(input, hasMultipleEmails);
      }

      const needsClarification = parsed.needsClarification === true;
      const topCandidatesRaw = Array.isArray(parsed.topCandidates) ? parsed.topCandidates : [];

      const topCandidates: ContactSelectionResult['topCandidates'] = [];

      for (const tc of topCandidatesRaw) {
        if (!isRecord(tc)) continue;
        const index = typeof tc.index === 'number' ? tc.index : 0;
        const confidence = typeof tc.confidence === 'number' ? clamp01(tc.confidence) : 0.5;

        const candidate = input.candidates[index - 1];
        if (!candidate) continue;

        topCandidates.push({
          displayName: candidate.displayName,
          email: candidate.email,
          source: candidate.source,
          confidence,
        });
      }

      // If LLM returned empty, fall back to heuristic
      if (topCandidates.length === 0) {
        return this.selectBestContactHeuristic(input, hasMultipleEmails);
      }

      // Safety check: if we have multiple different emails and LLM said no clarification needed,
      // but the top candidates have different emails, override and ask for clarification
      if (!needsClarification && topCandidates.length > 1) {
        const topEmails = new Set(
          topCandidates.filter((c) => c.email).map((c) => c.email!.toLowerCase()),
        );
        if (topEmails.size > 1) {
          this.logger.debug(
            'selectBestContact: LLM said no clarification but multiple different emails in top candidates, forcing clarification',
          );
          return {
            needsClarification: true,
            topCandidates,
            reason: 'Multiple candidates with different email addresses found.',
          };
        }
      }

      return {
        needsClarification,
        topCandidates,
        reason: typeof parsed.overallReason === 'string' ? parsed.overallReason : undefined,
      };
    } catch (err) {
      this.logger.warn(`selectBestContact LLM failed, using heuristic: ${String(err)}`);
      return this.selectBestContactHeuristic(input, hasMultipleEmails);
    }
  }

  private selectBestContactHeuristic(
    input: {
      queryName: string;
      candidates: Array<{
        displayName: string;
        email: string | null;
        source: 'hubspot' | 'gmail';
      }>;
    },
    hasMultipleEmails: boolean = false,
  ): ContactSelectionResult {
    const queryLower = input.queryName.toLowerCase().trim();
    const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 1);

    const scored = input.candidates.map((c) => {
      const nameLower = c.displayName.toLowerCase();
      const nameWords = nameLower.split(/\s+/).filter((w) => w.length > 1);

      let score = 0;

      // Exact match
      if (nameLower === queryLower) {
        score += 100;
      }
      // All query words present in name
      else if (queryWords.every((qw) => nameLower.includes(qw))) {
        score += 80;
      }
      // Some words match
      else {
        const matchingWords = queryWords.filter((qw) =>
          nameWords.some((nw) => nw.includes(qw) || qw.includes(nw)),
        );
        score += matchingWords.length * 20;
      }

      // Has email
      if (c.email) score += 15;

      // Penalize noreply/automated emails
      if (c.email) {
        const emailLower = c.email.toLowerCase();
        if (
          emailLower.includes('noreply') ||
          emailLower.includes('no-reply') ||
          emailLower.includes('notifications') ||
          emailLower.includes('mailer-daemon')
        ) {
          score -= 50;
        }
      }

      // Penalize "via" in display name (automated notifications)
      if (nameLower.includes(' via ')) {
        score -= 40;
      }

      // HubSpot preference
      if (c.source === 'hubspot') score += 5;

      return { candidate: c, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Filter to only good matches (score > 30)
    const goodMatches = scored.filter((s) => s.score > 30);

    // Check if we need clarification
    // Need clarification if:
    // 1. Multiple good matches with different emails, OR
    // 2. Top scores are very close
    const topScore = goodMatches[0]?.score ?? 0;
    const closeMatches = goodMatches.filter((s) => s.score >= topScore - 15);

    // Get unique emails among close matches
    const closeMatchEmails = new Set(
      closeMatches.filter((s) => s.candidate.email).map((s) => s.candidate.email!.toLowerCase()),
    );

    // Need clarification if there are multiple close matches with different emails
    const needsClarification =
      closeMatchEmails.size > 1 || (hasMultipleEmails && closeMatches.length > 1);

    return {
      needsClarification,
      topCandidates: scored.slice(0, 5).map((s) => ({
        ...s.candidate,
        confidence: Math.min(1, Math.max(0, s.score / 100)),
      })),
    };
  }
}

function safeJsonParse(text: string): unknown {
  if (!text) return null;
  try {
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
