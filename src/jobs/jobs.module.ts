import { Module } from '@nestjs/common';
import { PgBossService } from './pgboss.service';

@Module({
  providers: [PgBossService],
  exports: [PgBossService],
})
export class JobsModule {}