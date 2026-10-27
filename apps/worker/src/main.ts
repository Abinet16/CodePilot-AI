import { JOBS, QUEUES, TaskStatus } from "@codepilot/contracts";
import type { RunTaskJob } from "@codepilot/contracts";
import { PrismaClient } from "@prisma/client";
import { Worker } from "bullmq";
import Redis from "ioredis";
import { loadConfig } from "./config";
import { runPipeline } from "./pipeline";
import { StaleTransitionError, TaskStateStore } from "./task-state";

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = new PrismaClient();
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const store = new TaskStateStore(prisma);

  const worker = new Worker<RunTaskJob>(
    QUEUES.AGENT_TASKS,
    async (job) => {
      if (job.name !== JOBS.RUN_TASK) throw new Error(`Unknown job ${job.name}`);
      const controller = new AbortController();
      try {
        const final = await runPipeline(
          job.data.taskId,
          {
            stages: {
              // Week 3+: ANALYZING, PLANNING, GENERATING_PATCH, RUNNING_CHECKS, REPAIRING, OPENING_PR
              [TaskStatus.QUEUED]: async () => TaskStatus.ANALYZING,
            },
            loadStatus: async (id) => (await prisma.agentTask.findUniqueOrThrow({ where: { id } })).status,
            transition: (id, from, to) => store.transition(id, from, to),
            fail: (id, from, reason) => store.fail(id, from, reason),
          },
          controller.signal,
        );
        return { status: final };
      } catch (err) {
        // Someone else (a cancel request or another worker) moved the task. Not a job failure.
        if (err instanceof StaleTransitionError) return { status: "superseded" };
        throw err;
      }
    },
    { connection, concurrency: config.WORKER_CONCURRENCY },
  );

  worker.on("failed", (job, err) => console.error(`[worker] job ${job?.id} failed: ${err.message}`));
  console.log(`[worker] consuming "${QUEUES.AGENT_TASKS}" with concurrency ${config.WORKER_CONCURRENCY}`);

  const shutdown = async () => {
    console.log("[worker] shutting down");
    await worker.close();
    await prisma.$disconnect();
    connection.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
