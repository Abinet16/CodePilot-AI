import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { JOBS, QUEUES, taskJobId } from "@codepilot/contracts";
import type { RunTaskJob, TaskJobKey } from "@codepilot/contracts";
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

  /**
   * The job id is derived from the task and the reason it is enqueued, so
   * repeating the same request is a no-op in BullMQ while each human resume
   * (approval, requested changes) still gets a fresh job.
   */
  async enqueue(taskId: string, key: TaskJobKey = "start"): Promise<void> {
    await this.queue.add(
      JOBS.RUN_TASK,
      { taskId },
      {
        jobId: taskJobId(taskId, key),
        // Transient failures (rate limits, provider outages) are retried; stages resume from the persisted status.
        attempts: 3,
        backoff: { type: "exponential", delay: 15_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );
  }

  /**
   * Drops jobs that have not started yet. A running job is stopped by the
   * worker, which polls for cancellation; a job that starts later finds the
   * task terminal and exits.
   */
  async remove(taskId: string, keys: TaskJobKey[]): Promise<void> {
    await Promise.all(keys.map((key) => this.queue.remove(taskJobId(taskId, key))));
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
