import { createHash, randomBytes } from "node:crypto";
import type { ImplementationPlan, PatchFileStat } from "@codepilot/contracts";
import { TaskStatus } from "@codepilot/contracts";
import type { FileChange, PatchLimits, PatchPromptInput } from "@codepilot/agent-core";
import { PATCH_OUTPUT_SCHEMA, PATCH_SYSTEM_PROMPT, buildPatchPrompt, checkDiffLimits, reviewPatch, toPatchOutcome } from "@codepilot/agent-core";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { WorkspaceManager } from "../analysis/workspace";
import { GitError } from "../git/git";
import type { CommitIdentity, LocalRepo } from "../git/patch-ops";
import { commitPaths, diffFromBase, resetTo } from "../git/patch-ops";
import type { SourceDeps } from "../git/source";
import type { StructuredModel } from "../model/structured-model";
import { ModelRefusalError } from "../model/structured-model";
import type { RunRecorder } from "../runs";
import { PatchError, writeChanges } from "./workspace-files";

export interface PatchStageDeps extends SourceDeps {
  prisma: PrismaClient;
  /** Null when no model provider is configured for this worker. */
  model: StructuredModel | null;
  runs: RunRecorder;
  workspaces: WorkspaceManager;
  /** Model calls per patch round; later calls get the earlier problems as feedback. */
  maxAttempts: number;
  /** Tokens (input and output) a task may spend in total. Checked before every call. */
  taskTokenBudget: number;
  maxOutputTokens: number;
  limits: PatchLimits;
  /** Author and committer of agent commits. */
  author: CommitIdentity;
  /** Overridable for tests. */
  nonce?: () => string;
}

/** Below this, a call could not produce a useful patch, so the budget counts as spent. */
const MIN_CALL_TOKENS = 4_000;

export interface PatchRound {
  taskId: string;
  stage: typeof TaskStatus.GENERATING_PATCH | typeof TaskStatus.REPAIRING;
  signal: AbortSignal;
  /** The approved plan, the contract every file in the cumulative diff is checked against. */
  plan: ImplementationPlan;
  planRow: { id: string; version: number };
  /** What this round's edits may touch: the plan itself, or planForRepair of it. */
  scope: ImplementationPlan;
  baseSha: string;
  branch: string;
  repo: LocalRepo;
  /** The commit each attempt starts from: the base, or the previous patch when repairing. */
  startSha: string;
  /** Current contents of the files in scope that exist. */
  originals: ReadonlyMap<string, string>;
  prompt: Omit<PatchPromptInput, "validationProblems" | "nonce">;
}

/**
 * Asks the model for a patch, validates it against the approved plan, commits
 * it, and stores the cumulative diff from the base as the next patch version.
 * Invalid answers go back to the model for a bounded number of attempts.
 */
