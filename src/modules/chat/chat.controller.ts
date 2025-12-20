import { Body, Controller, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ChatService } from './chat.service';

@Controller('/api/chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post('/message')
  async message(
    @Req() req: Request,
    @Body() body: { threadId?: number; content?: string },
  ): Promise<{ threadId: number; assistant: { content: string }; citations: any[] }> {
    const userId = req.session.userId;
    if (!userId) throw new UnauthorizedException();

    const result = await this.chat.sendMessage({
      userId,
      threadId: typeof body.threadId === 'number' ? body.threadId : undefined,
      text: String(body.content ?? ''),
    });

    return {
      threadId: result.threadId,
      assistant: { content: result.assistant },
      citations: Array.isArray(result.citations) ? result.citations : [],
    };
  }
}
