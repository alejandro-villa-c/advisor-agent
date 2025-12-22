import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { JobsModule } from './jobs/jobs.module';
import { HubspotModule } from './modules/integrations/hubspot/hubspot.module';
import { RagModule } from './modules/rag/rag.module';
import { GoogleModule } from './modules/integrations/google/google.module';

import { HubspotContactsSyncWorker } from './workers/hubspot-contacts-sync.worker';
import { RagEmbedWorker } from './workers/rag-embed.worker';
import { HubspotNotesSyncWorker } from './workers/hubspot-notes-sync.worker';
import { SyncSchedulerService } from './workers/sync-scheduler.service';
import { SyncTickWorker } from './workers/sync-tick.worker';
import { GmailSyncWorker } from './workers/gmail-sync.worker';
import { CalendarSyncWorker } from './workers/calendar-sync.worker';
import { AgentReactWorker } from './workers/agent-react.worker';
import { AgentRunTaskWorker } from './workers/agent-run-task.worker';
import { AgentTickWorker } from './workers/agent-tick.worker';
import { AgentModule } from './modules/agent/agent.module';
import { WebSocketModule } from './modules/websocket/websocket.module';
import { InstructionTickWorker } from './workers/instruction-tick.worker';
import { InstructionsModule } from './modules/instructions/instructions.module';

@Module({
  imports: [
    DbModule,
    JobsModule,
    HubspotModule,
    RagModule,
    GoogleModule,
    AgentModule,
    WebSocketModule,
    InstructionsModule,
  ],
  providers: [
    HubspotContactsSyncWorker,
    HubspotNotesSyncWorker,
    GmailSyncWorker,
    CalendarSyncWorker,
    RagEmbedWorker,
    SyncSchedulerService,
    SyncTickWorker,
    AgentReactWorker,
    AgentRunTaskWorker,
    AgentTickWorker,
    InstructionTickWorker,
  ],
})
export class WorkerModule {}
