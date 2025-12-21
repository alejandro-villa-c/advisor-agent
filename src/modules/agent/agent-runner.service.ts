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
    let task = await this.tasks.getTask(taskId);
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

      // Re-fetch task to get latest memory after status change
      task = await this.tasks.getTask(taskId);
      if (!task) {
        this.logger.warn(`[agent] task not found after status update taskId=${taskId}`);
        return;
      }

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
          singletonKey: `agent.react:${taskId}:${Date.now()}`,
          singletonSeconds: 5,
        },
      );
    } catch (err: unknown) {
      this.logger.warn(
        `enqueueReact failed for taskId=${taskId}: ${err instanceof Error ? err.message : String(err)}`,
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

    const uiMessages = await this.tasks.getMessagesForUi(taskId);
    const lastUser = [...uiMessages].reverse().find((m) => m.role === 'user');

    if (!meeting) {
      return await this.startSchedulingFlow(taskId, task);
    }

    // PHASE: Need contact (user was asked who they want to meet with)
    if (phase === 'need_contact') {
      return await this.handleNeedContactResponse(taskId, task, lastUser?.content ?? '');
    }

    // PHASE: Need contact clarification
    if (phase === 'need_contact_clarification') {
      return await this.handleContactClarificationResponse(taskId, task, lastUser?.content ?? '');
    }

    if (phase === 'need_duration') {
      return await this.handleDurationResponse(taskId, task, lastUser?.content ?? '');
    }

    if (phase === 'need_user_approval') {
      return await this.handleUserApprovalResponse(taskId, task, lastUser?.content ?? '');
    }

    if (phase === 'waiting_contact_reply') {
      return await this.handleContactReply(taskId, task, lastUser?.content ?? '');
    }

    return 'not_scheduling';
  }

  private async handleNeedContactResponse(
    taskId: number,
    task: AgentTaskRow,
    userResponse: string,
  ): Promise<'handled'> {
    const mem = task.memory ?? {};
    const meeting = isRecord(mem['meeting']) ? mem['meeting'] : {};
    const durationMinutes =
      typeof meeting['durationMinutes'] === 'number' ? meeting['durationMinutes'] : null;
    const preferredTime =
      typeof meeting['preferredTime'] === 'string' ? meeting['preferredTime'] : null;
    const preferredTimeIso =
      typeof meeting['preferredTimeIso'] === 'string' ? meeting['preferredTimeIso'] : null;

    // Only check for explicit cancellation, NOT change_contact
    // because in this phase the user IS providing a contact name
    const flowControl = await this.nlp.parseFlowControlIntent({
      userMessage: userResponse,
      currentPhase: 'need_contact',
      currentContactName: undefined, // No contact selected yet
    });

    // Only handle cancel/restart, ignore change_contact since user is providing the contact
    if (flowControl.intent === 'cancel' && flowControl.confidence > 0.7) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `No problem, I've cancelled the scheduling request.`,
      });
      await this.tasks.setStatus(taskId, 'completed', null);
      return 'handled';
    }

    if (flowControl.intent === 'restart' && flowControl.confidence > 0.7) {
      await this.tasks.mergeMemory(taskId, { meeting: null });
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `Let's start over. What would you like to schedule?`,
      });
      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'What would you like to schedule?',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    // Treat the response as the contact name
    const contactName = userResponse.trim();

    if (!contactName) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I didn't catch the name. Who would you like to schedule a meeting with?`,
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'Who would you like to meet with?',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    // Search for the contact in BOTH HubSpot AND Gmail senders
    const [hubspotMatches, gmailSenders] = await Promise.all([
      this.syncedDataTools.findHubspotContactsLocal({
        userId: task.userId,
        query: contactName,
        limit: 10,
      }),
      this.syncedDataTools.findGmailSendersLocal({
        userId: task.userId,
        query: contactName,
        limit: 20,
      }),
    ]);

    // Build candidate list
    const candidates: Array<{
      source: 'hubspot' | 'gmail';
      displayName: string;
      email: string | null;
      hubspotContactId: string | null;
    }> = [];

    for (const h of hubspotMatches) {
      const displayName = `${h.firstName ?? ''} ${h.lastName ?? ''}`.trim() || h.email || 'Unknown';
      candidates.push({
        source: 'hubspot',
        displayName,
        email: h.email,
        hubspotContactId: h.id,
      });
    }

    for (const g of gmailSenders) {
      const emailLower = g.email.toLowerCase();
      const alreadyHave = candidates.some((c) => c.email && c.email.toLowerCase() === emailLower);
      if (!alreadyHave) {
        candidates.push({
          source: 'gmail',
          displayName: g.displayName || g.email,
          email: g.email,
          hubspotContactId: null,
        });
      }
    }

    if (candidates.length === 0) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I couldn't find a contact matching "${contactName}" in HubSpot or your email history. Could you provide their email address?`,
      });

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          phase: 'need_email',
          contact: {
            name: contactName,
            email: null,
            hubspotContactId: null,
          },
          durationMinutes,
          preferredTime,
          preferredTimeIso,
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

    // Get unique emails
    const uniqueEmails = new Set(
      candidates.filter((c) => c.email).map((c) => c.email!.toLowerCase()),
    );

    // If we have multiple email options, ask user to clarify
    if (uniqueEmails.size > 1) {
      const optionsToShow = candidates.filter((c) => c.email);

      const optionsList = optionsToShow
        .map((c, i) => `${i + 1}. ${c.displayName} (${c.email})`)
        .join('\n');

      const candidateOptions = optionsToShow.map((c, i) => ({
        index: i + 1,
        displayName: c.displayName,
        email: c.email,
        source: c.source,
        hubspotContactId: c.hubspotContactId,
      }));

      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I found multiple email addresses for "${contactName}". Which one should I use?\n\n${optionsList}\n\nPlease reply with the number.`,
      });

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          phase: 'need_contact_clarification',
          contactQuery: contactName,
          candidateOptions,
          durationMinutes,
          preferredTime,
          preferredTimeIso,
        },
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'Which contact did you mean? Reply with the number.',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    // We have one unique email - pick the first candidate with an email
    const best = candidates.find((c) => c.email) ?? candidates[0];

    if (!best || !best.email) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I found "${contactName}" but I don't have an email address on file. Please provide their email address.`,
      });

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          phase: 'need_email',
          contact: {
            name: best?.displayName ?? contactName,
            email: null,
            hubspotContactId: best?.hubspotContactId ?? null,
          },
          durationMinutes,
          preferredTime,
          preferredTimeIso,
        },
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: `Please provide the email address.`,
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    const contact = {
      name: best.displayName,
      email: best.email,
      hubspotContactId: best.hubspotContactId ?? '',
    };

    // If we don't have duration, ask for it
    if (durationMinutes === null) {
      await this.tasks.mergeMemory(taskId, {
        meeting: {
          phase: 'need_duration',
          contact,
          preferredTime,
          preferredTimeIso,
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

    // We have contact AND duration - check if we have a preferred time
    if (preferredTimeIso) {
      const timezone = 'America/Santo_Domingo';
      const preferredStart = new Date(preferredTimeIso);
      const preferredEnd = new Date(preferredStart.getTime() + durationMinutes * 60 * 1000);

      const busy = await this.calendarApi.getBusyIntervals(task.userId, {
        calendarId: 'primary',
        timeMinIso: preferredStart.toISOString(),
        timeMaxIso: preferredEnd.toISOString(),
        timeZone: timezone,
      });

      const isAvailable = !busy.some((b) => {
        const busyStart = new Date(b.startIso).getTime();
        const busyEnd = new Date(b.endIso).getTime();
        const slotStart = preferredStart.getTime();
        const slotEnd = preferredEnd.getTime();
        return busyStart < slotEnd && busyEnd > slotStart;
      });

      if (isAvailable) {
        const proposed = [
          {
            label: 'A',
            startIso: preferredStart.toISOString(),
            endIso: preferredEnd.toISOString(),
          },
        ];

        const dateStr = preferredStart.toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          timeZone: timezone,
        });
        const startTime = preferredStart.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          timeZone: timezone,
        });
        const endTime = preferredEnd.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          timeZone: timezone,
        });

        await this.tasks.mergeMemory(taskId, {
          meeting: {
            phase: 'need_user_approval',
            contact,
            durationMinutes,
            proposed,
            previouslyProposed: [],
            timezone,
          },
        });

        await this.tasks.appendMessage({
          taskId,
          userId: task.userId,
          role: 'assistant',
          content: `Great! ${dateStr}, ${startTime} – ${endTime} is available for a ${durationMinutes}-minute meeting with ${contact.name}.\n\nShould I send this time to ${contact.email}? (Reply "yes" to approve, or let me know if you'd like different times)`,
        });

        await this.tasks.setWaiting(taskId, {
          kind: 'user_message',
          prompt: 'Approve this time?',
          sinceIso: new Date().toISOString(),
        });
        await this.tasks.setStatus(taskId, 'waiting', null);
        return 'handled';
      }

      // Time is NOT free
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `Unfortunately, ${preferredTime || 'that time'} isn't available. Let me find some alternative times...`,
      });
    }

    // No preferred time OR preferred time wasn't available - find slots
    return await this.findSlotsAndAskApproval(taskId, task, contact, durationMinutes);
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
    const durationMinutes = parsed.durationMinutes;
    const preferredTime = parsed.preferredTimeframe;
    const preferredTimeIso = parsed.preferredTimeIso;

    if (!contactName) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I'd be happy to help schedule a meeting. Who would you like to meet with?`,
      });

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          phase: 'need_contact',
          durationMinutes,
          preferredTime,
          preferredTimeIso,
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

    // Search for the contact in BOTH HubSpot AND Gmail senders
    const [hubspotMatches, gmailSenders] = await Promise.all([
      this.syncedDataTools.findHubspotContactsLocal({
        userId: task.userId,
        query: contactName,
        limit: 10,
      }),
      this.syncedDataTools.findGmailSendersLocal({
        userId: task.userId,
        query: contactName,
        limit: 20,
      }),
    ]);

    // Build candidate list
    const candidates: Array<{
      source: 'hubspot' | 'gmail';
      displayName: string;
      email: string | null;
      hubspotContactId: string | null;
    }> = [];

    for (const h of hubspotMatches) {
      const displayName = `${h.firstName ?? ''} ${h.lastName ?? ''}`.trim() || h.email || 'Unknown';
      candidates.push({
        source: 'hubspot',
        displayName,
        email: h.email,
        hubspotContactId: h.id,
      });
    }

    for (const g of gmailSenders) {
      // Check if we already have this email from HubSpot
      const emailLower = g.email.toLowerCase();
      const alreadyHave = candidates.some((c) => c.email && c.email.toLowerCase() === emailLower);
      if (!alreadyHave) {
        candidates.push({
          source: 'gmail',
          displayName: g.displayName || g.email,
          email: g.email,
          hubspotContactId: null,
        });
      }
    }

    if (candidates.length === 0) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I couldn't find a contact matching "${contactName}" in HubSpot or your email history. Could you provide their email address?`,
      });

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          phase: 'need_email',
          contact: {
            name: contactName,
            email: null,
            hubspotContactId: null,
          },
          durationMinutes,
          preferredTime,
          preferredTimeIso,
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

    // Get unique emails
    const uniqueEmails = new Set(
      candidates.filter((c) => c.email).map((c) => c.email!.toLowerCase()),
    );

    // If we have multiple email options, ask user to clarify
    if (uniqueEmails.size > 1) {
      // Show all candidates with emails to user
      const optionsToShow = candidates.filter((c) => c.email);

      const optionsList = optionsToShow
        .map((c, i) => `${i + 1}. ${c.displayName} (${c.email})`)
        .join('\n');

      const candidateOptions = optionsToShow.map((c, i) => ({
        index: i + 1,
        displayName: c.displayName,
        email: c.email,
        source: c.source,
        hubspotContactId: c.hubspotContactId,
      }));

      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I found multiple email addresses for "${contactName}". Which one should I use?\n\n${optionsList}\n\nPlease reply with the number.`,
      });

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          phase: 'need_contact_clarification',
          contactQuery: contactName,
          candidateOptions,
          durationMinutes,
          preferredTime,
          preferredTimeIso,
        },
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'Which contact did you mean? Reply with the number.',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    // We have zero or one unique email - pick the first candidate with an email
    const best = candidates.find((c) => c.email) ?? candidates[0];

    if (!best || !best.email) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I found "${contactName}" but I don't have an email address on file. Please provide their email address.`,
      });

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          phase: 'need_email',
          contact: {
            name: best?.displayName ?? contactName,
            email: null,
            hubspotContactId: best?.hubspotContactId ?? null,
          },
          durationMinutes,
          preferredTime,
          preferredTimeIso,
        },
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: `Please provide the email address.`,
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    const contact = {
      name: best.displayName,
      email: best.email,
      hubspotContactId: best.hubspotContactId ?? '',
    };

    // If we don't have duration, ask for it
    if (durationMinutes === null) {
      const sourceNote = best.source === 'hubspot' ? '' : ' (from your email history)';

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          phase: 'need_duration',
          contact,
          preferredTime,
          preferredTimeIso,
        },
      });

      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I found ${best.displayName} (${best.email})${sourceNote}. How long should the meeting be? (e.g., "30 minutes", "1 hour")`,
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'How long should the meeting be? Please specify the duration.',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    // We have contact AND duration - check if we have a preferred time
    if (preferredTimeIso) {
      const timezone = 'America/Santo_Domingo';
      const preferredStart = new Date(preferredTimeIso);
      const preferredEnd = new Date(preferredStart.getTime() + durationMinutes * 60 * 1000);

      // Check if this time slot is free using the calendar API
      const busy = await this.calendarApi.getBusyIntervals(task.userId, {
        calendarId: 'primary',
        timeMinIso: preferredStart.toISOString(),
        timeMaxIso: preferredEnd.toISOString(),
        timeZone: timezone,
      });

      const isAvailable = !busy.some((b) => {
        const busyStart = new Date(b.startIso).getTime();
        const busyEnd = new Date(b.endIso).getTime();
        const slotStart = preferredStart.getTime();
        const slotEnd = preferredEnd.getTime();
        return busyStart < slotEnd && busyEnd > slotStart;
      });

      if (isAvailable) {
        // Time is free - propose this specific time
        const proposed = [
          {
            label: 'A',
            startIso: preferredStart.toISOString(),
            endIso: preferredEnd.toISOString(),
          },
        ];

        const dateStr = preferredStart.toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          timeZone: timezone,
        });
        const startTime = preferredStart.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          timeZone: timezone,
        });
        const endTime = preferredEnd.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          timeZone: timezone,
        });

        await this.tasks.mergeMemory(taskId, {
          meeting: {
            phase: 'need_user_approval',
            contact,
            durationMinutes,
            proposed,
            previouslyProposed: [],
            timezone,
          },
        });

        await this.tasks.appendMessage({
          taskId,
          userId: task.userId,
          role: 'assistant',
          content: `Great! ${dateStr}, ${startTime} – ${endTime} is available for a ${durationMinutes}-minute meeting with ${contact.name}.\n\nShould I send this time to ${contact.email}? (Reply "yes" to approve, or let me know if you'd like different times)`,
        });

        await this.tasks.setWaiting(taskId, {
          kind: 'user_message',
          prompt: 'Approve this time?',
          sinceIso: new Date().toISOString(),
        });
        await this.tasks.setStatus(taskId, 'waiting', null);
        return 'handled';
      }

      // Time is NOT free - tell user and find alternatives
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `Unfortunately, ${preferredTime || 'that time'} isn't available. Let me find some alternative times...`,
      });
    }

    // No preferred time OR preferred time wasn't available - find slots
    return await this.findSlotsAndAskApproval(taskId, task, contact, durationMinutes);
  }

  private async handleDurationResponse(
    taskId: number,
    task: AgentTaskRow,
    userResponse: string,
  ): Promise<'handled' | 'not_scheduling'> {
    const mem = task.memory ?? {};
    const meeting = isRecord(mem['meeting']) ? mem['meeting'] : {};
    const contact = isRecord(meeting['contact']) ? meeting['contact'] : {};
    const contactName = typeof contact['name'] === 'string' ? contact['name'] : '';
    const contactEmail = typeof contact['email'] === 'string' ? contact['email'] : '';
    const hubspotContactId =
      typeof contact['hubspotContactId'] === 'string' ? contact['hubspotContactId'] : '';
    const storedPreferredTime =
      typeof meeting['preferredTime'] === 'string' ? meeting['preferredTime'] : null;
    const storedPreferredTimeIso =
      typeof meeting['preferredTimeIso'] === 'string' ? meeting['preferredTimeIso'] : null;

    // Check for flow control
    const flowControlResult = await this.handleFlowControl(
      taskId,
      task,
      userResponse,
      'need_duration',
      contactName,
    );
    if (flowControlResult === 'handled') {
      return 'handled';
    }

    // Parse duration from user response using LLM
    const parsed = await this.nlp.parseUserResponse({
      userMessage: userResponse,
      agentAskedFor: 'duration',
    });

    // Check for cancellation
    if (parsed.type === 'cancellation') {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `No problem, I've cancelled the scheduling request.`,
      });
      await this.tasks.setStatus(taskId, 'completed', null);
      return 'handled';
    }

    const durationMinutes = parsed.durationMinutes ?? null;

    if (!durationMinutes) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I didn't catch the duration. How long should the meeting be? (e.g., "30 minutes", "1 hour")`,
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'Please specify the meeting duration.',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    const contactObj = {
      name: contactName,
      email: contactEmail,
      hubspotContactId,
    };

    // If we have a preferred time, check availability
    if (storedPreferredTimeIso) {
      const timezone = 'America/Santo_Domingo';
      const preferredStart = new Date(storedPreferredTimeIso);
      const preferredEnd = new Date(preferredStart.getTime() + durationMinutes * 60 * 1000);

      const busy = await this.calendarApi.getBusyIntervals(task.userId, {
        calendarId: 'primary',
        timeMinIso: preferredStart.toISOString(),
        timeMaxIso: preferredEnd.toISOString(),
        timeZone: timezone,
      });

      const isAvailable = !busy.some((b) => {
        const busyStart = new Date(b.startIso).getTime();
        const busyEnd = new Date(b.endIso).getTime();
        const slotStart = preferredStart.getTime();
        const slotEnd = preferredEnd.getTime();
        return busyStart < slotEnd && busyEnd > slotStart;
      });

      if (isAvailable) {
        const proposed = [
          {
            label: 'A',
            startIso: preferredStart.toISOString(),
            endIso: preferredEnd.toISOString(),
          },
        ];

        const dateStr = preferredStart.toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          timeZone: timezone,
        });
        const startTime = preferredStart.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          timeZone: timezone,
        });
        const endTime = preferredEnd.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          timeZone: timezone,
        });

        await this.tasks.mergeMemory(taskId, {
          meeting: {
            phase: 'need_user_approval',
            contact: contactObj,
            durationMinutes,
            proposed,
            previouslyProposed: [],
            timezone,
          },
        });

        await this.tasks.appendMessage({
          taskId,
          userId: task.userId,
          role: 'assistant',
          content: `Great! ${dateStr}, ${startTime} – ${endTime} is available for a ${durationMinutes}-minute meeting with ${contactName}.\n\nShould I send this time to ${contactEmail}? (Reply "yes" to approve, or let me know if you'd like different times)`,
        });

        await this.tasks.setWaiting(taskId, {
          kind: 'user_message',
          prompt: 'Approve this time?',
          sinceIso: new Date().toISOString(),
        });
        await this.tasks.setStatus(taskId, 'waiting', null);
        return 'handled';
      }

      // Time is NOT free
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `Unfortunately, ${storedPreferredTime || 'that time'} isn't available. Let me find some alternative times...`,
      });
    }

    // No preferred time or it wasn't available - find slots
    return await this.findSlotsAndAskApproval(taskId, task, contactObj, durationMinutes);
  }

  private async findSlotsAndAskApproval(
    taskId: number,
    task: AgentTaskRow,
    contact: { name: string; email: string; hubspotContactId: string },
    durationMinutes: number,
  ): Promise<'handled'> {
    const timezone = 'America/Santo_Domingo';

    const now = new Date();
    let timezoneOffsetMinutes = 0;
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'shortOffset',
      });
      const parts = formatter.formatToParts(now);
      const offsetPart = parts.find((p) => p.type === 'timeZoneName');
      if (offsetPart?.value) {
        const match = offsetPart.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
        if (match) {
          const sign = match[1] === '+' ? 1 : -1;
          const hours = parseInt(match[2], 10);
          const minutes = parseInt(match[3] ?? '0', 10);
          timezoneOffsetMinutes = sign * (hours * 60 + minutes);
        }
      }
    } catch {
      timezoneOffsetMinutes = -now.getTimezoneOffset();
    }

    // Get previously proposed times from memory to exclude
    const mem = task.memory ?? {};
    const meeting = isRecord(mem['meeting']) ? mem['meeting'] : {};
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

    this.logger.debug(
      `findSlotsAndAskApproval: excluding ${previouslyProposed.length} previously proposed times`,
    );

    // Get more slots than needed so we have room after filtering
    const slots = await this.syncedDataTools.suggestCalendarTimesLocal({
      userId: task.userId,
      startIso: now.toISOString(),
      endIso: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      durationMinutes,
      workDayStartHour: 9,
      workDayEndHour: 17,
      timezoneOffsetMinutes,
      maxSuggestions: 20,
    });

    // Filter out slots that overlap with previously proposed times
    const availableSlots = slots.filter((slot) => {
      const slotStart = new Date(slot.startIso).getTime();
      const slotEnd = new Date(slot.endIso).getTime();

      // Check if this slot overlaps with any previously proposed slot
      const overlaps = previouslyProposed.some((prev) => {
        const prevStart = new Date(prev.startIso).getTime();
        const prevEnd = new Date(prev.endIso).getTime();

        // Slots overlap if one starts before the other ends
        return slotStart < prevEnd && slotEnd > prevStart;
      });

      return !overlaps;
    });

    this.logger.debug(
      `findSlotsAndAskApproval: ${slots.length} total slots, ${availableSlots.length} after filtering`,
    );

    if (availableSlots.length === 0) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I couldn't find any more available time slots in the next 2 weeks. Would you like to cancel or try a different meeting duration?`,
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'What would you like to do?',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    const topSlots = availableSlots.slice(0, 3);

    const labels = ['A', 'B', 'C'];
    const proposed = topSlots.map((slot, i) => ({
      label: labels[i],
      startIso: slot.startIso,
      endIso: slot.endIso,
    }));

    const formattedSlots = proposed
      .map((slot) => {
        const start = new Date(slot.startIso);
        const end = new Date(slot.endIso);

        const dateStr = start.toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          timeZone: timezone,
        });

        const startTime = start.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          timeZone: timezone,
        });

        const endTime = end.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          timeZone: timezone,
        });

        return `  ${slot.label}) ${dateStr}, ${startTime} – ${endTime}`;
      })
      .join('\n');

    // Preserve previouslyProposed when saving
    await this.tasks.mergeMemory(taskId, {
      meeting: {
        ...meeting,
        phase: 'need_user_approval',
        contact: {
          name: contact.name,
          email: contact.email,
          hubspotContactId: contact.hubspotContactId,
        },
        durationMinutes,
        proposed,
        timezone,
      },
    });

    await this.tasks.appendMessage({
      taskId,
      userId: task.userId,
      role: 'assistant',
      content: `I found the following available time slots for a ${durationMinutes}-minute meeting with ${contact.name}:\n\n${formattedSlots}\n\nDo these times look good to send to ${contact.email}? (Reply "yes" to approve, or let me know if you'd like different times)`,
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
  ): Promise<'handled' | 'not_scheduling'> {
    const mem = task.memory ?? {};
    const meeting = isRecord(mem['meeting']) ? mem['meeting'] : {};
    const contact = isRecord(meeting['contact']) ? meeting['contact'] : {};
    const proposedRaw = Array.isArray(meeting['proposed']) ? meeting['proposed'] : [];
    const durationMinutes =
      typeof meeting['durationMinutes'] === 'number' ? meeting['durationMinutes'] : 30;
    const timeZone =
      typeof meeting['timezone'] === 'string' ? meeting['timezone'] : 'America/Santo_Domingo';
    const contactName = typeof contact['name'] === 'string' ? contact['name'] : '';

    // Check for cancellation or contact change first
    const flowControlResult = await this.handleFlowControl(
      taskId,
      task,
      userResponse,
      'need_user_approval',
      contactName,
    );
    if (flowControlResult === 'handled') {
      return 'handled';
    }

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

    // Check for cancellation in the parsed response
    if (parsed.type === 'cancellation') {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `No problem, I've cancelled the scheduling request. Let me know if you need anything else.`,
      });

      await this.tasks.mergeMemory(taskId, { meeting: null });
      await this.tasks.setStatus(taskId, 'completed', null);
      return 'handled';
    }

    // Check for contact change
    if (parsed.type === 'change_contact' && parsed.newContactName) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `Got it, let me find ${parsed.newContactName} instead.`,
      });

      await this.tasks.mergeMemory(taskId, { meeting: null });

      const updatedTask: AgentTaskRow = {
        ...task,
        goal: `Schedule a meeting with ${parsed.newContactName}`,
        memory: {},
      };

      return await this.startSchedulingFlow(taskId, updatedTask);
    }

    // Check for approval
    if (parsed.type === 'approval' && parsed.approved === true) {
      const contactEmail = typeof contact['email'] === 'string' ? contact['email'] : '';

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

      // Determine if single option mode (user specified exact time)
      const isSingleOption = proposed.length === 1;

      const body = isSingleOption
        ? buildSchedulingOptionsEmail({
            intro:
              `Hi ${contactName},\n\n` +
              `I'd like to schedule a ${durationMinutes}-minute meeting with you.`,
            options: proposed.map((p) => ({
              label: p.label,
              startIso: p.startIso,
              endIso: p.endIso,
              timeZone,
            })),
            singleOptionMode: true,
          })
        : buildSchedulingOptionsEmail({
            intro:
              `Hi ${contactName},\n\n` +
              `I'd like to schedule a ${durationMinutes}-minute meeting. Please reply with the letter of your preferred time, or "${String.fromCharCode('A'.charCodeAt(0) + proposed.length)}" if none of these work:\n`,
            options: proposed.map((p) => ({
              label: p.label,
              startIso: p.startIso,
              endIso: p.endIso,
              timeZone,
            })),
            includeNoneOption: true,
          });

      const subject = isSingleOption
        ? `Meeting Request — please confirm`
        : `Scheduling Request — please choose an option`;

      // Send email FIRST
      const sendRes = await this.gmailApi.sendEmail(task.userId, {
        to: contactEmail,
        subject,
        bodyText: body,
      });

      const gmailThreadId = extractThreadIdFromSendResult(sendRes);

      // AFTER sending, get the latest timestamp
      const threadMessages = await this.gmailApi.getThreadMessages(
        task.userId,
        gmailThreadId || '',
      );
      const latestInternalDateMs =
        threadMessages.length > 0
          ? Math.max(...threadMessages.map((m) => m.internalDateMs ?? 0))
          : Date.now();

      const sinceIso = new Date().toISOString();

      // Track previously proposed times
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
          isSingleOption,
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
        content: isSingleOption
          ? `I've sent the meeting request to ${contactEmail}. I'll notify you here when they respond.`
          : `I've sent the scheduling options to ${contactEmail}. I'll notify you here when they respond.`,
      });

      return 'handled';
    }

    // User rejected - find new time slots immediately
    if (parsed.type === 'rejection' || parsed.confidence < 0.6) {
      const contactEmail = typeof contact['email'] === 'string' ? contact['email'] : '';
      const hubspotContactId =
        typeof contact['hubspotContactId'] === 'string' ? contact['hubspotContactId'] : '';

      // Track previously proposed times so we don't show them again
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

      const allPreviouslyProposed: ProposedSlot[] = [...previouslyProposed, ...proposed];

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          ...meeting,
          previouslyProposed: allPreviouslyProposed,
        },
      });

      // Re-fetch task to get updated memory
      const updatedTask = await this.tasks.getTask(taskId);
      if (!updatedTask) {
        return 'handled';
      }

      // Find new slots
      return await this.findSlotsAndAskApproval(
        taskId,
        updatedTask,
        {
          name: contactName,
          email: contactEmail,
          hubspotContactId,
        },
        durationMinutes,
      );
    }

    // Default: treat as needing clarification
    await this.tasks.appendMessage({
      taskId,
      userId: task.userId,
      role: 'assistant',
      content: `I didn't quite catch that. Should I send these time options to the contact? (Reply "yes" to send, "no" for different times, or "cancel" to stop)`,
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

    const choice = extractLabelChoice(parsed.bodyText);
    const contactEmail = typeof contact['email'] === 'string' ? contact['email'] : '';
    const contactName = typeof contact['name'] === 'string' ? contact['name'] : contactEmail;
    const threadId = parsed.threadId;

    // Handle YES response (for single-option mode)
    if (choice === 'YES' && proposed.length >= 1) {
      const chosen = proposed[0];

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

      if (isBusyNow) {
        return await this.sendNewTimesAfterConflict(taskId, task, parsed, 'conflict');
      }

      // Create the calendar event
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
        `Confirmed — you're booked!\n\n` +
        `Start: ${formatDateTimeForHumans(chosen.startIso, timeZone)}\n` +
        `End: ${formatDateTimeForHumans(chosen.endIso, timeZone)}\n` +
        `Duration: ${durationMinutes} minutes\n\n` +
        `I've added it to my calendar and you should receive an invite shortly.`;

      await this.gmailApi.sendEmail(task.userId, {
        to: contactEmail,
        subject: parsed.subject ? `Re: ${parsed.subject}` : 'Re: Meeting Request',
        bodyText: confirmBody,
        threadId,
      });

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          ...meeting,
          phase: 'scheduled',
          chosen: { label: chosen.label, startIso: chosen.startIso, endIso: chosen.endIso },
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

    // Handle NO response (for single-option mode) - same as "none of these work"
    if (choice === 'NO') {
      return await this.handleNoneOfTheseWork(taskId, task, parsed);
    }

    // Handle D (none of these work) for multi-option mode
    if (choice === 'D') {
      return await this.handleNoneOfTheseWork(taskId, task, parsed);
    }

    if (!choice) {
      // Couldn't parse a choice - wait for another reply or ask the user
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

    // Find the chosen slot (A, B, or C)
    const chosen = proposed.find((p) => p.label.toUpperCase() === choice.toUpperCase());

    if (!chosen) {
      // Invalid choice - ask user what to do
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I received a reply from the contact but they selected "${choice}" which doesn't match any of the options. Here's what they said:\n\n"${parsed.bodyText.slice(0, 500)}"\n\nWould you like me to follow up with them?`,
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'How would you like to proceed?',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
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

    if (isBusyNow) {
      // Slot became unavailable - send new options
      return await this.sendNewTimesAfterConflict(taskId, task, parsed, 'conflict');
    }

    // Create the calendar event
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
        `Chosen option: ${choice}\n` +
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
      `Confirmed — you're booked for option ${choice}.\n\n` +
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
        chosen: { label: choice, startIso: chosen.startIso, endIso: chosen.endIso },
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

  /**
   * Handle cancellation or contact change during scheduling flow.
   * Returns 'handled' if the user wanted to cancel/change, null if they want to continue.
   */
  private async handleFlowControl(
    taskId: number,
    task: AgentTaskRow,
    userMessage: string,
    currentPhase: string,
    currentContactName?: string,
  ): Promise<'handled' | 'not_scheduling' | null> {
    const flowControl = await this.nlp.parseFlowControlIntent({
      userMessage,
      currentPhase,
      currentContactName,
    });

    if (flowControl.intent === 'continue') {
      return null; // Continue with normal flow
    }

    if (flowControl.intent === 'cancel') {
      // User wants to cancel the scheduling flow
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `No problem, I've cancelled the scheduling request. Let me know if you need anything else.`,
      });

      // Clear meeting memory and complete the task
      await this.tasks.mergeMemory(taskId, {
        meeting: null,
      });

      await this.tasks.setStatus(taskId, 'completed', null);
      return 'handled';
    }

    if (flowControl.intent === 'change_contact' && flowControl.newContactName) {
      // User wants to schedule with a different person
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `Got it, let me find ${flowControl.newContactName} instead.`,
      });

      // Clear the old meeting memory and restart with new contact
      await this.tasks.mergeMemory(taskId, {
        meeting: null,
      });

      // Update the task goal to reflect the new contact
      const originalGoal = task.goal;
      const newGoal = originalGoal.replace(
        /with\s+.+?(?=\s+for\s+|\s+at\s+|\s+on\s+|$)/i,
        `with ${flowControl.newContactName}`,
      );

      // Re-run the scheduling flow with the new contact
      const updatedTask: AgentTaskRow = {
        ...task,
        goal: newGoal,
        memory: {},
      };

      return await this.startSchedulingFlow(taskId, updatedTask);
    }

    if (flowControl.intent === 'restart') {
      // User wants to start over
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `Let's start over. Who would you like to schedule a meeting with?`,
      });

      // Clear meeting memory
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

    return null;
  }

  private async handleContactClarificationResponse(
    taskId: number,
    task: AgentTaskRow,
    userResponse: string,
  ): Promise<'handled'> {
    const mem = task.memory ?? {};
    const meeting = isRecord(mem['meeting']) ? mem['meeting'] : {};
    const candidateOptionsRaw = Array.isArray(meeting['candidateOptions'])
      ? meeting['candidateOptions']
      : [];
    const durationMinutes =
      typeof meeting['durationMinutes'] === 'number' ? meeting['durationMinutes'] : null;
    const preferredTime =
      typeof meeting['preferredTime'] === 'string' ? meeting['preferredTime'] : null;
    const preferredTimeIso =
      typeof meeting['preferredTimeIso'] === 'string' ? meeting['preferredTimeIso'] : null;

    // Parse candidate options safely
    const candidateOptions = candidateOptionsRaw
      .filter((c): c is Record<string, unknown> => isRecord(c))
      .map((c) => ({
        index: typeof c.index === 'number' ? c.index : 0,
        displayName: typeof c.displayName === 'string' ? c.displayName : '',
        email: typeof c.email === 'string' ? c.email : null,
        source: typeof c.source === 'string' ? c.source : 'gmail',
        hubspotContactId: typeof c.hubspotContactId === 'string' ? c.hubspotContactId : null,
      }))
      .filter((c) => c.index > 0 && c.displayName);

    // Check for cancellation first
    const flowControlResult = await this.handleFlowControl(
      taskId,
      task,
      userResponse,
      'need_contact_clarification',
    );
    if (flowControlResult === 'handled') {
      return 'handled';
    }

    // Try to parse the user's selection
    const response = userResponse.trim();

    // Check for number selection
    const numberMatch = response.match(/^(\d+)/);
    let selectedCandidate: (typeof candidateOptions)[number] | null = null;

    if (numberMatch) {
      const index = parseInt(numberMatch[1], 10);
      selectedCandidate = candidateOptions.find((c) => c.index === index) ?? null;
    }

    // If no number, try to match by name or email
    if (!selectedCandidate) {
      const responseLower = response.toLowerCase();
      for (const candidate of candidateOptions) {
        if (
          candidate.displayName.toLowerCase().includes(responseLower) ||
          responseLower.includes(candidate.displayName.toLowerCase()) ||
          (candidate.email && candidate.email.toLowerCase().includes(responseLower))
        ) {
          selectedCandidate = candidate;
          break;
        }
      }
    }

    if (!selectedCandidate) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I didn't understand your selection. Please reply with the number (1, 2, 3, etc.) of the contact you'd like to schedule with, or say "cancel" to stop.`,
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'Which contact number?',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    const { displayName, email, hubspotContactId } = selectedCandidate;

    if (!email) {
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I found ${displayName}, but I don't have an email address for them. Could you provide it?`,
      });

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          phase: 'need_email',
          contact: {
            name: displayName,
            email: null,
            hubspotContactId,
          },
          durationMinutes,
          preferredTime,
          preferredTimeIso,
        },
      });

      await this.tasks.setWaiting(taskId, {
        kind: 'user_message',
        prompt: 'Please provide the email address.',
        sinceIso: new Date().toISOString(),
      });
      await this.tasks.setStatus(taskId, 'waiting', null);
      return 'handled';
    }

    const contact = {
      name: displayName,
      email,
      hubspotContactId: hubspotContactId ?? '',
    };

    // If we already have duration AND preferred time, check availability
    if (durationMinutes && preferredTimeIso) {
      const timezone = 'America/Santo_Domingo';
      const preferredStart = new Date(preferredTimeIso);
      const preferredEnd = new Date(preferredStart.getTime() + durationMinutes * 60 * 1000);

      const busy = await this.calendarApi.getBusyIntervals(task.userId, {
        calendarId: 'primary',
        timeMinIso: preferredStart.toISOString(),
        timeMaxIso: preferredEnd.toISOString(),
        timeZone: timezone,
      });

      const isAvailable = !busy.some((b) => {
        const busyStart = new Date(b.startIso).getTime();
        const busyEnd = new Date(b.endIso).getTime();
        const slotStart = preferredStart.getTime();
        const slotEnd = preferredEnd.getTime();
        return busyStart < slotEnd && busyEnd > slotStart;
      });

      if (isAvailable) {
        const proposed = [
          {
            label: 'A',
            startIso: preferredStart.toISOString(),
            endIso: preferredEnd.toISOString(),
          },
        ];

        const dateStr = preferredStart.toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          timeZone: timezone,
        });
        const startTime = preferredStart.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          timeZone: timezone,
        });
        const endTime = preferredEnd.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          timeZone: timezone,
        });

        await this.tasks.mergeMemory(taskId, {
          meeting: {
            phase: 'need_user_approval',
            contact,
            durationMinutes,
            proposed,
            previouslyProposed: [],
            timezone,
          },
        });

        await this.tasks.appendMessage({
          taskId,
          userId: task.userId,
          role: 'assistant',
          content: `Great! ${dateStr}, ${startTime} – ${endTime} is available for a ${durationMinutes}-minute meeting with ${contact.name}.\n\nShould I send this time to ${contact.email}? (Reply "yes" to approve, or let me know if you'd like different times)`,
        });

        await this.tasks.setWaiting(taskId, {
          kind: 'user_message',
          prompt: 'Approve this time?',
          sinceIso: new Date().toISOString(),
        });
        await this.tasks.setStatus(taskId, 'waiting', null);
        return 'handled';
      }

      // Time is NOT free
      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `Unfortunately, ${preferredTime || 'that time'} isn't available. Let me find some alternative times...`,
      });

      return await this.findSlotsAndAskApproval(taskId, task, contact, durationMinutes);
    }

    // If we have duration but no preferred time, find slots directly
    if (durationMinutes) {
      return await this.findSlotsAndAskApproval(taskId, task, contact, durationMinutes);
    }

    // No duration yet - ask for it
    await this.tasks.mergeMemory(taskId, {
      meeting: {
        phase: 'need_duration',
        contact,
        preferredTime,
        preferredTimeIso,
      },
    });

    await this.tasks.appendMessage({
      taskId,
      userId: task.userId,
      role: 'assistant',
      content: `Great, I'll schedule with ${displayName} (${email}). How long should the meeting be? (e.g., "30 minutes", "1 hour")`,
    });

    await this.tasks.setWaiting(taskId, {
      kind: 'user_message',
      prompt: 'How long should the meeting be?',
      sinceIso: new Date().toISOString(),
    });
    await this.tasks.setStatus(taskId, 'waiting', null);
    return 'handled';
  }
}

