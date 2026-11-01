import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { CheckResultSummary, RepositoryChecks, TestRunStatus } from "@codepilot/contracts";
import { RepositoryChecksSchema, TaskStatus } from "@codepilot/contracts";
import type { CommandProfile } from "@codepilot/agent-core";
import { CommandPolicyError, decideAfterChecks, describeCommand, summarizeOutput, validateRepositoryChecks } from "@codepilot/agent-core";
import type { SandboxLimits, SandboxResult, SandboxRunRequest } from "@codepilot/sandbox-runner";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { WorkspaceManager } from "../analysis/workspace";
import type { SourceDeps } from "../git/source";
import { checkoutForTask } from "../git/source";
import type { StageHandler } from "../pipeline";

/** The part of DockerSandbox the stage uses, so tests can substitute it. */
export interface SandboxRunner {
  ready(image: string): Promise<boolean>;
  run(request: SandboxRunRequest): Promise<SandboxResult>;
}

export interface ChecksStageDeps extends SourceDeps {
  prisma: PrismaClient;
  /** Null when Docker is not available to this worker. */
  sandbox: SandboxRunner | null;
  workspaces: WorkspaceManager;
  image: string;
  limits: SandboxLimits;
  /** Output kept from each command before summarizing. */
  maxOutputBytes: number;
  /** Characters of each command's output stored and shown to the model. */
  outputChars: number;
  /** Repairs allowed per approved plan before failing checks fail the task. */
  maxRepairs: number;
}

/** Checks that cannot run for a reason a maintainer can act on. Not retried. */
export class ChecksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChecksError";
  }
}

const FINISHED: ReadonlySet<TestRunStatus> = new Set(["PASSED", "FAILED", "ERRORED", "TIMED_OUT"]);

/**
 * RUNNING_CHECKS: rebuild the latest patch on a fresh checkout of the pinned
 * commit (verified against its stored tree), run the repository's configured
 * checks in the sandbox, store every result, and decide: ready for review,
 * repair, or fail. Never reports a check as passing that did not run.
 *
 * Safe to re-run after a crash: a patch whose checks already finished is not
 * checked again, and a verification left RUNNING is marked ERRORED.
 */
