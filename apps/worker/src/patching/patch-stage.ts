import { ContextPackageSchema, ImplementationPlanSchema, TaskStatus } from "@codepilot/contracts";
import { assertTaskBranch, taskBranchName } from "@codepilot/agent-core";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { checkoutForTask } from "../git/source";
import type { StageHandler } from "../pipeline";
import type { PatchStageDeps } from "./patch-round";
import { runPatchRound } from "./patch-round";
import { PatchError, readPlannedFiles } from "./workspace-files";

export type { PatchStageDeps } from "./patch-round";

/**
 * GENERATING_PATCH: check out the pinned commit in a fresh workspace, ask the
 * model to implement the approved plan, and accept the answer only if every
 * file is in the plan, every edit applies, and the committed diff is within
 * the limits. The result is a commit on the task branch and a stored,
 * versioned patch. Invalid answers are fed back for a bounded number of attempts.
 *
 * Safe to re-run after a crash: a patch already stored for the approved plan
 * is reused, and the workspace is always rebuilt from the pinned commit.
 */
export function createPatchStage(deps: PatchStageDeps): StageHandler {
  return async ({ taskId, signal }) => {
    const task = await deps.prisma.agentTask.findUniqueOrThrow({
      where: { id: taskId },
      include: {
        repository: { include: { installation: true } },
        issue: true,
        plans: { where: { status: "APPROVED" }, orderBy: { version: "desc" }, take: 1 },
        patches: { orderBy: { version: "desc" }, select: { version: true, planId: true } },
      },
    });

    const approved = task.plans[0];
    if (!approved) throw new PatchError("The task has no approved plan to implement");
    if (task.patches.some((p) => p.planId === approved.id)) return TaskStatus.RUNNING_CHECKS;

    if (!deps.model) throw new PatchError("No model provider is configured for the worker");
    const parsedPlan = ImplementationPlanSchema.safeParse(approved.planJson);
    if (!parsedPlan.success) throw new PatchError(`Approved plan version ${approved.version} is malformed`);
    const plan = parsedPlan.data;
    const analysis = ContextPackageSchema.safeParse(task.analysis);
    if (!analysis.success || !task.baseSha) throw new PatchError("The task has no pinned commit and repository analysis");
    const baseSha = task.baseSha;

    const { repository } = task;
    const title = task.issue ? `${task.issue.githubIssueNumber} ${task.issue.title}` : (task.description ?? "").split("\n")[0]!;
    const branch = task.branchName ?? (await reserveBranch(deps.prisma, taskId, taskBranchName(taskId, title)));
    assertTaskBranch(branch, [repository.defaultBranch, analysis.data.branch]);

    const workspace = await deps.workspaces.create(taskId);
    try {
      const { repo } = await checkoutForTask(deps, repository, workspace, { baseSha, branch, signal });
      const originals = await readPlannedFiles(repo, plan, deps.limits.maxFileBytes);
      const request = task.issue ? `${task.issue.title}\n\n${task.issue.body ?? ""}`.trim() : (task.description ?? "");

      await runPatchRound(deps, {
        taskId,
        stage: TaskStatus.GENERATING_PATCH,
        signal,
        plan,
        planRow: approved,
        scope: plan,
        baseSha,
        branch,
        repo,
        startSha: baseSha,
        originals,
        prompt: {
          task: { repository: analysis.data.repository, request, issueNumber: task.issue?.githubIssueNumber ?? null },
          analysis: analysis.data,
          plan,
          planVersion: approved.version,
          files: [...originals].map(([p, content]) => ({ path: p, content })),
        },
      });
      return TaskStatus.RUNNING_CHECKS;
    } finally {
      await workspace.remove();
    }
  };
}

/** Records the task branch exactly once. If another worker reserved first, its name wins. */
async function reserveBranch(prisma: PrismaClient, taskId: string, name: string): Promise<string> {
  try {
    const reserved = await prisma.$transaction(async (tx) => {
      const { count } = await tx.agentTask.updateMany({
        where: { id: taskId, status: TaskStatus.GENERATING_PATCH, branchName: null },
        data: { branchName: name },
      });
      if (count === 1) await tx.taskEvent.create({ data: { taskId, eventType: "branch_reserved", payload: { branch: name } } });
      return (await tx.agentTask.findUniqueOrThrow({ where: { id: taskId }, select: { branchName: true } })).branchName;
    });
    if (!reserved) throw new PatchError("Task left GENERATING_PATCH before its branch could be reserved");
    return reserved;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new PatchError(`Another task in this repository already uses the branch ${name}`);
    }
    throw err;
  }
}
