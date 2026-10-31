import { readFileSync } from "node:fs";
import { DEFAULT_PATCH_LIMITS } from "@codepilot/agent-core";
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
import { watchForCancellation } from "./cancellation";
import { loadConfig } from "./config";
import { runPipeline } from "./pipeline";
import { AnthropicModel } from "./model/anthropic-model";
import { createPatchStage } from "./patching/patch-stage";
import { createPlanStage } from "./planning/plan-stage";
import { RunRecorder } from "./runs";
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

  const modelTimeoutMs = config.MODEL_TIMEOUT_SECONDS * 1000;
  const apiKey = config.ANTHROPIC_API_KEY;
  const planModel = apiKey ? AnthropicModel.fromApiKey(apiKey, config.PLANNING_MODEL, config.PLANNING_EFFORT, modelTimeoutMs) : null;
  const patchModel = apiKey ? AnthropicModel.fromApiKey(apiKey, config.PATCH_MODEL, config.PATCH_EFFORT, modelTimeoutMs) : null;
  if (!apiKey) console.warn("[worker] ANTHROPIC_API_KEY is not set; planning and patch generation will fail");
  const runs = new RunRecorder(prisma);

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
  const plan = createPlanStage({
    prisma,
    model: planModel,
    runs,
    maxAttempts: config.PLANNING_MAX_ATTEMPTS,
    taskTokenBudget: config.TASK_TOKEN_BUDGET,
    maxOutputTokens: config.PLANNING_MAX_OUTPUT_TOKENS,
  });
  const patch = createPatchStage({
    prisma,
    model: patchModel,
    runs,
    workspaces,
    github,
    maxAttempts: config.PATCH_MAX_ATTEMPTS,
    taskTokenBudget: config.TASK_TOKEN_BUDGET,
    maxOutputTokens: config.PATCH_MAX_OUTPUT_TOKENS,
    gitTimeoutMs: config.GIT_TIMEOUT_SECONDS * 1000,
    limits: {
      ...DEFAULT_PATCH_LIMITS,
      maxFileBytes: config.PATCH_MAX_FILE_KB * 1024,
      maxChangedLines: config.PATCH_MAX_CHANGED_LINES,
    },
    author: { name: config.PATCH_AUTHOR_NAME, email: config.PATCH_AUTHOR_EMAIL },
  });

  // A workspace older than any stage that uses one could take was left by a crashed worker.
  const swept = await workspaces.sweep(2 * Math.max(config.ANALYZE_TIMEOUT_SECONDS, config.PATCH_TIMEOUT_SECONDS) * 1000);
  if (swept > 0) console.log(`[worker] removed ${swept} stale workspace(s)`);

  const loadStatus = async (id: string) => (await prisma.agentTask.findUniqueOrThrow({ where: { id } })).status;

  const worker = new Worker<RunTaskJob>(
    QUEUES.AGENT_TASKS,
    async (job) => {
      if (job.name !== JOBS.RUN_TASK) throw new Error(`Unknown job ${job.name}`);
      const { taskId } = job.data;
      const controller = new AbortController();
      const stopWatching = watchForCancellation(taskId, loadStatus, controller, config.CANCELLATION_POLL_MS);
      try {
        const final = await runPipeline(
          taskId,
          {
            stages: {
              // Week 6+: RUNNING_CHECKS, REPAIRING, OPENING_PR
              [TaskStatus.QUEUED]: async () => TaskStatus.ANALYZING,
              [TaskStatus.ANALYZING]: analyze,
              [TaskStatus.PLANNING]: plan,
              [TaskStatus.GENERATING_PATCH]: patch,
            },
            stageTimeoutsMs: {
              [TaskStatus.ANALYZING]: config.ANALYZE_TIMEOUT_SECONDS * 1000,
              [TaskStatus.PLANNING]: config.PLAN_TIMEOUT_SECONDS * 1000,
              [TaskStatus.GENERATING_PATCH]: config.PATCH_TIMEOUT_SECONDS * 1000,
            },
            loadStatus,
            transition: (id, from, to) => store.transition(id, from, to),
            fail: (id, from, reason) => store.fail(id, from, reason),
            canRetry: job.attemptsMade + 1 < (job.opts.attempts ?? 1),
            onRetry: async (id, status, reason) => {
              await prisma.taskEvent.create({
                data: { taskId: id, eventType: "stage_retry_scheduled", payload: { status, reason, attempt: job.attemptsMade + 1 } },
              });
            },
          },
          controller.signal,
        );
        return { status: final };
      } catch (err) {
        // Someone else (a cancel request or another worker) moved the task. Not a job failure.
        if (err instanceof StaleTransitionError) return { status: "superseded" };
        throw err;
      } finally {
        stopWatching();
      }
    },
    {
      connection,
      concurrency: config.WORKER_CONCURRENCY,
      // A job whose worker died is handed to another worker once its lock lapses; the pipeline resumes it.
      lockDuration: 60_000,
      maxStalledCount: 2,
    },
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
