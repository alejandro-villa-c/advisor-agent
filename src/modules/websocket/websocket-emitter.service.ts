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
    // Skip empty messages
    if (!message.content || !message.content.trim()) {
      return true;
    }

    const url = `${this.webServerUrl}/internal/websocket/emit`;

    // Retry up to 2 times with a small delay
    for (let attempt = 1; attempt <= 2; attempt++) {
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
            `WebSocket emit failed (attempt ${attempt}): status=${response.status} body=${text.slice(0, 200)}`,
          );

          if (attempt < 2) {
            await this.delay(500); // Wait 500ms before retry
            continue;
          }
          return false;
        }

        const result = (await response.json()) as { ok: boolean };

        if (result.ok) {
          this.logger.debug(`WebSocket emit success: user=${userId} thread=${threadId}`);
        }

        return result.ok === true;
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : String(err);
        const cause =
          err instanceof Error && err.cause
            ? ` cause=${err.cause instanceof Error ? err.cause.message : JSON.stringify(err.cause)}`
            : '';

        this.logger.warn(
          `WebSocket emit error (attempt ${attempt}) to ${url}: ${errMessage}${cause}`,
        );

        if (attempt < 2) {
          await this.delay(500);
          continue;
        }
        return false;
      }
    }

    return false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
