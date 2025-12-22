import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, gt, desc, inArray } from 'drizzle-orm';
import { PgBossService } from '../jobs/pgboss.service';
import { DbService } from '../db/db.service';
import {
  agentInstructions,
  gmailMessages,
  calendarEvents,
  hubspotContacts,
  hubspotNotes,
  oauthAccounts,
} from '../db/schema';
import { InstructionsService, InstructionRow } from '../modules/instructions/instructions.service';
import {
  InstructionExecutorService,
  TriggerEvent,
} from '../modules/instructions/instruction-executor.service';
import { INSTRUCTION_TICK_JOB } from '../jobs/job.constants';

type PgBossJob<T> = {
  id: string | number;
  data: T;
};

type TriggerState = {
  gmail?: {
    lastProcessedInternalDateMs: number;
    lastProcessedMessageIds: string[];
  };
  calendar?: {
    lastProcessedEventIds: string[];
    lastCheckAt: string;
  };
  hubspot?: {
    lastProcessedContactIds: string[];
    lastProcessedNoteIds: string[];
    lastCheckAt: string;
  };
};

type UserContext = {
  hasGoogle: boolean;
  hasHubspot: boolean;
  googleEmail: string | null;
};

/**
 * A trigger event with timestamp for filtering against instruction creation time
 */
type TimestampedTrigger = TriggerEvent & {
  /** When this event occurred (for filtering against instruction.createdAt) */
  eventTimestamp: Date;
};

@Injectable()
export class InstructionTickWorker implements OnModuleInit {
  private readonly logger = new Logger(InstructionTickWorker.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly dbService: DbService,
    private readonly instructionsService: InstructionsService,
    private readonly executor: InstructionExecutorService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.pgBoss.client.work(
      INSTRUCTION_TICK_JOB,
      { batchSize: 1 },
      async (jobs: PgBossJob<Record<string, unknown>>[]) => {
        for (const job of jobs) await this.handleOne(job);
      },
    );

    this.logger.log(`Registered worker: ${INSTRUCTION_TICK_JOB}`);
  }

