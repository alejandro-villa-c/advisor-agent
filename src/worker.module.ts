import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module';
import { JobsModule } from './jobs/jobs.module';
import { HubspotModule } from './modules/integrations/hubspot/hubspot.module';
import { HubspotImportWorker } from './worker/hubspot-import.worker';

@Module({
  imports: [DbModule, JobsModule, HubspotModule],
  providers: [HubspotImportWorker],
})
export class WorkerModule {}
