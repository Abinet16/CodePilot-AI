import { readFileSync } from "node:fs";
import { JOBS, QUEUES, TaskStatus } from "@codepilot/contracts";
import type { RunTaskJob } from "@codepilot/contracts";
import { GitHubAppClient } from "@codepilot/github";
import { PrismaClient } from "@prisma/client";
import { Worker } from "bullmq";
import Redis from "ioredis";
import { createAnalyzeStage } from "./analysis/analyze-stage";
import { ContextRetriever } from "./analysis/retriever";
import { SnapshotStore } from "./analysis/snapshot-store";
import { WorkspaceManager } from "./analysis/workspace";
import { loadConfig } from "./config";
import { runPipeline } from "./pipeline";
import { StaleTransitionError, TaskStateStore } from "./task-state";

async function main(): Promise<void> {
  const config = loadConfig();
  const prisma = new PrismaClient();
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const store = new TaskStateStore(prisma);
  const workspaces = new WorkspaceManager(config.WORKSPACE_ROOT);

  const github =
    config.GITHUB_APP_ID && config.GITHUB_APP_PRIVATE_KEY_PATH
      ? new GitHubAppClient(config.GITHUB_APP_ID, readFileSync(config.GITHUB_APP_PRIVATE_KEY_PATH, "utf8"))
      : null;
  if (!github) console.warn("[worker] GitHub App is not configured; repository analysis will fail");

  const analyze = createAnalyzeStage({
    prisma,
    github,
    snapshots: new SnapshotStore(prisma),
    retriever: new ContextRetriever(prisma),
    workspaces,
    maxRepositorySizeMb: config.MAX_REPOSITORY_SIZE_MB,
    gitTimeoutMs: config.GIT_TIMEOUT_SECONDS * 1000,
    snapshotsToKeep: config.SNAPSHOTS_TO_KEEP,
  });

  // A workspace older than any analysis could take was left by a crashed worker.
  const swept = await workspaces.sweep(4 * config.GIT_TIMEOUT_SECONDS * 1000);
  if (swept > 0) console.log(`[worker] removed ${swept} stale workspace(s)`);

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
              // Week 4+: PLANNING, GENERATING_PATCH, RUNNING_CHECKS, REPAIRING, OPENING_PR
              [TaskStatus.QUEUED]: async () => TaskStatus.ANALYZING,
              [TaskStatus.ANALYZING]: analyze,
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
