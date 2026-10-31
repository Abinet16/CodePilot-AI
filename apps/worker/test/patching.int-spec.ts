import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContextPackage, ImplementationPlan, TaskStatus } from "@codepilot/contracts";
import { DEFAULT_PATCH_LIMITS } from "@codepilot/agent-core";
import type { Prisma } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { WorkspaceManager } from "../src/analysis/workspace";
import { fetchCommit } from "../src/git/git";
import { applyDiff } from "../src/git/patch-ops";
import type { StructuredModel } from "../src/model/structured-model";
import { createPatchStage } from "../src/patching/patch-stage";
import { runPipeline } from "../src/pipeline";
import { RunRecorder } from "../src/runs";
import { TaskStateStore } from "../src/task-state";
import { createFixtureRepo } from "./git-fixture";
import { ScriptedModel, answer } from "./scripted-model";

const fixture = createFixtureRepo({
  "package.json": '{ "name": "shop" }\n',
  "src/pagination.ts": "export function totalPages(total: number, size: number) {\n  return Math.floor(total / size);\n}\n",
  "src/legacy.ts": "export const unused = true;\n",
  "src/link.ts": { symlink: "pagination.ts" },
});

const analysis: ContextPackage = {
  repository: "acme/shop",
  branch: "main",
  commitSha: fixture.commitSha,
  query: "Fix totalPages",
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
    testFileCount: 0,
    directories: { src: 2 },
  },
  stats: { indexedFiles: 2, indexedBytes: 200, skipped: {}, truncated: false },
  snippets: [{ path: "src/pagination.ts", startLine: 1, endLine: 3, content: "export function totalPages", score: 10, reasons: ["path_mentioned"] }],
  relatedTests: [],
  budget: { maxChars: 48_000, usedChars: 30, droppedSnippets: 0 },
};

const approvedPlan: ImplementationPlan = {
  summary: "Count the last partial page",
  assumptions: [],
  affectedFiles: [
    { path: "src/pagination.ts", change: "modify", reason: "Holds the bug" },
    { path: "src/pagination.test.ts", change: "create", reason: "Regression test" },
    { path: "src/legacy.ts", change: "delete", reason: "Unused" },
  ],
  implementationSteps: ["Use Math.ceil", "Add a test"],
  testPlan: ["Run the new test"],
  risks: [],
};

const fixEdit = { find: "Math.floor(total / size)", replace: "Math.ceil(total / size)" };

function patchAnswer(files: unknown[], commitMessage = "Count the last partial page in totalPages") {
  return { kind: "patch", reason: null, patch: { summary: "Use Math.ceil so a partial last page counts.", commitMessage, files } };
}

const modify = (edits = [fixEdit], filePath = "src/pagination.ts") => ({ path: filePath, change: "modify", edits, content: null });
const create = (content = "test('partial page', () => {});\n") => ({ path: "src/pagination.test.ts", change: "create", edits: null, content });
const remove = () => ({ path: "src/legacy.ts", change: "delete", edits: null, content: null });

