import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '../../db/db.service';
import {
  agentInstructions,
  proactiveActions,
  proactiveActionRateLimits,
  instructionTriggerStates,
} from '../../db/schema';
import { OpenAiChatService } from '../integrations/openai/openai-chat.service';

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

const MAX_ACTIONS_PER_HOUR = 20;

@Injectable()
export class InstructionsService {
  private readonly logger = new Logger(InstructionsService.name);

  constructor(
    private readonly dbService: DbService,
    private readonly llm: OpenAiChatService,
  ) {}

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
      // Can't check conflicts without LLM
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

    // Check for conflicts
    const conflict = await this.checkForConflicts(userId, trimmed);

    if (conflict.hasConflict) {
      // Return the conflict info but don't create
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
    // First get current state
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
   * Check if user has exceeded rate limit for proactive actions
   */
  async checkRateLimit(userId: number): Promise<{ allowed: boolean; remaining: number }> {
    const now = new Date();
    const hourWindow = new Date(now);
    hourWindow.setMinutes(0, 0, 0);

    // Get or create rate limit record
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
      return { allowed: true, remaining: MAX_ACTIONS_PER_HOUR };
    }

    const count = existing[0].actionCount;
    const remaining = Math.max(0, MAX_ACTIONS_PER_HOUR - count);

    return { allowed: count < MAX_ACTIONS_PER_HOUR, remaining };
  }

  /**
   * Increment rate limit counter
   */
  async incrementRateLimit(userId: number): Promise<void> {
    const now = new Date();
    const hourWindow = new Date(now);
    hourWindow.setMinutes(0, 0, 0);

    // Upsert: insert or increment
    await this.dbService.db
      .insert(proactiveActionRateLimits)
      .values({
        userId,
        hourWindow,
        actionCount: 1,
      })
      .onConflictDoUpdate({
        target: [proactiveActionRateLimits.userId, proactiveActionRateLimits.hourWindow],
        set: {
          actionCount: sql`${proactiveActionRateLimits.actionCount} + 1`,
        },
      });
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
      // Create initial state
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
