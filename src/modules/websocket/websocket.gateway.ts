import { Injectable, Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

type SocketRegistration = {
  userId: number;
  threadId: number | null;
};

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
  pingInterval: 25000, // Keep connection alive through proxies
  pingTimeout: 60000,
})
@Injectable()
export class ChatWebSocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatWebSocketGateway.name);

  // Maps socket ID -> { userId, threadId }
  private readonly socketRegistrations = new Map<string, SocketRegistration>();

  // Reverse index: userId -> Set<socketId>
  private readonly userSockets = new Map<number, Set<string>>();

  // Reverse index: userId-threadId -> Set<socketId>
  private readonly threadSockets = new Map<string, Set<string>>();

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);

    // Try to get userId from session
    const req = client.request as unknown as { session?: { userId?: number } };
    const userId = req.session?.userId;

    if (userId) {
      // Pre-register with userId only (threadId will come from 'register' event)
      this.registerSocket(client.id, userId, null);
      this.logger.debug(`Client ${client.id} pre-registered for user ${userId} from session`);
    } else {
      // In production, session might not be available on WebSocket upgrade
      // Client will send userId via 'register' event
      this.logger.debug(`Client ${client.id} connected, waiting for register event`);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.unregisterSocket(client.id);
  }

  @SubscribeMessage('register')
  async handleRegister(
    client: Socket,
    data: { userId?: number; threadId?: number },
  ): Promise<void> {
    // Try to get userId from existing registration, session, or payload
    let userId: number | undefined;

    const existing = this.socketRegistrations.get(client.id);
    if (existing?.userId) {
      userId = existing.userId;
    } else {
      // Try session
      const req = client.request as unknown as { session?: { userId?: number } };
      userId = req.session?.userId;
    }

    // If still no userId, try from payload (for production where session isn't available)
    if (!userId && typeof data.userId === 'number' && data.userId > 0) {
      userId = data.userId;
    }

    if (!userId) {
      this.logger.warn(`Socket ${client.id} tried to register but has no userId`);
      return;
    }

    const threadId = typeof data.threadId === 'number' && data.threadId > 0 ? data.threadId : null;

    // Update registration with threadId
    this.unregisterSocket(client.id);
    this.registerSocket(client.id, userId, threadId);

    // Join user-specific room for broadcasts
    await client.join(`user:${userId}`);
    if (threadId) {
      await client.join(`thread:${userId}:${threadId}`);
    }

    this.logger.log(
      `Socket ${client.id} registered for user ${userId}, thread ${threadId ?? 'none'}`,
    );

    // Send confirmation back to client
    client.emit('registered', { userId, threadId });
  }

  private registerSocket(socketId: string, userId: number, threadId: number | null): void {
    this.socketRegistrations.set(socketId, { userId, threadId });

    // Add to user index
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId)!.add(socketId);

    // Add to thread index if threadId is set
    if (threadId !== null) {
      const threadKey = `${userId}:${threadId}`;
      if (!this.threadSockets.has(threadKey)) {
        this.threadSockets.set(threadKey, new Set());
      }
      this.threadSockets.get(threadKey)!.add(socketId);
    }
  }

  private unregisterSocket(socketId: string): void {
    const reg = this.socketRegistrations.get(socketId);
    if (!reg) return;

    // Remove from user index
    const userSet = this.userSockets.get(reg.userId);
    if (userSet) {
      userSet.delete(socketId);
      if (userSet.size === 0) {
        this.userSockets.delete(reg.userId);
      }
    }

    // Remove from thread index
    if (reg.threadId !== null) {
      const threadKey = `${reg.userId}:${reg.threadId}`;
      const threadSet = this.threadSockets.get(threadKey);
      if (threadSet) {
        threadSet.delete(socketId);
        if (threadSet.size === 0) {
          this.threadSockets.delete(threadKey);
        }
      }
    }

    this.socketRegistrations.delete(socketId);
  }

  /**
   * Emit to all sockets for a given user (regardless of thread).
   */
  emitToUser(userId: number, event: string, data: unknown): void {
    const sockets = this.userSockets.get(userId);
    if (!sockets || sockets.size === 0) {
      this.logger.debug(`No sockets found for user ${userId}`);
      return;
    }

    for (const socketId of sockets) {
      this.server.to(socketId).emit(event, data);
    }

    this.logger.debug(`Emitted ${event} to ${sockets.size} socket(s) for user ${userId}`);
  }

  /**
   * Emit to sockets viewing a specific thread for a specific user.
   * This ensures messages only go to the correct thread view.
   */
  emitToThread(userId: number, threadId: number, event: string, data: unknown): void {
    const threadKey = `${userId}:${threadId}`;
    const sockets = this.threadSockets.get(threadKey);

    if (!sockets || sockets.size === 0) {
      this.logger.debug(`No sockets found for user ${userId} thread ${threadId}`);
      return;
    }

    for (const socketId of sockets) {
      this.server.to(socketId).emit(event, data);
    }

    this.logger.debug(
      `Emitted ${event} to ${sockets.size} socket(s) for user ${userId} thread ${threadId}`,
    );
  }

  /**
   * Emit a new message to sockets viewing the specific thread.
   */
  emitNewMessage(
    userId: number,
    threadId: number,
    message: { role: string; content: string },
  ): void {
    this.emitToThread(userId, threadId, 'new-message', {
      threadId,
      message,
    });
  }
}
