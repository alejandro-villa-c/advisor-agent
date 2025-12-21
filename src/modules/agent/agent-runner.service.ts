import { Injectable, Logger } from '@nestjs/common';
import { AgentToolsService } from './agent-tools.service';
import { AgentSyncedDataToolsService } from './agent-synced-data-tools.service';
import { AgentTasksService, type AgentTaskRow } from './agent-tasks.service';
import type {
  OpenAiChatMessage,
  OpenAiToolCall,
  OpenAiChatToolCall,
} from '../integrations/openai/openai-tool-chat.service';
import { OpenAiToolChatService } from '../integrations/openai/openai-tool-chat.service';
import { GmailApiService } from '../integrations/google/gmail-api.service';
import { CalendarApiService } from '../integrations/google/calendar-api.service';
import { HubspotApiService } from '../integrations/hubspot/hubspot-api.service';
import { PgBossService } from '../../jobs/pgboss.service';
import { AGENT_REACT_JOB } from '../../jobs/job.constants';
import { AgentNlpService } from './agent-nlp.service';

type ProposedSlot = {
  label: string;
  startIso: string;
  endIso: string;
};

type ToolResult =
  | { kind: 'ok'; output: Record<string, unknown> }
  | { kind: 'await'; output: Record<string, unknown>; userVisiblePrompt?: string }
  | { kind: 'error'; error: string };

