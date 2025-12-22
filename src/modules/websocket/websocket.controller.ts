import { Body, Controller, Post, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ChatWebSocketGateway } from './websocket.gateway';

/**
 * Body for legacy message emission (chat messages)
 */
interface EmitMessageBody {
  userId: number;
  threadId: number;
  message: {
    role: string;
    content: string;
  };
  secret: string;
}

/**
 * Body for generic event emission (activity_log, etc.)
 */
interface EmitEventBody {
  userId: number;
  event: string;
  data: unknown;
  secret: string;
}

@Controller('internal/websocket')
export class WebSocketController {
  private readonly logger = new Logger(WebSocketController.name);

  constructor(private readonly gateway: ChatWebSocketGateway) {}

  /**
   * Generic emit endpoint - handles any event type
   */
  @Post('emit')
  @HttpCode(HttpStatus.OK)
  emit(@Body() body: EmitEventBody | EmitMessageBody): { ok: boolean } {
    // Simple secret check to prevent unauthorized access
    const expectedSecret = process.env.INTERNAL_API_SECRET || 'dev-secret';
    if (body.secret !== expectedSecret) {
      this.logger.warn('WebSocket emit rejected: invalid secret');
      return { ok: false };
    }

    // Check if this is the new generic format (has 'event' field)
    if ('event' in body && typeof body.event === 'string') {
      const eventBody = body;

      this.logger.debug(`Emitting event: ${eventBody.event} to user ${eventBody.userId}`);

      // Emit to user's room
      this.gateway.emitToUser(eventBody.userId, eventBody.event, eventBody.data);
      return { ok: true };
    }

    // Legacy format: thread message
    if ('threadId' in body && 'message' in body) {
      const msgBody = body;
      this.gateway.emitNewMessage(msgBody.userId, msgBody.threadId, msgBody.message);
      return { ok: true };
    }

    this.logger.warn('WebSocket emit rejected: invalid body format');
    return { ok: false };
  }
}
