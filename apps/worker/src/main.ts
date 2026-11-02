import { readFileSync } from "node:fs";
import { DEFAULT_PATCH_LIMITS } from "@codepilot/agent-core";
import { JOBS, QUEUES, TaskStatus } from "@codepilot/contracts";
import type { RunTaskJob } from "@codepilot/contracts";
import { GitHubAppClient } from "@codepilot/github";
import { DockerSandbox } from "@codepilot/sandbox-runner";
import { PrismaClient } from "@prisma/client";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { createAnalyzeStage } from "./analysis/analyze-stage";
import { createChecksStage } from "./checks/checks-stage";
import { ContextRetriever } from "./analysis/retriever";
import { SnapshotStore } from "./analysis/snapshot-store";
import { WorkspaceManager } from "./analysis/workspace";
import { watchForCancellation } from "./cancellation";
import { loadConfig } from "./config";
import { runPipeline } from "./pipeline";
import { createModels } from "./model/factory";
import { createPatchStage } from "./patching/patch-stage";
import { createRepairStage } from "./patching/repair-stage";
import { createOpenPullRequestStage } from "./pull-requests/open-pr-stage";
import { reconcilePullRequests } from "./pull-requests/reconcile";
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

  const models = createModels(config);
  const planModel = models.planning;
  const patchModel = models.patch;
  if (models.missing) console.warn(`[worker] ${models.missing}; planning and patch generation will fail`);
  else console.log(`[worker] model provider: ${models.provider} (planning ${planModel?.model}, patches ${patchModel?.model})`);
  const runs = new RunRecorder(prisma, models.provider);

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
  const patchDeps = {
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
  };
  const patch = createPatchStage(patchDeps);
  const repair = createRepairStage({ ...patchDeps, maxRepairs: config.MAX_REPAIR_ATTEMPTS });

  const sandbox = config.SANDBOX_ENABLED ? new DockerSandbox() : null;
  if (!sandbox) console.warn("[worker] SANDBOX_ENABLED=false; checks will fail");
  else if (!(await sandbox.ready(config.SANDBOX_IMAGE))) {
    console.warn(`[worker] sandbox image ${config.SANDBOX_IMAGE} is not available; run pnpm sandbox:build, or checks will fail`);
  }
  const checks = createChecksStage({
    prisma,
    sandbox,
    workspaces,
    github,
    gitTimeoutMs: config.GIT_TIMEOUT_SECONDS * 1000,
    image: config.SANDBOX_IMAGE,
    limits: { memoryMb: config.SANDBOX_MEMORY_MB, cpus: config.SANDBOX_CPUS, pids: config.SANDBOX_PIDS, tmpfsMb: config.SANDBOX_TMPFS_MB },
    maxOutputBytes: config.CHECK_OUTPUT_KB * 1024,
    outputChars: config.CHECK_OUTPUT_CHARS,
    maxRepairs: config.MAX_REPAIR_ATTEMPTS,
  });

  const openPullRequest = createOpenPullRequestStage({
    prisma,
    github,
    workspaces,
    gitTimeoutMs: config.GIT_TIMEOUT_SECONDS * 1000,
    author: { name: config.PATCH_AUTHOR_NAME, email: config.PATCH_AUTHOR_EMAIL },
  });

  // A workspace older than any stage that uses one could take was left by a crashed worker.
  const longestStageMs = 1000 * Math.max(config.ANALYZE_TIMEOUT_SECONDS, config.PATCH_TIMEOUT_SECONDS, config.CHECKS_TIMEOUT_SECONDS, config.REPAIR_TIMEOUT_SECONDS);
  const swept = await workspaces.sweep(2 * longestStageMs);
  if (swept > 0) console.log(`[worker] removed ${swept} stale workspace(s)`);
  const sweptContainers = (await sandbox?.sweep(2 * longestStageMs)) ?? 0;
  if (sweptContainers > 0) console.log(`[worker] removed ${sweptContainers} stale sandbox container(s)`);

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
              [TaskStatus.QUEUED]: async () => TaskStatus.ANALYZING,
              [TaskStatus.ANALYZING]: analyze,
              [TaskStatus.PLANNING]: plan,
              [TaskStatus.GENERATING_PATCH]: patch,
              [TaskStatus.RUNNING_CHECKS]: checks,
              [TaskStatus.REPAIRING]: repair,
              [TaskStatus.OPENING_PR]: openPullRequest,
            },
            stageTimeoutsMs: {
              [TaskStatus.ANALYZING]: config.ANALYZE_TIMEOUT_SECONDS * 1000,
              [TaskStatus.PLANNING]: config.PLAN_TIMEOUT_SECONDS * 1000,
              [TaskStatus.GENERATING_PATCH]: config.PATCH_TIMEOUT_SECONDS * 1000,
              [TaskStatus.RUNNING_CHECKS]: config.CHECKS_TIMEOUT_SECONDS * 1000,
              [TaskStatus.REPAIRING]: config.REPAIR_TIMEOUT_SECONDS * 1000,
              [TaskStatus.OPENING_PR]: config.OPEN_PR_TIMEOUT_SECONDS * 1000,
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

  // One scheduler entry across all workers: BullMQ keeps a single repeating job, whoever upserts it.
  const maintenance = new Queue(QUEUES.MAINTENANCE, { connection });
  const maintenanceWorker = new Worker(
    QUEUES.MAINTENANCE,
    async (job) => {
      if (job.name !== JOBS.RECONCILE_PULL_REQUESTS || !github) return { skipped: true };
      return reconcilePullRequests(prisma, github, { staleAfterMs: config.PR_RECONCILE_STALE_SECONDS * 1000, limit: 100 });
    },
    { connection, concurrency: 1 },
  );
  if (github) {
    await maintenance.upsertJobScheduler(
      JOBS.RECONCILE_PULL_REQUESTS,
      { every: config.PR_RECONCILE_INTERVAL_SECONDS * 1000 },
      { name: JOBS.RECONCILE_PULL_REQUESTS, opts: { removeOnComplete: 100, removeOnFail: 100 } },
    );
  }
  maintenanceWorker.on("failed", (job, err) => console.error(`[worker] maintenance job ${job?.name} failed: ${err.message}`));

  const shutdown = async () => {
    console.log("[worker] shutting down");
    await worker.close();
    await maintenanceWorker.close();
    await maintenance.close();
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
