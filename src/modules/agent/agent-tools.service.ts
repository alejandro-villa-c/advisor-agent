import { Injectable } from '@nestjs/common';
import type { OpenAiToolDefinition } from '../integrations/openai/openai-tool-chat.service';

@Injectable()
export class AgentToolsService {
  buildSystemPrompt(input: { goal: string; memory: Record<string, unknown> }): string {
    const goal = (input.goal ?? '').trim();
    const nowIso = new Date().toISOString();

    return [
      `You are an autonomous assistant (agent) helping a financial advisor.`,
      ``,
      `NOW_UTC: ${nowIso}`,
      `USER_TIMEZONE: America/Santo_Domingo`,
      `USER_TZ_OFFSET_MINUTES: -240`,
      ``,
      `GOAL:`,
      goal || '(no goal provided)',
      ``,
      `MEMORY (JSON):`,
      safeJsonStringify(input.memory ?? {}),
      ``,
      `Rules:`,
      `- Use the available tools when you need data or to take actions (email, calendar, hubspot).`,
      `- You may call multiple tools. Be persistent and finish the task.`,
      `- If you need to wait for an email reply, call await_gmail_reply with the Gmail threadId and (ideally) fromEmail.`,
      `  (await_gmail_reply automatically uses Gmail's internal timestamps to avoid clock-skew issues.)`,
      `- If you need clarification from the advisor (the app user), call await_user_message.`,
      `- When you have completed the goal, respond normally (no tool calls) with what you did.`,
      ``,
      `Scheduling protocol (REQUIRED for meeting scheduling):`,
      `1) Propose labeled options (A, B, C) and ask the client to reply with the label only.`,
      `2) After you send the email, call remember() to store meeting state like this:`,
      `   {`,
      `     "meeting": {`,
      `       "timezone": "America/Santo_Domingo",`,
      `       "durationMinutes": 30,`,
      `       "contact": { "name": "Sara Smith", "email": "sara@x.com", "hubspotContactId": "123" },`,
      `       "gmailThreadId": "<threadId from gmail_send_email result>",`,
      `       "proposed": [`,
      `         { "label": "A", "startIso": "...", "endIso": "..." },`,
      `         { "label": "B", "startIso": "...", "endIso": "..." },`,
      `         { "label": "C", "startIso": "...", "endIso": "..." }`,
      `       ]`,
      `     }`,
      `   }`,
      `3) When a client selects a label, BEFORE creating the event you MUST call calendar_get_busy for that exact slot.`,
      `4) If busy, email new labeled options and await_gmail_reply again.`,
      `5) If free, create event, add HubSpot note, and send confirmation.`,
    ].join('\n');
  }

  getToolDefinitions(): OpenAiToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: 'remember',
          description: 'Merge a JSON patch into the task memory.',
          parameters: {
            type: 'object',
            properties: {
              patch: { type: 'object', additionalProperties: true },
            },
            required: ['patch'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'await_user_message',
          description:
            'Put the task into waiting state until the advisor (app user) replies with more info.',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'Question/prompt shown to the advisor.' },
            },
            required: ['prompt'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'await_gmail_reply',
          description:
            'Put the task into waiting state until a reply arrives in the given Gmail thread.',
          parameters: {
            type: 'object',
            properties: {
              gmailThreadId: { type: 'string' },
              fromEmail: {
                type: 'string',
                description: 'Filter replies to this sender (recommended).',
              },
            },
            required: ['gmailThreadId'],
          },
        },
      },

      // Local search tools (DB mirrors)
      {
        type: 'function',
        function: {
          name: 'hubspot_find_contacts_local',
          description: 'Search locally-synced HubSpot contacts (fast).',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              limit: { type: 'number' },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'gmail_search_messages_local',
          description: 'Search locally-synced Gmail messages (fast).',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              limit: { type: 'number' },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'calendar_suggest_times_local',
          description: 'Suggest free meeting time slots based on locally-synced calendar events.',
          parameters: {
            type: 'object',
            properties: {
              startIso: { type: 'string', description: 'Range start ISO datetime' },
              endIso: { type: 'string', description: 'Range end ISO datetime' },
              durationMinutes: { type: 'number', default: 30 },
              workDayStartHour: { type: 'number', default: 9 },
              workDayEndHour: { type: 'number', default: 17 },
              timezoneOffsetMinutes: {
                type: 'number',
                default: -240,
                description:
                  'User timezone offset in minutes (e.g. -240 for America/Santo_Domingo)',
              },
              maxSuggestions: { type: 'number', default: 10 },
            },
            required: ['startIso', 'endIso', 'durationMinutes'],
          },
        },
      },

      // Action tools (real APIs)
      {
        type: 'function',
        function: {
          name: 'gmail_send_email',
          description: 'Send an email via Gmail API. Can also send a reply in an existing thread.',
          parameters: {
            type: 'object',
            properties: {
              to: { type: 'string' },
              subject: { type: 'string' },
              bodyText: { type: 'string' },
              cc: { type: 'string' },
              bcc: { type: 'string' },
              threadId: { type: 'string' },
              inReplyToMessageId: { type: 'string' },
              references: { type: 'string' },
              replyTo: { type: 'string' },
            },
            required: ['to', 'subject', 'bodyText'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'calendar_get_busy',
          description: 'Fetch busy intervals from Google Calendar (authoritative).',
          parameters: {
            type: 'object',
            properties: {
              calendarId: { type: 'string', default: 'primary' },
              timeMinIso: { type: 'string' },
              timeMaxIso: { type: 'string' },
              timeZone: { type: 'string' },
            },
            required: ['timeMinIso', 'timeMaxIso'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'calendar_create_event',
          description: 'Create a Google Calendar event.',
          parameters: {
            type: 'object',
            properties: {
              calendarId: { type: 'string', default: 'primary' },
              summary: { type: 'string' },
              description: { type: 'string' },
              location: { type: 'string' },
              startIso: { type: 'string' },
              endIso: { type: 'string' },
              timeZone: { type: 'string' },
              attendees: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    email: { type: 'string' },
                    displayName: { type: 'string' },
                  },
                  required: ['email'],
                },
              },
            },
            required: ['summary', 'startIso', 'endIso'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'calendar_update_event',
          description: 'Update (PATCH) a Google Calendar event.',
          parameters: {
            type: 'object',
            properties: {
              calendarId: { type: 'string', default: 'primary' },
              eventId: { type: 'string' },
              summary: { type: 'string' },
              description: { type: 'string' },
              location: { type: 'string' },
              startIso: { type: 'string' },
              endIso: { type: 'string' },
              timeZone: { type: 'string' },
              attendees: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    email: { type: 'string' },
                    displayName: { type: 'string' },
                  },
                  required: ['email'],
                },
              },
            },
            required: ['eventId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'hubspot_find_or_create_contact',
          description: 'Find a HubSpot contact by email or create it.',
          parameters: {
            type: 'object',
            properties: {
              email: { type: 'string' },
              firstName: { type: 'string' },
              lastName: { type: 'string' },
            },
            required: ['email'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'hubspot_create_note_on_contact',
          description: 'Create a HubSpot note associated to a contact.',
          parameters: {
            type: 'object',
            properties: {
              contactId: { type: 'string' },
              body: { type: 'string' },
              timestampIso: { type: 'string' },
            },
            required: ['contactId', 'body'],
          },
        },
      },
    ];
  }
}

function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v ?? null, null, 2);
  } catch {
    return 'null';
  }
}
