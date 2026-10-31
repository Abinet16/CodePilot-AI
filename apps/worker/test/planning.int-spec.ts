import type { ContextPackage, TaskStatus } from "@codepilot/contracts";
import { MAX_PLAN_VERSIONS } from "@codepilot/contracts";
import type { Prisma } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { TransientError, runPipeline } from "../src/pipeline";
import type { StructuredModel } from "../src/model/structured-model";
import { ModelRefusalError } from "../src/model/structured-model";
import { createPlanStage } from "../src/planning/plan-stage";
import { RunRecorder } from "../src/runs";
import { TaskStateStore } from "../src/task-state";
import { ScriptedModel, answer, usage } from "./scripted-model";

const SHA = "d".repeat(40);

const analysis: ContextPackage = {
  repository: "acme/shop",
  branch: "main",
  commitSha: SHA,
  query: "Fix paginate",
  profile: {
    languages: { typescript: 2 },
    primaryLanguage: "typescript",
    supported: true,
    packageManager: "pnpm",
    typescript: true,
    frameworks: [],
    testFrameworks: ["Jest"],
    scripts: { test: "jest" },
    monorepo: false,
    instructionFiles: [],
    testFileCount: 1,
    directories: { src: 2 },
  },
  stats: { indexedFiles: 2, indexedBytes: 200, skipped: {}, truncated: false },
  snippets: [{ path: "src/pagination.ts", startLine: 1, endLine: 4, content: "export function paginate() {}", score: 10, reasons: ["path_mentioned"] }],
  relatedTests: ["src/pagination.test.ts"],
  budget: { maxChars: 48_000, usedChars: 30, droppedSnippets: 0 },
};

function planAnswer(affectedFiles = [{ path: "src/pagination.ts", change: "modify", reason: "Contains the bound" }]) {
  return {
    kind: "plan",
    reason: null,
    plan: {
      summary: "Include the last partial page",
      assumptions: [],
      affectedFiles,
      implementationSteps: ["Use Math.ceil for totalPages"],
      testPlan: ["Add a test for a partial last page"],
      risks: [],
    },
  };
}

