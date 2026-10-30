import { randomBytes } from "node:crypto";
import type { ImplementationPlan } from "@codepilot/contracts";
import { ContextPackageSchema, ImplementationPlanSchema, MAX_PLAN_VERSIONS, TaskStatus } from "@codepilot/contracts";
import type { PlanReview, PlanRevision } from "@codepilot/agent-core";
import { PLANNING_OUTPUT_SCHEMA, PLANNING_SYSTEM_PROMPT, buildPlanningPrompt, reviewPlanPaths, toPlanningOutcome } from "@codepilot/agent-core";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { StageHandler } from "../pipeline";
import type { RunRecorder } from "../runs";
import type { PlanModel } from "./plan-model";
import { ModelRefusalError } from "./plan-model";

export interface PlanStageDeps {
  prisma: PrismaClient;
  /** Null when no model provider is configured for this worker. */
  model: PlanModel | null;
  runs: RunRecorder;
  /** Model calls per planning round; later calls get the earlier validation problems as feedback. */
  maxAttempts: number;
  /** Tokens (input and output) a task may spend in total. Checked before every call. */
  taskTokenBudget: number;
  maxOutputTokens: number;
  /** Overridable for tests. */
  nonce?: () => string;
}

/** A task that cannot be planned for a reason the user can act on. Not retried. */
export class PlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningError";
  }
}

/** Below this, a call could not produce a useful plan, so the budget counts as spent. */
const MIN_CALL_TOKENS = 2_000;

/**
 * PLANNING: ask the model for a structured plan, validate it (schema, path
 * policy, the pinned commit's file list), and store it as the next plan
 * version. Invalid output is fed back for a bounded number of attempts.
 *
 * Safe to re-run after a crash: a plan stored for this round is reused
 * instead of calling the model again.
 */
export function createPlanStage(deps: PlanStageDeps): StageHandler {
  const nonce = deps.nonce ?? (() => randomBytes(8).toString("hex"));

  return async ({ taskId, signal }) => {
    const task = await deps.prisma.agentTask.findUniqueOrThrow({
      where: { id: taskId },
      include: { issue: true, plans: { orderBy: { version: "asc" } } },
    });
    const next = task.requirePlanApproval ? TaskStatus.AWAITING_PLAN_APPROVAL : TaskStatus.GENERATING_PATCH;

    const latest = task.plans.at(-1);
    if (latest && latest.status !== "CHANGES_REQUESTED") return next;

    if (!deps.model) throw new PlanningError("No model provider is configured for the worker");
    const model = deps.model;
    if (task.plans.length >= MAX_PLAN_VERSIONS) {
      throw new PlanningError(`The plan was revised ${task.plans.length} times, the limit for one task; start a new task with a refined description`);
    }

    const analysis = ContextPackageSchema.safeParse(task.analysis);
    if (!analysis.success) throw new PlanningError("The task has no usable repository analysis");
    const snapshot = await deps.prisma.repositorySnapshot.findUnique({
      where: { repositoryId_commitSha: { repositoryId: task.repositoryId, commitSha: analysis.data.commitSha } },
      select: { paths: true },
    });
    if (!snapshot) throw new PlanningError("The indexed snapshot of the pinned commit is no longer available; start a new task");
    const existingPaths = new Set(snapshot.paths);

    const revision = latest ? toRevision(latest) : undefined;
    const request = task.issue ? `${task.issue.title}\n\n${task.issue.body ?? ""}`.trim() : (task.description ?? "");
    const planningTask = { repository: analysis.data.repository, request, issueNumber: task.issue?.githubIssueNumber ?? null };

    let problems: string[] | undefined;
    for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
      const remaining = deps.taskTokenBudget - (await deps.runs.tokensUsed(taskId));
      if (remaining < MIN_CALL_TOKENS) throw new PlanningError(`The task used its token budget of ${deps.taskTokenBudget.toLocaleString("en-US")}`);

      const prompt = buildPlanningPrompt({ task: planningTask, analysis: analysis.data, revision, validationProblems: problems, nonce: nonce() });
      const run = await deps.runs.start(taskId, TaskStatus.PLANNING, model.model);

      let response;
      try {
        response = await model.generate({
          system: PLANNING_SYSTEM_PROMPT,
          prompt,
          schema: PLANNING_OUTPUT_SCHEMA,
          maxOutputTokens: Math.min(deps.maxOutputTokens, remaining),
          signal,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof ModelRefusalError) {
          await deps.runs.finish(run.id, { status: "FAILED", error: message, usage: err.usage, servedModel: err.model });
          throw new PlanningError(message);
        }
        await deps.runs.finish(run.id, { status: signal.aborted ? "CANCELLED" : "FAILED", error: message });
        throw err;
      }
      const billed = { usage: response.usage, servedModel: response.model };

      const parsed = response.output === null ? { ok: false as const, problems: [response.problem ?? "No answer."] } : toPlanningOutcome(response.output);
      let reviewed: PlanReview;
      if (!parsed.ok) {
        reviewed = parsed;
      } else if (parsed.outcome.kind === "rejected") {
        await deps.runs.finish(run.id, { status: "SUCCEEDED", ...billed });
        throw new PlanningError(`The agent declined to plan this task: ${parsed.outcome.reason}`);
      } else {
        reviewed = reviewPlanPaths(parsed.outcome.plan, existingPaths);
      }
      if (!reviewed.ok) {
        problems = reviewed.problems;
        await deps.runs.finish(run.id, { status: "FAILED", error: `Invalid plan: ${problems.join(" ")}`, ...billed });
        await deps.prisma.taskEvent.create({ data: { taskId, eventType: "plan_invalid", payload: { attempt, runId: run.id, problems } } });
        continue;
      }

      await deps.runs.finish(run.id, { status: "SUCCEEDED", ...billed });
      await savePlan(deps.prisma, taskId, (latest?.version ?? 0) + 1, reviewed.plan, run.id, response.model, !task.requirePlanApproval);
      return next;
    }

    throw new PlanningError(`The model's plan failed validation ${deps.maxAttempts} times: ${(problems ?? []).join(" ")}`);
  };
}

function toRevision(plan: { version: number; planJson: Prisma.JsonValue; feedback: string | null }): PlanRevision {
  const parsed = ImplementationPlanSchema.safeParse(plan.planJson);
  if (!parsed.success) throw new PlanningError(`Plan version ${plan.version} is malformed and cannot be revised`);
  return { version: plan.version, plan: parsed.data, feedback: plan.feedback ?? "" };
}

async function savePlan(
  prisma: PrismaClient,
  taskId: string,
  version: number,
  plan: ImplementationPlan,
  runId: string,
  model: string,
  autoApprove: boolean,
): Promise<void> {
  const now = new Date();
  try {
    await prisma.$transaction([
      prisma.implementationPlan.create({
        data: {
          taskId,
          version,
          planJson: plan as unknown as Prisma.InputJsonObject,
          runId,
          model,
          ...(autoApprove ? { status: "APPROVED" as const, approvedAt: now } : {}),
        },
      }),
      prisma.taskEvent.create({
        data: { taskId, eventType: "plan_proposed", payload: { version, runId, affectedFiles: plan.affectedFiles.length } },
      }),
      ...(autoApprove ? [prisma.taskEvent.create({ data: { taskId, eventType: "plan_auto_approved", payload: { version } } })] : []),
    ]);
  } catch (err) {
    // Another worker stored this version first; its plan stands and the transition decides the winner.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
    throw err;
  }
}