@Injectable()
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);

  constructor(
    private readonly openAi: OpenAiToolChatService,
    private readonly agentTools: AgentToolsService,
    private readonly syncedDataTools: AgentSyncedDataToolsService,
    private readonly tasks: AgentTasksService,
    private readonly gmailApi: GmailApiService,
    private readonly calendarApi: CalendarApiService,
    private readonly hubspotApi: HubspotApiService,
    private readonly pgBoss: PgBossService,
    private readonly nlp: AgentNlpService,
  ) {}

  async runTask(taskId: number): Promise<void> {
    const task = await this.tasks.getTask(taskId);
    if (!task) {
      this.logger.warn(`[agent] task not found taskId=${taskId}`);
      return;
    }

    try {
      if (task.status === 'completed' || task.status === 'failed') return;

      if (!this.openAi.isConfigured()) {
        await this.tasks.setStatus(taskId, 'failed', 'OPENAI_API_KEY is not set.');
        return;
      }

      await this.tasks.setWaiting(taskId, null);
      await this.tasks.setStatus(taskId, 'running', null);

      // Check if this is a scheduling task and handle the multi-step flow
      const schedulingResult = await this.handleSchedulingFlow(taskId, task);
      if (schedulingResult !== 'not_scheduling') {
        return;
      }

      // Fall back to general LLM-driven agent loop
      const systemPrompt = this.agentTools.buildSystemPrompt({
        goal: task.goal,
        memory: task.memory,
      });
      const toolDefs = this.agentTools.getToolDefinitions();

      const history = await this.tasks.getMessagesForOpenAi(taskId);
      const messages: OpenAiChatMessage[] = [{ role: 'system', content: systemPrompt }, ...history];

      const maxTurns = 12;
      const maxToolCallsTotal = 20;

      let toolCallsUsed = 0;

      for (let turn = 0; turn < maxTurns; turn += 1) {
        const resp = await this.openAi.completeWithTools({
          messages,
          tools: toolDefs,
          temperature: 0.2,
        });

        if (resp.kind === 'final') {
          const text = resp.text.trim();
          if (text) {
            await this.tasks.appendMessage({
              taskId,
              userId: task.userId,
              role: 'assistant',
              content: text,
            });
          } else {
            await this.tasks.appendMessage({
              taskId,
              userId: task.userId,
              role: 'assistant',
              content: 'Done.',
            });
          }

          await this.tasks.setStatus(taskId, 'completed', null);
          return;
        }

        const toolCalls: OpenAiChatToolCall[] = resp.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argumentsJson },
        }));

        const assistantText = resp.assistantText?.trim() ?? '';

        await this.tasks.appendMessage({
          taskId,
          userId: task.userId,
          role: 'assistant',
          content: assistantText,
        });

        messages.push({
          role: 'assistant',
          content: assistantText,
          tool_calls: toolCalls,
        });

        for (const tc of resp.toolCalls) {
          toolCallsUsed += 1;
          if (toolCallsUsed > maxToolCallsTotal) {
            await this.tasks.setStatus(taskId, 'failed', 'Too many tool calls in one run.');
            return;
          }

          const toolRes = await this.handleToolCall(taskId, task.userId, tc);

          if (toolRes.kind === 'error') {
            await this.tasks.setStatus(taskId, 'failed', toolRes.error);
            return;
          }

          const toolOutputText = safeJsonStringify(toolRes.output);

          await this.tasks.appendMessage({
            taskId,
            userId: task.userId,
            role: 'tool',
            content: toolOutputText,
            toolName: tc.name,
            toolCallId: tc.id,
          });

          messages.push({
            role: 'tool',
            name: tc.name,
            tool_call_id: tc.id,
            content: toolOutputText,
          });

          if (toolRes.kind === 'await') {
            if (toolRes.userVisiblePrompt?.trim()) {
              await this.tasks.appendMessage({
                taskId,
                userId: task.userId,
                role: 'assistant',
                content: toolRes.userVisiblePrompt.trim(),
              });
            }

            await this.tasks.setStatus(taskId, 'waiting', null);
            return;
          }
        }
      }

      await this.tasks.setStatus(taskId, 'failed', 'Max turns reached without completion.');
    } finally {
      await this.enqueueReact(taskId);
    }
  }

  private async enqueueReact(taskId: number): Promise<void> {
    try {
      await this.pgBoss.client.send(
        AGENT_REACT_JOB,
        { taskId },
        {
          singletonKey: `agent.react:${taskId}`,
          singletonSeconds: 30,
        },
      );
    } catch (err: unknown) {
      this.logger.warn(
        `[${AGENT_REACT_JOB}] enqueue failed taskId=${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Handles the multi-step scheduling flow:
   * 1. Check if it's a scheduling request (via NLP)
   * 2. Find contact
   * 3. Ask user for duration (if not specified)
   * 4. Find available slots
   * 5. Show slots to user for approval
   * 6. Send email to contact with options
   * 7. Wait for contact reply
   * 8. Handle contact response (including "none work")
   */
  private async handleSchedulingFlow(
    taskId: number,
    task: AgentTaskRow,
  ): Promise<'not_scheduling' | 'handled'> {
    const mem = task.memory ?? {};
    const meeting = isRecord(mem['meeting']) ? mem['meeting'] : null;
    const phase = meeting ? (typeof meeting['phase'] === 'string' ? meeting['phase'] : null) : null;

    // Get the latest user message to understand context
    const uiMessages = await this.tasks.getMessagesForUi(taskId);
    const lastUser = [...uiMessages].reverse().find((m) => m.role === 'user');

    // PHASE: Initial request - use NLP to parse and find contact
    if (!meeting) {
      return await this.startSchedulingFlow(taskId, task);
    }

    // PHASE: Waiting for duration from user
    if (phase === 'need_duration') {
      return await this.handleDurationResponse(taskId, task, lastUser?.content ?? '');
    }

    // PHASE: Waiting for user approval of proposed slots
    if (phase === 'need_user_approval') {
      return await this.handleUserApprovalResponse(taskId, task, lastUser?.content ?? '');
    }

    // PHASE: Waiting for contact reply
    if (phase === 'waiting_contact_reply') {
      return await this.handleContactReply(taskId, task, lastUser?.content ?? '');
    }

    return 'not_scheduling';
  }

  private async startSchedulingFlow(
    taskId: number,
    task: AgentTaskRow,
  ): Promise<'handled' | 'not_scheduling'> {
    // Use NLP to parse the goal
    const parsed = await this.nlp.parseSchedulingGoal(task.goal);

    if (!parsed.isSchedulingRequest || parsed.confidence < 0.5) {
      return 'not_scheduling';
    }

    const contactName = parsed.contactName;
    if (!contactName) {
      // Ask user to clarify who they want to meet with
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I'd be happy to help schedule a meeting. Who would you like to meet with?`,
      });

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          phase: 'need_contact',
        },
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'Who would you like to meet with?',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    // Search for the contact in HubSpot
    const matches = await this.syncedDataTools.findHubspotContactsLocal({
      userId: task.userId,
      query: contactName,
      limit: 10,
    });

    const best = pickBestContact(matches, contactName);
    if (!best) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I couldn't find a contact matching "${contactName}" in HubSpot. Could you provide their email address?`,
      });

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          phase: 'need_duration',
          contact: {
            name: contactName,
            email: null,
            hubspotContactId: null,
          },
        },
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: `Please provide the email address for ${contactName}.`,
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    if (!best.email) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I found "${best.displayName}" in HubSpot, but they don't have an email address on file. Please provide their email address.`,
      });

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          phase: 'need_duration',
          contact: {
            name: best.displayName,
            email: null,
            hubspotContactId: best.hubspotContactId,
          },
        },
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: `Please provide the email address for ${best.displayName}.`,
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    // Use duration from NLP parsing if available
    const durationFromGoal = parsed.durationMinutes;

    if (durationFromGoal === null) {
      // Need to ask for duration
      await this.tasks.mergeMemory(taskId, {
        meeting: {
          phase: 'need_duration',
          contact: {
            name: best.displayName,
            email: best.email,
            hubspotContactId: best.hubspotContactId,
          },
        },
      });

      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I found ${best.displayName} (${best.email}). How long should the meeting be? (e.g., "30 minutes", "1 hour")`,
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'How long should the meeting be? Please specify the duration.',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    // Duration was specified, proceed to find slots and ask for approval
    return await this.findSlotsAndAskApproval(
      taskId,
      task,
      {
        name: best.displayName,
        email: best.email,
        hubspotContactId: best.hubspotContactId,
      },
      durationFromGoal,
    );
  }

  private async handleDurationResponse(
    taskId: number,
    task: AgentTaskRow,
    userResponse: string,
  ): Promise<'handled'> {
    const mem = task.memory ?? {};
    const meeting = isRecord(mem['meeting']) ? mem['meeting'] : {};
    const contact = isRecord(meeting['contact']) ? meeting['contact'] : {};
    const contactEmail = typeof contact['email'] === 'string' ? contact['email'] : '';

    // Use NLP to parse the response
    // Determine what we're asking for based on current state
    const agentAskedFor = contactEmail ? 'duration' : 'email';
    const parsed = await this.nlp.parseUserResponse({
      userMessage: userResponse,
      agentAskedFor,
    });

    // Check if user provided an email (in case we were waiting for that)
    if (parsed.type === 'email' && parsed.email) {
      // Update contact with email
      const updatedContact = {
        ...contact,
        email: parsed.email,
      };

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          ...meeting,
          contact: updatedContact,
        },
      });

      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `Got it. How long should the meeting be? (e.g., "30 minutes", "1 hour")`,
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'How long should the meeting be? Please specify the duration.',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    // Check for duration
    if (parsed.type === 'duration' && parsed.durationMinutes) {
      // Make sure we have an email
      if (!contactEmail) {
        await this.tasks.appendMessage({
          taskId,
          userId: task.userId,
          role: 'assistant',
          content: `I still need the email address for this contact. Could you provide it?`,
        });

        await this.tasks.setWaiting(taskId, {
          kind: 'user_message',
          prompt: 'Please provide the email address.',
          sinceIso: new Date().toISOString(),
        });
        await this.tasks.setStatus(taskId, 'waiting', null);
        return 'handled';
      }

      return await this.findSlotsAndAskApproval(
        taskId,
        task,
        {
          name: typeof contact['name'] === 'string' ? contact['name'] : '',
          email: contactEmail,
          hubspotContactId:
            typeof contact['hubspotContactId'] === 'string' ? contact['hubspotContactId'] : '',
        },
        parsed.durationMinutes,
      );
    }

    // Couldn't understand the response - ask again with context
    if (!contactEmail) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I didn't quite catch that. Could you please provide the email address for the contact?`,
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'Please provide the email address.',
        sinceIso: new Date().toISOString(),
      });
    } else {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I didn't quite catch that. Could you please specify how long the meeting should be? (e.g., "30 minutes", "1 hour", or "half an hour")`,
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'Please specify the meeting duration.',
        sinceIso: new Date().toISOString(),
      });
    }

    await this.tasks.setStatus(taskId, 'waiting', null);
    return 'handled';
  }

  private async findSlotsAndAskApproval(
    taskId: number,
    task: AgentTaskRow,
    contact: { name: string; email: string; hubspotContactId: string },
    durationMinutes: number,
  ): Promise<'handled'> {
    const timeZone = 'America/Santo_Domingo';

    const now = Date.now();
    const startIso = new Date(now + 60 * 60_000).toISOString();
    const endIso = new Date(now + 14 * 24 * 60 * 60_000).toISOString();

    const slots = await this.syncedDataTools.suggestCalendarTimesLocal({
      userId: task.userId,
      startIso,
      endIso,
      durationMinutes,
      workDayStartHour: 9,
      workDayEndHour: 17,
      timezoneOffsetMinutes: -240,
      maxSuggestions: 6,
    });

    const proposed = slots.slice(0, 3).map((s, idx) => ({
      label: String.fromCharCode('A'.charCodeAt(0) + idx),
      startIso: s.startIso,
      endIso: s.endIso,
    }));

    if (proposed.length === 0) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I couldn't find any available time slots in the next 2 weeks. Would you like me to check a different date range?`,
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'No available slots found. What would you like to do?',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    // Store meeting info and proposed slots
    await this.tasks.mergeMemory(taskId, {
      meeting: {
        phase: 'need_user_approval',
        timezone: timeZone,
        durationMinutes,
        contact,
        proposed,
        previouslyProposed: [],
      },
    });

    // Format slots for user approval
    const slotLines = proposed.map((p) => {
      const start = formatDateTimeForHumans(p.startIso, timeZone);
      const end = formatTimeForHumans(p.endIso, timeZone);
      return `  ${p.label}) ${start} – ${end}`;
    });

    await this.tasks.appendMessage({
      taskId,
      userId: task.userId,
      role: 'assistant',
      content:
        `I found the following available time slots for a ${durationMinutes}-minute meeting with ${contact.name}:\n\n` +
        slotLines.join('\n') +
        `\n\nDo these times look good to send to ${contact.email}? (Reply "yes" to approve, or let me know if you'd like different times)`,
    });

    await this.tasks.setWaiting(taskId, {
      kind: 'user_message',
      prompt: 'Do these times look good to send? Reply yes to approve.',
      sinceIso: new Date().toISOString(),
    });
    await this.tasks.setStatus(taskId, 'waiting', null);
    return 'handled';
  }

  private async handleUserApprovalResponse(
    taskId: number,
    task: AgentTaskRow,
    userResponse: string,
  ): Promise<'handled'> {
    const mem = task.memory ?? {};
    const meeting = isRecord(mem['meeting']) ? mem['meeting'] : {};
    const contact = isRecord(meeting['contact']) ? meeting['contact'] : {};
    const proposedRaw = Array.isArray(meeting['proposed']) ? meeting['proposed'] : [];
    const durationMinutes =
      typeof meeting['durationMinutes'] === 'number' ? meeting['durationMinutes'] : 30;
    const timeZone =
      typeof meeting['timezone'] === 'string' ? meeting['timezone'] : 'America/Santo_Domingo';

    // Safely parse proposed slots
    const proposed: ProposedSlot[] = proposedRaw
      .filter((p): p is Record<string, unknown> => isRecord(p))
      .map((p) => ({
        label: typeof p.label === 'string' ? p.label : '',
        startIso: typeof p.startIso === 'string' ? p.startIso : '',
        endIso: typeof p.endIso === 'string' ? p.endIso : '',
      }))
      .filter((p) => p.label && p.startIso && p.endIso);

    // Use NLP to parse the response
    const parsed = await this.nlp.parseUserResponse({
      userMessage: userResponse,
      agentAskedFor: 'approval',
    });

    // Check for approval
    if (parsed.type === 'approval' && parsed.approved === true) {
      // User approved - send email to contact
      const contactEmail = typeof contact['email'] === 'string' ? contact['email'] : '';
      const contactName = typeof contact['name'] === 'string' ? contact['name'] : '';

      if (!contactEmail) {
        await this.tasks.appendMessage({
          taskId,
          userId: task.userId,
          role: 'assistant',
          content: `I don't have an email address for this contact. Could you provide it?`,
        });

        await this.tasks.setWaiting(taskId, {
          kind: 'user_message',
          prompt: 'Please provide the email address.',
          sinceIso: new Date().toISOString(),
        });
        await this.tasks.setStatus(taskId, 'waiting', null);
        return 'handled';
      }

      const body = buildSchedulingOptionsEmail({
        intro:
          `Hi ${contactName},\n\n` +
          `I'd like to schedule a ${durationMinutes}-minute meeting. Please reply with the letter of your preferred time, or "D" if none of these work:\n`,
        options: proposed.map((p) => ({
          label: p.label,
          startIso: p.startIso,
          endIso: p.endIso,
          timeZone,
        })),
        includeNoneOption: true,
      });

      // Send email FIRST
      const sendRes = await this.gmailApi.sendEmail(task.userId, {
        to: contactEmail,
        subject: `Scheduling Request — please choose an option`,
        bodyText: body,
      });

      const gmailThreadId = extractThreadIdFromSendResult(sendRes);

      // AFTER sending, get the latest timestamp to ensure we only pick up replies
      // that come after our sent message
      const threadMessages = await this.gmailApi.getThreadMessages(
        task.userId,
        gmailThreadId || '',
      );
      const latestInternalDateMs =
        threadMessages.length > 0
          ? Math.max(...threadMessages.map((m) => m.internalDateMs ?? 0))
          : Date.now();

      const sinceIso = new Date().toISOString();

      // Track previously proposed times - safely parse existing array
      const previouslyProposedRaw = Array.isArray(meeting['previouslyProposed'])
        ? meeting['previouslyProposed']
        : [];
      const previouslyProposed: ProposedSlot[] = previouslyProposedRaw
        .filter((p): p is Record<string, unknown> => isRecord(p))
        .map((p) => ({
          label: typeof p.label === 'string' ? p.label : '',
          startIso: typeof p.startIso === 'string' ? p.startIso : '',
          endIso: typeof p.endIso === 'string' ? p.endIso : '',
        }))
        .filter((p) => p.startIso);

      const updatedPreviouslyProposed: ProposedSlot[] = [...previouslyProposed, ...proposed];

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          ...meeting,
          phase: 'waiting_contact_reply',
          gmailThreadId: gmailThreadId || null,
          proposed,
          previouslyProposed: updatedPreviouslyProposed,
        },
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'gmail_reply',
        threadId: gmailThreadId || '',
        fromEmail: contactEmail,
        sinceIso,
        sinceInternalDateMs: latestInternalDateMs,
      });
      await this.tasks.setStatus(taskId, 'waiting', null);

      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I've sent the scheduling options to ${contactEmail}. I'll notify you here when they respond.`,
      });

      return 'handled';
    }

    // User rejected or we couldn't understand clearly - ask for different times or clarification
    if (parsed.type === 'rejection' || parsed.confidence < 0.6) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `No problem. Would you like me to find different time slots, or do you have specific times in mind?`,
      });

      // Go back to needing approval with potential for new slots
      await this.tasks.mergeMemory(taskId, {
        meeting: {
          ...meeting,
          phase: 'need_user_approval',
        },
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'What times would work better for you?',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    // Default: treat as needing clarification
    await this.tasks.appendMessage({
      taskId,
      userId: task.userId,
      role: 'assistant',
      content: `I didn't quite catch that. Should I send these time options to the contact? (Reply "yes" to send, or "no" if you'd like different times)`,
    });

    await this.tasks.setWaiting(taskId, {
      kind: 'user_message',
      prompt: 'Please confirm: should I send these times?',
      sinceIso: new Date().toISOString(),
    });
    await this.tasks.setStatus(taskId, 'waiting', null);
    return 'handled';
  }

  private async handleContactReply(
    taskId: number,
    task: AgentTaskRow,
    lastMessageContent: string,
  ): Promise<'handled'> {
    const mem = task.memory ?? {};
    const meeting = isRecord(mem['meeting']) ? mem['meeting'] : {};
    const contact = isRecord(meeting['contact']) ? meeting['contact'] : {};
    const proposedRaw = Array.isArray(meeting['proposed']) ? meeting['proposed'] : [];
    const durationMinutes =
      typeof meeting['durationMinutes'] === 'number' ? meeting['durationMinutes'] : 30;
    const timeZone =
      typeof meeting['timezone'] === 'string' ? meeting['timezone'] : 'America/Santo_Domingo';

    // Safely parse proposed slots
    const proposed: ProposedSlot[] = proposedRaw
      .filter((p): p is Record<string, unknown> => isRecord(p))
      .map((p) => ({
        label: typeof p.label === 'string' ? p.label : '',
        startIso: typeof p.startIso === 'string' ? p.startIso : '',
        endIso: typeof p.endIso === 'string' ? p.endIso : '',
      }))
      .filter((p) => p.label && p.startIso && p.endIso);

    // Parse the incoming email
    const parsed = parseIncomingEmailBlock(lastMessageContent);
    if (!parsed) {
      return 'handled';
    }

    const label = extractLabelChoice(parsed.bodyText);

    // Check if contact selected "D" (none of these work)
    if (label === 'D') {
      return await this.handleNoneOfTheseWork(taskId, task, parsed);
    }

    if (!label) {
      // Couldn't parse a label - wait for another reply or ask the user
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I received a reply from the contact but couldn't determine their selection. Here's what they said:\n\n"${parsed.bodyText.slice(0, 500)}"\n\nWould you like me to follow up with them?`,
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'How would you like to proceed?',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    // Find the chosen slot
    const chosen = proposed.find((p) => p.label.toUpperCase() === label.toUpperCase());

    if (!chosen) {
      return 'handled';
    }

    // Check if slot is still available
    const busy = await this.calendarApi.getBusyIntervals(task.userId, {
      calendarId: 'primary',
      timeMinIso: chosen.startIso,
      timeMaxIso: chosen.endIso,
      timeZone,
    });

    const isBusyNow = busy.some((b) => {
      const busyStart = new Date(b.startIso).getTime();
      const busyEnd = new Date(b.endIso).getTime();
      const chosenStart = new Date(chosen.startIso).getTime();
      const chosenEnd = new Date(chosen.endIso).getTime();
      return busyStart < chosenEnd && busyEnd > chosenStart;
    });

    const contactEmail = typeof contact['email'] === 'string' ? contact['email'] : '';
    const threadId = parsed.threadId;

    if (isBusyNow) {
      // Slot became unavailable - send new options
      return await this.sendNewTimesAfterConflict(taskId, task, parsed, 'conflict');
    }

    // Create the calendar event
    const contactName = typeof contact['name'] === 'string' ? contact['name'] : contactEmail;
    const summary = `Meeting with ${contactName}`;

    const created = await this.calendarApi.createEvent(task.userId, {
      calendarId: 'primary',
      summary,
      startIso: chosen.startIso,
      endIso: chosen.endIso,
      timeZone,
      attendees: [{ email: contactEmail }],
    });

    // Add HubSpot note
    const hubspotContactId =
      typeof contact['hubspotContactId'] === 'string' ? contact['hubspotContactId'] : '';
    if (hubspotContactId) {
      const noteBody =
        `Scheduled meeting.\n\n` +
        `Client: ${contactEmail}\n` +
        `Chosen option: ${label}\n` +
        `Start: ${formatDateTimeForHumans(chosen.startIso, timeZone)}\n` +
        `End: ${formatDateTimeForHumans(chosen.endIso, timeZone)}\n` +
        `Duration: ${durationMinutes} minutes\n` +
        `Calendar event: ${created.id}\n`;

      await this.hubspotApi.createNoteOnContact(task.userId, {
        contactId: hubspotContactId,
        body: noteBody,
        timestampIso: new Date().toISOString(),
      });
    }

    // Send confirmation email
    const confirmBody =
      `Confirmed — you're booked for option ${label}.\n\n` +
      `Start: ${formatDateTimeForHumans(chosen.startIso, timeZone)}\n` +
      `End: ${formatDateTimeForHumans(chosen.endIso, timeZone)}\n` +
      `Duration: ${durationMinutes} minutes\n\n` +
      `I've added it to my calendar and you should receive an invite shortly.`;

    await this.gmailApi.sendEmail(task.userId, {
      to: contactEmail,
      subject: parsed.subject ? `Re: ${parsed.subject}` : 'Re: Scheduling Request',
      bodyText: confirmBody,
      threadId,
    });

    await this.tasks.mergeMemory(taskId, {
      meeting: {
        ...meeting,
        phase: 'scheduled',
        chosen: { label, startIso: chosen.startIso, endIso: chosen.endIso },
        calendarEventId: created.id,
      },
    });

    await this.tasks.appendMessage({
      taskId,
      userId: task.userId,
      role: 'assistant',
      content:
        `Meeting scheduled with ${contactName}!\n\n` +
        `📅 ${formatDateTimeForHumans(chosen.startIso, timeZone)} – ${formatTimeForHumans(chosen.endIso, timeZone)}\n` +
        `⏱️ ${durationMinutes} minutes\n\n` +
        `I've created the calendar event and sent a confirmation email.`,
    });

    await this.tasks.setStatus(taskId, 'completed', null);
    return 'handled';
  }

  private async handleNoneOfTheseWork(
    taskId: number,
    task: AgentTaskRow,
    parsed: {
      threadId: string;
      messageId: string;
      from: string;
      subject: string;
      bodyText: string;
    },
  ): Promise<'handled'> {
    await this.tasks.appendMessage({
      taskId,
      userId: task.userId,
      role: 'assistant',
      content: `The contact indicated none of the proposed times work for them. I'm automatically sending new time options.`,
    });

    return await this.sendNewTimesAfterConflict(taskId, task, parsed, 'none_work');
  }

  private async sendNewTimesAfterConflict(
    taskId: number,
    task: AgentTaskRow,
    parsed: {
      threadId: string;
      messageId: string;
      from: string;
      subject: string;
      bodyText: string;
    },
    reason: 'conflict' | 'none_work',
  ): Promise<'handled'> {
    const mem = task.memory ?? {};
    const meeting = isRecord(mem['meeting']) ? mem['meeting'] : {};
    const contact = isRecord(meeting['contact']) ? meeting['contact'] : {};
    const durationMinutes =
      typeof meeting['durationMinutes'] === 'number' ? meeting['durationMinutes'] : 30;
    const timeZone =
      typeof meeting['timezone'] === 'string' ? meeting['timezone'] : 'America/Santo_Domingo';

    // Safely parse previously proposed slots
    const previouslyProposedRaw = Array.isArray(meeting['previouslyProposed'])
      ? meeting['previouslyProposed']
      : [];
    const previouslyProposed: ProposedSlot[] = previouslyProposedRaw
      .filter((p): p is Record<string, unknown> => isRecord(p))
      .map((p) => ({
        label: typeof p.label === 'string' ? p.label : '',
        startIso: typeof p.startIso === 'string' ? p.startIso : '',
        endIso: typeof p.endIso === 'string' ? p.endIso : '',
      }))
      .filter((p) => p.startIso);

    const contactEmail = typeof contact['email'] === 'string' ? contact['email'] : '';
    const threadId = parsed.threadId;

    // Find new slots that haven't been proposed before
    const now = Date.now();
    const startIso = new Date(now + 60 * 60_000).toISOString();
    const endIso = new Date(now + 21 * 24 * 60 * 60_000).toISOString(); // Extend to 3 weeks

    const allSlots = await this.syncedDataTools.suggestCalendarTimesLocal({
      userId: task.userId,
      startIso,
      endIso,
      durationMinutes,
      workDayStartHour: 9,
      workDayEndHour: 17,
      timezoneOffsetMinutes: -240,
      maxSuggestions: 20,
    });

    // Filter out previously proposed times
    const previousStartTimes = new Set(previouslyProposed.map((p) => p.startIso));

    const newSlots = allSlots.filter((s) => !previousStartTimes.has(s.startIso));

    const nextProposed: ProposedSlot[] = newSlots.slice(0, 3).map((s, idx) => ({
      label: String.fromCharCode('A'.charCodeAt(0) + idx),
      startIso: s.startIso,
      endIso: s.endIso,
    }));

    if (nextProposed.length === 0) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I've run out of available time slots to propose. Would you like me to check a different date range or time of day?`,
      });

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          ...meeting,
          phase: 'need_user_approval',
          proposed: [],
        },
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'No more available slots. What would you like to do?',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    // Send email with new options FIRST
    const intro =
      reason === 'conflict'
        ? `I apologize — the time you selected just became unavailable.\n\nHere are some alternative times. Please reply with A, B, C, or D if none of these work:\n`
        : `No problem! Here are some additional times that might work better.\n\nPlease reply with A, B, C, or D if none of these work:\n`;

    const body = buildSchedulingOptionsEmail({
      intro,
      options: nextProposed.map((p) => ({
        label: p.label,
        startIso: p.startIso,
        endIso: p.endIso,
        timeZone,
      })),
      includeNoneOption: true,
    });

    await this.gmailApi.sendEmail(task.userId, {
      to: contactEmail,
      subject: parsed.subject ? `Re: ${parsed.subject}` : 'Re: Scheduling Request',
      bodyText: body,
      threadId,
    });

    // AFTER sending, get the latest message timestamp
    // This ensures we capture our newly sent message's timestamp
    const threadMessages = await this.gmailApi.getThreadMessages(task.userId, threadId);
    const latestInternalDateMs =
      threadMessages.length > 0
        ? Math.max(...threadMessages.map((m) => m.internalDateMs ?? 0))
        : Date.now();

    // Update memory with new proposed times
    const updatedPreviouslyProposed: ProposedSlot[] = [...previouslyProposed, ...nextProposed];

    await this.tasks.mergeMemory(taskId, {
      meeting: {
        ...meeting,
        phase: 'waiting_contact_reply',
        proposed: nextProposed,
        previouslyProposed: updatedPreviouslyProposed,
        gmailThreadId: threadId,
      },
    });

    const sinceIso = new Date().toISOString();
    await this.tasks.setWaiting(taskId, {
      kind: 'gmail_reply',
      threadId,
      fromEmail: contactEmail,
      sinceIso,
      sinceInternalDateMs: latestInternalDateMs,
    });
    await this.tasks.setStatus(taskId, 'waiting', null);

    const messageContent =
      reason === 'conflict'
        ? `The selected time became unavailable. I've sent new options to ${contactEmail}.`
        : `I've sent new time options to ${contactEmail}.`;

    await this.tasks.appendMessage({
      taskId,
      userId: task.userId,
      role: 'assistant',
      content: messageContent,
    });

    return 'handled';
  }

  private async handleToolCall(
    taskId: number,
    userId: number,
    tc: OpenAiToolCall,
  ): Promise<ToolResult> {
    const argsUnknown = safeJson(tc.argumentsJson);
    const args = isRecord(argsUnknown) ? argsUnknown : {};

    try {
      switch (tc.name) {
        case 'remember': {
          const patch = isRecord(args.patch) ? args.patch : {};
          const merged = await this.tasks.mergeMemory(taskId, patch);

          const out = { ok: true, memory: merged };
          await this.tasks.logToolCall({
            taskId,
            userId,
            toolName: tc.name,
            toolCallId: tc.id,
            status: 'ok',
            inputJson: args,
            outputJson: out,
          });

          return { kind: 'ok', output: out };
        }

        case 'await_user_message': {
          const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
          if (!prompt) {
            const err = 'await_user_message: prompt is required.';
            await this.tasks.logToolCall({
              taskId,
              userId,
              toolName: tc.name,
              toolCallId: tc.id,
              status: 'error',
              inputJson: args,
              error: err,
            });
            return { kind: 'error', error: err };
          }

          const sinceIso = new Date().toISOString();
          const waiting: Record<string, unknown> = {
            kind: 'user_message',
            prompt,
            sinceIso,
          };

          await this.tasks.setWaiting(taskId, waiting);

          const out = { waiting: true, kind: 'user_message', prompt, sinceIso };

          await this.tasks.logToolCall({
            taskId,
            userId,
            toolName: tc.name,
            toolCallId: tc.id,
            status: 'await',
            inputJson: args,
            outputJson: out,
          });

          return {
            kind: 'await',
            output: out,
            userVisiblePrompt: prompt,
          };
        }

        case 'await_gmail_reply': {
          const gmailThreadId =
            typeof args.gmailThreadId === 'string' ? args.gmailThreadId.trim() : '';
          const fromEmail = typeof args.fromEmail === 'string' ? args.fromEmail.trim() : '';

          if (!gmailThreadId) {
            const err = 'await_gmail_reply: gmailThreadId is required.';
            await this.tasks.logToolCall({
              taskId,
              userId,
              toolName: tc.name,
              toolCallId: tc.id,
              status: 'error',
              inputJson: args,
              error: err,
            });
            return { kind: 'error', error: err };
          }

          const threadMessages = await this.gmailApi.getThreadMessages(userId, gmailThreadId);
          const latestInternalDateMs =
            threadMessages.length > 0
              ? Math.max(...threadMessages.map((m) => m.internalDateMs ?? 0))
              : Date.now();

          const sinceIso = new Date().toISOString();
          const waiting: Record<string, unknown> = {
            kind: 'gmail_reply',
            threadId: gmailThreadId,
            fromEmail: fromEmail || null,
            sinceIso,
            sinceInternalDateMs: latestInternalDateMs,
          };

          await this.tasks.setWaiting(taskId, waiting);

          const out = {
            waiting: true,
            kind: 'gmail_reply',
            gmailThreadId,
            fromEmail: fromEmail || null,
            sinceIso,
            sinceInternalDateMs: latestInternalDateMs,
          };

          await this.tasks.logToolCall({
            taskId,
            userId,
            toolName: tc.name,
            toolCallId: tc.id,
            status: 'await',
            inputJson: args,
            outputJson: out,
          });

          return { kind: 'await', output: out };
        }

        case 'hubspot_find_contacts_local': {
          const query = typeof args.query === 'string' ? args.query : '';
          const limit = typeof args.limit === 'number' ? args.limit : 10;

          const matches = await this.syncedDataTools.findHubspotContactsLocal({
            userId,
            query,
            limit: clampInt(limit, 1, 25),
          });

          const out: Record<string, unknown> = { matches };

          await this.tasks.logToolCall({
            taskId,
            userId,
            toolName: tc.name,
            toolCallId: tc.id,
            status: 'ok',
            inputJson: args,
            outputJson: out,
          });

          return { kind: 'ok', output: out };
        }

        case 'gmail_search_messages_local': {
          const query = typeof args.query === 'string' ? args.query : '';
          const limit = typeof args.limit === 'number' ? args.limit : 10;

          const matches = await this.syncedDataTools.searchGmailMessagesLocal({
            userId,
            query,
            limit: clampInt(limit, 1, 25),
          });

          const out: Record<string, unknown> = { matches };

          await this.tasks.logToolCall({
            taskId,
            userId,
            toolName: tc.name,
            toolCallId: tc.id,
            status: 'ok',
            inputJson: args,
            outputJson: out,
          });

          return { kind: 'ok', output: out };
        }

        case 'calendar_suggest_times_local': {
          const startIso = typeof args.startIso === 'string' ? args.startIso : '';
          const endIso = typeof args.endIso === 'string' ? args.endIso : '';
          const durationMinutes =
            typeof args.durationMinutes === 'number' ? args.durationMinutes : 30;

          const workDayStartHour =
            typeof args.workDayStartHour === 'number' ? args.workDayStartHour : 9;
          const workDayEndHour = typeof args.workDayEndHour === 'number' ? args.workDayEndHour : 17;
          const timezoneOffsetMinutes =
            typeof args.timezoneOffsetMinutes === 'number' ? args.timezoneOffsetMinutes : -240;
          const maxSuggestions = typeof args.maxSuggestions === 'number' ? args.maxSuggestions : 10;

          const slots = await this.syncedDataTools.suggestCalendarTimesLocal({
            userId,
            startIso,
            endIso,
            durationMinutes,
            workDayStartHour,
            workDayEndHour,
            timezoneOffsetMinutes,
            maxSuggestions,
          });

          const out: Record<string, unknown> = { slots };

          await this.tasks.logToolCall({
            taskId,
            userId,
            toolName: tc.name,
            toolCallId: tc.id,
            status: 'ok',
            inputJson: args,
            outputJson: out,
          });

          return { kind: 'ok', output: out };
        }

        case 'gmail_send_email': {
          const to = typeof args.to === 'string' ? args.to : '';
          const subject = typeof args.subject === 'string' ? args.subject : '';
          const bodyText = typeof args.bodyText === 'string' ? args.bodyText : '';

          const result = await this.gmailApi.sendEmail(userId, {
            to,
            subject,
            bodyText,
            cc: typeof args.cc === 'string' ? args.cc : undefined,
            bcc: typeof args.bcc === 'string' ? args.bcc : undefined,
            threadId: typeof args.threadId === 'string' ? args.threadId : undefined,
            inReplyToMessageId:
              typeof args.inReplyToMessageId === 'string' ? args.inReplyToMessageId : undefined,
            references: typeof args.references === 'string' ? args.references : undefined,
            replyTo: typeof args.replyTo === 'string' ? args.replyTo : undefined,
          });

          const out: Record<string, unknown> = { ok: true, result };

          await this.tasks.logToolCall({
            taskId,
            userId,
            toolName: tc.name,
            toolCallId: tc.id,
            status: 'ok',
            inputJson: args,
            outputJson: out,
          });

          return { kind: 'ok', output: out };
        }

        case 'calendar_get_busy': {
          const calendarId = typeof args.calendarId === 'string' ? args.calendarId : undefined;
          const timeMinIso = typeof args.timeMinIso === 'string' ? args.timeMinIso : '';
          const timeMaxIso = typeof args.timeMaxIso === 'string' ? args.timeMaxIso : '';
          const timeZone = typeof args.timeZone === 'string' ? args.timeZone : undefined;

          const busy = await this.calendarApi.getBusyIntervals(userId, {
            calendarId,
            timeMinIso,
            timeMaxIso,
            timeZone,
          });

          const out: Record<string, unknown> = { busy };

          await this.tasks.logToolCall({
            taskId,
            userId,
            toolName: tc.name,
            toolCallId: tc.id,
            status: 'ok',
            inputJson: args,
            outputJson: out,
          });

          return { kind: 'ok', output: out };
        }

        case 'calendar_create_event': {
          const calendarId = typeof args.calendarId === 'string' ? args.calendarId : undefined;
          const summary = typeof args.summary === 'string' ? args.summary : '';
          const description = typeof args.description === 'string' ? args.description : undefined;
          const location = typeof args.location === 'string' ? args.location : undefined;
          const startIso = typeof args.startIso === 'string' ? args.startIso : '';
          const endIso = typeof args.endIso === 'string' ? args.endIso : '';
          const timeZone = typeof args.timeZone === 'string' ? args.timeZone : undefined;

          const attendees = Array.isArray(args.attendees)
            ? args.attendees
                .map((a) =>
                  isRecord(a)
                    ? {
                        email: typeof a.email === 'string' ? a.email : '',
                        displayName: typeof a.displayName === 'string' ? a.displayName : undefined,
                      }
                    : null,
                )
                .filter((x): x is NonNullable<typeof x> => Boolean(x && x.email))
            : undefined;

          const created = await this.calendarApi.createEvent(userId, {
            calendarId,
            summary,
            description,
            location,
            startIso,
            endIso,
            timeZone,
            attendees,
          });

          const out: Record<string, unknown> = { ok: true, created };

          await this.tasks.logToolCall({
            taskId,
            userId,
            toolName: tc.name,
            toolCallId: tc.id,
            status: 'ok',
            inputJson: args,
            outputJson: out,
          });

          return { kind: 'ok', output: out };
        }

        case 'calendar_update_event': {
          const calendarId = typeof args.calendarId === 'string' ? args.calendarId : undefined;
          const eventId = typeof args.eventId === 'string' ? args.eventId : '';

          const attendees = Array.isArray(args.attendees)
            ? args.attendees
                .map((a) =>
                  isRecord(a)
                    ? {
                        email: typeof a.email === 'string' ? a.email : '',
                        displayName: typeof a.displayName === 'string' ? a.displayName : undefined,
                      }
                    : null,
                )
                .filter((x): x is NonNullable<typeof x> => Boolean(x && x.email))
            : undefined;

          const updated = await this.calendarApi.updateEvent(userId, {
            calendarId,
            eventId,
            summary: typeof args.summary === 'string' ? args.summary : undefined,
            description: typeof args.description === 'string' ? args.description : undefined,
            location: typeof args.location === 'string' ? args.location : undefined,
            startIso: typeof args.startIso === 'string' ? args.startIso : undefined,
            endIso: typeof args.endIso === 'string' ? args.endIso : undefined,
            timeZone: typeof args.timeZone === 'string' ? args.timeZone : undefined,
            attendees,
          });

          const out: Record<string, unknown> = { ok: true, updated };

          await this.tasks.logToolCall({
            taskId,
            userId,
            toolName: tc.name,
            toolCallId: tc.id,
            status: 'ok',
            inputJson: args,
            outputJson: out,
          });

          return { kind: 'ok', output: out };
        }

        case 'hubspot_find_or_create_contact': {
          const email = typeof args.email === 'string' ? args.email : '';
          if (!email.trim()) {
            const err = 'hubspot_find_or_create_contact: email is required.';
            await this.tasks.logToolCall({
              taskId,
              userId,
              toolName: tc.name,
              toolCallId: tc.id,
              status: 'error',
              inputJson: args,
              error: err,
            });
            return { kind: 'error', error: err };
          }

          const res = await this.hubspotApi.findOrCreateContactByEmail(userId, {
            email: email.trim(),
            firstName: typeof args.firstName === 'string' ? args.firstName : undefined,
            lastName: typeof args.lastName === 'string' ? args.lastName : undefined,
          });

          const out: Record<string, unknown> = { ok: true, contact: res };

          await this.tasks.logToolCall({
            taskId,
            userId,
            toolName: tc.name,
            toolCallId: tc.id,
            status: 'ok',
            inputJson: args,
            outputJson: out,
          });

          return { kind: 'ok', output: out };
        }

        case 'hubspot_create_note_on_contact': {
          const contactId = typeof args.contactId === 'string' ? args.contactId : '';
          const body = typeof args.body === 'string' ? args.body : '';
          const timestampIso =
            typeof args.timestampIso === 'string' ? args.timestampIso : undefined;

          const res = await this.hubspotApi.createNoteOnContact(userId, {
            contactId,
            body,
            timestampIso,
          });

          const out: Record<string, unknown> = { ok: true, note: res };

          await this.tasks.logToolCall({
            taskId,
            userId,
            toolName: tc.name,
            toolCallId: tc.id,
            status: 'ok',
            inputJson: args,
            outputJson: out,
          });

          return { kind: 'ok', output: out };
        }

        default: {
          const err = `Unknown tool: ${tc.name}`;
          await this.tasks.logToolCall({
            taskId,
            userId,
            toolName: tc.name,
            toolCallId: tc.id,
            status: 'error',
            inputJson: args,
            error: err,
          });
          return { kind: 'error', error: err };
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);

      await this.tasks.logToolCall({
        taskId,
        userId,
        toolName: tc.name,
        toolCallId: tc.id,
        status: 'error',
        inputJson: args,
        error: msg,
      });

      return { kind: 'error', error: msg };
    }
  }
}

