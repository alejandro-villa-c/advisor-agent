import { Injectable, Logger } from '@nestjs/common';
import { OpenAiChatService } from '../integrations/openai/openai-chat.service';
import { GmailApiService } from '../integrations/google/gmail-api.service';
import { CalendarApiService } from '../integrations/google/calendar-api.service';
import { HubspotApiService } from '../integrations/hubspot/hubspot-api.service';
import { InstructionsService, InstructionRow } from './instructions.service';
import { WebSocketEmitterService } from '../websocket/websocket-emitter.service';

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
    private readonly wsEmitter: WebSocketEmitterService,
  ) {}

  /**
   * Process a trigger event against user's active instructions.
   * Each instruction is evaluated independently - multiple instructions can act on the same trigger.
   */
  async processTrigger(
    userId: number,
    trigger: TriggerEvent,
    instructions: InstructionRow[],
  ): Promise<void> {
    if (instructions.length === 0) return;

    // Safety: Check for self-loop (agent's own actions)
    if (this.isSelfGeneratedTrigger(userId, trigger)) {
      this.logger.debug(`[InstructionExecutor] Skipping self-generated trigger: ${trigger.type}`);
      return;
    }

    // Process each instruction independently against this trigger
    // This allows multiple instructions to act on the same trigger
    for (const instruction of instructions) {
      // Check rate limit before each instruction
      const rateLimit = await this.instructionsService.checkRateLimit(userId);
      if (!rateLimit.allowed) {
        this.logger.warn(
          `[InstructionExecutor] User ${userId} hit rate limit (${rateLimit.remaining} remaining)`,
        );
        return;
      }

      // Check if this specific instruction already processed this trigger
      const triggerKey = `${trigger.type}:${trigger.summary}:inst${instruction.id}`;
      const alreadyProcessed = await this.instructionsService.isTriggerProcessed(
        userId,
        trigger.type,
        triggerKey,
      );
      if (alreadyProcessed) {
        this.logger.debug(
          `[InstructionExecutor] Instruction ${instruction.id} already processed trigger: ${trigger.type}`,
        );
        continue;
      }

      // Process this single instruction against the trigger
      await this.processInstructionForTrigger(userId, trigger, instruction);
    }
  }

  /**
   * Process a single instruction against a trigger event.
   * Supports multi-step execution for instructions that need to gather data first.
   */
  private async processInstructionForTrigger(
    userId: number,
    trigger: TriggerEvent,
    instruction: InstructionRow,
  ): Promise<void> {
    // Multi-step execution loop
    // Some instructions require gathering data first, then acting on it
    // e.g., "look up calendar events, then email the results"
    const maxSteps = 3; // Prevent infinite loops
    const stepContext: Record<string, unknown> = {}; // Accumulated results from previous steps
    let step = 0;

    while (step < maxSteps) {
      step++;

      this.logger.debug(
        `[InstructionExecutor] Instruction ${instruction.id} - Step ${step}/${maxSteps} - Context keys: ${Object.keys(stepContext).join(', ') || 'none'}`,
      );

      // Ask LLM to plan actions for this single instruction
      const plan = await this.planActionsForInstruction(userId, trigger, instruction, stepContext);

      if (!plan.shouldAct || plan.actions.length === 0) {
        if (step === 1) {
          this.logger.debug(`[InstructionExecutor] No action needed for trigger: ${trigger.type}`);
        }
        break; // No more actions needed
      }

      this.logger.log(
        `[InstructionExecutor] Step ${step}: Executing ${plan.actions.length} action(s) for trigger: ${trigger.type}`,
      );

      // Track if any action in this step gathered data (needs re-planning)
      let gatheredData = false;

      // Execute the planned actions
      for (const action of plan.actions) {
        // Log the action as "running"
        const actionLogId = await this.instructionsService.logProactiveAction({
          userId,
          instructionId: plan.matchingInstructionId,
          instructionText: plan.matchingInstructionText ?? '',
          triggerType: trigger.type,
          triggerSummary: trigger.summary,
          triggerData: trigger.data,
          actionTaken: `${action.tool}: ${action.description}`,
          status: 'running',
        });

        // Emit WebSocket event for new activity
        await this.wsEmitter.emitActivityLog(userId, {
          id: actionLogId,
          triggerType: trigger.type,
          triggerSummary: trigger.summary,
          instructionText: plan.matchingInstructionText ?? '',
          actionTaken: `${action.tool}: ${action.description}`,
          status: 'running',
        });

        try {
          const result = await this.executeAction(userId, action);

          // Track created resources to prevent self-triggered loops
          if (result && typeof result === 'object') {
            const resourceId = result.contactId || result.eventId || result.noteId;
            if (resourceId && typeof resourceId === 'string') {
              this.instructionsService.trackCreatedResource(userId, resourceId);
            }
          }

          // Update log to completed
          await this.instructionsService.updateProactiveAction(actionLogId, {
            status: 'completed',
            actionResult: result,
          });

          // Emit WebSocket event for completed action
          await this.wsEmitter.emitActivityLog(userId, {
            id: actionLogId,
            triggerType: trigger.type,
            triggerSummary: trigger.summary,
            instructionText: plan.matchingInstructionText ?? '',
            actionTaken: `${action.tool}: ${action.description}`,
            status: 'completed',
          });

          // Increment rate limit counter
          await this.instructionsService.incrementRateLimit(userId);

          // Check if this was a data-gathering action
          // If so, store the result and flag for re-planning
          if (this.isDataGatheringAction(action.tool)) {
            stepContext[action.tool] = result;
            stepContext.lastActionResult = result;
            gatheredData = true;
            this.logger.debug(
              `[InstructionExecutor] Data gathered from ${action.tool}, will re-plan for next step`,
            );
          }
        } catch (err) {
          this.logger.error(
            `[InstructionExecutor] Action failed: ${err instanceof Error ? err.message : String(err)}`,
          );

          const errorMessage = err instanceof Error ? err.message : String(err);

          // Update log to failed
          await this.instructionsService.updateProactiveAction(actionLogId, {
            status: 'failed',
            error: errorMessage,
          });

          // Emit WebSocket event for failed action
          await this.wsEmitter.emitActivityLog(userId, {
            id: actionLogId,
            triggerType: trigger.type,
            triggerSummary: trigger.summary,
            instructionText: plan.matchingInstructionText ?? '',
            actionTaken: `${action.tool}: ${action.description}`,
            status: 'failed',
            error: errorMessage,
          });

          // Don't continue with more steps if an action failed
          return;
        }
      }

      // If we gathered data, continue to next step for re-planning
      // Otherwise, we're done
      if (!gatheredData) {
        break;
      }
    }
  }

  /**
   * Check if an action is a data-gathering action that should trigger re-planning
   */
  private isDataGatheringAction(tool: string): boolean {
    const dataGatheringTools = [
      'calendar_find_events',
      'gmail_search',
      'gmail_get_thread',
      'hubspot_find_contact',
      'hubspot_get_contact',
    ];
    return dataGatheringTools.includes(tool);
  }

  /**
   * Use LLM to determine if a SINGLE instruction applies to a trigger and plan actions.
   * This is used when processing instructions independently.
   */
  private async planActionsForInstruction(
    _userId: number,
    trigger: TriggerEvent,
    instruction: InstructionRow,
    stepContext: Record<string, unknown> = {},
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

    const triggerDescription = `
Type: ${trigger.type}
Summary: ${trigger.summary}
Details: ${JSON.stringify(trigger.data, null, 2)}
    `.trim();

    // Build context section if we have data from previous steps
    const hasContext = Object.keys(stepContext).length > 0;
    const contextSection = hasContext
      ? `
PREVIOUS STEP RESULTS (use this data to complete the instruction):
${JSON.stringify(stepContext, null, 2)}

IMPORTANT: You already gathered the data above. Now use it to complete the remaining action (e.g., send an email with the information).
`
      : '';

    const systemPrompt = `You are an AI assistant that evaluates if a specific instruction applies to a trigger event and plans appropriate actions.

TRIGGER EVENT:
${triggerDescription}

INSTRUCTION TO EVALUATE:
"${instruction.instruction}"
${contextSection}
AVAILABLE TOOLS:

**Gmail:**
- gmail_send_email: Send a new email. REQUIRED: to, subject, bodyText. Optional: cc, bcc
- gmail_reply: Reply to an email thread. REQUIRED: threadId, bodyText
- gmail_search: Search emails. Params: query, maxResults?
- gmail_get_thread: Get full thread content. Params: threadId

**Calendar:**
- calendar_create_event: Create event. REQUIRED: summary, startIso, endIso. Optional: description, attendees (array of email strings)
- calendar_update_event: Update event. REQUIRED: eventId. Optional: summary, startIso, endIso, description
- calendar_delete_event: Delete event. REQUIRED: eventId
- calendar_find_events: Search events. Optional: query, attendeeEmail, timeMinIso, timeMaxIso, maxResults

**HubSpot:**
- hubspot_create_contact: Create contact. REQUIRED: email. Optional: firstName, lastName
- hubspot_update_contact: Update contact. REQUIRED: contactId. Optional: email, firstName, lastName, company, phone
- hubspot_delete_contact: Delete contact. REQUIRED: contactId
- hubspot_get_contact: Get contact. Params: contactId OR email
- hubspot_find_contact: Search contacts. Params: query, maxResults?
- hubspot_find_or_create_contact: Find existing or create new contact. REQUIRED: email. Optional: firstName, lastName, noteBody
- hubspot_create_note: Add note to contact. REQUIRED: contactId, body
- hubspot_delete_note: Delete note. REQUIRED: noteId

TASK: Determine if this specific instruction applies to the trigger event.

TRIGGER MATCHING RULES:
The current trigger is: "${trigger.type}"

Only match if the instruction's "when" condition matches this trigger type:
- gmail_received → "when I receive an email", "when someone emails me", "when a client emails"
- gmail_sent → "when I send an email"
- calendar_event_created → "when I add/create a calendar event", "when I schedule a meeting"
- calendar_event_updated → "when I update a calendar event"
- hubspot_contact_created → "when I create a contact in HubSpot", "when I add a contact"
- hubspot_note_created → "when I add a note to a contact"

If the instruction's trigger condition does NOT match "${trigger.type}", set shouldAct to false.

MULTI-STEP WORKFLOWS:
- Some instructions require gathering data first, then acting on it
- Example: "look up calendar events, then email the results" requires:
  Step 1: calendar_find_events (gather data)
  Step 2: gmail_send_email (act on the data)
- If you need to gather data first, return ONLY the data-gathering action
- When PREVIOUS STEP RESULTS contains data, use it to complete the final action
- Data-gathering tools: calendar_find_events, gmail_search, gmail_get_thread, hubspot_find_contact, hubspot_get_contact

CONTENT GENERATION RULES:
- NEVER use placeholders like [Your Name], [Company], [Date], etc.
- For emails: write complete, ready-to-send content
- Sign emails simply with "Best regards" - do NOT add a name placeholder
- Use actual values from trigger data (attendee names, event titles, dates, etc.)
- For calendar events: use ISO 8601 format for dates (e.g., "2025-12-22T10:00:00Z")
- If the instruction says "1 hour from now", calculate the actual time based on current context

CURRENT TIME CONTEXT:
The current time should be inferred from the trigger event timestamp or recent context.
For relative times like "1 hour from now", calculate from the email's sent time or current moment.

Return ONLY valid JSON:
{
  "shouldAct": boolean,
  "reasoning": string,
  "actions": [
    {
      "tool": string,
      "description": string,
      "params": { ... }
    }
  ]
}`;

    try {
      const raw = await this.llm.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: 'Does this instruction apply to the trigger? If yes, plan the actions.',
          },
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
        matchingInstructionId: shouldAct ? instruction.id : null,
        matchingInstructionText: shouldAct ? instruction.instruction : null,
        actions,
        reasoning,
      };
    } catch (err) {
      this.logger.error(
        `[InstructionExecutor] planActionsForInstruction failed: ${err instanceof Error ? err.message : String(err)}`,
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
   * Check if this trigger was generated by the agent itself (to prevent loops)
   */
  private isSelfGeneratedTrigger(userId: number, trigger: TriggerEvent): boolean {
    // Check for self-sent emails
    if (trigger.type === 'gmail_received') {
      const data = trigger.data;

      // Check if this is flagged as sent by us (from the worker)
      if (data.isSent === true) {
        return true;
      }

      // Check for markers that indicate automated emails
      const snippet = safeString(data.snippet).toLowerCase();
      const subject = safeString(data.subject).toLowerCase();

      if (snippet.includes('[sent by ai assistant]') || subject.includes('[automated]')) {
        return true;
      }
    }

    // Check if this trigger is for a resource we recently created
    // This prevents loops like: email → create contact → contact_created trigger → try to create again
    if (
      trigger.type === 'hubspot_contact_created' ||
      trigger.type === 'hubspot_contact_updated' ||
      trigger.type === 'hubspot_note_created' ||
      trigger.type === 'calendar_event_created' ||
      trigger.type === 'calendar_event_updated'
    ) {
      const resourceId = safeString(
        trigger.data.contactId || trigger.data.eventId || trigger.data.noteId,
      );
      if (resourceId) {
        // Check if we created this resource in recent actions (last 5 minutes)
        const wasCreatedByUs = this.instructionsService.wasResourceCreatedByAgent(
          userId,
          resourceId,
          5 * 60 * 1000, // 5 minute window
        );
        if (wasCreatedByUs) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Use LLM to determine what actions (if any) should be taken
   * @param stepContext - Results from previous steps (for multi-step execution)
   */
  private async planActions(
    _userId: number,
    trigger: TriggerEvent,
    instructions: InstructionRow[],
    stepContext: Record<string, unknown> = {},
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

    // Build context section if we have data from previous steps
    const hasContext = Object.keys(stepContext).length > 0;
    const contextSection = hasContext
      ? `
PREVIOUS STEP RESULTS (use this data to complete the instruction):
${JSON.stringify(stepContext, null, 2)}

IMPORTANT: You already gathered the data above. Now use it to complete the remaining action (e.g., send an email with the information).
`
      : '';

    const systemPrompt = `You are an AI assistant that evaluates trigger events against user-defined instructions and plans appropriate actions.

TRIGGER EVENT:
${triggerDescription}

USER'S ACTIVE INSTRUCTIONS:
${instructionsList}
${contextSection}
AVAILABLE TOOLS:

**Gmail:**
- gmail_send_email: Send a new email. REQUIRED: to, subject, bodyText. Optional: cc, bcc
- gmail_reply: Reply to an email thread. REQUIRED: threadId, bodyText
- gmail_search: Search emails. Params: query, maxResults?
- gmail_get_thread: Get full thread content. Params: threadId

**Calendar:**
- calendar_create_event: Create event. REQUIRED: summary, startIso, endIso. Optional: description, attendees
- calendar_update_event: Update event. REQUIRED: eventId. Optional: summary, startIso, endIso, description
- calendar_delete_event: Delete event. REQUIRED: eventId
- calendar_find_events: Search events. Optional: query, attendeeEmail, timeMinIso, timeMaxIso, maxResults

**HubSpot:**
- hubspot_create_contact: Create contact. REQUIRED: email. Optional: firstName, lastName
- hubspot_update_contact: Update contact. REQUIRED: contactId. Optional: email, firstName, lastName, company, phone
- hubspot_delete_contact: Delete contact. REQUIRED: contactId
- hubspot_get_contact: Get contact. Params: contactId OR email
- hubspot_find_contact: Search contacts. Params: query, maxResults?
- hubspot_find_or_create_contact: Find existing or create new contact. REQUIRED: email. Optional: firstName, lastName, noteBody
- hubspot_create_note: Add note to contact. REQUIRED: contactId, body
- hubspot_delete_note: Delete note. REQUIRED: noteId

GUIDELINES:
- Match trigger events to instructions based on intent, not just keywords
- Only act when an instruction clearly applies TO THIS SPECIFIC TRIGGER TYPE
- Generate appropriate content for required fields (email body, subject, notes, etc.)
- Use data from the trigger event to populate action parameters
- For gmail_received triggers: sender info is in sender.email, sender.firstName, sender.lastName, sender.name
- Skip automated emails (noreply@, notifications, newsletters, system-generated)
- When in doubt, don't act

MULTI-STEP WORKFLOWS:
- Some instructions require gathering data first, then acting on it
- Example: "look up calendar events, then email the results" requires:
  Step 1: calendar_find_events (gather data)
  Step 2: gmail_send_email (act on the data)
- If you need to gather data first, return ONLY the data-gathering action
- After data is gathered, you'll be called again with the results in PREVIOUS STEP RESULTS
- When PREVIOUS STEP RESULTS contains data, use it to complete the final action (e.g., compose and send the email)
- Data-gathering tools: calendar_find_events, gmail_search, gmail_get_thread, hubspot_find_contact, hubspot_get_contact

CRITICAL TRIGGER MATCHING RULES:
The current trigger is: "${trigger.type}"

ONLY match instructions whose "when" condition matches this trigger type:
- gmail_received → "when I receive an email", "when someone emails me", "when a client emails"
- gmail_sent → "when I send an email"
- calendar_event_created → "when I add/create a calendar event", "when I schedule a meeting"
- calendar_event_updated → "when I update a calendar event"
- calendar_event_deleted → "when I delete a calendar event"  
- hubspot_contact_created → "when I create a contact in HubSpot", "when I add a contact"
- hubspot_contact_updated → "when I update a contact in HubSpot"
- hubspot_note_created → "when I add a note to a contact"

STRICT RULES:
- If trigger is "${trigger.type}", ONLY instructions about that specific trigger type can match
- calendar_event_created triggers CANNOT match instructions about HubSpot contacts
- hubspot_contact_created triggers CANNOT match instructions about emails or calendar
- gmail_received triggers CANNOT match instructions about creating contacts (unless the instruction says "when I receive an email... create a contact")
- When in doubt, set shouldAct to false

CONTENT GENERATION RULES:
- NEVER use placeholders like [Your Name], [Company], [Date], etc.
- If you don't have specific information, write naturally without it or use generic phrasing
- For emails: write complete, ready-to-send content using only available data
- Sign emails simply with "Best regards" or similar - do NOT add a name placeholder
- Use actual values from trigger data (attendee names, event titles, dates, etc.)
- Keep generated content professional, concise, and natural

Return ONLY valid JSON:
{
  "shouldAct": boolean,
  "matchingInstructionIndex": number | null,  // 1-based index from the instruction list above, or null if no match
  "reasoning": string,
  "actions": [
    {
      "tool": string,
      "description": string,
      "params": { ... }
    }
  ]
}

IMPORTANT: If shouldAct is true, matchingInstructionIndex MUST be the 1-based index (1, 2, 3...) of the matching instruction from the list above.`;

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
      let matchingIndex =
        typeof parsed.matchingInstructionIndex === 'number'
          ? parsed.matchingInstructionIndex
          : null;

      // Fallback: if shouldAct is true but no valid index, and there's only one instruction, use it
      if (
        shouldAct &&
        (matchingIndex === null || matchingIndex === 0) &&
        instructions.length === 1
      ) {
        matchingIndex = 1;
      }

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
      // =========================================================================
      // GMAIL TOOLS
      // =========================================================================
      case 'gmail_send_email': {
        const result = await this.gmailApi.sendEmail(userId, {
          to: safeString(params.to),
          subject: safeString(params.subject),
          bodyText: safeString(params.bodyText),
          cc: safeStringOrUndefined(params.cc),
          bcc: safeStringOrUndefined(params.bcc),
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

      case 'gmail_search': {
        const query = safeString(params.query);
        const maxResults = safeNumber(params.maxResults, 10);
        const results = await this.gmailApi.listMessageIds(userId, { q: query, maxResults });
        return { success: true, messageIds: results };
      }

      case 'gmail_get_thread': {
        const threadId = safeString(params.threadId);
        const messages = await this.gmailApi.getThreadMessages(userId, threadId);
        return { success: true, messages };
      }

      // =========================================================================
      // CALENDAR TOOLS
      // =========================================================================
      case 'calendar_create_event': {
        const attendeesRaw = params.attendees;
        const attendees = Array.isArray(attendeesRaw)
          ? attendeesRaw
              .map((a) => {
                if (typeof a === 'string') return { email: a };
                if (isRecord(a)) {
                  return {
                    email: safeString(a.email),
                    displayName: safeStringOrUndefined(a.displayName),
                  };
                }
                return null;
              })
              .filter((a): a is { email: string; displayName?: string } => a !== null && !!a.email)
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

      case 'calendar_delete_event': {
        const eventId = safeString(params.eventId);
        await this.calendarApi.deleteEvent(userId, eventId);
        return { success: true, eventId, deleted: true };
      }

      case 'calendar_find_events': {
        const query = safeStringOrUndefined(params.query);
        const attendeeEmail = safeStringOrUndefined(params.attendeeEmail);
        const timeMinIso = safeStringOrUndefined(params.timeMinIso) ?? new Date().toISOString();
        const timeMaxIso =
          safeStringOrUndefined(params.timeMaxIso) ??
          new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        const maxResults = safeNumber(params.maxResults, 10);

        const events = await this.calendarApi.findEvents(userId, {
          query,
          attendeeEmail,
          timeMinIso,
          timeMaxIso,
          maxResults,
        });
        return { success: true, events };
      }

      // =========================================================================
      // HUBSPOT TOOLS
      // =========================================================================
      case 'hubspot_create_contact': {
        const result = await this.hubspotApi.createContact(userId, {
          email: safeString(params.email),
          firstName: safeStringOrUndefined(params.firstName),
          lastName: safeStringOrUndefined(params.lastName),
        });
        return { success: true, contactId: result.id };
      }

      case 'hubspot_update_contact': {
        const contactId = safeString(params.contactId);
        const result = await this.hubspotApi.updateContact(userId, contactId, {
          email: safeStringOrUndefined(params.email),
          firstName: safeStringOrUndefined(params.firstName),
          lastName: safeStringOrUndefined(params.lastName),
          company: safeStringOrUndefined(params.company),
          phone: safeStringOrUndefined(params.phone),
        });
        return { success: true, contactId: result.id };
      }

      case 'hubspot_delete_contact': {
        const contactId = safeString(params.contactId);
        await this.hubspotApi.deleteContact(userId, contactId);
        return { success: true, contactId, deleted: true };
      }

      case 'hubspot_get_contact': {
        const contactId = safeStringOrUndefined(params.contactId);
        const email = safeStringOrUndefined(params.email);

        if (contactId) {
          const contact = await this.hubspotApi.getContact(userId, contactId);
          return { success: true, contact };
        } else if (email) {
          const contacts = await this.hubspotApi.searchContacts(userId, email, 1);
          const contact = contacts.find((c) => c.email?.toLowerCase() === email.toLowerCase());
          return { success: true, contact: contact ?? null, found: !!contact };
        } else {
          throw new Error('Either contactId or email is required');
        }
      }

      case 'hubspot_find_contact': {
        const query = safeString(params.query);
        const maxResults = safeNumber(params.maxResults, 10);
        const contacts = await this.hubspotApi.searchContacts(userId, query, maxResults);
        return { success: true, contacts };
      }

      case 'hubspot_find_or_create_contact': {
        const email = safeString(params.email);
        const firstName = safeStringOrUndefined(params.firstName);
        const lastName = safeStringOrUndefined(params.lastName);
        const noteBody = safeStringOrUndefined(params.noteBody);

        if (!email) {
          throw new Error('Email is required for hubspot_find_or_create_contact');
        }

        // Use the existing findOrCreateContactByEmail method
        const result = await this.hubspotApi.findOrCreateContactByEmail(userId, {
          email,
          firstName,
          lastName,
        });

        // Add note if requested
        let noteId: string | null = null;
        if (noteBody && result.id) {
          const noteResult = await this.hubspotApi.createNoteOnContact(userId, {
            contactId: result.id,
            body: noteBody,
          });
          noteId = noteResult.noteId;
        }

        return {
          success: true,
          contactId: result.id,
          wasCreated: result.created,
          alreadyExisted: !result.created,
          noteId,
        };
      }

      case 'hubspot_create_note': {
        const result = await this.hubspotApi.createNoteOnContact(userId, {
          contactId: safeString(params.contactId),
          body: safeString(params.body),
        });
        return { success: true, noteId: result.noteId };
      }

      case 'hubspot_delete_note': {
        const noteId = safeString(params.noteId);
        await this.hubspotApi.deleteNote(userId, noteId);
        return { success: true, noteId, deleted: true };
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

function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function safeStringOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function safeNumber(value: unknown, defaultValue: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return defaultValue;
}
