import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { JobsModule } from './jobs/jobs.module';
import { HubspotModule } from './modules/integrations/hubspot/hubspot.module';
import { RagModule } from './modules/rag/rag.module';
import { GoogleModule } from './modules/integrations/google/google.module';

import { HubspotContactsSyncWorker } from './worker/hubspot-contacts-sync.worker';
import { RagEmbedWorker } from './worker/rag-embed.worker';
import { HubspotNotesSyncWorker } from './worker/hubspot-notes-sync.worker';
import { SyncSchedulerService } from './worker/sync-scheduler.service';
import { SyncTickWorker } from './worker/sync-tick.worker';
import { GmailSyncWorker } from './worker/gmail-sync.worker';
import { CalendarSyncWorker } from './worker/calendar-sync.worker';

@Module({
  imports: [DbModule, JobsModule, HubspotModule, RagModule, GoogleModule],
  providers: [
    HubspotContactsSyncWorker,
    HubspotNotesSyncWorker,
    GmailSyncWorker,
    CalendarSyncWorker,
    RagEmbedWorker,
    SyncSchedulerService,
    SyncTickWorker,
  ],
})
export class WorkerModule {}
