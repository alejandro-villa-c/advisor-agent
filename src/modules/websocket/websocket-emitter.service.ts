import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class WebSocketEmitterService {
  private readonly logger = new Logger(WebSocketEmitterService.name);
  private readonly webServerUrl: string;
  private readonly secret: string;

  constructor() {
    // In development, web server is on port 3000
    this.webServerUrl = process.env.APP_BASE_URL || 'http://127.0.0.1:3000';
    this.secret = process.env.INTERNAL_API_SECRET || 'dev-secret';
    
    this.logger.log(`WebSocket emitter configured for: ${this.webServerUrl}`);
  }

  async emitNewMessage(
    userId: number,
    threadId: number,
    message: { role: string; content: string },
  ): Promise<boolean> {
    const url = `${this.webServerUrl}/internal/websocket/emit`;
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          threadId,
          message,
          secret: this.secret,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        this.logger.warn(
          `WebSocket emit failed: status=${response.status} body=${text.slice(0, 200)}`,
        );
        return false;
      }

      const result = (await response.json()) as { ok: boolean };
      
      if (result.ok) {
        this.logger.debug(`WebSocket emit success: user=${userId} thread=${threadId}`);
      }
      
      return result.ok === true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const cause = err instanceof Error && err.cause ? ` cause=${String(err.cause)}` : '';
      
      this.logger.warn(
        `WebSocket emit error to ${url}: ${message}${cause}`,
      );
      return false;
    }
  }
}