/** Requires a migrated PostgreSQL at DATABASE_URL. */
describe("planning stage (PostgreSQL)", () => {
  const prisma = new PrismaClient();
  const states = new TaskStateStore(prisma);
  const runs = new RunRecorder(prisma);
  const suffix = Date.now() * 1000 + 700;
  let seq = 0;
  let userId: string;
  let repositoryId: string;

  async function createTask(extra: Partial<Prisma.AgentTaskUncheckedCreateInput> = {}) {
    return prisma.agentTask.create({
      data: {
        repositoryId,
        requestedById: userId,
        description: "Fix the off-by-one in paginate: the last partial page is dropped",
        status: "PLANNING",
        baseSha: SHA,
        analysis: analysis as unknown as Prisma.InputJsonObject,
        ...extra,
      },
    });
  }

  async function plan(taskId: string, model: StructuredModel | null, options: { budget?: number; canRetry?: boolean; signal?: AbortSignal } = {}) {
    const stage = createPlanStage({
      prisma,
      model,
      runs,
      maxAttempts: 2,
      taskTokenBudget: options.budget ?? 100_000,
      maxOutputTokens: 16_000,
      nonce: () => `nonce${++seq}abc`,
    });
    const status = await runPipeline(
      taskId,
      {
        stages: { PLANNING: stage },
        loadStatus: async (id) => (await prisma.agentTask.findUniqueOrThrow({ where: { id } })).status as TaskStatus,
        transition: (id, from, to) => states.transition(id, from, to),
        fail: (id, from, reason) => states.fail(id, from, reason),
        canRetry: options.canRetry,
      },
      options.signal ?? new AbortController().signal,
    );
    const task = await prisma.agentTask.findUniqueOrThrow({
      where: { id: taskId },
      include: {
        plans: { orderBy: { version: "asc" } },
        runs: { orderBy: { attemptNumber: "asc" } },
        usageRecords: true,
        events: { orderBy: { createdAt: "asc" } },
      },
    });
    return { status, task };
  }

  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { githubId: BigInt(suffix), githubLogin: `planner-${suffix}` } })).id;
    const installation = await prisma.githubInstallation.create({ data: { installationId: BigInt(suffix), accountLogin: "acme" } });
    const repository = await prisma.repository.create({
      data: { installationId: installation.id, githubRepoId: BigInt(suffix), owner: "acme", name: `shop-${suffix}`, defaultBranch: "main", enabled: true },
    });
    repositoryId = repository.id;
    await prisma.repositorySnapshot.create({
      data: {
        repositoryId,
        commitSha: SHA,
        profile: analysis.profile as unknown as Prisma.InputJsonObject,
        stats: analysis.stats as unknown as Prisma.InputJsonObject,
        paths: ["package.json", "src/pagination.ts", "src/pagination.test.ts"],
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("stores a validated plan as version 1 and waits for approval, with run and usage records", async () => {
    const created = await createTask();
    const model = new ScriptedModel([answer(planAnswer())]);
    const { status, task } = await plan(created.id, model);

    expect(status).toBe("AWAITING_PLAN_APPROVAL");
    expect(task.plans).toHaveLength(1);
    expect(task.plans[0]).toMatchObject({ version: 1, status: "PROPOSED", model: "claude-opus-5-5", runId: task.runs[0]!.id });
    expect(task.runs).toMatchObject([{ attemptNumber: 1, stage: "PLANNING", status: "SUCCEEDED" }]);
    expect(task.usageRecords).toHaveLength(1);
    expect(task.usageRecords[0]).toMatchObject({ provider: "anthropic", inputTokens: 3_000, outputTokens: 1_000, runId: task.runs[0]!.id });
    // 3k * $4/M + 1k * $20/M
    expect(Number(task.usageRecords[0]!.estimatedCost)).toBeCloseTo(0.032, 6);
    expect(task.events.map((e) => e.eventType)).toContain("plan_proposed");
    expect(model.prompts[0]).toContain("Fix the off-by-one in paginate");
  });

  it("feeds invalid paths back to the model and accepts the corrected plan", async () => {
    const created = await createTask();
    const model = new ScriptedModel([
      answer(planAnswer([{ path: "src/paging.ts", change: "modify", reason: "guess" }])),
      answer(planAnswer([{ path: "./src/pagination.ts", change: "modify", reason: "fixed" }])),
    ]);
    const { status, task } = await plan(created.id, model);

    expect(status).toBe("AWAITING_PLAN_APPROVAL");
    expect(task.runs.map((r) => r.status)).toEqual(["FAILED", "SUCCEEDED"]);
    expect(task.runs[0]!.error).toMatch(/src\/paging\.ts does not exist/);
    expect(model.prompts[1]).toContain("could not be accepted:\n- src/paging.ts does not exist");
    expect((task.plans[0]!.planJson as { affectedFiles: Array<{ path: string }> }).affectedFiles[0]!.path).toBe("src/pagination.ts");
    expect(task.usageRecords).toHaveLength(2);
    expect(task.events.filter((e) => e.eventType === "plan_invalid")).toHaveLength(1);
  });

  it("fails after the bounded attempts when output stays invalid", async () => {
    const created = await createTask();
    const bad = answer(planAnswer([{ path: ".env", change: "modify", reason: "leak" }]));
    const { status, task } = await plan(created.id, new ScriptedModel([bad, bad]));
    expect(status).toBe("FAILED");
    expect(task.failureReason).toMatch(/failed validation 2 times.*denied file/);
    expect(task.plans).toHaveLength(0);
  });

  it("fails clearly when the model declines the task", async () => {
    const created = await createTask();
    const { status, task } = await plan(created.id, new ScriptedModel([answer({ kind: "rejected", plan: null, reason: "Which page size is expected?" })]));
    expect(status).toBe("FAILED");
    expect(task.failureReason).toBe("The agent declined to plan this task: Which page size is expected?");
    expect(task.runs[0]!.status).toBe("SUCCEEDED");
  });

  it("records the billed usage of a refusal and does not retry it", async () => {
    const created = await createTask();
    const { status, task } = await plan(created.id, new ScriptedModel([new ModelRefusalError("cyber", "claude-opus-5-5", usage)]), { canRetry: true });
    expect(status).toBe("FAILED");
    expect(task.failureReason).toMatch(/declined to plan this task \(cyber\)/);
    expect(task.usageRecords).toHaveLength(1);
  });

  it("leaves the task in PLANNING for a queue retry on a transient provider error", async () => {
    const created = await createTask();
    await expect(plan(created.id, new ScriptedModel([new TransientError("rate limited")]), { canRetry: true })).rejects.toBeInstanceOf(TransientError);
    const task = await prisma.agentTask.findUniqueOrThrow({ where: { id: created.id }, include: { runs: true, usageRecords: true } });
    expect(task.status).toBe("PLANNING");
    expect(task.runs).toMatchObject([{ status: "FAILED", error: "rate limited" }]);
    expect(task.usageRecords).toHaveLength(0);

    // The retried job resumes planning and numbers its run after the failed one.
    const { status, task: after } = await plan(created.id, new ScriptedModel([answer(planAnswer())]));
    expect(status).toBe("AWAITING_PLAN_APPROVAL");
    expect(after.runs.map((r) => r.attemptNumber)).toEqual([1, 2]);
  });

  it("stops before calling the model once the token budget is spent", async () => {
    const created = await createTask();
    const model = new ScriptedModel([answer(planAnswer([{ path: "nope.ts", change: "modify", reason: "x" }]))]);
    const { status, task } = await plan(created.id, model, { budget: 5_000 });
    expect(status).toBe("FAILED");
    expect(task.failureReason).toBe("The task used its token budget of 5,000");
    expect(model.prompts).toHaveLength(1);
  });

  it("reuses a stored plan after a crash instead of calling the model again", async () => {
    const created = await createTask();
    await prisma.implementationPlan.create({
      data: { taskId: created.id, version: 1, planJson: planAnswer().plan as unknown as Prisma.InputJsonObject, model: "claude-opus-5-5" },
    });
    const model = new ScriptedModel([]);
    const { status } = await plan(created.id, model);
    expect(status).toBe("AWAITING_PLAN_APPROVAL");
    expect(model.prompts).toHaveLength(0);
  });

  it("revises a plan with the reviewer's feedback as the next version", async () => {
    const created = await createTask();
    await prisma.implementationPlan.create({
      data: {
        taskId: created.id,
        version: 1,
        planJson: planAnswer().plan as unknown as Prisma.InputJsonObject,
        model: "claude-opus-5-5",
        status: "CHANGES_REQUESTED",
        feedback: "Also cover an empty list in the tests",
      },
    });
    const model = new ScriptedModel([answer(planAnswer())]);
    const { status, task } = await plan(created.id, model);
    expect(status).toBe("AWAITING_PLAN_APPROVAL");
    expect(task.plans.map((p) => [p.version, p.status])).toEqual([
      [1, "CHANGES_REQUESTED"],
      [2, "PROPOSED"],
    ]);
    expect(model.prompts[0]).toContain("version 1 of your plan");
    expect(model.prompts[0]).toContain("Also cover an empty list in the tests");
  });

  it("refuses to revise past the version limit", async () => {
    const created = await createTask();
    for (let version = 1; version <= MAX_PLAN_VERSIONS; version++) {
      await prisma.implementationPlan.create({
        data: { taskId: created.id, version, planJson: planAnswer().plan as unknown as Prisma.InputJsonObject, model: "m", status: "CHANGES_REQUESTED", feedback: "more" },
      });
    }
    const { status, task } = await plan(created.id, new ScriptedModel([]));
    expect(status).toBe("FAILED");
    expect(task.failureReason).toMatch(/revised 3 times/);
  });

  it("approves its own plan when the task does not require review", async () => {
    const created = await createTask({ requirePlanApproval: false });
    const { status, task } = await plan(created.id, new ScriptedModel([answer(planAnswer())]));
    // Patch generation lands in week 5, so the pipeline fails at the next stage.
    expect(status).toBe("FAILED");
    expect(task.failureReason).toMatch(/No stage handler is implemented for GENERATING_PATCH/);
    expect(task.plans[0]).toMatchObject({ status: "APPROVED" });
    expect(task.plans[0]!.approvedAt).not.toBeNull();
    expect(task.events.map((e) => e.eventType)).toContain("plan_auto_approved");
  });

  it("marks the run cancelled and leaves the task alone when the job is aborted", async () => {
    const created = await createTask();
    const controller = new AbortController();
    const model = new ScriptedModel([
      (req) =>
        new Promise((_, reject) => {
          req.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          setTimeout(async () => {
            await prisma.agentTask.update({ where: { id: created.id }, data: { status: "CANCELLED" } });
            controller.abort();
          }, 10);
        }),
    ]);
    const { status, task } = await plan(created.id, model, { signal: controller.signal });
    expect(status).toBe("CANCELLED");
    expect(task.runs).toMatchObject([{ status: "CANCELLED" }]);
    expect(task.failureReason).toBeNull();
  });

  it("fails clearly when no model provider is configured", async () => {
    const created = await createTask();
    const { status, task } = await plan(created.id, null);
    expect(status).toBe("FAILED");
    expect(task.failureReason).toBe("No model provider is configured for the worker");
  });
});
