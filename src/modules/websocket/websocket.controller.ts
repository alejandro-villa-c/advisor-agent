import { Body, Controller, Post, HttpCode, HttpStatus } from '@nestjs/common';
import { ChatWebSocketGateway } from './websocket.gateway';

interface EmitMessageBody {
  userId: number;
  threadId: number;
  message: {
    role: string;
    content: string;
  };
  secret: string;
}

@Controller('internal/websocket')
export class WebSocketController {
  constructor(private readonly gateway: ChatWebSocketGateway) {}

  @Post('emit')
  @HttpCode(HttpStatus.OK)
  emit(@Body() body: EmitMessageBody): { ok: boolean } {
    // Simple secret check to prevent unauthorized access
    const expectedSecret = process.env.INTERNAL_API_SECRET || 'dev-secret';
    if (body.secret !== expectedSecret) {
      return { ok: false };
    }

    this.gateway.emitNewMessage(body.userId, body.threadId, body.message);
    return { ok: true };
  }
}
