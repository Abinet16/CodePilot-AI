import { createHash, randomBytes } from "node:crypto";
import type { PatchFileStat } from "@codepilot/contracts";
import { ContextPackageSchema, ImplementationPlanSchema, TaskStatus } from "@codepilot/contracts";
import type { FileChange, PatchLimits } from "@codepilot/agent-core";
import {
  PATCH_OUTPUT_SCHEMA,
  PATCH_SYSTEM_PROMPT,
  assertTaskBranch,
  buildPatchPrompt,
  checkDiffLimits,
  reviewPatch,
  taskBranchName,
  toPatchOutcome,
} from "@codepilot/agent-core";
import type { InstallationGitHub } from "@codepilot/github";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { WorkspaceManager } from "../analysis/workspace";
import { GitError, fetchCommit, githubRemoteUrl } from "../git/git";
import type { CommitIdentity, LocalRepo } from "../git/patch-ops";
import { commitPaths, createBranch, diffFromBase, resetTo } from "../git/patch-ops";
import type { StructuredModel } from "../model/structured-model";
import { ModelRefusalError } from "../model/structured-model";
import type { StageHandler } from "../pipeline";
import type { RunRecorder } from "../runs";
import { PatchError, readPlannedFiles, writeChanges } from "./workspace-files";

export interface PatchStageDeps {
  prisma: PrismaClient;
  /** Null when no model provider is configured for this worker. */
  model: StructuredModel | null;
  runs: RunRecorder;
  workspaces: WorkspaceManager;
  /** Null when the GitHub App is not configured for this worker. */
  github: InstallationGitHub | null;
  /** Model calls per patch round; later calls get the earlier problems as feedback. */
  maxAttempts: number;
  /** Tokens (input and output) a task may spend in total. Checked before every call. */
  taskTokenBudget: number;
  maxOutputTokens: number;
  gitTimeoutMs: number;
  limits: PatchLimits;
  /** Author and committer of agent commits. */
  author: CommitIdentity;
  /** Overrides the clone URL; tests point this at a local fixture repository. */
  remoteUrl?: (owner: string, name: string) => string;
  /** Overridable for tests. */
  nonce?: () => string;
}

/** Below this, a call could not produce a useful patch, so the budget counts as spent. */
const MIN_CALL_TOKENS = 4_000;

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
  const nonce = deps.nonce ?? (() => randomBytes(8).toString("hex"));

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
    const model = deps.model;
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

    const remoteUrl = (deps.remoteUrl ?? githubRemoteUrl)(repository.owner, repository.name);
    const fromGitHub = remoteUrl.startsWith("https://github.com/");
    if (fromGitHub && !deps.github) throw new PatchError("The GitHub App is not configured for the worker");

    const workspace = await deps.workspaces.create(taskId);
    try {
      await fetchCommit({
        repoDir: workspace.repoDir,
        homeDir: workspace.homeDir,
        remoteUrl,
        commitSha: baseSha,
        token: fromGitHub ? await deps.github!.getInstallationToken(repository.installation.installationId) : null,
        timeoutMs: deps.gitTimeoutMs,
        signal,
        allowFileProtocol: remoteUrl.startsWith("file://"),
      });
      const repo: LocalRepo = { repoDir: workspace.repoDir, homeDir: workspace.homeDir, timeoutMs: deps.gitTimeoutMs, signal };
      await createBranch(repo, branch);
      const originals = await readPlannedFiles(repo, plan, deps.limits.maxFileBytes);

      const request = task.issue ? `${task.issue.title}\n\n${task.issue.body ?? ""}`.trim() : (task.description ?? "");
      const promptBase = {
        task: { repository: analysis.data.repository, request, issueNumber: task.issue?.githubIssueNumber ?? null },
        analysis: analysis.data,
        plan,
        planVersion: approved.version,
        files: [...originals].map(([p, content]) => ({ path: p, content })),
      };

      let problems: string[] | undefined;
      for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
        const remaining = deps.taskTokenBudget - (await deps.runs.tokensUsed(taskId));
        if (remaining < MIN_CALL_TOKENS) throw new PatchError(`The task used its token budget of ${deps.taskTokenBudget.toLocaleString("en-US")}`);

        const prompt = buildPatchPrompt({ ...promptBase, validationProblems: problems, nonce: nonce() });
        const run = await deps.runs.start(taskId, TaskStatus.GENERATING_PATCH, model.model);

        let response;
        try {
          response = await model.generate({
            system: PATCH_SYSTEM_PROMPT,
            prompt,
            schema: PATCH_OUTPUT_SCHEMA,
            maxOutputTokens: Math.min(deps.maxOutputTokens, remaining),
            signal,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof ModelRefusalError) {
            await deps.runs.finish(run.id, { status: "FAILED", error: message, usage: err.usage, servedModel: err.model });
            throw new PatchError(`The model declined to implement the plan${err.category ? ` (${err.category})` : ""}`);
          }
          await deps.runs.finish(run.id, { status: signal.aborted ? "CANCELLED" : "FAILED", error: message });
          throw err;
        }
        const billed = { usage: response.usage, servedModel: response.model };

        const parsed = response.output === null ? { ok: false as const, problems: [response.problem ?? "No answer."] } : toPatchOutcome(response.output);
        if (!parsed.ok) {
          problems = parsed.problems;
        } else if (parsed.outcome.kind === "rejected") {
          await deps.runs.finish(run.id, { status: "SUCCEEDED", ...billed });
          throw new PatchError(`The agent declined to implement the plan: ${parsed.outcome.reason}`);
        } else {
          const proposal = parsed.outcome.patch;
          const reviewed = reviewPatch(proposal, plan, originals, deps.limits);
          if (!reviewed.ok) {
            problems = reviewed.problems;
          } else {
            const message = commitMessage(proposal.commitMessage, proposal.summary, taskId, approved.version);
            const result = await commitAndCheck(repo, baseSha, reviewed.changes, message, deps);
            if (result.ok) {
              await deps.runs.finish(run.id, { status: "SUCCEEDED", ...billed });
              await savePatch(deps.prisma, {
                taskId,
                planId: approved.id,
                runId: run.id,
                baseSha,
                branchName: branch,
                model: response.model,
                summary: proposal.summary,
                commitMessage: proposal.commitMessage,
                unchangedPlanFiles: reviewed.unchangedPlanFiles,
                ...result.committed,
              });
              return TaskStatus.RUNNING_CHECKS;
            }
            problems = result.problems;
          }
        }

        await deps.runs.finish(run.id, { status: "FAILED", error: `Invalid patch: ${problems.join(" ")}`, ...billed });
        await deps.prisma.taskEvent.create({ data: { taskId, eventType: "patch_invalid", payload: { attempt, runId: run.id, problems } } });
      }

      throw new PatchError(`The model's patch was rejected ${deps.maxAttempts} times: ${(problems ?? []).join(" ")}`);
    } finally {
      await workspace.remove();
    }
  };
}

