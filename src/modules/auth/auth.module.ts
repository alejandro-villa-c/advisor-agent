import { Module } from '@nestjs/common';
import { JobsModule } from '../../jobs/jobs.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [JobsModule],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