export function createChecksStage(deps: ChecksStageDeps): StageHandler {
  return async ({ taskId, signal }) => {
    const task = await deps.prisma.agentTask.findUniqueOrThrow({
      where: { id: taskId },
      include: {
        repository: { include: { installation: true, settings: true } },
        patches: { orderBy: { version: "desc" }, take: 1, include: { testRuns: { orderBy: { startedAt: "desc" } } } },
      },
    });
    const patch = task.patches[0];
    if (!patch) throw new ChecksError("The task has no patch to check");

    const finished = patch.testRuns.find((r) => FINISHED.has(r.status));
    if (finished) return decide(deps, taskId, patch, finished.status, finished.error);
    await deps.prisma.testRun.updateMany({
      where: { patchId: patch.id, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "ERRORED", error: "Interrupted before it finished", completedAt: new Date() },
    });

    const config = loadChecks(task.repository.settings, `${task.repository.owner}/${task.repository.name}`);
    if (!deps.sandbox) throw new ChecksError("The sandbox is not available to the worker (Docker is not configured)");
    const sandbox = deps.sandbox;
    if (!(await sandbox.ready(deps.image))) throw new ChecksError(`The sandbox image ${deps.image} is not available on the worker`);

    const testRun = await deps.prisma.testRun.create({
      data: { taskId, patchId: patch.id, runnerImage: deps.image, status: "RUNNING", startedAt: new Date() },
    });
    await deps.prisma.taskEvent.create({ data: { taskId, eventType: "checks_started", payload: { patchVersion: patch.version, testRunId: testRun.id } } });

    const workspace = await deps.workspaces.create(taskId);
    let outcome: { status: TestRunStatus; error: string | null };
    try {
      await checkoutForTask(deps, task.repository, workspace, {
        baseSha: patch.baseSha,
        signal,
        patch: { diff: patch.patchContent, treeSha: patch.treeSha },
      });
      const cacheDir = path.join(workspace.dir, "cache");
      await mkdir(cacheDir, { recursive: true });

      const steps: Array<{ profile: CommandProfile; kind: CheckResultSummary["kind"]; network: "none" | "bridge" }> = [
        ...(config.install ? [{ profile: config.install, kind: "install" as const, network: "bridge" as const }] : []),
        ...config.checks.map((c) => ({ profile: c, kind: c.kind, network: "none" as const })),
      ];
      outcome = { status: "PASSED", error: null };
      for (const [position, step] of steps.entries()) {
        const result = await sandbox.run({
          image: deps.image,
          workspaceDir: workspace.repoDir,
          cacheDir,
          executable: step.profile.executable,
          args: step.profile.args,
          timeoutMs: step.profile.timeoutMs,
          network: step.network,
          limits: deps.limits,
          maxOutputBytes: deps.maxOutputBytes,
          signal,
        });
        const summary = summarizeOutput(result.output, deps.outputChars);
        await deps.prisma.testResult.create({
          data: {
            testRunId: testRun.id,
            position,
            profileId: step.profile.id,
            kind: step.kind,
            command: describeCommand(step.profile),
            status: result.status,
            exitCode: result.exitCode,
            outputSummary: summary.text,
            outputTruncated: summary.truncated || result.outputTruncated,
            durationMs: result.durationMs,
          },
        });

        if (result.status === "PASSED") continue;
        if (result.limitExceeded) {
          outcome = { status: result.status, error: `${step.profile.id}: ${result.error}` };
          break;
        }
        if (result.status === "ERRORED") {
          outcome = { status: "ERRORED", error: `${step.profile.id}: ${result.error}` };
          break;
        }
        if (step.kind === "install") {
          outcome = { status: "ERRORED", error: `The install step failed with exit code ${result.exitCode}` };
          break;
        }
        // A failing check does not stop the others: the repair sees every failure at once.
        outcome = { status: "FAILED", error: null };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finishRun(deps.prisma, testRun.id, { status: "ERRORED", error: message.slice(0, 2_000) });
      throw err;
    } finally {
      await workspace.remove();
    }

    await finishRun(deps.prisma, testRun.id, outcome);
    return decide(deps, taskId, patch, outcome.status, outcome.error);
  };
}

function loadChecks(settings: { installCommand: Prisma.JsonValue; checks: Prisma.JsonValue } | null, fullName: string): RepositoryChecks {
  const raw = settings ? { install: settings.installCommand ?? null, checks: settings.checks } : null;
  const parsed = raw ? RepositoryChecksSchema.safeParse(raw) : null;
  if (!parsed?.success) {
    throw new ChecksError(`No checks are configured for ${fullName}; a maintainer can set them up on the repository's checks page`);
  }
  try {
    // Stored configurations are validated again before anything runs.
    return validateRepositoryChecks(parsed.data);
  } catch (err) {
    if (err instanceof CommandPolicyError) throw new ChecksError(`The checks configured for ${fullName} are not allowed: ${err.message}`);
    throw err;
  }
}

async function finishRun(prisma: PrismaClient, testRunId: string, outcome: { status: TestRunStatus; error: string | null }): Promise<void> {
  await prisma.testRun.update({ where: { id: testRunId }, data: { status: outcome.status, error: outcome.error, completedAt: new Date() } });
}

/**
 * Turns a finished verification into the next status. Passing checks verify
 * the patch; failing checks reject it and ask for a repair while the repair
 * budget lasts. A timeout is a safety boundary and fails the task. A run that
 * could not complete (sandbox, install, or configuration problem) fails the
 * task without judging the patch.
 */
async function decide(
  deps: ChecksStageDeps,
  taskId: string,
  patch: { id: string; version: number; planId: string },
  status: TestRunStatus,
  error: string | null,
): Promise<TaskStatus> {
  if (status === "ERRORED") {
    throw new ChecksError(`Checks could not complete for patch version ${patch.version}: ${error ?? "unknown error"}`);
  }
  const patchesForPlan = await deps.prisma.patch.count({ where: { taskId, planId: patch.planId } });
  const decision = decideAfterChecks(
    { passed: status === "PASSED", safetyViolation: status === "TIMED_OUT" ? (error ?? "a check timed out") : undefined },
    patchesForPlan - 1,
    deps.maxRepairs,
  );

  await deps.prisma.$transaction([
    deps.prisma.patch.update({ where: { id: patch.id }, data: { status: decision.action === "ready_for_review" ? "VERIFIED" : "REJECTED" } }),
    deps.prisma.taskEvent.create({
      data: { taskId, eventType: status === "PASSED" ? "checks_passed" : "checks_failed", payload: { patchVersion: patch.version, status } },
    }),
  ]);

  if (decision.action === "ready_for_review") return TaskStatus.READY_FOR_REVIEW;
  if (decision.action === "repair") return TaskStatus.REPAIRING;
  throw new ChecksError(decision.reason);
}
