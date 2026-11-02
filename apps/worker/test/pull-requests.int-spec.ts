import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContextPackage, ImplementationPlan, TaskStatus } from "@codepilot/contracts";
import { DEFAULT_PATCH_LIMITS } from "@codepilot/agent-core";
import type { Prisma } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { WorkspaceManager } from "../src/analysis/workspace";
import { createPatchStage } from "../src/patching/patch-stage";
import { runPipeline } from "../src/pipeline";
import { createOpenPullRequestStage } from "../src/pull-requests/open-pr-stage";
import { reconcilePullRequests } from "../src/pull-requests/reconcile";
import { RunRecorder } from "../src/runs";
import { TaskStateStore } from "../src/task-state";
import { FakePullRequestGitHub } from "./fake-pr-github";
import { createFixtureRepo } from "./git-fixture";
import { ScriptedModel, answer } from "./scripted-model";

const fixture = createFixtureRepo({
  "package.json": '{ "name": "shop" }\n',
  "src/pagination.js": "module.exports = (total, size) => Math.floor(total / size);\n",
});

const analysis: ContextPackage = {
  repository: "acme/shop",
  branch: "main",
  commitSha: fixture.commitSha,
  query: "Fix pages",
  profile: {
    languages: { javascript: 1 },
    primaryLanguage: "javascript",
    supported: true,
    packageManager: "npm",
    typescript: false,
    frameworks: [],
    testFrameworks: [],
    scripts: {},
    monorepo: false,
    instructionFiles: [],
    testFileCount: 0,
    directories: { src: 1 },
  },
  stats: { indexedFiles: 2, indexedBytes: 100, skipped: {}, truncated: false },
  snippets: [],
  relatedTests: [],
  budget: { maxChars: 48_000, usedChars: 0, droppedSnippets: 0 },
};

const plan: ImplementationPlan = {
  summary: "Count the last partial page",
  assumptions: ["Page size is positive"],
  affectedFiles: [{ path: "src/pagination.js", change: "modify", reason: "Holds the bug" }],
  implementationSteps: ["Round up"],
  testPlan: ["node test.js"],
  risks: [],
};

const patchAnswer = answer({
  kind: "patch",
  reason: null,
  patch: {
    summary: "Use Math.ceil so the last partial page counts. cc @octocat",
    commitMessage: "Count the last partial page",
    files: [{ path: "src/pagination.js", change: "modify", edits: [{ find: "Math.floor", replace: "Math.ceil" }], content: null }],
  },
});