  private async handleOne(job: PgBossJob<Record<string, unknown>>): Promise<void> {
    this.logger.debug(`[${INSTRUCTION_TICK_JOB}] start job=${String(job.id)}`);

    try {
      // Get all users with active instructions
      const usersWithInstructions = await this.dbService.db
        .selectDistinct({ userId: agentInstructions.userId })
        .from(agentInstructions)
        .where(eq(agentInstructions.isActive, true));

      if (usersWithInstructions.length === 0) {
        this.logger.debug(`[${INSTRUCTION_TICK_JOB}] no users with active instructions`);
        return;
      }

      const userIds = usersWithInstructions.map((u) => u.userId);

      // Get which users have which integrations connected AND their Google email
      const accounts = await this.dbService.db
        .select({
          userId: oauthAccounts.userId,
          provider: oauthAccounts.provider,
          email: oauthAccounts.accountEmail,
        })
        .from(oauthAccounts)
        .where(inArray(oauthAccounts.userId, userIds));

      const userContextMap = new Map<number, UserContext>();

      for (const a of accounts) {
        const current = userContextMap.get(a.userId) ?? {
          hasGoogle: false,
          hasHubspot: false,
          googleEmail: null,
        };

        if (a.provider === 'google') {
          current.hasGoogle = true;
          current.googleEmail = a.email ?? null;
        }
        if (a.provider === 'hubspot') {
          current.hasHubspot = true;
        }

        userContextMap.set(a.userId, current);
      }

      // Process each user
      for (const userId of userIds) {
        try {
          await this.processUserTriggers(userId, userContextMap.get(userId));
        } catch (err) {
          this.logger.error(
            `[${INSTRUCTION_TICK_JOB}] Error processing user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      this.logger.debug(
        `[${INSTRUCTION_TICK_JOB}] done job=${String(job.id)} users=${userIds.length}`,
      );
    } catch (err: unknown) {
      this.logger.error(
        `[${INSTRUCTION_TICK_JOB}] FAILED job=${String(job.id)} ` +
          (err instanceof Error ? err.stack : String(err)),
      );
      throw err;
    }
  }

  private async processUserTriggers(userId: number, context?: UserContext): Promise<void> {
    if (!context) return;

    // Get user's active instructions
    const instructions = await this.instructionsService.listActiveInstructions(userId);
    if (instructions.length === 0) return;

    // Get current trigger state
    const stateRaw = await this.instructionsService.getTriggerState(userId);
    const state: TriggerState = {
      gmail: isRecord(stateRaw.gmail) ? (stateRaw.gmail as TriggerState['gmail']) : undefined,
      calendar: isRecord(stateRaw.calendar)
        ? (stateRaw.calendar as TriggerState['calendar'])
        : undefined,
      hubspot: isRecord(stateRaw.hubspot)
        ? (stateRaw.hubspot as TriggerState['hubspot'])
        : undefined,
    };

    const triggers: TimestampedTrigger[] = [];

    // Detect Gmail triggers
    if (context.hasGoogle) {
      const gmailTriggers = await this.detectGmailTriggers(userId, state, context.googleEmail);
      triggers.push(...gmailTriggers.triggers);
      if (gmailTriggers.newState) {
        state.gmail = gmailTriggers.newState;
      }
    }

    // Detect Calendar triggers
    if (context.hasGoogle) {
      const calendarTriggers = await this.detectCalendarTriggers(userId, state);
      triggers.push(...calendarTriggers.triggers);
      if (calendarTriggers.newState) {
        state.calendar = calendarTriggers.newState;
      }
    }

    // Detect HubSpot triggers
    if (context.hasHubspot) {
      const hubspotTriggers = await this.detectHubspotTriggers(userId, state);
      triggers.push(...hubspotTriggers.triggers);
      if (hubspotTriggers.newState) {
        state.hubspot = hubspotTriggers.newState;
      }
    }

    // Save updated state
    await this.instructionsService.updateTriggerState(userId, state);

    // Process triggers if any
    if (triggers.length > 0) {
      this.logger.log(
        `[${INSTRUCTION_TICK_JOB}] user=${userId} detected ${triggers.length} triggers`,
      );

      for (const trigger of triggers) {
        // Filter instructions to only those created BEFORE this event
        // This ensures we don't apply instructions to pre-existing data
        const applicableInstructions = this.filterInstructionsByTriggerTime(
          instructions,
          trigger.eventTimestamp,
        );

        if (applicableInstructions.length > 0) {
          await this.executor.processTrigger(userId, trigger, applicableInstructions);
        } else {
          this.logger.debug(
            `[${INSTRUCTION_TICK_JOB}] Trigger "${trigger.type}" skipped - no instructions created before event time`,
          );
        }
      }
    }
  }

  /**
   * Filter instructions to only those that were created BEFORE the trigger event occurred.
   * This prevents instructions from being applied to pre-existing data.
   *
   * Example: If user creates instruction "When I create a contact, send welcome email" at 3pm,
   * contacts created at 2pm won't get emails, but contacts created at 4pm will.
   */
  private filterInstructionsByTriggerTime(
    instructions: InstructionRow[],
    eventTimestamp: Date,
  ): InstructionRow[] {
    return instructions.filter((inst) => {
      // The instruction must have been created BEFORE the event occurred
      // for it to apply to that event
      return inst.createdAt.getTime() < eventTimestamp.getTime();
    });
  }

  /**
   * Detect new Gmail messages and classify as received/sent
   */
  private async detectGmailTriggers(
    userId: number,
    state: TriggerState,
    userEmail: string | null,
  ): Promise<{
    triggers: TimestampedTrigger[];
    newState: TriggerState['gmail'];
  }> {
    const triggers: TimestampedTrigger[] = [];

    const lastProcessedMs = state.gmail?.lastProcessedInternalDateMs ?? 0;
    const lastProcessedIds = new Set(state.gmail?.lastProcessedMessageIds ?? []);

    // Calculate cutoff date - either from last processed or 5 minutes ago for first run
    const cutoffDate =
      lastProcessedMs > 0 ? new Date(lastProcessedMs) : new Date(Date.now() - 5 * 60 * 1000);

    // Query for new emails since cutoff
    const newEmails = await this.dbService.db
      .select({
        id: gmailMessages.id,
        gmailMessageId: gmailMessages.gmailMessageId,
        gmailThreadId: gmailMessages.gmailThreadId,
        from: gmailMessages.from,
        to: gmailMessages.to,
        subject: gmailMessages.subject,
        snippet: gmailMessages.snippet,
        sentAt: gmailMessages.sentAt,
        createdAt: gmailMessages.createdAt, // When we synced it (fallback)
      })
      .from(gmailMessages)
      .where(and(eq(gmailMessages.userId, userId), gt(gmailMessages.sentAt, cutoffDate)))
      .orderBy(desc(gmailMessages.sentAt))
      .limit(50);

    let maxProcessedMs = lastProcessedMs;
    const processedIds: string[] = [];

    // Normalize user email for comparison
    const normalizedUserEmail = userEmail?.toLowerCase().trim() ?? null;

    for (const email of newEmails) {
      // Skip if already processed
      if (lastProcessedIds.has(email.gmailMessageId)) continue;

      const sentAtMs = email.sentAt ? new Date(email.sentAt).getTime() : 0;
      if (sentAtMs > maxProcessedMs) {
        maxProcessedMs = sentAtMs;
      }

      processedIds.push(email.gmailMessageId);

      // Determine if this email was sent by the user or received
      const isSent = this.isEmailSentByUser(email.from, normalizedUserEmail);

      // For sent emails, use "to" field; for received, use "from" field
      const otherParty = isSent
        ? (email.to ?? 'unknown recipient')
        : (email.from ?? 'unknown sender');

      // Use sentAt as the event timestamp (when the email was actually sent/received)
      const eventTimestamp = email.sentAt ?? email.createdAt ?? new Date();

      triggers.push({
        type: isSent ? 'gmail_sent' : 'gmail_received',
        summary: isSent
          ? `Email sent to ${otherParty}: ${email.subject ?? '(no subject)'}`
          : `Email from ${otherParty}: ${email.subject ?? '(no subject)'}`,
        data: {
          gmailMessageId: email.gmailMessageId,
          gmailThreadId: email.gmailThreadId,
          from: email.from,
          to: email.to,
          subject: email.subject,
          snippet: email.snippet,
          sentAt: email.sentAt?.toISOString(),
          isSent,
        },
        eventTimestamp,
      });
    }

    return {
      triggers,
      newState: {
        lastProcessedInternalDateMs: maxProcessedMs,
        lastProcessedMessageIds: processedIds.slice(0, 100),
      },
    };
  }

  /**
   * Determine if an email was sent by the user based on the "from" field
   */
  private isEmailSentByUser(from: string | null, userEmail: string | null): boolean {
    if (!from || !userEmail) return false;

    const normalizedFrom = from.toLowerCase();

    // Check if the from field contains the user's email
    // Handle formats like "John Doe <john@example.com>" or just "john@example.com"
    if (normalizedFrom.includes(userEmail)) {
      return true;
    }

    // Extract email from "Name <email>" format
    const emailMatch = normalizedFrom.match(/<([^>]+)>/);
    if (emailMatch) {
      const extractedEmail = emailMatch[1].trim();
      return extractedEmail === userEmail;
    }

    // Direct comparison for plain email format
    return normalizedFrom.trim() === userEmail;
  }

  /**
   * Detect new/updated calendar events
   */
  private async detectCalendarTriggers(
    userId: number,
    state: TriggerState,
  ): Promise<{
    triggers: TimestampedTrigger[];
    newState: TriggerState['calendar'];
  }> {
    const triggers: TimestampedTrigger[] = [];

    const lastCheckAt = state.calendar?.lastCheckAt
      ? new Date(state.calendar.lastCheckAt)
      : new Date(Date.now() - 5 * 60 * 1000);

    const lastProcessedIds = new Set(state.calendar?.lastProcessedEventIds ?? []);

    // Query for events updated since last check
    const recentEvents = await this.dbService.db
      .select({
        id: calendarEvents.id,
        googleEventId: calendarEvents.googleEventId,
        summary: calendarEvents.summary,
        description: calendarEvents.description,
        startAt: calendarEvents.startAt,
        endAt: calendarEvents.endAt,
        attendees: calendarEvents.attendees,
        createdAt: calendarEvents.createdAt,
        updatedAt: calendarEvents.updatedAt,
      })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.userId, userId), gt(calendarEvents.updatedAt, lastCheckAt)))
      .orderBy(desc(calendarEvents.updatedAt))
      .limit(50);

    const newProcessedIds: string[] = [];

    for (const event of recentEvents) {
      newProcessedIds.push(event.googleEventId);

      // Determine if this is new or updated
      const isNew = !lastProcessedIds.has(event.googleEventId);
      const createdRecently =
        event.createdAt && new Date(event.createdAt).getTime() > lastCheckAt.getTime();

      const triggerType =
        isNew || createdRecently ? 'calendar_event_created' : 'calendar_event_updated';

      // Use createdAt for new events, updatedAt for updates
      const eventTimestamp =
        isNew || createdRecently
          ? (event.createdAt ?? new Date())
          : (event.updatedAt ?? new Date());

      triggers.push({
        type: triggerType,
        summary: `Calendar event ${isNew || createdRecently ? 'created' : 'updated'}: ${event.summary ?? '(no title)'}`,
        data: {
          googleEventId: event.googleEventId,
          summary: event.summary,
          description: event.description,
          startAt: event.startAt?.toISOString(),
          endAt: event.endAt?.toISOString(),
          attendees: event.attendees,
        },
        eventTimestamp,
      });
    }

    return {
      triggers,
      newState: {
        lastProcessedEventIds: newProcessedIds.slice(0, 100),
        lastCheckAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Detect new/updated HubSpot contacts and notes
   */
  private async detectHubspotTriggers(
    userId: number,
    state: TriggerState,
  ): Promise<{
    triggers: TimestampedTrigger[];
    newState: TriggerState['hubspot'];
  }> {
    const triggers: TimestampedTrigger[] = [];

    const lastCheckAt = state.hubspot?.lastCheckAt
      ? new Date(state.hubspot.lastCheckAt)
      : new Date(Date.now() - 5 * 60 * 1000);

    const lastContactIds = new Set(state.hubspot?.lastProcessedContactIds ?? []);
    const lastNoteIds = new Set(state.hubspot?.lastProcessedNoteIds ?? []);

    // Check for new/updated contacts
    const recentContacts = await this.dbService.db
      .select({
        id: hubspotContacts.id,
        hubspotContactId: hubspotContacts.hubspotContactId,
        email: hubspotContacts.email,
        firstName: hubspotContacts.firstName,
        lastName: hubspotContacts.lastName,
        createdAt: hubspotContacts.createdAt,
        updatedAt: hubspotContacts.updatedAt,
      })
      .from(hubspotContacts)
      .where(and(eq(hubspotContacts.userId, userId), gt(hubspotContacts.updatedAt, lastCheckAt)))
      .orderBy(desc(hubspotContacts.updatedAt))
      .limit(50);

    const newContactIds: string[] = [];

    for (const contact of recentContacts) {
      newContactIds.push(contact.hubspotContactId);

      const isNew = !lastContactIds.has(contact.hubspotContactId);
      const createdRecently =
        contact.createdAt && new Date(contact.createdAt).getTime() > lastCheckAt.getTime();

      const displayName =
        `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim() || contact.email || 'Unknown';

      const triggerType =
        isNew || createdRecently ? 'hubspot_contact_created' : 'hubspot_contact_updated';

      // Use createdAt for new contacts, updatedAt for updates
      const eventTimestamp =
        isNew || createdRecently
          ? (contact.createdAt ?? new Date())
          : (contact.updatedAt ?? new Date());

      triggers.push({
        type: triggerType,
        summary: `HubSpot contact ${isNew || createdRecently ? 'created' : 'updated'}: ${displayName}`,
        data: {
          hubspotContactId: contact.hubspotContactId,
          email: contact.email,
          firstName: contact.firstName,
          lastName: contact.lastName,
        },
        eventTimestamp,
      });
    }

    // Check for new notes
    const recentNotes = await this.dbService.db
      .select({
        id: hubspotNotes.id,
        hubspotNoteId: hubspotNotes.hubspotNoteId,
        hubspotContactId: hubspotNotes.hubspotContactId,
        body: hubspotNotes.body,
        createdAt: hubspotNotes.createdAt,
      })
      .from(hubspotNotes)
      .where(and(eq(hubspotNotes.userId, userId), gt(hubspotNotes.createdAt, lastCheckAt)))
      .orderBy(desc(hubspotNotes.createdAt))
      .limit(50);

    const newNoteIds: string[] = [];

    for (const note of recentNotes) {
      if (lastNoteIds.has(note.hubspotNoteId)) continue;

      newNoteIds.push(note.hubspotNoteId);

      const bodyPreview = (note.body ?? '').slice(0, 100);

      // Use createdAt as the event timestamp
      const eventTimestamp = note.createdAt ?? new Date();

      triggers.push({
        type: 'hubspot_note_created',
        summary: `HubSpot note created: ${bodyPreview}${(note.body ?? '').length > 100 ? '...' : ''}`,
        data: {
          hubspotNoteId: note.hubspotNoteId,
          hubspotContactId: note.hubspotContactId,
          body: note.body,
        },
        eventTimestamp,
      });
    }

    return {
      triggers,
      newState: {
        lastProcessedContactIds: newContactIds.slice(0, 100),
        lastProcessedNoteIds: newNoteIds.slice(0, 100),
        lastCheckAt: new Date().toISOString(),
      },
    };
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