export async function runPatchRound(deps: PatchStageDeps, round: PatchRound): Promise<void> {
  if (!deps.model) throw new PatchError("No model provider is configured for the worker");
  const model = deps.model;
  const nonce = deps.nonce ?? (() => randomBytes(8).toString("hex"));
  const { taskId, signal } = round;
  const declined = round.stage === TaskStatus.REPAIRING ? "repair the patch" : "implement the plan";

  let problems: string[] | undefined;
  for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
    const remaining = deps.taskTokenBudget - (await deps.runs.tokensUsed(taskId));
    if (remaining < MIN_CALL_TOKENS) throw new PatchError(`The task used its token budget of ${deps.taskTokenBudget.toLocaleString("en-US")}`);

    const prompt = buildPatchPrompt({ ...round.prompt, validationProblems: problems, nonce: nonce() });
    const run = await deps.runs.start(taskId, round.stage, model.model);

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
        throw new PatchError(`The model declined to ${declined}${err.category ? ` (${err.category})` : ""}`);
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
      throw new PatchError(`The agent declined to ${declined}: ${parsed.outcome.reason}`);
    } else {
      const proposal = parsed.outcome.patch;
      const reviewed = reviewPatch(proposal, round.scope, round.originals, deps.limits);
      if (!reviewed.ok) {
        problems = reviewed.problems;
      } else {
        const message = commitMessage(proposal.commitMessage, proposal.summary, taskId, round.planRow.version);
        const result = await commitAndCheck(round, reviewed.changes, message, deps);
        if (result.ok) {
          await deps.runs.finish(run.id, { status: "SUCCEEDED", ...billed });
          await savePatch(deps.prisma, {
            taskId,
            planId: round.planRow.id,
            runId: run.id,
            baseSha: round.baseSha,
            branchName: round.branch,
            model: response.model,
            summary: proposal.summary,
            commitMessage: proposal.commitMessage,
            ...result.committed,
          });
          return;
        }
        problems = result.problems;
      }
    }

    await deps.runs.finish(run.id, { status: "FAILED", error: `Invalid patch: ${problems.join(" ")}`, ...billed });
    await deps.prisma.taskEvent.create({ data: { taskId, eventType: "patch_invalid", payload: { attempt, runId: run.id, stage: round.stage, problems } } });
  }

  throw new PatchError(`The model's patch was rejected ${deps.maxAttempts} times: ${(problems ?? []).join(" ")}`);
}

interface Committed {
  commitSha: string;
  treeSha: string;
  diff: string;
  files: PatchFileStat[];
  unchangedPlanFiles: string[];
}

type CommitResult = { ok: true; committed: Committed } | { ok: false; problems: string[] };

/**
 * Writes and commits the validated changes, then checks the cumulative diff
 * from the base. A diff the model can fix (too large, binary) resets the
 * branch to where the round started and comes back as problems. A diff that
 * strays from the approved plan means something other than the patch changed
 * the tree, and fails the task.
 */
async function commitAndCheck(round: PatchRound, changes: readonly FileChange[], message: string, deps: PatchStageDeps): Promise<CommitResult> {
  const { repo, baseSha } = round;
  await writeChanges(repo.repoDir, changes);
  const { commitSha, treeSha } = await commitPaths(
    repo,
    changes.map((c) => c.path),
    message,
    deps.author,
  );
  const { diff, files, binary } = await diffFromBase(repo, baseSha);

  const planned = new Map(round.plan.affectedFiles.map((f) => [f.path, f.change]));
  const stray = files.filter((f) => planned.get(f.path) !== f.change);
  if (stray.length > 0) {
    throw new GitError(`The committed diff strays from the approved plan: ${stray.map((f) => `${f.change} ${f.path}`).join(", ")}`);
  }

  const problems = [...binary.map((p) => `${p}: git treats the result as binary; write plain text only.`), ...checkDiffLimits(files, Buffer.byteLength(diff), deps.limits)];
  if (problems.length > 0) {
    // The branch moves back to where this round started, so the next attempt begins clean.
    await resetTo(repo, round.startSha);
    return { ok: false, problems };
  }
  const changed = new Set(files.map((f) => f.path));
  const unchangedPlanFiles = round.plan.affectedFiles.map((f) => f.path).filter((p) => !changed.has(p));
  return { ok: true, committed: { commitSha, treeSha, diff, files, unchangedPlanFiles } };
}

/** Subject from the model, body from its summary, and trailers that tie the commit to the task. */
export function commitMessage(subject: string, summary: string, taskId: string, planVersion: number): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const body = summary.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  return `${subject}\n\n${body}\n\nCodePilot-Task: ${taskId}\nCodePilot-Plan: v${planVersion}\n`;
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
}

async function savePatch(prisma: PrismaClient, patch: NewPatch): Promise<void> {
  const { diff, files, ...rest } = patch;
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const diffHash = createHash("sha256").update(diff).digest("hex");

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
  } catch (err) {
    // Another worker stored this version first; its patch stands and the transition decides the winner.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
    throw err;
  }
}