interface Committed {
  commitSha: string;
  treeSha: string;
  diff: string;
  files: PatchFileStat[];
}

type CommitResult = { ok: true; committed: Committed } | { ok: false; problems: string[] };

/**
 * Writes and commits the validated changes, then checks the committed diff.
 * A diff the model can fix (too large, binary) resets the workspace to the
 * base and comes back as problems; a diff that disagrees with the validated
 * change set means something other than the patch changed, and fails the task.
 */
async function commitAndCheck(
  repo: LocalRepo,
  baseSha: string,
  changes: readonly FileChange[],
  message: string,
  deps: PatchStageDeps,
): Promise<CommitResult> {
  await writeChanges(repo.repoDir, changes);
  const { commitSha, treeSha } = await commitPaths(
    repo,
    changes.map((c) => c.path),
    message,
    deps.author,
  );
  const { diff, files, binary } = await diffFromBase(repo, baseSha);

  const expected = new Map(changes.map((c) => [c.path, c.change]));
  const unexpected = files.filter((f) => expected.get(f.path) !== f.change);
  if (unexpected.length > 0 || files.length > expected.size) {
    throw new GitError(`The committed diff does not match the validated patch: ${unexpected.map((f) => `${f.change} ${f.path}`).join(", ")}`);
  }

  const problems = [...binary.map((p) => `${p}: git treats the result as binary; write plain text only.`), ...checkDiffLimits(files, Buffer.byteLength(diff), deps.limits)];
  if (problems.length > 0) {
    // The branch moves back to the base, so the next attempt starts from a clean checkout.
    await resetTo(repo, baseSha);
    return { ok: false, problems };
  }
  return { ok: true, committed: { commitSha, treeSha, diff, files } };
}

/** Subject from the model, body from its summary, and trailers that tie the commit to the task. */
export function commitMessage(subject: string, summary: string, taskId: string, planVersion: number): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const body = summary.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  return `${subject}\n\n${body}\n\nCodePilot-Task: ${taskId}\nCodePilot-Plan: v${planVersion}\n`;
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

interface NewPatch extends Committed {
  taskId: string;
  planId: string;
  runId: string;
  baseSha: string;
  branchName: string;
  model: string;
  summary: string;
  commitMessage: string;
  unchangedPlanFiles: string[];
}

async function savePatch(prisma: PrismaClient, patch: NewPatch): Promise<void> {
  const { diff, files, ...rest } = patch;
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const diffHash = createHash("sha256").update(diff).digest("hex");

  for (let tries = 0; ; tries++) {
    const last = await prisma.patch.findFirst({ where: { taskId: patch.taskId }, orderBy: { version: "desc" }, select: { version: true } });
    const version = (last?.version ?? 0) + 1;
    try {
      await prisma.$transaction([
        prisma.patch.create({
          data: { ...rest, version, patchContent: diff, diffHash, files: files as unknown as Prisma.InputJsonArray, additions, deletions },
        }),
        prisma.taskEvent.create({
          data: {
            taskId: patch.taskId,
            eventType: "patch_created",
            payload: { version, commitSha: patch.commitSha, branch: patch.branchName, files: files.length, additions, deletions },
          },
        }),
      ]);
      return;
    } catch (err) {
      // Another worker stored a version first. If it implements the same plan, its patch stands.
      const conflict = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
      if (!conflict || tries >= 3) throw err;
      if (await prisma.patch.findFirst({ where: { taskId: patch.taskId, planId: patch.planId } })) return;
    }
  }
}
