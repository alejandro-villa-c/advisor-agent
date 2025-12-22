import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql, gt } from 'drizzle-orm';
import { DbService } from '../../db/db.service';
import {
  agentInstructions,
  proactiveActions,
  proactiveActionRateLimits,
  instructionTriggerStates,
} from '../../db/schema';
import { OpenAiChatService } from '../integrations/openai/openai-chat.service';
import { ConfigService } from '@nestjs/config';

export type InstructionRow = {
  id: number;
  userId: number;
  instruction: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type ProactiveActionRow = {
  id: number;
  instructionId: number | null;
  instructionText: string;
  triggerType: string;
  triggerSummary: string;
  actionTaken: string;
  status: string;
  error: string | null;
  createdAt: Date;
};

export type ConflictCheckResult = {
  hasConflict: boolean;
  conflictingInstruction: InstructionRow | null;
  reason: string | null;
};

/**
 * Available tools for ongoing instructions
 */
export const AVAILABLE_TOOLS = [
  {
    category: 'Gmail',
    tools: [
      { name: 'gmail_send_email', description: 'Send a new email to someone' },
      { name: 'gmail_reply', description: 'Reply to an email thread' },
      { name: 'gmail_search', description: 'Search for emails by query' },
      { name: 'gmail_get_thread', description: 'Get full content of an email thread' },
    ],
  },
  {
    category: 'Calendar',
    tools: [
      { name: 'calendar_create_event', description: 'Create a new calendar event' },
      { name: 'calendar_update_event', description: 'Update an existing calendar event' },
      { name: 'calendar_delete_event', description: 'Delete/cancel a calendar event' },
      { name: 'calendar_find_events', description: 'Search for calendar events' },
    ],
  },
  {
    category: 'HubSpot',
    tools: [
      { name: 'hubspot_create_contact', description: 'Create a new contact' },
      { name: 'hubspot_update_contact', description: 'Update contact information' },
      { name: 'hubspot_delete_contact', description: 'Delete a contact' },
      { name: 'hubspot_get_contact', description: 'Get contact details' },
      { name: 'hubspot_find_contact', description: 'Search for contacts' },
      {
        name: 'hubspot_find_or_create_contact',
        description: 'Find or create a contact (with optional note)',
      },
      { name: 'hubspot_create_note', description: 'Add a note to a contact' },
      { name: 'hubspot_delete_note', description: 'Delete a note' },
    ],
  },
];

/**
 * Supported triggers for ongoing instructions
 */
export const SUPPORTED_TRIGGERS = [
  {
    category: 'Gmail',
    triggers: [
      { type: 'gmail_received', description: 'When you receive an email' },
      { type: 'gmail_sent', description: 'When you send an email' },
    ],
  },
  {
    category: 'Calendar',
    triggers: [
      { type: 'calendar_event_created', description: 'When a calendar event is created' },
      { type: 'calendar_event_updated', description: 'When a calendar event is updated' },
      { type: 'calendar_event_deleted', description: 'When a calendar event is deleted' },
    ],
  },
  {
    category: 'HubSpot',
    triggers: [
      { type: 'hubspot_contact_created', description: 'When a contact is created in HubSpot' },
      { type: 'hubspot_contact_updated', description: 'When a contact is updated in HubSpot' },
      { type: 'hubspot_contact_deleted', description: 'When a contact is deleted from HubSpot' },
      { type: 'hubspot_note_created', description: 'When a note is added to a contact' },
    ],
  },
];

@Injectable()
export class InstructionsService {
  private readonly logger = new Logger(InstructionsService.name);
  private readonly maxActionsPerHour: number;

  constructor(
    private readonly dbService: DbService,
    private readonly llm: OpenAiChatService,
    private readonly config: ConfigService,
  ) {
    this.maxActionsPerHour = this.config.get<number>('PROACTIVE_ACTIONS_PER_HOUR', 20);
  }

  /**
   * Get available tools and triggers for UI display
   */
  getCapabilities(): {
    tools: typeof AVAILABLE_TOOLS;
    triggers: typeof SUPPORTED_TRIGGERS;
    maxActionsPerHour: number;
  } {
    return {
      tools: AVAILABLE_TOOLS,
      triggers: SUPPORTED_TRIGGERS,
      maxActionsPerHour: this.maxActionsPerHour,
    };
  }

  /**
   * List all instructions for a user
   */
  async listInstructions(userId: number): Promise<InstructionRow[]> {
    const rows = await this.dbService.db
      .select()
      .from(agentInstructions)
      .where(eq(agentInstructions.userId, userId))
      .orderBy(desc(agentInstructions.createdAt));

    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      instruction: r.instruction,
      isActive: r.isActive,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  /**
   * List only active instructions for a user
   */
  async listActiveInstructions(userId: number): Promise<InstructionRow[]> {
    const rows = await this.dbService.db
      .select()
      .from(agentInstructions)
      .where(and(eq(agentInstructions.userId, userId), eq(agentInstructions.isActive, true)))
      .orderBy(desc(agentInstructions.createdAt));

    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      instruction: r.instruction,
      isActive: r.isActive,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  /**
   * Check if a new instruction conflicts with existing ones
   */
  async checkForConflicts(userId: number, newInstruction: string): Promise<ConflictCheckResult> {
    const existing = await this.listActiveInstructions(userId);

    if (existing.length === 0) {
      return { hasConflict: false, conflictingInstruction: null, reason: null };
    }

    if (!this.llm.isConfigured()) {
      return { hasConflict: false, conflictingInstruction: null, reason: null };
    }

    const existingList = existing.map((inst, i) => `${i + 1}. "${inst.instruction}"`).join('\n');

    const systemPrompt = `You are checking if a new ongoing instruction conflicts with existing ones.

Existing instructions:
${existingList}

New instruction:
"${newInstruction}"

A conflict exists if:
- The new instruction directly contradicts an existing one (e.g., "ignore all emails" vs "reply to all emails")
- The new instruction would cause opposite actions for the same trigger
- The instructions would create an infinite loop

Return ONLY valid JSON:
{
  "hasConflict": boolean,
  "conflictingIndex": number | null,  // 1-based index of conflicting instruction, or null
  "reason": string | null  // Brief explanation if conflict exists
}

Examples of conflicts:
- "When I receive an email, delete it" conflicts with "When I receive an email, reply with thanks"
- "Ignore all contacts" conflicts with "Create a note for every contact"

Examples of NON-conflicts:
- "When I receive an email from clients, reply" and "When I receive spam, ignore" (different conditions)
- "Send welcome email to new contacts" and "Add note when contact created" (different actions, same trigger is OK)`;

    try {
      const raw = await this.llm.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Check for conflicts.' },
        ],
        temperature: 0.0,
      });

      const parsed = safeJsonParse(raw);
      if (!isRecord(parsed)) {
        return { hasConflict: false, conflictingInstruction: null, reason: null };
      }

      const hasConflict = parsed.hasConflict === true;
      const conflictingIndex =
        typeof parsed.conflictingIndex === 'number' ? parsed.conflictingIndex : null;
      const reason = typeof parsed.reason === 'string' ? parsed.reason : null;

      if (!hasConflict) {
        return { hasConflict: false, conflictingInstruction: null, reason: null };
      }

      const conflictingInstruction =
        conflictingIndex !== null && conflictingIndex >= 1 && conflictingIndex <= existing.length
          ? existing[conflictingIndex - 1]
          : null;

      return { hasConflict: true, conflictingInstruction, reason };
    } catch (err) {
      this.logger.warn(`Conflict check failed: ${String(err)}`);
      return { hasConflict: false, conflictingInstruction: null, reason: null };
    }
  }

  /**
   * Create a new instruction
   */
  async createInstruction(
    userId: number,
    instruction: string,
  ): Promise<{ id: number; conflict: ConflictCheckResult | null }> {
    const trimmed = instruction.trim();
    if (!trimmed) {
      throw new Error('Instruction cannot be empty');
    }

    const conflict = await this.checkForConflicts(userId, trimmed);

    if (conflict.hasConflict) {
      return { id: -1, conflict };
    }

    const inserted = await this.dbService.db
      .insert(agentInstructions)
      .values({
        userId,
        instruction: trimmed,
        isActive: true,
      })
      .returning({ id: agentInstructions.id });

    const id = inserted[0]?.id;
    if (!id) throw new Error('Failed to create instruction');

    return { id, conflict: null };
  }

  /**
   * Delete an instruction
   */
  async deleteInstruction(userId: number, instructionId: number): Promise<boolean> {
    const result = await this.dbService.db
      .delete(agentInstructions)
      .where(and(eq(agentInstructions.id, instructionId), eq(agentInstructions.userId, userId)))
      .returning({ id: agentInstructions.id });

    return result.length > 0;
  }

  /**
   * Toggle an instruction's active state
   */
  async toggleInstruction(
    userId: number,
    instructionId: number,
  ): Promise<{ isActive: boolean } | null> {
    const current = await this.dbService.db
      .select({ isActive: agentInstructions.isActive })
      .from(agentInstructions)
      .where(and(eq(agentInstructions.id, instructionId), eq(agentInstructions.userId, userId)))
      .limit(1);

    if (current.length === 0) return null;

    const newState = !current[0].isActive;

    await this.dbService.db
      .update(agentInstructions)
      .set({ isActive: newState, updatedAt: sql`now()` })
      .where(and(eq(agentInstructions.id, instructionId), eq(agentInstructions.userId, userId)));

    return { isActive: newState };
  }

  /**
   * Pause all instructions for a user
   */
  async pauseAll(userId: number): Promise<number> {
    const result = await this.dbService.db
      .update(agentInstructions)
      .set({ isActive: false, updatedAt: sql`now()` })
      .where(and(eq(agentInstructions.userId, userId), eq(agentInstructions.isActive, true)))
      .returning({ id: agentInstructions.id });

    return result.length;
  }

  /**
   * Resume all instructions for a user
   */
  async resumeAll(userId: number): Promise<number> {
    const result = await this.dbService.db
      .update(agentInstructions)
      .set({ isActive: true, updatedAt: sql`now()` })
      .where(and(eq(agentInstructions.userId, userId), eq(agentInstructions.isActive, false)))
      .returning({ id: agentInstructions.id });

    return result.length;
  }

  /**
   * Get recent proactive actions for a user
   */
  async getRecentActions(userId: number, limit = 50): Promise<ProactiveActionRow[]> {
    const rows = await this.dbService.db
      .select()
      .from(proactiveActions)
      .where(eq(proactiveActions.userId, userId))
      .orderBy(desc(proactiveActions.createdAt))
      .limit(clampInt(limit, 1, 200));

    return rows.map((r) => ({
      id: r.id,
      instructionId: r.instructionId,
      instructionText: r.instructionText,
      triggerType: r.triggerType,
      triggerSummary: r.triggerSummary,
      actionTaken: r.actionTaken,
      status: r.status,
      error: r.error,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Check if a trigger has already been processed (idempotency)
   * Uses triggerType + triggerSummary as a composite key
   */
  async isTriggerProcessed(
    userId: number,
    triggerType: string,
    triggerSummary: string,
  ): Promise<boolean> {
    // Check if we've processed this exact trigger in the last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const existing = await this.dbService.db
      .select({ id: proactiveActions.id })
      .from(proactiveActions)
      .where(
        and(
          eq(proactiveActions.userId, userId),
          sql`${proactiveActions.triggerType} = ${triggerType}`,
          eq(proactiveActions.triggerSummary, triggerSummary),
          gt(proactiveActions.createdAt, oneHourAgo),
        ),
      )
      .limit(1);

    return existing.length > 0;
  }

  /**
   * Log a proactive action
   */
  async logProactiveAction(input: {
    userId: number;
    instructionId: number | null;
    instructionText: string;
    triggerType: string;
    triggerSummary: string;
    triggerData?: Record<string, unknown>;
    actionTaken: string;
    actionResult?: Record<string, unknown>;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    error?: string;
  }): Promise<number> {
    const inserted = await this.dbService.db
      .insert(proactiveActions)
      .values({
        userId: input.userId,
        instructionId: input.instructionId,
        instructionText: input.instructionText,
        triggerType: input.triggerType as
          | 'gmail_received'
          | 'gmail_sent'
          | 'calendar_event_created'
          | 'calendar_event_updated'
          | 'calendar_event_deleted'
          | 'hubspot_contact_created'
          | 'hubspot_contact_updated'
          | 'hubspot_contact_deleted'
          | 'hubspot_note_created'
          | 'hubspot_note_deleted',
        triggerSummary: input.triggerSummary,
        triggerData: input.triggerData ?? null,
        actionTaken: input.actionTaken,
        actionResult: input.actionResult ?? null,
        status: input.status,
        error: input.error ?? null,
      })
      .returning({ id: proactiveActions.id });

    return inserted[0]?.id ?? 0;
  }

  /**
   * Update a proactive action (for status changes after execution)
   */
  async updateProactiveAction(
    actionId: number,
    update: {
      status?: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
      actionResult?: Record<string, unknown>;
      error?: string;
    },
  ): Promise<void> {
    const setClause: Record<string, unknown> = {};

    if (update.status) {
      setClause.status = update.status;
    }
    if (update.actionResult !== undefined) {
      setClause.actionResult = update.actionResult;
    }
    if (update.error !== undefined) {
      setClause.error = update.error;
    }

    if (Object.keys(setClause).length === 0) return;

    await this.dbService.db
      .update(proactiveActions)
      .set(setClause)
      .where(eq(proactiveActions.id, actionId));
  }

  /**
   * Check if user has exceeded rate limit for proactive actions
   */
  async checkRateLimit(userId: number): Promise<{ allowed: boolean; remaining: number }> {
    const now = new Date();
    const hourWindow = new Date(now);
    hourWindow.setMinutes(0, 0, 0);

    const existing = await this.dbService.db
      .select()
      .from(proactiveActionRateLimits)
      .where(
        and(
          eq(proactiveActionRateLimits.userId, userId),
          eq(proactiveActionRateLimits.hourWindow, hourWindow),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      return { allowed: true, remaining: this.maxActionsPerHour };
    }

    const count = existing[0].actionCount;
    const remaining = Math.max(0, this.maxActionsPerHour - count);

    return { allowed: count < this.maxActionsPerHour, remaining };
  }

  /**
   * Increment rate limit counter
   * Uses check-then-update to avoid constraint issues
   */
  async incrementRateLimit(userId: number): Promise<void> {
    const now = new Date();
    const hourWindow = new Date(now);
    hourWindow.setMinutes(0, 0, 0);
    hourWindow.setMilliseconds(0); // Important: zero out milliseconds for consistent matching

    // Check if record exists
    const existing = await this.dbService.db
      .select({ id: proactiveActionRateLimits.id })
      .from(proactiveActionRateLimits)
      .where(
        and(
          eq(proactiveActionRateLimits.userId, userId),
          eq(proactiveActionRateLimits.hourWindow, hourWindow),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      // Update existing record
      await this.dbService.db
        .update(proactiveActionRateLimits)
        .set({ actionCount: sql`${proactiveActionRateLimits.actionCount} + 1` })
        .where(eq(proactiveActionRateLimits.id, existing[0].id));
    } else {
      // Insert new record - wrap in try/catch for race condition
      try {
        await this.dbService.db.insert(proactiveActionRateLimits).values({
          userId,
          hourWindow,
          actionCount: 1,
        });
      } catch {
        // Race condition - another process inserted, so update instead
        await this.dbService.db
          .update(proactiveActionRateLimits)
          .set({ actionCount: sql`${proactiveActionRateLimits.actionCount} + 1` })
          .where(
            and(
              eq(proactiveActionRateLimits.userId, userId),
              eq(proactiveActionRateLimits.hourWindow, hourWindow),
            ),
          );
      }
    }
  }

  /**
   * Get or create trigger state for a user
   */
  async getTriggerState(userId: number): Promise<Record<string, unknown>> {
    const rows = await this.dbService.db
      .select({ state: instructionTriggerStates.state })
      .from(instructionTriggerStates)
      .where(eq(instructionTriggerStates.userId, userId))
      .limit(1);

    if (rows.length === 0) {
      await this.dbService.db.insert(instructionTriggerStates).values({
        userId,
        state: {},
      });
      return {};
    }

    const state: unknown = rows[0].state;
    return isRecord(state) ? state : {};
  }

  /**
   * Update trigger state for a user
   */
  async updateTriggerState(userId: number, patch: Record<string, unknown>): Promise<void> {
    const current = await this.getTriggerState(userId);
    const merged = { ...current, ...patch };

    await this.dbService.db
      .update(instructionTriggerStates)
      .set({ state: merged, updatedAt: sql`now()` })
      .where(eq(instructionTriggerStates.userId, userId));
  }

  /**
   * Track a resource ID that was created by the agent.
   * This is stored in a simple in-memory cache with TTL.
   */
  private createdResourcesCache = new Map<string, number>(); // resourceId -> timestamp

  trackCreatedResource(userId: number, resourceId: string): void {
    const key = `${userId}:${resourceId}`;
    this.createdResourcesCache.set(key, Date.now());

    // Clean up old entries (older than 10 minutes)
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, timestamp] of this.createdResourcesCache.entries()) {
      if (timestamp < cutoff) {
        this.createdResourcesCache.delete(k);
      }
    }
  }

  /**
   * Check if a resource was recently created by the agent.
   */
  wasResourceCreatedByAgent(userId: number, resourceId: string, windowMs: number): boolean {
    const key = `${userId}:${resourceId}`;
    const timestamp = this.createdResourcesCache.get(key);
    if (!timestamp) return false;
    return Date.now() - timestamp < windowMs;
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

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  const x = Math.trunc(n);
  if (x < min) return min;
  if (x > max) return max;
  return x;
}