/** Requires a migrated PostgreSQL at DATABASE_URL. */
describe("patch stage (PostgreSQL, git)", () => {
  const prisma = new PrismaClient();
  const states = new TaskStateStore(prisma);
  const runs = new RunRecorder(prisma);
  const root = mkdtempSync(path.join(tmpdir(), "codepilot-patch-ws-"));
  const workspaces = new WorkspaceManager(root);
  const suffix = Date.now() * 1000 + 800;
  let seq = 0;
  let userId: string;
  let repositoryId: string;

  async function createTask(plan: ImplementationPlan | null = approvedPlan, extra: Partial<Prisma.AgentTaskUncheckedCreateInput> = {}) {
    const task = await prisma.agentTask.create({
      data: {
        repositoryId,
        requestedById: userId,
        description: "Fix totalPages: the last partial page is dropped",
        status: "GENERATING_PATCH",
        baseSha: fixture.commitSha,
        analysis: analysis as unknown as Prisma.InputJsonObject,
        ...extra,
      },
    });
    if (plan) {
      await prisma.implementationPlan.create({
        data: { taskId: task.id, version: 1, planJson: plan as unknown as Prisma.InputJsonObject, model: "claude-opus-5-5", status: "APPROVED", approvedAt: new Date() },
      });
    }
    return task;
  }

  function stage(model: StructuredModel | null, options: { budget?: number; limits?: typeof DEFAULT_PATCH_LIMITS } = {}) {
    return createPatchStage({
      prisma,
      model,
      runs,
      workspaces,
      github: null,
      maxAttempts: 2,
      taskTokenBudget: options.budget ?? 100_000,
      maxOutputTokens: 32_000,
      gitTimeoutMs: 30_000,
      limits: options.limits ?? DEFAULT_PATCH_LIMITS,
      author: { name: "CodePilot AI", email: "codepilot@invalid" },
      remoteUrl: () => fixture.url,
      nonce: () => `nonce${++seq}abc`,
    });
  }

  function load(taskId: string) {
    return prisma.agentTask.findUniqueOrThrow({
      where: { id: taskId },
      include: { patches: { orderBy: { version: "asc" } }, runs: { orderBy: { attemptNumber: "asc" } }, events: { orderBy: { createdAt: "asc" } } },
    });
  }

  const signal = () => new AbortController().signal;

  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { githubId: BigInt(suffix), githubLogin: `patcher-${suffix}` } })).id;
    const installation = await prisma.githubInstallation.create({ data: { installationId: BigInt(suffix), accountLogin: "acme" } });
    const repository = await prisma.repository.create({
      data: { installationId: installation.id, githubRepoId: BigInt(suffix), owner: "acme", name: `shop-${suffix}`, defaultBranch: "main", enabled: true },
    });
    repositoryId = repository.id;
  });

  afterEach(() => {
    // Every run removes its workspace, whether it succeeded or not.
    expect(readdirSync(root)).toEqual([]);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(root, { recursive: true, force: true });
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("commits the approved plan on a task branch and stores the patch as version 1", async () => {
    const task = await createTask();
    const model = new ScriptedModel([answer(patchAnswer([modify(), create(), remove()]))]);
    expect(await stage(model)({ taskId: task.id, signal: signal() })).toBe("RUNNING_CHECKS");

    const stored = await load(task.id);
    expect(stored.branchName).toBe(`codepilot/fix-totalpages-the-last-partial-page-is-dropped-${task.id.slice(0, 8)}`);
    expect(stored.patches).toHaveLength(1);
    const patch = stored.patches[0]!;
    expect(patch).toMatchObject({
      version: 1,
      status: "PROPOSED",
      baseSha: fixture.commitSha,
      branchName: stored.branchName,
      runId: stored.runs[0]!.id,
      commitMessage: "Count the last partial page in totalPages",
      additions: 2,
      deletions: 2,
      unchangedPlanFiles: [],
    });
    expect(patch.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(patch.files).toEqual([
      { path: "src/legacy.ts", change: "delete", additions: 0, deletions: 1 },
      { path: "src/pagination.test.ts", change: "create", additions: 1, deletions: 0 },
      { path: "src/pagination.ts", change: "modify", additions: 1, deletions: 1 },
    ]);
    expect(patch.patchContent).toContain("+  return Math.ceil(total / size);");
    expect(stored.runs).toMatchObject([{ stage: "GENERATING_PATCH", status: "SUCCEEDED" }]);
    expect(stored.events.map((e) => e.eventType)).toEqual(expect.arrayContaining(["branch_reserved", "patch_created"]));

    // The prompt fenced the file contents and carried the approved plan.
    expect(model.prompts[0]).toMatch(/<untrusted-nonce\d+abc source="src\/pagination.ts">\nexport function totalPages/);
    expect(model.prompts[0]).toContain("The approved implementation plan (version 1)");

    // The stored diff rebuilds exactly the committed tree from a fresh checkout of the base.
    const work = mkdtempSync(path.join(tmpdir(), "codepilot-rebuild-"));
    const repoDir = path.join(work, "repo");
    await fetchCommit({ repoDir, homeDir: work, remoteUrl: fixture.url, commitSha: fixture.commitSha, token: null, timeoutMs: 30_000, allowFileProtocol: true });
    writeFileSync(path.join(work, "patch.diff"), patch.patchContent);
    expect(await applyDiff({ repoDir, homeDir: work, timeoutMs: 30_000 }, path.join(work, "patch.diff"))).toBe(patch.treeSha);
    rmSync(work, { recursive: true, force: true });
  });

  it("records planned files the patch left alone", async () => {
    const task = await createTask();
    await stage(new ScriptedModel([answer(patchAnswer([modify()]))]))({ taskId: task.id, signal: signal() });
    const { patches } = await load(task.id);
    expect(patches[0]!.unchangedPlanFiles).toEqual(["src/pagination.test.ts", "src/legacy.ts"]);
  });

  it("feeds files outside the plan back to the model and accepts the corrected patch", async () => {
    const task = await createTask();
    const outside = { path: "src/other.ts", change: "create", edits: null, content: "export {};\n" };
    const model = new ScriptedModel([answer(patchAnswer([modify(), outside])), answer(patchAnswer([modify()]))]);
    expect(await stage(model)({ taskId: task.id, signal: signal() })).toBe("RUNNING_CHECKS");

    const stored = await load(task.id);
    expect(stored.runs.map((r) => r.status)).toEqual(["FAILED", "SUCCEEDED"]);
    expect(stored.runs[0]!.error).toMatch(/src\/other\.ts is not in the approved plan/);
    expect(model.prompts[1]).toContain("could not be applied:\n- src/other.ts is not in the approved plan");
    expect(stored.events.filter((e) => e.eventType === "patch_invalid")).toHaveLength(1);
    expect(stored.patches).toHaveLength(1);
  });

  it("fails after the bounded attempts when edits never apply", async () => {
    const task = await createTask();
    const bad = answer(patchAnswer([modify([{ find: "Math.round", replace: "Math.ceil" }])]));
    await expect(stage(new ScriptedModel([bad, bad]))({ taskId: task.id, signal: signal() })).rejects.toThrow(
      /rejected 2 times: src\/pagination\.ts edit 1: the find text does not occur/,
    );
    expect((await load(task.id)).patches).toHaveLength(0);
  });

  it("sends an oversized diff back and starts the next attempt from a clean checkout", async () => {
    const task = await createTask();
    const huge = create(Array.from({ length: 50 }, (_, i) => `test('case ${i}', () => {});`).join("\n") + "\n");
    const model = new ScriptedModel([answer(patchAnswer([modify(), huge])), answer(patchAnswer([modify()]))]);
    await stage(model, { limits: { ...DEFAULT_PATCH_LIMITS, maxChangedLines: 10 } })({ taskId: task.id, signal: signal() });

    const { patches } = await load(task.id);
    expect(model.prompts[1]).toMatch(/changes 52 lines, more than the 10 allowed/);
    // The second commit sits directly on the base: nothing from the first attempt survived.
    expect(patches[0]!.files).toEqual([{ path: "src/pagination.ts", change: "modify", additions: 1, deletions: 1 }]);
  });

  it("fails clearly when the model declines to implement the plan", async () => {
    const task = await createTask();
    const declined = answer({ kind: "rejected", reason: "src/pagination.ts has no paging bound to change", patch: null });
    await expect(stage(new ScriptedModel([declined]))({ taskId: task.id, signal: signal() })).rejects.toThrow(
      "The agent declined to implement the plan: src/pagination.ts has no paging bound to change",
    );
  });

  it("reuses the stored patch after a crash instead of calling the model again", async () => {
    const task = await createTask();
    await stage(new ScriptedModel([answer(patchAnswer([modify()]))]))({ taskId: task.id, signal: signal() });
    const model = new ScriptedModel([]);
    expect(await stage(model)({ taskId: task.id, signal: signal() })).toBe("RUNNING_CHECKS");
    expect(model.prompts).toHaveLength(0);
    expect((await load(task.id)).patches).toHaveLength(1);
  });

  it("refuses a plan that edits a symlink before any model call", async () => {
    const task = await createTask({ ...approvedPlan, affectedFiles: [{ path: "src/link.ts", change: "modify", reason: "x" }] });
    const model = new ScriptedModel([]);
    await expect(stage(model)({ taskId: task.id, signal: signal() })).rejects.toThrow(/symlink or submodule/);
    expect(model.prompts).toHaveLength(0);
  });

  it("stops at the token budget", async () => {
    const task = await createTask();
    await expect(stage(new ScriptedModel([]), { budget: 3_000 })({ taskId: task.id, signal: signal() })).rejects.toThrow(/token budget of 3,000/);
  });

  it("refuses a task without an approved plan", async () => {
    const task = await createTask(null);
    await expect(stage(new ScriptedModel([]))({ taskId: task.id, signal: signal() })).rejects.toThrow(/no approved plan/);
  });

  it("records a cancelled model call when the task is cancelled", async () => {
    const task = await createTask();
    const controller = new AbortController();
    const model = new ScriptedModel([
      async () => {
        controller.abort(new Error("cancelled"));
        throw new Error("aborted");
      },
    ]);
    await expect(stage(model)({ taskId: task.id, signal: controller.signal })).rejects.toThrow("aborted");
    expect((await load(task.id)).runs).toMatchObject([{ status: "CANCELLED" }]);
  });

  it("moves the task to RUNNING_CHECKS through the pipeline, which stops there until checks exist", async () => {
    const task = await createTask();
    const status = await runPipeline(
      task.id,
      {
        stages: { GENERATING_PATCH: stage(new ScriptedModel([answer(patchAnswer([modify()]))])) },
        loadStatus: async (id) => (await prisma.agentTask.findUniqueOrThrow({ where: { id } })).status as TaskStatus,
        transition: (id, from, to) => states.transition(id, from, to),
        fail: (id, from, reason) => states.fail(id, from, reason),
      },
      signal(),
    );
    const stored = await load(task.id);
    expect(status).toBe("FAILED");
    expect(stored.failureReason).toBe("No stage handler is implemented for RUNNING_CHECKS yet");
    expect(stored.events.filter((e) => e.eventType === "status_changed").map((e) => `${e.fromStatus}->${e.toStatus}`)).toEqual([
      "GENERATING_PATCH->RUNNING_CHECKS",
      "RUNNING_CHECKS->FAILED",
    ]);
  });
});
