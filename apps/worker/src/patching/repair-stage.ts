import { ContextPackageSchema, ImplementationPlanSchema, TaskStatus } from "@codepilot/contracts";
import { planForRepair } from "@codepilot/agent-core";
import { trackedModes } from "../git/patch-ops";
import { checkoutForTask } from "../git/source";
import type { StageHandler } from "../pipeline";
import type { PatchStageDeps } from "./patch-round";
import { commitMessage, runPatchRound } from "./patch-round";
import { PatchError, readPlannedFiles } from "./workspace-files";

export interface RepairStageDeps extends PatchStageDeps {
  /** Repairs allowed per approved plan; the checks stage enforces it, this is a backstop. */
  maxRepairs: number;
}

/**
 * REPAIRING: rebuild the rejected patch on the task branch, show the model the
 * failing check output and the patched files, and store its fix as the next
 * patch version. The fix is held to the same approved plan, and the stored
 * diff is always cumulative from the base, so checks rebuild it the same way.
 *
 * Safe to re-run after a crash: once a newer patch exists, the repair is done.
 */
export function createRepairStage(deps: RepairStageDeps): StageHandler {
  return async ({ taskId, signal }) => {
    const task = await deps.prisma.agentTask.findUniqueOrThrow({
      where: { id: taskId },
      include: {
        repository: { include: { installation: true } },
        issue: true,
        patches: {
          orderBy: { version: "desc" },
          take: 1,
          include: {
            plan: true,
            testRuns: { where: { status: "FAILED" }, orderBy: { startedAt: "desc" }, take: 1, include: { results: { orderBy: { position: "asc" } } } },
          },
        },
      },
    });

    const rejected = task.patches[0];
    if (!rejected) throw new PatchError("The task has no patch to repair");
    if (rejected.status !== "REJECTED") return TaskStatus.RUNNING_CHECKS;
    const failedRun = rejected.testRuns[0];
    if (!failedRun) throw new PatchError(`Patch version ${rejected.version} has no failed checks to repair`);

    const repairsSoFar = (await deps.prisma.patch.count({ where: { taskId, planId: rejected.planId } })) - 1;
    if (repairsSoFar >= deps.maxRepairs) throw new PatchError(`Checks still failing after ${repairsSoFar} repair attempt(s)`);
    if (!deps.model) throw new PatchError("No model provider is configured for the worker");

    const parsedPlan = ImplementationPlanSchema.safeParse(rejected.plan.planJson);
    if (!parsedPlan.success) throw new PatchError(`Approved plan version ${rejected.plan.version} is malformed`);
    const plan = parsedPlan.data;
    const analysis = ContextPackageSchema.safeParse(task.analysis);
    if (!analysis.success) throw new PatchError("The task has no repository analysis");

    const workspace = await deps.workspaces.create(taskId);
    try {
      const { repo, headSha } = await checkoutForTask(deps, task.repository, workspace, {
        baseSha: rejected.baseSha,
        branch: rejected.branchName,
        signal,
        patch: {
          diff: rejected.patchContent,
          treeSha: rejected.treeSha,
          commit: { message: commitMessage(rejected.commitMessage, rejected.summary, taskId, rejected.plan.version), identity: deps.author },
        },
      });

      const existing = await trackedModes(
        repo,
        plan.affectedFiles.map((f) => f.path),
      );
      const scope = planForRepair(plan, new Set(existing.keys()));
      const originals = await readPlannedFiles(repo, scope, deps.limits.maxFileBytes);
      const request = task.issue ? `${task.issue.title}\n\n${task.issue.body ?? ""}`.trim() : (task.description ?? "");

      await runPatchRound(deps, {
        taskId,
        stage: TaskStatus.REPAIRING,
        signal,
        plan,
        planRow: rejected.plan,
        scope,
        baseSha: rejected.baseSha,
        branch: rejected.branchName,
        repo,
        startSha: headSha,
        originals,
        prompt: {
          task: { repository: analysis.data.repository, request, issueNumber: task.issue?.githubIssueNumber ?? null },
          analysis: analysis.data,
          plan: scope,
          planVersion: rejected.plan.version,
          files: [...originals].map(([p, content]) => ({ path: p, content })),
          repair: {
            patchVersion: rejected.version,
            attempt: repairsSoFar + 1,
            maxAttempts: deps.maxRepairs,
            failures: failedRun.results
              .filter((r) => r.status !== "PASSED")
              .map((r) => ({ profileId: r.profileId, command: r.command, status: r.status, exitCode: r.exitCode, output: r.outputSummary })),
          },
        },
      });
      return TaskStatus.RUNNING_CHECKS;
    } finally {
      await workspace.remove();
    }
  };
}
