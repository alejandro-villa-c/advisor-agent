import { Module } from '@nestjs/common';
import { PgBossService } from './pgboss.service';
import { JobsController } from './jobs.controller';

@Module({
  providers: [PgBossService],
  controllers: [JobsController],
  exports: [PgBossService],
})
export class JobsModule {}
