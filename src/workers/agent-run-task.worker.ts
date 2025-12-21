import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgBossService } from '../jobs/pgboss.service';
import { AGENT_RUN_TASK_JOB } from '../jobs/job.constants';
import { AgentRunnerService } from '../modules/agent/agent-runner.service';

type PgBossJob<T> = { id: string | number; data: T };

type AgentRunTaskJobData = {
  taskId: number;
};

@Injectable()
export class AgentRunTaskWorker implements OnModuleInit {
  private readonly logger = new Logger(AgentRunTaskWorker.name);

  constructor(
    private readonly pgBossService: PgBossService,
    private readonly runner: AgentRunnerService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.pgBossService.client.createQueue(AGENT_RUN_TASK_JOB);
    } catch (err: unknown) {
      this.logger.warn(
        `createQueue(${AGENT_RUN_TASK_JOB}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this.pgBossService.client.work(
      AGENT_RUN_TASK_JOB,
      { batchSize: 1 },
      async (jobs: PgBossJob<AgentRunTaskJobData>[]) => {
        for (const job of jobs) {
          const taskId = Number(job.data?.taskId);
          if (!Number.isFinite(taskId) || taskId <= 0) {
            this.logger.warn(`[${AGENT_RUN_TASK_JOB}] invalid taskId in job=${String(job.id)}`);
            continue;
          }

          this.logger.log(`[${AGENT_RUN_TASK_JOB}] start job=${String(job.id)} taskId=${taskId}`);

          try {
            await this.runner.runTask(taskId);
          } catch (err) {
            this.logger.error(
              `[${AGENT_RUN_TASK_JOB}] FAILED job=${String(job.id)} taskId=${taskId} ` +
                (err instanceof Error ? err.stack : String(err)),
            );
            throw err;
          }

          this.logger.log(`[${AGENT_RUN_TASK_JOB}] done job=${String(job.id)} taskId=${taskId}`);
        }
      },
    );

    this.logger.log(`Registered worker: ${AGENT_RUN_TASK_JOB}`);
  }
}