// HELPER FUNCTIONS

// HELPER FUNCTIONS

function pickBestContact(
  matches: Array<{
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  }>,
  query: string,
): { hubspotContactId: string; email: string | null; displayName: string } | null {
  if (!Array.isArray(matches) || matches.length === 0) return null;

  const qn = normalizeName(query);

  const scored = matches.map((m) => {
    const full = `${m.firstName ?? ''} ${m.lastName ?? ''}`.trim();
    const fn = normalizeName(full);
    const exact = fn && qn && fn === qn ? 100 : 0;
    const contains = fn && qn && fn.includes(qn) ? 50 : 0;
    const hasEmail = m.email ? 10 : 0;
    const score = exact + contains + hasEmail;
    return { m, full, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const displayName = best.full || query;

  return {
    hubspotContactId: String(best.m.id),
    email: best.m.email ?? null,
    displayName,
  };
}

function normalizeName(s: string): string {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '');
}

function extractThreadIdFromSendResult(sendRes: unknown): string {
  if (!sendRes || typeof sendRes !== 'object') return '';
  const r = sendRes as Record<string, unknown>;
  const t1 = typeof r.threadId === 'string' ? r.threadId : '';
  if (t1) return t1;
  const t2 = typeof r.gmailThreadId === 'string' ? r.gmailThreadId : '';
  if (t2) return t2;
  const inner = r.result;
  if (inner && typeof inner === 'object') {
    const rr = inner as Record<string, unknown>;
    const t3 = typeof rr.threadId === 'string' ? rr.threadId : '';
    if (t3) return t3;
  }
  return '';
}

function parseIncomingEmailBlock(content: string): {
  threadId: string;
  messageId: string;
  from: string;
  subject: string;
  bodyText: string;
} | null {
  const text = String(content ?? '');
  if (!text.startsWith('INCOMING_EMAIL_REPLY')) return null;

  const lines = text.split('\n');
  const kv: Record<string, string> = {};

  let blankIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '') {
      blankIdx = i;
      break;
    }
  }

  const headerLines = lines.slice(1, blankIdx >= 0 ? blankIdx : lines.length);
  for (const l of headerLines) {
    const m = l.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    kv[m[1]] = m[2] ?? '';
  }

  const threadId = (kv['threadId'] ?? '').trim();
  const messageId = (kv['messageId'] ?? '').trim();
  const from = (kv['from'] ?? '').trim();
  const subject = (kv['subject'] ?? '').trim();
  const bodyText =
    blankIdx >= 0
      ? lines
          .slice(blankIdx + 1)
          .join('\n')
          .trim()
      : '';

  if (!threadId) return null;

  return { threadId, messageId, from, subject, bodyText };
}

