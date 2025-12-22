import { Injectable, Logger } from '@nestjs/common';
import { OpenAiChatService } from '../integrations/openai/openai-chat.service';
import { GmailApiService } from '../integrations/google/gmail-api.service';
import { CalendarApiService } from '../integrations/google/calendar-api.service';
import { HubspotApiService } from '../integrations/hubspot/hubspot-api.service';
import { InstructionsService, InstructionRow } from './instructions.service';

export type TriggerEvent = {
  type:
    | 'gmail_received'
    | 'gmail_sent'
    | 'calendar_event_created'
    | 'calendar_event_updated'
    | 'calendar_event_deleted'
    | 'hubspot_contact_created'
    | 'hubspot_contact_updated'
    | 'hubspot_contact_deleted'
    | 'hubspot_note_created'
    | 'hubspot_note_deleted';
  summary: string;
  data: Record<string, unknown>;
};

type ActionPlan = {
  shouldAct: boolean;
  matchingInstructionId: number | null;
  matchingInstructionText: string | null;
  actions: Array<{
    tool: string;
    description: string;
    params: Record<string, unknown>;
  }>;
  reasoning: string;
};

@Injectable()
export class InstructionExecutorService {
  private readonly logger = new Logger(InstructionExecutorService.name);

  constructor(
    private readonly llm: OpenAiChatService,
    private readonly instructionsService: InstructionsService,
    private readonly gmailApi: GmailApiService,
    private readonly calendarApi: CalendarApiService,
    private readonly hubspotApi: HubspotApiService,
  ) {}

