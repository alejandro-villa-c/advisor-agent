import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module';
import { WebModule } from './modules/web/web.module';
import { AuthModule } from './modules/auth/auth.module';
import { HubspotModule } from './modules/integrations/hubspot/hubspot.module';
import { JobsModule } from './jobs/jobs.module';
import { RagModule } from './modules/rag/rag.module';
import { ChatModule } from './modules/chat/chat.module';
import { ThreadsModule } from './modules/threads/threads.module';
import { AgentModule } from './modules/agent/agent.module';
import { WebSocketModule } from './modules/websocket/websocket.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DbModule,
    WebModule,
    AuthModule,
    HubspotModule,
    JobsModule,
    RagModule,
    ChatModule,
    ThreadsModule,
    AgentModule,
    WebSocketModule,
  ],
})
export class AppModule {}
