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

      const didAuto = await this.tryAutoResolveScheduling(taskId, task);
      if (didAuto === 'completed') return;
      if (didAuto === 'waiting') return;

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
      // Always try to mirror any newly-added agent messages into the chat thread.
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

  // ---------------- scheduling auto-resolve ----------------
  private async tryAutoResolveScheduling(
    taskId: number,
    task: AgentTaskRow,
  ): Promise<'completed' | 'waiting' | 'nope'> {
    const mem = task.memory ?? {};
    const meeting = isRecord(mem['meeting']) ? mem['meeting'] : null;
    if (!meeting) return 'nope';

    const proposedRaw = meeting['proposed'];
    if (!Array.isArray(proposedRaw) || proposedRaw.length === 0) return 'nope';

    const uiMessages = await this.tasks.getMessagesForUi(taskId);
    const lastUser = [...uiMessages].reverse().find((m) => m.role === 'user');
    if (!lastUser) return 'nope';

    const parsed = parseIncomingEmailBlock(lastUser.content);
    if (!parsed) return 'nope';

    const label = extractLabelChoice(parsed.bodyText);
    if (!label) return 'nope';

    const proposed = proposedRaw
      .map((p) => {
        if (!isRecord(p)) return null;
        const l = typeof p.label === 'string' ? p.label.trim().toUpperCase() : '';
        const startIso = typeof p.startIso === 'string' ? p.startIso.trim() : '';
        const endIso = typeof p.endIso === 'string' ? p.endIso.trim() : '';
        if (!l || !startIso || !endIso) return null;
        return { label: l, startIso, endIso };
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));

    const chosen = proposed.find((p) => p.label === label);
    if (!chosen) return 'nope';

    const timeZone =
      typeof meeting['timezone'] === 'string' && meeting['timezone'].trim()
        ? meeting['timezone'].trim()
        : 'America/Santo_Domingo';

    const durationMinutes =
      typeof meeting['durationMinutes'] === 'number' && Number.isFinite(meeting['durationMinutes'])
        ? Math.trunc(meeting['durationMinutes'])
        : 30;

    const contact = isRecord(meeting['contact']) ? meeting['contact'] : {};
    const contactEmail =
      (typeof contact['email'] === 'string' ? contact['email'].trim() : '') ||
      extractEmail(parsed.from) ||
      '';

    if (!contactEmail) return 'nope';

    const busy = await this.calendarApi.getBusyIntervals(task.userId, {
      calendarId: 'primary',
      timeMinIso: chosen.startIso,
      timeMaxIso: chosen.endIso,
      timeZone,
    });

    const isBusyNow = Array.isArray(busy) && busy.length > 0;
    const threadId = parsed.threadId;

    if (isBusyNow) {
      const now = Date.now();
      const startIso = new Date(now + 60 * 60_000).toISOString();
      const endIso = new Date(now + 7 * 24 * 60 * 60_000).toISOString();

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

      const nextProposed = slots.slice(0, 3).map((s, idx) => ({
        label: String.fromCharCode('A'.charCodeAt(0) + idx),
        startIso: s.startIso,
        endIso: s.endIso,
      }));

      if (nextProposed.length === 0) return 'nope';

      await this.tasks.mergeMemory(taskId, {
        meeting: {
          ...meeting,
          proposed: nextProposed,
          gmailThreadId: threadId,
        },
      });

      const body = buildSchedulingOptionsEmail({
        intro:
          `Thanks — it looks like the time you picked (${label}) just became unavailable on my calendar.\n\n` +
          `Here are a few new options. Please reply with A, B, or C:`,
        options: nextProposed.map((p) => ({
          label: p.label,
          startIso: p.startIso,
          endIso: p.endIso,
          timeZone,
        })),
      });

      await this.gmailApi.sendEmail(task.userId, {
        to: contactEmail,
        subject: parsed.subject ? `Re: ${parsed.subject}` : 'Re: Scheduling',
        bodyText: body,
        threadId,
      });

      // Use Gmail's internal timeline as baseline (not server clock)
      const baseline = await getGmailThreadBaselineInternalDateMs(
        this.gmailApi,
        task.userId,
        threadId,
      );

      await this.tasks.setWaiting(taskId, {
        kind: 'gmail_reply',
        threadId,
        fromEmail: contactEmail,
        sinceIso: new Date().toISOString(), // keep for debugging
        sinceInternalDateMs: baseline.sinceInternalDateMs,
      });

      await this.tasks.setStatus(taskId, 'waiting', null);

      await this.tasks.appendMessage({
        taskId,
        userId: task.userId,
        role: 'assistant',
        content: `I received the client’s reply (${label}), but that slot is now busy. I emailed new options and I’m waiting for their selection.`,
      });

      return 'waiting';
    }

    const summary =
      (typeof meeting['summary'] === 'string' && meeting['summary'].trim()) ||
      `Meeting with ${contactEmail}`;

    const created = await this.calendarApi.createEvent(task.userId, {
      calendarId: 'primary',
      summary,
      description: typeof meeting['description'] === 'string' ? meeting['description'] : undefined,
      location: typeof meeting['location'] === 'string' ? meeting['location'] : undefined,
      startIso: chosen.startIso,
      endIso: chosen.endIso,
      timeZone,
      attendees: [{ email: contactEmail }],
    });

    const hubspotContactId =
      typeof contact['hubspotContactId'] === 'string' ? contact['hubspotContactId'].trim() : '';

    if (hubspotContactId) {
      const noteBody =
        `Scheduled meeting.\n\n` +
        `Client: ${contactEmail}\n` +
        `Chosen option: ${label}\n` +
        `Start: ${chosen.startIso}\n` +
        `End: ${chosen.endIso}\n` +
        `Calendar event: ${created.id}\n`;

      await this.hubspotApi.createNoteOnContact(task.userId, {
        contactId: hubspotContactId,
        body: noteBody,
        timestampIso: new Date().toISOString(),
      });
    }

    const confirmBody =
      `Confirmed — you’re booked for option ${label}.\n\n` +
      `Start: ${chosen.startIso}\n` +
      `End: ${chosen.endIso}\n\n` +
      `I’ve added it to my calendar and you should receive an invite shortly.`;

    await this.gmailApi.sendEmail(task.userId, {
      to: contactEmail,
      subject: parsed.subject ? `Re: ${parsed.subject}` : 'Re: Scheduling',
      bodyText: confirmBody,
      threadId,
    });

    await this.tasks.mergeMemory(taskId, {
      meeting: {
        ...meeting,
        status: 'scheduled',
        chosen: { label, startIso: chosen.startIso, endIso: chosen.endIso },
        calendarEventId: created.id,
        gmailThreadId: threadId,
      },
    });

    await this.tasks.appendMessage({
      taskId,
      userId: task.userId,
      role: 'assistant',
      content: `Scheduled the meeting (option ${label}) and sent confirmation.`,
    });

    await this.tasks.setStatus(taskId, 'completed', null);
    return 'completed';
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

          // baseline using Gmail internalDateMs
          const baseline = await getGmailThreadBaselineInternalDateMs(
            this.gmailApi,
            userId,
            gmailThreadId,
          );

          const waiting: Record<string, unknown> = {
            kind: 'gmail_reply',
            threadId: gmailThreadId,
            fromEmail: fromEmail || null,
            sinceIso: new Date().toISOString(), // keep for debug/visibility
            sinceInternalDateMs: baseline.sinceInternalDateMs,
          };

          await this.tasks.setWaiting(taskId, waiting);

          const out = {
            waiting: true,
            kind: 'gmail_reply',
            gmailThreadId,
            fromEmail: fromEmail || null,
            sinceIso: waiting.sinceIso,
            sinceInternalDateMs: baseline.sinceInternalDateMs,
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

        // Local mirror tools
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

        // Action tools
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

async function getGmailThreadBaselineInternalDateMs(
  gmailApi: GmailApiService,
  userId: number,
  threadId: string,
): Promise<{ sinceInternalDateMs: number }> {
  try {
    const msgs = await gmailApi.getThreadMessages(userId, threadId);
    let max = 0;

    for (const m of msgs) {
      const v = typeof m.internalDateMs === 'number' ? m.internalDateMs : NaN;
      if (Number.isFinite(v) && v > max) max = v;
    }

    return { sinceInternalDateMs: max };
  } catch {
    // If Gmail read fails, keep baseline at 0 (still better than mixing server clock with Gmail clock).
    return { sinceInternalDateMs: 0 };
  }
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

  const head = s.slice(0, 400);

  const patterns = [
    /\boption\s*([A-F])\b/i,
    /\bchoose\s*([A-F])\b/i,
    /\b([A-F])\)/i,
    /\b([A-F])\b/i,
  ];

  for (const re of patterns) {
    const m = head.match(re);
    if (m && m[1]) return String(m[1]).toUpperCase();
  }

  return null;
}

function extractEmail(s: string): string | null {
  const m = String(s ?? '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : null;
}

function buildSchedulingOptionsEmail(input: {
  intro: string;
  options: Array<{ label: string; startIso: string; endIso: string; timeZone: string }>;
}): string {
  const lines: string[] = [];
  lines.push(input.intro);
  lines.push('');

  for (const opt of input.options) {
    lines.push(`${opt.label}) ${opt.startIso} – ${opt.endIso} (${opt.timeZone})`);
  }

  lines.push('');
  lines.push('Reply with A, B, or C.');

  return lines.join('\n');
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