// HELPER FUNCTIONS

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

  // FIRST: Check for Yes/No responses (for single-option mode)
  const yesPatterns = [
    /^YES\b/i,
    /^YEP\b/i,
    /^YEAH\b/i,
    /^YUP\b/i,
    /^SURE\b/i,
    /^OK\b/i,
    /^OKAY\b/i,
    /^SOUNDS?\s+GOOD\b/i,
    /^THAT\s+WORKS?\b/i,
    /^WORKS?\s+FOR\s+ME\b/i,
    /^PERFECT\b/i,
    /^GREAT\b/i,
    /^CONFIRMED?\b/i,
    /^I'?M?\s+(?:GOOD|IN|AVAILABLE|FREE)\b/i,
    /^(?:THAT'?S?\s+)?(?:GOOD|FINE|GREAT|PERFECT)\b/i,
    /^SEE\s+YOU\s+THEN\b/i,
  ];

  for (const pattern of yesPatterns) {
    if (pattern.test(head)) {
      return 'YES';
    }
  }

  const noPatterns = [
    /^NO\b/i,
    /^NOPE\b/i,
    /^NAH\b/i,
    /^SORRY\b/i,
    /^(?:I\s+)?CAN'?T\b/i,
    /^(?:THAT\s+)?(?:DOESN'?T|DOES\s+NOT|WON'?T|WILL\s+NOT)\s+WORK\b/i,
    /^(?:I'?M?\s+)?NOT\s+(?:AVAILABLE|FREE)\b/i,
    /^(?:I\s+)?(?:HAVE|GOT)\s+(?:A\s+)?(?:CONFLICT|SOMETHING)\b/i,
    /^UNFORTUNATELY\b/i,
    /^(?:NEED|WANT)\s+(?:A\s+)?DIFFERENT\s+TIME\b/i,
  ];

  for (const pattern of noPatterns) {
    if (pattern.test(head)) {
      return 'NO';
    }
  }

  // SECOND: Check for explicit letter choices A, B, C at the very start
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

  // THIRD: Check for choice phrases that indicate A, B, or C
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

  // FOURTH: Check for standalone A, B, or C with clear word boundaries
  // Be careful not to match letters that are part of words
  const standaloneABC = headUpper.match(/(?:^|[\s.,:;!?()])([A-C])(?:[\s.,:;!?()]|$)/);
  if (standaloneABC) {
    return standaloneABC[1];
  }

  // FIFTH: Now check for explicit "D" or "none of these" ONLY if no A/B/C was found

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
  singleOptionMode?: boolean;
}): string {
  const lines: string[] = [];

  // Single option mode: Yes/No format
  if (input.singleOptionMode && input.options.length === 1) {
    const opt = input.options[0];
    const start = formatDateTimeForHumans(opt.startIso, opt.timeZone);
    const end = formatTimeForHumans(opt.endIso, opt.timeZone);

    lines.push(input.intro);
    lines.push('');
    lines.push(`Proposed time: ${start} – ${end}`);
    lines.push('');
    lines.push('Please reply:');
    lines.push('  Yes - if this time works for you');
    lines.push('  No - if you need a different time');
    lines.push('');
    lines.push('Just reply with "Yes" or "No".');

    return lines.join('\n');
  }

  // Multiple options mode: A/B/C/D format
  lines.push(input.intro);
  lines.push('');

  for (const opt of input.options) {
    const start = formatDateTimeForHumans(opt.startIso, opt.timeZone);
    const end = formatTimeForHumans(opt.endIso, opt.timeZone);
    lines.push(`${opt.label}) ${start} – ${end}`);
  }

  if (input.includeNoneOption) {
    const nextLabel = String.fromCharCode('A'.charCodeAt(0) + input.options.length);
    lines.push(`${nextLabel}) None of these times work for me`);
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
