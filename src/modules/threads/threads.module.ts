import { Module } from '@nestjs/common';
import { ThreadsController } from './threads.controller';
import { ThreadsService } from './threads.service';
import { DbModule } from '../../db/db.module';

@Module({
  imports: [DbModule],
  controllers: [ThreadsController],
  providers: [ThreadsService],
  exports: [ThreadsService],
})
export class ThreadsModule {}