function extractLabelChoice(body: string): string | null {
  const s = (body ?? '').trim();
  if (!s) return null;

  // Take first 300 chars for analysis
  const head = s.slice(0, 300);
  const headUpper = head.toUpperCase();

  // FIRST: Check for explicit letter choices A, B, C at the very start
  // This is the most common case: contact just replies "C" or "C." or "Option C"
  
  // Check if response starts with a single letter (most common case)
  const startsWithLetter = head.match(/^([A-Ca-c])\b/);
  if (startsWithLetter) {
    return startsWithLetter[1].toUpperCase();
  }

  // Check for "Option X" pattern at the start
  const optionAtStart = headUpper.match(/^OPTION\s*([A-C])\b/);
  if (optionAtStart) {
    return optionAtStart[1];
  }

  // Check for letter with parenthesis like "A)" or "(A)" at start
  const parenAtStart = head.match(/^\(?([A-Ca-c])\)/);
  if (parenAtStart) {
    return parenAtStart[1].toUpperCase();
  }

  // SECOND: Check for choice phrases that indicate A, B, or C
  const choicePatterns = [
    /\bOPTION\s+([A-C])\b/i,
    /\bCHOOSE\s+([A-C])\b/i,
    /\bSELECT\s+([A-C])\b/i,
    /\bPICK\s+([A-C])\b/i,
    /\bPREFER\s+([A-C])\b/i,
    /\bWANT\s+([A-C])\b/i,
    /\b([A-C])\s+(?:WORKS?|PLEASE|IS\s+(?:GOOD|FINE|GREAT|PERFECT|BEST))\b/i,
    /\bGO\s+(?:WITH|FOR)\s+(?:OPTION\s+)?([A-C])\b/i,
    /\bLET'?S?\s+(?:DO|GO\s+WITH)\s+(?:OPTION\s+)?([A-C])\b/i,
    /\bI'?LL?\s+(?:TAKE|DO)\s+(?:OPTION\s+)?([A-C])\b/i,
    /\b([A-C])\s+(?:IS\s+)?(?:MY\s+)?(?:CHOICE|PREFERENCE)\b/i,
  ];

  for (const pattern of choicePatterns) {
    const match = head.match(pattern);
    if (match && match[1]) {
      return match[1].toUpperCase();
    }
  }

  // THIRD: Check for standalone A, B, or C with clear word boundaries
  // Be careful not to match letters that are part of words
  const standaloneABC = headUpper.match(/(?:^|[\s.,:;!?()])([A-C])(?:[\s.,:;!?()]|$)/);
  if (standaloneABC) {
    return standaloneABC[1];
  }

  // FOURTH: Now check for explicit "D" or "none of these" ONLY if no A/B/C was found
  
  // Check if starts with D
  const startsWithD = head.match(/^([Dd])\b/);
  if (startsWithD) {
    return 'D';
  }

  // Check for explicit "Option D"
  const optionD = headUpper.match(/\bOPTION\s*D\b/);
  if (optionD) {
    return 'D';
  }

  // Check for standalone D
  const standaloneD = headUpper.match(/(?:^|[\s.,:;!?()])D(?:[\s.,:;!?()]|$)/);
  if (standaloneD) {
    return 'D';
  }

  // Check for explicit "none of these" type phrases
  // Be very specific to avoid false positives
  const nonePatterns = [
    /\bNONE\s+OF\s+(?:THESE|THEM|THE(?:SE)?\s+(?:TIMES?|OPTIONS?))\s+WORK/i,
    /\bNONE\s+(?:OF\s+(?:THESE|THEM))?\s*WORK/i,
    /\b(?:THESE|THEY)\s+DON'?T\s+WORK/i,
    /\bCAN'?T\s+(?:MAKE|DO)\s+ANY\s+OF\s+(?:THESE|THEM|THOSE)/i,
    /\bNONE\s+OF\s+(?:THESE|THEM|THOSE)\b/i,
    /\bNEITHER\s+(?:OF\s+)?(?:THESE|THEM|THOSE)\b/i,
  ];

  for (const pattern of nonePatterns) {
    if (pattern.test(head)) {
      return 'D';
    }
  }

  return null;
}

function buildSchedulingOptionsEmail(input: {
  intro: string;
  options: Array<{ label: string; startIso: string; endIso: string; timeZone: string }>;
  includeNoneOption?: boolean;
}): string {
  const lines: string[] = [];
  lines.push(input.intro);
  lines.push('');

  for (const opt of input.options) {
    const start = formatDateTimeForHumans(opt.startIso, opt.timeZone);
    const end = formatTimeForHumans(opt.endIso, opt.timeZone);
    lines.push(`${opt.label}) ${start} – ${end}`);
  }

  if (input.includeNoneOption) {
    lines.push(`D) None of these times work for me`);
  }

  lines.push('');
  lines.push('Please reply with just the letter of your choice.');

  return lines.join('\n');
}

function formatDateTimeForHumans(isoString: string, timeZone: string): string {
  try {
    const date = new Date(isoString);
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  } catch {
    return isoString;
  }
}

function formatTimeForHumans(isoString: string, timeZone: string): string {
  try {
    const date = new Date(isoString);
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
  } catch {
    return isoString;
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

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v ?? null, null, 2);
  } catch {
    return 'null';
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  const x = Math.trunc(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}