const remoteRef = (branch: string): string | null => {
  try {
    return execFileSync("git", ["-C", fixture.dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).toString().trim();
  } catch {
    return null;
  }
};

/** Requires a migrated PostgreSQL at DATABASE_URL. */
describe("open pull request stage (PostgreSQL, git)", () => {
  const prisma = new PrismaClient();
  const states = new TaskStateStore(prisma);
  const root = mkdtempSync(path.join(tmpdir(), "codepilot-pr-ws-"));
  const workspaces = new WorkspaceManager(root);
  const author = { name: "CodePilot AI", email: "codepilot@codepilot.invalid" };
  const suffix = Date.now() * 1000 + 950;
  let seq = 0;
  let userId: string;
  let installationId: string;

  /** A task at OPENING_PR with a verified patch whose checks passed. */
  async function verifiedTask() {
    const n = ++seq;
    const repository = await prisma.repository.create({
      data: { installationId, githubRepoId: BigInt(suffix + n), owner: "acme", name: `shop-${suffix}-${n}`, defaultBranch: "main", enabled: true },
    });
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
      data: { taskId: task.id, version: 1, planJson: plan as unknown as Prisma.InputJsonObject, model: "claude-opus-5-5", status: "APPROVED", reviewedById: userId, approvedAt: new Date() },
    });
    await createPatchStage({
      prisma,
      model: new ScriptedModel([patchAnswer]),
      runs: new RunRecorder(prisma),
      workspaces,
      github: null,
      maxAttempts: 1,
      taskTokenBudget: 100_000,
      maxOutputTokens: 32_000,
      gitTimeoutMs: 30_000,
      limits: DEFAULT_PATCH_LIMITS,
      author,
      remoteUrl: () => fixture.url,
      nonce: () => `nonce${n}abcdef`,
    })({ taskId: task.id, signal: new AbortController().signal });

    const patch = await prisma.patch.findFirstOrThrow({ where: { taskId: task.id } });
    await prisma.patch.update({ where: { id: patch.id }, data: { status: "VERIFIED" } });
    await prisma.testRun.create({
      data: {
        taskId: task.id,
        patchId: patch.id,
        runnerImage: "codepilot/sandbox-node:22",
        status: "PASSED",
        startedAt: new Date(),
        completedAt: new Date(),
        results: { create: [{ position: 0, profileId: "test", kind: "test", command: "node test.js", status: "PASSED", exitCode: 0, outputSummary: "ok", durationMs: 800 }] },
      },
    });
    await prisma.agentTask.update({ where: { id: task.id }, data: { status: "OPENING_PR" } });
    return { task: await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } }), patch };
  }

  async function open(taskId: string, github: FakePullRequestGitHub | null, options: { canRetry?: boolean; signal?: AbortSignal } = {}) {
    const status = await runPipeline(
      taskId,
      {
        stages: { OPENING_PR: createOpenPullRequestStage({ prisma, github, workspaces, gitTimeoutMs: 30_000, author, remoteUrl: () => fixture.url }) },
        loadStatus: async (id) => (await prisma.agentTask.findUniqueOrThrow({ where: { id } })).status as TaskStatus,
        transition: (id, from, to) => states.transition(id, from, to),
        fail: (id, from, reason) => states.fail(id, from, reason),
        canRetry: options.canRetry,
      },
      options.signal ?? new AbortController().signal,
    );
    const task = await prisma.agentTask.findUniqueOrThrow({
      where: { id: taskId },
      include: { pullRequests: true, patches: true, events: { orderBy: { createdAt: "asc" } } },
    });
    return { status, task };
  }

  beforeAll(async () => {
    userId = (await prisma.user.create({ data: { githubId: BigInt(suffix), githubLogin: `reviewer-${suffix}` } })).id;
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

  it("pushes the verified patch and opens a draft PR with its evidence", async () => {
    const { task, patch } = await verifiedTask();
    const github = new FakePullRequestGitHub(fixture.dir);
    const { status, task: stored } = await open(task.id, github);

    expect(status).toBe("PR_OPENED");
    const pushed = remoteRef(patch.branchName);
    expect(pushed).toMatch(/^[0-9a-f]{40}$/);
    // The pushed commit carries exactly the verified tree, on top of the pinned base.
    expect(execFileSync("git", ["-C", fixture.dir, "rev-parse", `${pushed}^{tree}`]).toString().trim()).toBe(patch.treeSha);
    expect(execFileSync("git", ["-C", fixture.dir, "rev-parse", `${pushed}^`]).toString().trim()).toBe(fixture.commitSha);
    expect(remoteRef("main")).toBe(fixture.commitSha);

    expect(github.pulls).toHaveLength(1);
    const pr = github.pulls[0]!;
    expect(pr).toMatchObject({ draft: true, base: { ref: "main" }, head: { ref: patch.branchName, sha: pushed }, title: "Count the last partial page" });
    expect(pr.body).toContain("Opened by CodePilot AI as a draft");
    expect(pr.body).toContain(`approved by reviewer-${suffix}`);
    expect(pr.body).toContain("| test (test) | `node test.js` | ✅ passed | 0.8s |");
    expect(pr.body).toContain("cc @‍octocat");

    expect(stored.pullRequests).toMatchObject([{ githubPrNumber: 100, status: "DRAFT", headSha: pushed, branchName: patch.branchName, baseBranch: "main", patchId: patch.id }]);
    expect(stored.patches[0]!.status).toBe("SUBMITTED");
    expect(stored.events.map((e) => e.eventType)).toEqual(expect.arrayContaining(["branch_pushed", "pull_request_opened"]));
    const key = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key: `open-pr:${task.id}:${patch.id}` } });
    expect(key).toMatchObject({ state: "COMPLETED", result: { number: 100, headSha: pushed } });
  });

  it("retries a GitHub outage without pushing or opening anything twice", async () => {
    const { task, patch } = await verifiedTask();
    const github = new FakePullRequestGitHub(fixture.dir);
    github.failCreate = [502];

    await expect(open(task.id, github, { canRetry: true })).rejects.toThrow(/GitHub is unavailable \(502\)/);
    const afterFirst = remoteRef(patch.branchName);
    expect(afterFirst).not.toBeNull();
    expect((await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("OPENING_PR");

    const { status } = await open(task.id, github);
    expect(status).toBe("PR_OPENED");
    // The rebuilt commit is identical, so the branch was found in place rather than pushed again.
    expect(remoteRef(patch.branchName)).toBe(afterFirst);
    expect(github.pulls).toHaveLength(1);
    expect(github.calls.filter((c) => c.startsWith("createPull"))).toHaveLength(2);
  });

  it("reuses a PR GitHub already opened when the worker crashed before recording it", async () => {
    const { task, patch } = await verifiedTask();
    const github = new FakePullRequestGitHub(fixture.dir);
    await open(task.id, github);

    // Roll the database back to just before the PR was recorded.
    await prisma.pullRequest.deleteMany({ where: { taskId: task.id } });
    await prisma.idempotencyKey.update({ where: { key: `open-pr:${task.id}:${patch.id}` }, data: { state: "IN_PROGRESS", result: undefined } });
    await prisma.agentTask.update({ where: { id: task.id }, data: { status: "OPENING_PR", completedAt: null } });

    const { status, task: stored } = await open(task.id, github);
    expect(status).toBe("PR_OPENED");
    expect(github.pulls).toHaveLength(1);
    expect(stored.pullRequests).toMatchObject([{ githubPrNumber: 100 }]);
  });

  it("records a PR from a completed idempotency key without calling GitHub", async () => {
    const { task, patch } = await verifiedTask();
    await prisma.idempotencyKey.create({
      data: { key: `open-pr:${task.id}:${patch.id}`, scope: "open-pull-request", state: "COMPLETED", result: { number: 7, url: "https://github.com/acme/shop/pull/7", headSha: "c".repeat(40) } },
    });
    const github = new FakePullRequestGitHub(fixture.dir);
    const { status, task: stored } = await open(task.id, github);
    expect(status).toBe("PR_OPENED");
    expect(github.calls).toEqual([]);
    expect(stored.pullRequests).toMatchObject([{ githubPrNumber: 7, headSha: "c".repeat(40) }]);
  });

  it("never overwrites a branch that already exists on GitHub at another commit", async () => {
    const { task, patch } = await verifiedTask();
    execFileSync("git", ["-C", fixture.dir, "update-ref", `refs/heads/${patch.branchName}`, fixture.commitSha]);
    const github = new FakePullRequestGitHub(fixture.dir);
    const { status, task: stored } = await open(task.id, github);

    expect(status).toBe("FAILED");
    expect(stored.failureReason).toMatch(/already exists on GitHub at a different commit; it was not overwritten/);
    expect(remoteRef(patch.branchName)).toBe(fixture.commitSha);
    expect(github.pulls).toHaveLength(0);
  });

  it("deletes the branch it pushed when GitHub refuses the PR", async () => {
    const { task, patch } = await verifiedTask();
    const github = new FakePullRequestGitHub(fixture.dir);
    github.failCreate = [403];
    const { status, task: stored } = await open(task.id, github);

    expect(status).toBe("FAILED");
    expect(stored.failureReason).toMatch(/needs Contents and Pull requests write access/);
    expect(remoteRef(patch.branchName)).toBeNull();
    expect(stored.events.map((e) => e.eventType)).toEqual(expect.arrayContaining(["branch_pushed", "branch_deleted"]));
  });

  it("fails clearly without a GitHub App", async () => {
    const { task } = await verifiedTask();
    const { status, task: stored } = await open(task.id, null);
    expect(status).toBe("FAILED");
    expect(stored.failureReason).toBe("The GitHub App is not configured for the worker");
  });

  it("reconciles PRs a webhook missed, and skips recently confirmed ones", async () => {
    const github = new FakePullRequestGitHub(fixture.dir);
    const merged = await verifiedTask();
    const untouched = await verifiedTask();
    await open(merged.task.id, github);
    await open(untouched.task.id, github);

    const mergedPr = github.pulls.find((p) => p.head.ref === merged.patch.branchName)!;
    Object.assign(mergedPr, { state: "closed", merged_at: "2099-01-01T00:00:00Z", closed_at: "2099-01-01T00:00:00Z", updated_at: "2099-01-01T00:00:00Z" });

    const later = new Date(Date.now() + 60 * 60_000);
    // Other suites' pull requests share the database; this fake GitHub only knows these two, so only they are asserted on.
    const result = await reconcilePullRequests(prisma, github, { staleAfterMs: 10 * 60_000, limit: 500, now: later });
    expect(result.updated).toBeGreaterThanOrEqual(1);

    const rows = await prisma.pullRequest.findMany({ where: { taskId: { in: [merged.task.id, untouched.task.id] } } });
    const byTask = new Map(rows.map((r) => [r.taskId, r]));
    expect(byTask.get(merged.task.id)).toMatchObject({ status: "MERGED", mergedAt: new Date("2099-01-01T00:00:00Z"), lastSyncedAt: later });
    expect(byTask.get(untouched.task.id)).toMatchObject({ status: "DRAFT", lastSyncedAt: later });
    const events = await prisma.taskEvent.findMany({ where: { taskId: merged.task.id, eventType: "pull_request_merged" } });
    expect(events).toHaveLength(1);

    // Just confirmed, so a second run right away leaves them alone.
    const calls = github.calls.length;
    await reconcilePullRequests(prisma, github, { staleAfterMs: 10 * 60_000, limit: 500, now: later });
    expect(github.calls.slice(calls).filter((c) => c.includes(String(mergedPr.number)))).toEqual([]);
  });

  it("keeps reconciling the rest when one PR cannot be read", async () => {
    const github = new FakePullRequestGitHub(fixture.dir);
    const gone = await verifiedTask();
    await open(gone.task.id, github);
    github.pulls.length = 0;

    const later = new Date(Date.now() + 2 * 60 * 60_000);
    const result = await reconcilePullRequests(prisma, github, { staleAfterMs: 10 * 60_000, limit: 500, now: later });
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(await prisma.pullRequest.findUniqueOrThrow({ where: { taskId: gone.task.id } })).toMatchObject({ status: "DRAFT", lastSyncedAt: later });
  });
});
