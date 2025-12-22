import { Injectable, Logger } from '@nestjs/common';
import { GmailApiService } from '../integrations/google/gmail-api.service';
import { CalendarApiService } from '../integrations/google/calendar-api.service';
import { HubspotApiService } from '../integrations/hubspot/hubspot-api.service';
import { SyncedDataToolsService } from './synced-data-tools.service';

export type ToolExecutionResult = {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
};

/**
 * Shared tool execution service used by both:
 * - InstructionExecutorService (for ongoing instructions / proactive actions)
 * - AgentRunnerService (for one-time agent tasks)
 *
 * This centralizes all tool implementations in one place.
 */
@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    private readonly gmailApi: GmailApiService,
    private readonly calendarApi: CalendarApiService,
    private readonly hubspotApi: HubspotApiService,
    private readonly syncedDataTools: SyncedDataToolsService,
  ) {}

  /**
   * Execute a tool by name with the given parameters.
   * Returns a standardized result object.
   */
  async execute(
    userId: number,
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    try {
      const data = await this.executeInternal(userId, toolName, params);
      return { success: true, data };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[ToolExecutor] ${toolName} failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Get all available tool definitions for OpenAI function calling.
   */
  getToolDefinitions(): Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }> {
    return [
      // =========================================================================
      // LOCAL SEARCH TOOLS (preferred - search synced data)
      // =========================================================================
      {
        type: 'function',
        function: {
          name: 'hubspot_find_contacts_local',
          description:
            'Search for contacts in the LOCAL synced HubSpot data. This searches ALL your historical contacts. Use this FIRST before hubspot_find_contacts.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description:
                  'Search query (name, email, etc.) - searches firstName, lastName, email',
              },
              limit: { type: 'number', description: 'Max results (default 25)' },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'gmail_find_senders_local',
          description:
            'Find unique email senders from LOCAL synced Gmail data. Returns deduplicated list of senders matching the query with their email, display name, and last contact date. Use this to find ALL people who have emailed you.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query - matches against sender name and email',
              },
              limit: { type: 'number', description: 'Max unique senders to return (default 50)' },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'gmail_search_local',
          description:
            'Search for emails in LOCAL synced Gmail data. Searches subject, snippet, from, and to fields. Returns ALL historical emails matching the query.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query - matches subject, snippet, from, to',
              },
              limit: { type: 'number', description: 'Max results (default 25)' },
            },
            required: ['query'],
          },
        },
      },

      // =========================================================================
      // GMAIL TOOLS
      // =========================================================================
      {
        type: 'function',
        function: {
          name: 'gmail_send_email',
          description: 'Send a new email. Use this for composing fresh emails to contacts.',
          parameters: {
            type: 'object',
            properties: {
              to: { type: 'string', description: 'Recipient email address' },
              subject: { type: 'string', description: 'Email subject line' },
              bodyText: { type: 'string', description: 'Plain text email body' },
              cc: { type: 'string', description: 'CC recipients (optional)' },
              bcc: { type: 'string', description: 'BCC recipients (optional)' },
            },
            required: ['to', 'subject', 'bodyText'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'gmail_reply',
          description:
            'Reply to an existing email thread. Automatically handles threading headers.',
          parameters: {
            type: 'object',
            properties: {
              threadId: { type: 'string', description: 'Gmail thread ID to reply to' },
              bodyText: { type: 'string', description: 'Reply message body' },
            },
            required: ['threadId', 'bodyText'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'gmail_search',
          description:
            'Search for emails using Gmail API. NOTE: Prefer gmail_search_local for broader historical search. Use this only if you need very recent emails not yet synced.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description:
                  'Gmail search query (e.g., "from:john@example.com", "subject:meeting", "is:unread")',
              },
              maxResults: { type: 'number', description: 'Max results to return (default 10)' },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'gmail_get_thread',
          description:
            'Get full content of an email thread. Use when you need the complete message bodies, not just snippets.',
          parameters: {
            type: 'object',
            properties: {
              threadId: { type: 'string', description: 'Gmail thread ID' },
            },
            required: ['threadId'],
          },
        },
      },

      // =========================================================================
      // CALENDAR TOOLS
      // =========================================================================
      {
        type: 'function',
        function: {
          name: 'calendar_create_event',
          description:
            'Create a new calendar event. Use for scheduling meetings, appointments, etc.',
          parameters: {
            type: 'object',
            properties: {
              summary: { type: 'string', description: 'Event title' },
              startIso: { type: 'string', description: 'Start time in ISO 8601 format' },
              endIso: { type: 'string', description: 'End time in ISO 8601 format' },
              description: { type: 'string', description: 'Event description (optional)' },
              location: { type: 'string', description: 'Event location (optional)' },
              timeZone: {
                type: 'string',
                description: 'Timezone (optional, e.g., "America/New_York")',
              },
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
                description: 'List of attendees to invite',
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
          description: 'Update an existing calendar event.',
          parameters: {
            type: 'object',
            properties: {
              eventId: { type: 'string', description: 'Calendar event ID to update' },
              summary: { type: 'string', description: 'New event title (optional)' },
              startIso: { type: 'string', description: 'New start time (optional)' },
              endIso: { type: 'string', description: 'New end time (optional)' },
              description: { type: 'string', description: 'New description (optional)' },
              location: { type: 'string', description: 'New location (optional)' },
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
                description: 'Updated attendee list (optional)',
              },
            },
            required: ['eventId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'calendar_delete_event',
          description: 'Delete/cancel a calendar event.',
          parameters: {
            type: 'object',
            properties: {
              eventId: { type: 'string', description: 'Calendar event ID to delete' },
            },
            required: ['eventId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'calendar_find_events',
          description:
            'Search for calendar events by query, attendee, or time range. Use to find existing meetings.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Text search in event title/description (optional)',
              },
              attendeeEmail: {
                type: 'string',
                description: 'Filter by attendee email (optional)',
              },
              timeMinIso: {
                type: 'string',
                description: 'Start of time range (default: now)',
              },
              timeMaxIso: {
                type: 'string',
                description: 'End of time range (default: 30 days from now)',
              },
              maxResults: { type: 'number', description: 'Max results (default 50)' },
            },
            required: [],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'calendar_get_busy',
          description:
            'Get busy/free intervals from calendar. Use to check availability before scheduling.',
          parameters: {
            type: 'object',
            properties: {
              timeMinIso: { type: 'string', description: 'Start of range in ISO 8601' },
              timeMaxIso: { type: 'string', description: 'End of range in ISO 8601' },
              timeZone: { type: 'string', description: 'Timezone (optional)' },
            },
            required: ['timeMinIso', 'timeMaxIso'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'calendar_suggest_times',
          description:
            'Suggest available meeting time slots based on calendar. Returns free slots within work hours.',
          parameters: {
            type: 'object',
            properties: {
              startIso: { type: 'string', description: 'Start of search range' },
              endIso: { type: 'string', description: 'End of search range' },
              durationMinutes: {
                type: 'number',
                description: 'Meeting duration in minutes (default 30)',
              },
              workDayStartHour: { type: 'number', description: 'Work day start hour (default 9)' },
              workDayEndHour: { type: 'number', description: 'Work day end hour (default 17)' },
              maxSuggestions: {
                type: 'number',
                description: 'Max number of suggestions (default 5)',
              },
            },
            required: ['startIso', 'endIso', 'durationMinutes'],
          },
        },
      },

      // =========================================================================
      // HUBSPOT TOOLS
      // =========================================================================
      {
        type: 'function',
        function: {
          name: 'hubspot_create_contact',
          description: 'Create a new contact in HubSpot CRM.',
          parameters: {
            type: 'object',
            properties: {
              email: { type: 'string', description: 'Contact email (required)' },
              firstName: { type: 'string', description: 'First name (optional)' },
              lastName: { type: 'string', description: 'Last name (optional)' },
            },
            required: ['email'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'hubspot_update_contact',
          description: 'Update an existing HubSpot contact.',
          parameters: {
            type: 'object',
            properties: {
              contactId: { type: 'string', description: 'HubSpot contact ID' },
              email: { type: 'string', description: 'New email (optional)' },
              firstName: { type: 'string', description: 'New first name (optional)' },
              lastName: { type: 'string', description: 'New last name (optional)' },
              company: { type: 'string', description: 'Company name (optional)' },
              phone: { type: 'string', description: 'Phone number (optional)' },
            },
            required: ['contactId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'hubspot_delete_contact',
          description: 'Delete a contact from HubSpot.',
          parameters: {
            type: 'object',
            properties: {
              contactId: { type: 'string', description: 'HubSpot contact ID to delete' },
            },
            required: ['contactId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'hubspot_get_contact',
          description: 'Get details of a HubSpot contact by ID or email.',
          parameters: {
            type: 'object',
            properties: {
              contactId: { type: 'string', description: 'HubSpot contact ID (optional)' },
              email: { type: 'string', description: 'Contact email to look up (optional)' },
            },
            required: [],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'hubspot_find_contacts',
          description:
            'Search for contacts via HubSpot API. NOTE: Prefer hubspot_find_contacts_local for broader historical search.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query (name, email, etc.)' },
              maxResults: { type: 'number', description: 'Max results (default 10)' },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'hubspot_find_or_create_contact',
          description:
            'Find a contact by email, or create if not found. Optionally add a note. Best for ensuring a contact exists.',
          parameters: {
            type: 'object',
            properties: {
              email: { type: 'string', description: 'Contact email' },
              firstName: { type: 'string', description: 'First name (for creation)' },
              lastName: { type: 'string', description: 'Last name (for creation)' },
              noteBody: {
                type: 'string',
                description: 'Optional note to add after finding/creating',
              },
            },
            required: ['email'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'hubspot_create_note',
          description:
            'Create a note on a HubSpot contact. Use to log interactions, meeting notes, etc.',
          parameters: {
            type: 'object',
            properties: {
              contactId: { type: 'string', description: 'HubSpot contact ID' },
              body: { type: 'string', description: 'Note content' },
            },
            required: ['contactId', 'body'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'hubspot_delete_note',
          description: 'Delete a note from HubSpot.',
          parameters: {
            type: 'object',
            properties: {
              noteId: { type: 'string', description: 'HubSpot note ID to delete' },
            },
            required: ['noteId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'hubspot_get_notes_for_contact',
          description: 'Get notes for a specific HubSpot contact.',
          parameters: {
            type: 'object',
            properties: {
              contactId: { type: 'string', description: 'HubSpot contact ID' },
              limit: { type: 'number', description: 'Max notes to return (default 10)' },
            },
            required: ['contactId'],
          },
        },
      },

      // =========================================================================
      // AGENT CONTROL TOOLS (for waiting/memory)
      // =========================================================================
      {
        type: 'function',
        function: {
          name: 'await_user_message',
          description:
            'Pause and wait for the user (advisor) to provide more information. Use when you need clarification or approval.',
          parameters: {
            type: 'object',
            properties: {
              prompt: {
                type: 'string',
                description: 'Question or prompt to show the user',
              },
            },
            required: ['prompt'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'await_email_reply',
          description:
            'Pause and wait for a reply in a Gmail thread. Use after sending an email when you need to wait for a response before continuing.',
          parameters: {
            type: 'object',
            properties: {
              threadId: { type: 'string', description: 'Gmail thread ID to watch' },
              fromEmail: {
                type: 'string',
                description: 'Expected sender email (optional but recommended)',
              },
              purpose: {
                type: 'string',
                description: 'Brief description of what you are waiting for',
              },
            },
            required: ['threadId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'await_calendar_event',
          description:
            'Pause and wait until a calendar event starts or is about to start. Useful for scheduling follow-up actions.',
          parameters: {
            type: 'object',
            properties: {
              eventId: { type: 'string', description: 'Calendar event ID to watch' },
              triggerMinutesBefore: {
                type: 'number',
                description: 'Minutes before event to trigger (default 0 = at event start)',
              },
              purpose: {
                type: 'string',
                description: 'Brief description of what to do when triggered',
              },
            },
            required: ['eventId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'remember',
          description:
            'Store information in task memory for later use. Use to track state across multiple steps.',
          parameters: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Memory key' },
              value: {
                type: 'object',
                additionalProperties: true,
                description: 'Value to store (any JSON object)',
              },
            },
            required: ['key', 'value'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'complete_task',
          description:
            'Mark the task as complete with a final summary. Use when the goal has been fully achieved.',
          parameters: {
            type: 'object',
            properties: {
              summary: {
                type: 'string',
                description: 'Summary of what was accomplished',
              },
            },
            required: ['summary'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'fail_task',
          description:
            'Mark the task as failed. Use when the goal cannot be achieved (e.g., missing information, API errors).',
          parameters: {
            type: 'object',
            properties: {
              reason: {
                type: 'string',
                description: 'Reason why the task cannot be completed',
              },
            },
            required: ['reason'],
          },
        },
      },
    ];
  }

  /**
   * Internal execution - routes to appropriate handler
   */
  private async executeInternal(
    userId: number,
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (toolName) {
      // =========================================================================
      // LOCAL SEARCH TOOLS
      // =========================================================================
      case 'hubspot_find_contacts_local': {
        const query = safeString(params.query);
        const limit = safeNumber(params.limit, 25);
        const contacts = await this.syncedDataTools.findHubspotContactsLocal({
          userId,
          query,
          limit,
        });

        return {
          count: contacts.length,
          contacts: contacts.map((c) => ({
            id: c.id,
            email: c.email,
            firstName: c.firstName,
            lastName: c.lastName,
            fullName: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
          })),
        };
      }

      case 'gmail_find_senders_local': {
        const query = safeString(params.query);
        const limit = safeNumber(params.limit, 50);
        const senders = await this.syncedDataTools.findGmailSendersLocal({
          userId,
          query,
          limit,
        });

        return {
          count: senders.length,
          senders: senders.map((s) => ({
            email: s.email,
            displayName: s.displayName,
            lastContactedAt: s.lastContactedAt?.toISOString() ?? null,
          })),
        };
      }

      case 'gmail_search_local': {
        const query = safeString(params.query);
        const limit = safeNumber(params.limit, 25);
        const messages = await this.syncedDataTools.searchGmailMessagesLocal({
          userId,
          query,
          limit,
        });

        return {
          count: messages.length,
          messages: messages.map((m) => ({
            gmailMessageId: m.gmailMessageId,
            gmailThreadId: m.gmailThreadId,
            from: m.from,
            to: m.to,
            subject: m.subject,
            snippet: m.snippet,
            sentAt: m.sentAtIso,
          })),
        };
      }

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
        return { sent: true, messageId: result.id, threadId: result.threadId };
      }

      case 'gmail_reply': {
        const threadId = safeString(params.threadId);
        const bodyText = safeString(params.bodyText);

        // Get thread info for proper reply
        const messages = await this.gmailApi.getThreadMessages(userId, threadId);
        const lastMessage = messages[messages.length - 1];

        if (!lastMessage) {
          throw new Error('Cannot reply: thread has no messages');
        }

        const result = await this.gmailApi.sendEmail(userId, {
          to: lastMessage.headers.from ?? '',
          subject: lastMessage.headers.subject
            ? `Re: ${lastMessage.headers.subject.replace(/^Re:\s*/i, '')}`
            : 'Re:',
          bodyText,
          threadId,
          inReplyToMessageId: lastMessage.headers.messageId,
        });
        return { sent: true, messageId: result.id, threadId: result.threadId };
      }

      case 'gmail_search': {
        const query = safeString(params.query);
        const maxResults = safeNumber(params.maxResults, 10);
        const messages = await this.gmailApi.searchEmails(userId, query, maxResults);

        return {
          count: messages.length,
          messages: messages.map((m) => ({
            id: m.id,
            threadId: m.threadId,
            from: m.headers.from,
            to: m.headers.to,
            subject: m.headers.subject,
            date: m.headers.date,
            snippet: m.snippet,
          })),
        };
      }

      case 'gmail_get_thread': {
        const threadId = safeString(params.threadId);
        const messages = await this.gmailApi.getThreadMessages(userId, threadId);

        return {
          threadId,
          messageCount: messages.length,
          messages: messages.map((m) => ({
            id: m.id,
            from: m.headers.from,
            to: m.headers.to,
            subject: m.headers.subject,
            date: m.headers.date,
            bodyText: m.bodyText?.slice(0, 5000), // Truncate for context
          })),
        };
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
          location: safeStringOrUndefined(params.location),
          timeZone: safeStringOrUndefined(params.timeZone),
          attendees,
        });
        return { created: true, eventId: result.id };
      }

      case 'calendar_update_event': {
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

        const result = await this.calendarApi.updateEvent(userId, {
          eventId: safeString(params.eventId),
          summary: safeStringOrUndefined(params.summary),
          startIso: safeStringOrUndefined(params.startIso),
          endIso: safeStringOrUndefined(params.endIso),
          description: safeStringOrUndefined(params.description),
          location: safeStringOrUndefined(params.location),
          timeZone: safeStringOrUndefined(params.timeZone),
          attendees,
        });
        return { updated: true, eventId: result.id };
      }

      case 'calendar_delete_event': {
        const eventId = safeString(params.eventId);
        await this.calendarApi.deleteEvent(userId, eventId);
        return { deleted: true, eventId };
      }

      case 'calendar_find_events': {
        const events = await this.calendarApi.findEvents(userId, {
          query: safeStringOrUndefined(params.query),
          attendeeEmail: safeStringOrUndefined(params.attendeeEmail),
          timeMinIso: safeStringOrUndefined(params.timeMinIso),
          timeMaxIso: safeStringOrUndefined(params.timeMaxIso),
          maxResults: safeNumber(params.maxResults, 50),
        });

        return {
          count: events.length,
          events: events.map((e) => ({
            id: e.id,
            summary: e.summary,
            description: e.description,
            location: e.location,
            startIso: e.startIso,
            endIso: e.endIso,
            attendees: e.attendees,
          })),
        };
      }

      case 'calendar_get_busy': {
        const busy = await this.calendarApi.getBusyIntervals(userId, {
          timeMinIso: safeString(params.timeMinIso),
          timeMaxIso: safeString(params.timeMaxIso),
          timeZone: safeStringOrUndefined(params.timeZone),
        });

        return {
          busyIntervals: busy,
          count: busy.length,
        };
      }

      case 'calendar_suggest_times': {
        const slots = await this.syncedDataTools.suggestCalendarTimesLocal({
          userId,
          startIso: safeString(params.startIso),
          endIso: safeString(params.endIso),
          durationMinutes: safeNumber(params.durationMinutes, 30),
          workDayStartHour: safeNumber(params.workDayStartHour, 9),
          workDayEndHour: safeNumber(params.workDayEndHour, 17),
          timezoneOffsetMinutes: safeNumber(params.timezoneOffsetMinutes, -240),
          maxSuggestions: safeNumber(params.maxSuggestions, 5),
        });

        return {
          count: slots.length,
          availableSlots: slots,
        };
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
        return { created: true, contactId: result.id };
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
        return { updated: true, contactId: result.id };
      }

      case 'hubspot_delete_contact': {
        const contactId = safeString(params.contactId);
        await this.hubspotApi.deleteContact(userId, contactId);
        return { deleted: true, contactId };
      }

      case 'hubspot_get_contact': {
        const contactId = safeStringOrUndefined(params.contactId);
        const email = safeStringOrUndefined(params.email);

        if (contactId) {
          const contact = await this.hubspotApi.getContact(userId, contactId);
          return { found: true, contact };
        } else if (email) {
          const contacts = await this.hubspotApi.searchContacts(userId, email, 1);
          const contact = contacts.find((c) => c.email?.toLowerCase() === email.toLowerCase());
          return { found: !!contact, contact: contact ?? null };
        } else {
          throw new Error('Either contactId or email is required');
        }
      }

      case 'hubspot_find_contacts': {
        const query = safeString(params.query);
        const maxResults = safeNumber(params.maxResults, 10);
        const contacts = await this.hubspotApi.searchContacts(userId, query, maxResults);

        return {
          count: contacts.length,
          contacts: contacts.map((c) => ({
            id: c.id,
            email: c.email,
            firstName: c.firstName,
            lastName: c.lastName,
          })),
        };
      }

      case 'hubspot_find_or_create_contact': {
        const email = safeString(params.email);
        const firstName = safeStringOrUndefined(params.firstName);
        const lastName = safeStringOrUndefined(params.lastName);
        const noteBody = safeStringOrUndefined(params.noteBody);

        if (!email) {
          throw new Error('Email is required for hubspot_find_or_create_contact');
        }

        const result = await this.hubspotApi.findOrCreateContactByEmail(userId, {
          email,
          firstName,
          lastName,
        });

        let noteId: string | null = null;
        if (noteBody && result.id) {
          const noteResult = await this.hubspotApi.createNoteOnContact(userId, {
            contactId: result.id,
            body: noteBody,
          });
          noteId = noteResult.noteId;
        }

        return {
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
        return { created: true, noteId: result.noteId };
      }

      case 'hubspot_delete_note': {
        const noteId = safeString(params.noteId);
        await this.hubspotApi.deleteNote(userId, noteId);
        return { deleted: true, noteId };
      }

      case 'hubspot_get_notes_for_contact': {
        const contactId = safeString(params.contactId);
        const limit = safeNumber(params.limit, 10);
        const notes = await this.hubspotApi.listNotesForContact(userId, {
          contactId,
          limit,
        });

        return {
          count: notes.length,
          notes: notes.map((n) => ({
            id: n.id,
            body: n.body,
            timestamp: n.timestamp,
          })),
        };
      }

      // =========================================================================
      // AGENT CONTROL TOOLS
      // These are handled specially by AgentRunnerService, but we define
      // placeholder implementations here for completeness
      // =========================================================================
      case 'await_user_message':
      case 'await_email_reply':
      case 'await_calendar_event':
      case 'remember':
      case 'complete_task':
      case 'fail_task':
        // These are control flow tools - they're handled by the AgentRunnerService
        // directly, not executed here. Return the params so the runner knows what to do.
        return { _controlTool: toolName, ...params };

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

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
