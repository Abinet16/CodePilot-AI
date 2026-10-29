import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { JOBS, QUEUES } from "@codepilot/contracts";
import type { RunTaskJob } from "@codepilot/contracts";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { REDIS } from "../redis/redis.provider";

/** Producer side of the agent-tasks queue. Jobs carry the task id only. */
@Injectable()
export class TaskQueue implements OnModuleDestroy {
  private readonly queue: Queue<RunTaskJob>;

  constructor(@Inject(REDIS) redis: Redis) {
    this.queue = new Queue<RunTaskJob>(QUEUES.AGENT_TASKS, { connection: redis });
  }

  async enqueue(taskId: string): Promise<void> {
    // jobId = taskId: enqueueing the same task twice is a no-op in BullMQ.
    await this.queue.add(
      JOBS.RUN_TASK,
      { taskId },
      {
        jobId: taskId,
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );
  }

  /** Drops a job that has not started yet. A running job notices cancellation at its next transition. */
  async remove(taskId: string): Promise<void> {
    await this.queue.remove(taskId);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
