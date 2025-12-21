import { Module } from '@nestjs/common';
import { ChatWebSocketGateway } from './websocket.gateway';
import { WebSocketController } from './websocket.controller';
import { WebSocketEmitterService } from './websocket-emitter.service';

@Module({
  controllers: [WebSocketController],
  providers: [ChatWebSocketGateway, WebSocketEmitterService],
  exports: [ChatWebSocketGateway, WebSocketEmitterService],
})
export class WebSocketModule {}
