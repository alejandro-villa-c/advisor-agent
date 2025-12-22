import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { InstructionsService } from './instructions.service';

@Controller('/api/instructions')
export class InstructionsController {
  constructor(private readonly instructions: InstructionsService) {}

  /**
   * List all instructions for the current user
   */
  @Get()
  async list(@Req() req: Request): Promise<{
    instructions: Array<{
      id: number;
      instruction: string;
      isActive: boolean;
      createdAt: string;
    }>;
  }> {
    const userId = requireUserId(req);
    const rows = await this.instructions.listInstructions(userId);

    return {
      instructions: rows.map((r) => ({
        id: r.id,
        instruction: r.instruction,
        isActive: r.isActive,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Create a new instruction
   */
  @Post()
  async create(
    @Req() req: Request,
    @Body() body: { instruction?: string; forceCreate?: boolean },
  ): Promise<{
    success: boolean;
    id?: number;
    conflict?: {
      hasConflict: boolean;
      conflictingInstruction?: { id: number; instruction: string } | null;
      reason?: string | null;
    };
  }> {
    const userId = requireUserId(req);
    const instruction = String(body.instruction ?? '').trim();

    if (!instruction) {
      throw new Error('Instruction is required');
    }

    // If forceCreate is true, skip conflict check
    if (body.forceCreate) {
      const result = await this.instructions.createInstruction(userId, instruction);
      return { success: true, id: result.id };
    }

    const result = await this.instructions.createInstruction(userId, instruction);

    if (result.conflict?.hasConflict) {
      return {
        success: false,
        conflict: {
          hasConflict: true,
          conflictingInstruction: result.conflict.conflictingInstruction
            ? {
                id: result.conflict.conflictingInstruction.id,
                instruction: result.conflict.conflictingInstruction.instruction,
              }
            : null,
          reason: result.conflict.reason,
        },
      };
    }

    return { success: true, id: result.id };
  }

  /**
   * Delete an instruction
   */
  @Delete('/:id')
  async delete(@Req() req: Request, @Param('id') idStr: string): Promise<{ success: boolean }> {
    const userId = requireUserId(req);
    const id = Number(idStr);

    if (!Number.isFinite(id) || id <= 0) {
      throw new Error('Invalid instruction ID');
    }

    const deleted = await this.instructions.deleteInstruction(userId, id);
    return { success: deleted };
  }

  /**
   * Toggle an instruction on/off
   */
  @Post('/:id/toggle')
  async toggle(
    @Req() req: Request,
    @Param('id') idStr: string,
  ): Promise<{ success: boolean; isActive?: boolean }> {
    const userId = requireUserId(req);
    const id = Number(idStr);

    if (!Number.isFinite(id) || id <= 0) {
      throw new Error('Invalid instruction ID');
    }

    const result = await this.instructions.toggleInstruction(userId, id);

    if (!result) {
      return { success: false };
    }

    return { success: true, isActive: result.isActive };
  }

  /**
   * Pause all instructions
   */
  @Post('/pause-all')
  async pauseAll(@Req() req: Request): Promise<{ success: boolean; count: number }> {
    const userId = requireUserId(req);
    const count = await this.instructions.pauseAll(userId);
    return { success: true, count };
  }

  /**
   * Resume all instructions
   */
  @Post('/resume-all')
  async resumeAll(@Req() req: Request): Promise<{ success: boolean; count: number }> {
    const userId = requireUserId(req);
    const count = await this.instructions.resumeAll(userId);
    return { success: true, count };
  }

  /**
   * Get recent proactive actions (activity log)
   */
  @Get('/activity')
  async getActivity(@Req() req: Request): Promise<{
    actions: Array<{
      id: number;
      instructionText: string;
      triggerType: string;
      triggerSummary: string;
      actionTaken: string;
      status: string;
      error: string | null;
      createdAt: string;
    }>;
  }> {
    const userId = requireUserId(req);
    const rows = await this.instructions.getRecentActions(userId, 50);

    return {
      actions: rows.map((r) => ({
        id: r.id,
        instructionText: r.instructionText,
        triggerType: r.triggerType,
        triggerSummary: r.triggerSummary,
        actionTaken: r.actionTaken,
        status: r.status,
        error: r.error,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Check rate limit status
   */
  @Get('/rate-limit')
  async getRateLimit(@Req() req: Request): Promise<{
    allowed: boolean;
    remaining: number;
    maxPerHour: number;
  }> {
    const userId = requireUserId(req);
    const result = await this.instructions.checkRateLimit(userId);
    return { ...result, maxPerHour: 20 };
  }
}

function requireUserId(req: Request): number {
  const anyReq = req as unknown as Record<string, unknown>;

  const candidates: unknown[] = [
    anyReq['userId'],
    readNested(anyReq, 'user', 'id'),
    readNested(anyReq, 'user', 'userId'),
    readNested(anyReq, 'auth', 'userId'),
    readNested(anyReq, 'session', 'userId'),
  ];

  for (const c of candidates) {
    const n = toPositiveInt(c);
    if (n !== null) return n;
  }

  throw new UnauthorizedException('No userId on request.');
}

function readNested(obj: Record<string, unknown>, key1: string, key2: string): unknown {
  const v1 = obj[key1];
  if (!isRecord(v1)) return undefined;
  return v1[key2];
}

function toPositiveInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return null;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