  /**
   * Process a trigger event against user's active instructions.
   * Uses LLM to determine if any instruction applies and what action to take.
   */
  async processTrigger(
    userId: number,
    trigger: TriggerEvent,
    instructions: InstructionRow[],
  ): Promise<void> {
    if (instructions.length === 0) return;

    // Check rate limit
    const rateLimit = await this.instructionsService.checkRateLimit(userId);
    if (!rateLimit.allowed) {
      this.logger.warn(
        `[InstructionExecutor] User ${userId} hit rate limit (${rateLimit.remaining} remaining)`,
      );
      return;
    }

    // Ask LLM to plan actions
    const plan = await this.planActions(userId, trigger, instructions);

    if (!plan.shouldAct) {
      this.logger.debug(`[InstructionExecutor] No action needed for trigger: ${trigger.type}`);
      return;
    }

    this.logger.log(
      `[InstructionExecutor] Executing ${plan.actions.length} action(s) for trigger: ${trigger.type}`,
    );

    // Execute the planned actions
    for (const action of plan.actions) {
      // Log the action as "running"
      await this.instructionsService.logProactiveAction({
        userId,
        instructionId: plan.matchingInstructionId,
        instructionText: plan.matchingInstructionText ?? '',
        triggerType: trigger.type,
        triggerSummary: trigger.summary,
        triggerData: trigger.data,
        actionTaken: `${action.tool}: ${action.description}`,
        status: 'running',
      });

      try {
        const result = await this.executeAction(userId, action);

        // Log success
        await this.instructionsService.logProactiveAction({
          userId,
          instructionId: plan.matchingInstructionId,
          instructionText: plan.matchingInstructionText ?? '',
          triggerType: trigger.type,
          triggerSummary: trigger.summary,
          actionTaken: `${action.tool}: ${action.description}`,
          actionResult: result,
          status: 'completed',
        });

        // Increment rate limit counter
        await this.instructionsService.incrementRateLimit(userId);
      } catch (err) {
        this.logger.error(
          `[InstructionExecutor] Action failed: ${err instanceof Error ? err.message : String(err)}`,
        );

        await this.instructionsService.logProactiveAction({
          userId,
          instructionId: plan.matchingInstructionId,
          instructionText: plan.matchingInstructionText ?? '',
          triggerType: trigger.type,
          triggerSummary: trigger.summary,
          actionTaken: `${action.tool}: ${action.description}`,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Use LLM to determine what actions (if any) should be taken
   */
  private async planActions(
    _userId: number,
    trigger: TriggerEvent,
    instructions: InstructionRow[],
  ): Promise<ActionPlan> {
    if (!this.llm.isConfigured()) {
      return {
        shouldAct: false,
        matchingInstructionId: null,
        matchingInstructionText: null,
        actions: [],
        reasoning: 'LLM not configured',
      };
    }

    const instructionsList = instructions
      .map((inst, i) => `${i + 1}. [ID:${inst.id}] "${inst.instruction}"`)
      .join('\n');

    const triggerDescription = `
Type: ${trigger.type}
Summary: ${trigger.summary}
Details: ${JSON.stringify(trigger.data, null, 2)}
    `.trim();

    const systemPrompt = `You are evaluating whether any ongoing instructions apply to a trigger event.

TRIGGER EVENT:
${triggerDescription}

USER'S ACTIVE INSTRUCTIONS:
${instructionsList}

AVAILABLE TOOLS:
- gmail_send_email: Send an email (params: to, subject, bodyText, cc?, bcc?, threadId?, inReplyToMessageId?)
- gmail_reply: Reply to an email thread (params: threadId, bodyText)
- calendar_create_event: Create a calendar event (params: summary, startIso, endIso, description?, attendees?)
- calendar_update_event: Update a calendar event (params: eventId, summary?, startIso?, endIso?, description?)
- hubspot_create_contact: Create a HubSpot contact (params: email, firstName?, lastName?)
- hubspot_create_note: Create a note on a contact (params: contactId, body)
- hubspot_find_contact: Search for a contact by email (params: email)

Analyze the trigger and determine:
1. Does ANY instruction apply to this trigger?
2. If yes, what specific action(s) should be taken?

Return ONLY valid JSON:
{
  "shouldAct": boolean,
  "matchingInstructionIndex": number | null,  // 1-based index
  "reasoning": string,
  "actions": [
    {
      "tool": string,
      "description": string,  // Human-readable description of what we're doing
      "params": { ... }  // Tool-specific parameters
    }
  ]
}

IMPORTANT RULES:
- Only act if an instruction CLEARLY applies to this trigger
- Don't act on routine/automated emails (notifications, newsletters, etc.)
- Don't create duplicate contacts if the email already exists in HubSpot
- Be conservative - when in doubt, don't act
- If replying to email, keep it professional and brief
- Consider the INTENT behind the instruction, not just literal matching

EXAMPLES:

Instruction: "When someone emails me that's not in HubSpot, create a contact"
Trigger: gmail_received from "john@newclient.com"
-> Should check if contact exists first, then create if not found

Instruction: "When I create a calendar event, email attendees about the meeting"
Trigger: calendar_event_created with attendees ["sara@x.com"]
-> Should send email to attendees

Instruction: "When a client asks about our next meeting, look it up and respond"
Trigger: gmail_received asking "When is our next call?"
-> This is complex - might need multiple steps (calendar lookup + email reply)
   For now, skip complex multi-step scenarios or handle simply`;

    try {
      const raw = await this.llm.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Analyze and plan actions.' },
        ],
        temperature: 0.0,
      });

      const parsed = safeJsonParse(raw);
      if (!isRecord(parsed)) {
        return {
          shouldAct: false,
          matchingInstructionId: null,
          matchingInstructionText: null,
          actions: [],
          reasoning: 'Failed to parse LLM response',
        };
      }

      const shouldAct = parsed.shouldAct === true;
      const matchingIndex =
        typeof parsed.matchingInstructionIndex === 'number'
          ? parsed.matchingInstructionIndex
          : null;

      const matchingInstruction =
        matchingIndex !== null && matchingIndex >= 1 && matchingIndex <= instructions.length
          ? instructions[matchingIndex - 1]
          : null;

      const actions = Array.isArray(parsed.actions)
        ? parsed.actions
            .filter((a): a is Record<string, unknown> => isRecord(a))
            .map((a) => ({
              tool: typeof a.tool === 'string' ? a.tool : '',
              description: typeof a.description === 'string' ? a.description : '',
              params: isRecord(a.params) ? a.params : {},
            }))
            .filter((a) => a.tool)
        : [];

      const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';

      return {
        shouldAct,
        matchingInstructionId: matchingInstruction?.id ?? null,
        matchingInstructionText: matchingInstruction?.instruction ?? null,
        actions,
        reasoning,
      };
    } catch (err) {
      this.logger.error(
        `[InstructionExecutor] planActions failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        shouldAct: false,
        matchingInstructionId: null,
        matchingInstructionText: null,
        actions: [],
        reasoning: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Execute a single action
   */
  private async executeAction(
    userId: number,
    action: { tool: string; description: string; params: Record<string, unknown> },
  ): Promise<Record<string, unknown>> {
    const { tool, params } = action;

    switch (tool) {
      case 'gmail_send_email': {
        const result = await this.gmailApi.sendEmail(userId, {
          to: safeString(params.to),
          subject: safeString(params.subject),
          bodyText: safeString(params.bodyText),
          cc: safeStringOrUndefined(params.cc),
          bcc: safeStringOrUndefined(params.bcc),
          threadId: safeStringOrUndefined(params.threadId),
          inReplyToMessageId: safeStringOrUndefined(params.inReplyToMessageId),
        });
        return { success: true, result };
      }

      case 'gmail_reply': {
        const threadId = safeString(params.threadId);
        const bodyText = safeString(params.bodyText);

        // Get thread info for proper reply
        const messages = await this.gmailApi.getThreadMessages(userId, threadId);
        const lastMessage = messages[messages.length - 1];

        const result = await this.gmailApi.sendEmail(userId, {
          to: lastMessage?.headers.from ?? '',
          subject: lastMessage?.headers.subject
            ? `Re: ${lastMessage.headers.subject.replace(/^Re:\s*/i, '')}`
            : 'Re:',
          bodyText,
          threadId,
          inReplyToMessageId: lastMessage?.headers.messageId,
        });
        return { success: true, result };
      }

      case 'calendar_create_event': {
        const attendeesRaw = params.attendees;
        const attendees = Array.isArray(attendeesRaw)
          ? attendeesRaw
              .filter((a): a is Record<string, unknown> => isRecord(a))
              .map((a) => ({
                email: safeString(a.email),
                displayName: safeStringOrUndefined(a.displayName),
              }))
              .filter((a) => a.email)
          : undefined;

        const result = await this.calendarApi.createEvent(userId, {
          summary: safeString(params.summary),
          startIso: safeString(params.startIso),
          endIso: safeString(params.endIso),
          description: safeStringOrUndefined(params.description),
          attendees,
        });
        return { success: true, eventId: result.id };
      }

      case 'calendar_update_event': {
        const result = await this.calendarApi.updateEvent(userId, {
          eventId: safeString(params.eventId),
          summary: safeStringOrUndefined(params.summary),
          startIso: safeStringOrUndefined(params.startIso),
          endIso: safeStringOrUndefined(params.endIso),
          description: safeStringOrUndefined(params.description),
        });
        return { success: true, eventId: result.id };
      }

      case 'hubspot_create_contact': {
        const result = await this.hubspotApi.createContact(userId, {
          email: safeString(params.email),
          firstName: safeStringOrUndefined(params.firstName),
          lastName: safeStringOrUndefined(params.lastName),
        });
        return { success: true, contactId: result.id };
      }

      case 'hubspot_create_note': {
        const result = await this.hubspotApi.createNoteOnContact(userId, {
          contactId: safeString(params.contactId),
          body: safeString(params.body),
        });
        return { success: true, noteId: result.noteId };
      }

      case 'hubspot_find_contact': {
        const email = safeString(params.email);
        const contacts = await this.hubspotApi.searchContacts(userId, email, 1);
        const found = contacts.find((c) => c.email?.toLowerCase() === email.toLowerCase());
        return {
          success: true,
          found: !!found,
          contact: found ?? null,
        };
      }

      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

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

/**
 * Safely convert unknown value to string
 */
function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Safely convert unknown value to string or undefined
 */
function safeStringOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}
