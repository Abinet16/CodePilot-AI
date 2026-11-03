import type {
  DashboardResponse,
  IssueSummary,
  PatchDetail,
  RepositoryChecks,
  RepositoryChecksResponse,
  RepositoryDetail,
  RepositorySummary,
  TaskDetail,
  TaskJobKey,
  TaskPage,
  UsageReport,
} from "@codepilot/contracts";
import { taskJobId } from "@codepilot/contracts";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { AppModule } from "../src/app.module";
import { GITHUB_API } from "../src/github/github.client";
import { configureApp } from "../src/main";
import { TaskQueue } from "../src/tasks/task-queue";
import { FakeGitHub, repo } from "./fake-github";

Object.assign(process.env, {
  NODE_ENV: "test",
  WEB_ORIGIN: "http://localhost:3000",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "codepilot-test",
  GITHUB_APP_PRIVATE_KEY_PATH: "/not/read/because/github/is/faked",
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  GITHUB_WEBHOOK_SECRET: "tasks-webhook-secret",
});

const base = Date.now() * 1000 + 500;
const ids = { alice: base + 1, bob: base + 2, installation: base + 10, shared: base + 20, aliceOnly: base + 21 };
const SHA = "f".repeat(40);

class FakeTaskQueue {
  readonly enqueued: string[] = [];
  readonly jobIds: string[] = [];
  readonly removed: string[] = [];
  fail = false;
  async enqueue(taskId: string, key: TaskJobKey = "start"): Promise<void> {
    if (this.fail) throw new Error("redis down");
    this.enqueued.push(taskId);
    this.jobIds.push(taskJobId(taskId, key));
  }
  async remove(taskId: string, keys: TaskJobKey[]): Promise<void> {
    this.removed.push(...keys.map((k) => taskJobId(taskId, k)));
  }
}

describe("tasks API (PostgreSQL)", () => {
  let app: NestExpressApplication;
  const prisma = new PrismaClient();
  const github = new FakeGitHub();
  const queue = new FakeTaskQueue();
  let alice: TestAgent;
  let bob: TestAgent;
  let shared: RepositorySummary;
  let aliceOnly: RepositorySummary;

  async function login(code: string): Promise<TestAgent> {
    const agent = request.agent(app.getHttpServer());
    const start = await agent.get("/api/auth/github/login").expect(302);
    const state = new URL(start.headers.location as string).searchParams.get("state");
    await agent.get(`/api/auth/github/callback?code=${code}&state=${state}`).expect(302);
    return agent;
  }

  beforeAll(async () => {
    const installation = { id: ids.installation, account: { login: "acme" }, suspended_at: null };
    github.accounts.set("t-alice", {
      user: { id: ids.alice, login: `t-alice-${base}`, name: null, email: null, avatar_url: null },
      installations: [
        {
          installation,
          repositories: [repo(ids.shared, "acme", `t-shared-${base}`, "admin"), repo(ids.aliceOnly, "acme", `t-private-${base}`, "push")],
        },
      ],
    });
    github.accounts.set("t-bob", {
      user: { id: ids.bob, login: `t-bob-${base}`, name: null, email: null, avatar_url: null },
      installations: [{ installation, repositories: [repo(ids.shared, "acme", `t-shared-${base}`, "pull")] }],
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GITHUB_API)
      .useValue(github)
      .overrideProvider(TaskQueue)
      .useValue(queue)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
    configureApp(app);
    await app.init();

    alice = await login("t-alice");
    bob = await login("t-bob");
    const repos = (await alice.get("/api/repositories").expect(200)).body as RepositorySummary[];
    shared = repos.find((r) => r.name === `t-shared-${base}`)!;
    aliceOnly = repos.find((r) => r.name === `t-private-${base}`)!;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const describeTask = (repositoryId: string, extra: object = {}) => ({ repositoryId, description: "Fix the pagination off-by-one error", ...extra });

  it("requires a session", async () => {
    await request(app.getHttpServer()).get("/api/tasks").expect(401);
    await request(app.getHttpServer()).post("/api/tasks").send(describeTask(shared.id)).expect(401);
  });

  it("only starts tasks on enabled repositories", async () => {
    await alice.post("/api/tasks").send(describeTask(shared.id)).expect(409);
    await alice.patch(`/api/repositories/${shared.id}`).send({ enabled: true }).expect(200);
    await alice.patch(`/api/repositories/${aliceOnly.id}`).send({ enabled: true }).expect(200);
  });

  it("creates a queued task and enqueues only its id", async () => {
    const res = await alice.post("/api/tasks").send(describeTask(shared.id)).expect(201);
    const task = res.body as TaskDetail;
    expect(task).toMatchObject({
      status: "QUEUED",
      repositoryFullName: shared.fullName,
      title: "Fix the pagination off-by-one error",
      analysis: null,
      plans: [],
      runs: [],
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    });
    expect(task.events.map((e) => e.eventType)).toEqual(["task_created"]);
    expect(queue.enqueued.at(-1)).toBe(task.id);

    const audit = await prisma.auditLog.findFirst({ where: { taskId: task.id, action: "task.created" } });
    expect(audit).not.toBeNull();
  });

  it("validates the request body strictly", async () => {
    await alice.post("/api/tasks").send({ repositoryId: shared.id }).expect(400);
    await alice.post("/api/tasks").send(describeTask(shared.id, { description: "short" })).expect(400);
    await alice.post("/api/tasks").send(describeTask(shared.id, { baseSha: SHA })).expect(400);
    await alice.post("/api/tasks").send(describeTask("not-a-uuid")).expect(400);
  });

  it("enforces repository access and WRITE permission", async () => {
    await bob.post("/api/tasks").send(describeTask(shared.id)).expect(403);
    await bob.post("/api/tasks").send(describeTask(aliceOnly.id)).expect(404);
    await alice.post("/api/tasks").send(describeTask("00000000-0000-4000-8000-000000000000")).expect(404);
  });

  it("only accepts open issues from the same repository", async () => {
    const open = await prisma.issue.create({ data: { repositoryId: shared.id, githubIssueNumber: 41, title: "Pagination drops last page" } });
    const closed = await prisma.issue.create({ data: { repositoryId: shared.id, githubIssueNumber: 42, title: "Old", state: "CLOSED" } });
    const elsewhere = await prisma.issue.create({ data: { repositoryId: aliceOnly.id, githubIssueNumber: 1, title: "Other repo" } });

    const res = await alice.post("/api/tasks").send({ repositoryId: shared.id, issueId: open.id }).expect(201);
    expect((res.body as TaskDetail).title).toBe("#41 Pagination drops last page");
    expect((res.body as TaskDetail).issue).toEqual({ number: 41, title: "Pagination drops last page", state: "OPEN" });
    await alice.post("/api/tasks").send({ repositoryId: shared.id, issueId: closed.id }).expect(409);
    await alice.post("/api/tasks").send({ repositoryId: shared.id, issueId: elsewhere.id }).expect(404);

    const issues = (await bob.get(`/api/repositories/${shared.id}/issues`).expect(200)).body as IssueSummary[];
    expect(issues.map((i) => i.number)).toEqual([41]);
    await bob.get(`/api/repositories/${aliceOnly.id}/issues`).expect(404);
  });

  it("marks the task failed when it cannot be enqueued", async () => {
    queue.fail = true;
    await alice.post("/api/tasks").send(describeTask(shared.id)).expect(503);
    queue.fail = false;
    const latest = await prisma.agentTask.findFirstOrThrow({ where: { repositoryId: shared.id }, orderBy: { createdAt: "desc" } });
    expect(latest).toMatchObject({ status: "FAILED", failureReason: "Could not enqueue the task" });
  });

  it("lists and shows tasks only to users who can access the repository", async () => {
    const privateTask = (await alice.post("/api/tasks").send(describeTask(aliceOnly.id)).expect(201)).body as TaskDetail;

    const aliceTasks = ((await alice.get("/api/tasks?limit=100").expect(200)).body as TaskPage).items;
    const bobTasks = ((await bob.get("/api/tasks?limit=100").expect(200)).body as TaskPage).items;
    expect(aliceTasks.some((t) => t.id === privateTask.id)).toBe(true);
    expect(bobTasks.some((t) => t.id === privateTask.id)).toBe(false);
    expect(bobTasks.length).toBeGreaterThan(0);

    const filtered = (await alice.get(`/api/tasks?repositoryId=${aliceOnly.id}`).expect(200)).body as TaskPage;
    expect(filtered.items.map((t) => t.id)).toEqual([privateTask.id]);
    expect(filtered.items[0]).toMatchObject({ group: "active", pullRequest: null, estimatedCostUsd: 0 });
    expect(filtered.nextCursor).toBeNull();
    await alice.get("/api/tasks?repositoryId=nope").expect(400);
    await alice.get("/api/tasks?status=FAILED").expect(400);

    await bob.get(`/api/tasks/${privateTask.id}`).expect(404);
    await alice.get(`/api/tasks/${privateTask.id}`).expect(200);
  });

  it("returns stored analysis and withholds malformed analysis", async () => {
    const task = (await alice.post("/api/tasks").send(describeTask(shared.id)).expect(201)).body as TaskDetail;
    const analysis = {
      repository: shared.fullName,
      branch: "main",
      commitSha: SHA,
      query: "Fix the pagination off-by-one error",
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
      stats: { indexedFiles: 2, indexedBytes: 100, skipped: {}, truncated: false },
      snippets: [{ path: "src/pagination.ts", startLine: 1, endLine: 9, content: "export function paginate() {}", score: 16, reasons: ["path_mentioned"] }],
      relatedTests: ["src/pagination.test.ts"],
      budget: { maxChars: 48000, usedChars: 30, droppedSnippets: 0 },
    };
    await prisma.agentTask.update({ where: { id: task.id }, data: { analysis, baseSha: SHA } });
    const detail = (await bob.get(`/api/tasks/${task.id}`).expect(200)).body as TaskDetail;
    expect(detail.baseSha).toBe(SHA);
    expect(detail.analysis?.snippets[0]?.path).toBe("src/pagination.ts");

    await prisma.agentTask.update({ where: { id: task.id }, data: { analysis: { snippets: "nope" } } });
    expect(((await alice.get(`/api/tasks/${task.id}`).expect(200)).body as TaskDetail).analysis).toBeNull();
  });

  it("cancels an active task once, with WRITE permission", async () => {
    const task = (await alice.post("/api/tasks").send(describeTask(shared.id)).expect(201)).body as TaskDetail;
    await bob.post(`/api/tasks/${task.id}/cancel`).expect(403);

    const cancelled = (await alice.post(`/api/tasks/${task.id}/cancel`).expect(200)).body as TaskDetail;
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.completedAt).not.toBeNull();
    expect(cancelled.events.at(-1)).toMatchObject({ fromStatus: "QUEUED", toStatus: "CANCELLED" });
    expect(queue.removed).toContain(taskJobId(task.id, "start"));

    await alice.post(`/api/tasks/${task.id}/cancel`).expect(409);
    expect(await prisma.auditLog.count({ where: { taskId: task.id, action: "task.cancelled" } })).toBe(1);
  });

  const proposal = {
    summary: "Include the last partial page",
    assumptions: [],
    affectedFiles: [{ path: "src/pagination.ts", change: "modify", reason: "Contains the bound" }],
    implementationSteps: ["Use Math.ceil"],
    testPlan: ["Add a partial-page test"],
    risks: [],
  };

  /** A task the worker has planned: one proposed plan version and its run and usage. */
  async function plannedTask(versions = 1): Promise<string> {
    const task = (await alice.post("/api/tasks").send(describeTask(shared.id)).expect(201)).body as TaskDetail;
    await prisma.agentTask.update({ where: { id: task.id }, data: { status: "AWAITING_PLAN_APPROVAL", baseSha: SHA } });
    const requester = await prisma.user.findFirstOrThrow({ where: { githubId: BigInt(ids.alice) } });
    for (let version = 1; version <= versions; version++) {
      const run = await prisma.agentRun.create({
        data: {
          taskId: task.id,
          attemptNumber: version,
          stage: "PLANNING",
          model: "claude-opus-5-5",
          status: "SUCCEEDED",
          tokenUsage: { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 200 },
          completedAt: new Date(),
        },
      });
      await prisma.usageRecord.create({
        data: {
          userId: requester.id,
          taskId: task.id,
          runId: run.id,
          provider: "anthropic",
          model: "claude-opus-5-5",
          inputTokens: 1200,
          outputTokens: 500,
          estimatedCost: "0.014800",
        },
      });
      await prisma.implementationPlan.create({
        data: {
          taskId: task.id,
          version,
          planJson: proposal,
          model: "claude-opus-5-5",
          runId: run.id,
          status: version < versions ? "CHANGES_REQUESTED" : "PROPOSED",
          feedback: version < versions ? "Cover the empty list too" : null,
        },
      });
    }
    return task.id;
  }

  it("shows plans, runs, and usage on the task", async () => {
    const id = await plannedTask(2);
    const detail = (await bob.get(`/api/tasks/${id}`).expect(200)).body as TaskDetail;
    expect(detail.plans.map((p) => [p.version, p.status])).toEqual([
      [1, "CHANGES_REQUESTED"],
      [2, "PROPOSED"],
    ]);
    expect(detail.plans[0]!.feedback).toBe("Cover the empty list too");
    expect(detail.plans[1]!.plan?.affectedFiles[0]?.path).toBe("src/pagination.ts");
    expect(detail.runs[0]).toMatchObject({ attemptNumber: 1, stage: "PLANNING", status: "SUCCEEDED", inputTokens: 1200, outputTokens: 500 });
    expect(detail.usage).toEqual({ inputTokens: 2400, outputTokens: 1000, estimatedCostUsd: 0.0296 });

    await prisma.implementationPlan.update({ where: { taskId_version: { taskId: id, version: 2 } }, data: { planJson: { summary: 7 } } });
    expect(((await alice.get(`/api/tasks/${id}`).expect(200)).body as TaskDetail).plans[1]!.plan).toBeNull();
  });

  it("approves the plan under review, once, and resumes the task", async () => {
    const id = await plannedTask();
    await bob.post(`/api/tasks/${id}/plan/approve`).send({ version: 1 }).expect(403);
    await alice.post(`/api/tasks/${id}/plan/approve`).send({}).expect(400);
    await alice.post(`/api/tasks/${id}/plan/approve`).send({ version: 2 }).expect(409);

    const approved = (await alice.post(`/api/tasks/${id}/plan/approve`).send({ version: 1 }).expect(200)).body as TaskDetail;
    expect(approved.status).toBe("GENERATING_PATCH");
    expect(approved.plans[0]).toMatchObject({ status: "APPROVED", reviewedBy: `t-alice-${base}` });
    expect(approved.events.at(-1)).toMatchObject({ fromStatus: "AWAITING_PLAN_APPROVAL", toStatus: "GENERATING_PATCH", payload: { reason: "plan_approved", version: 1 } });
    expect(queue.jobIds.at(-1)).toBe(taskJobId(id, "plan-v1-approved"));
    expect(await prisma.auditLog.count({ where: { taskId: id, action: "plan.approved" } })).toBe(1);

    await alice.post(`/api/tasks/${id}/plan/approve`).send({ version: 1 }).expect(409);
  });

  it("sends a plan back to planning with feedback, up to the revision limit", async () => {
    const id = await plannedTask();
    await alice.post(`/api/tasks/${id}/plan/request-changes`).send({ version: 1, feedback: "short" }).expect(400);

    const revising = (await alice
      .post(`/api/tasks/${id}/plan/request-changes`)
      .send({ version: 1, feedback: "Please also handle an empty list" })
      .expect(200)).body as TaskDetail;
    expect(revising.status).toBe("PLANNING");
    expect(revising.plans[0]).toMatchObject({ status: "CHANGES_REQUESTED", feedback: "Please also handle an empty list" });
    expect(queue.jobIds.at(-1)).toBe(taskJobId(id, "plan-v1-revise"));
    expect(await prisma.auditLog.count({ where: { taskId: id, action: "plan.changes_requested" } })).toBe(1);

    // Not awaiting review any more.
    await alice.post(`/api/tasks/${id}/plan/approve`).send({ version: 1 }).expect(409);

    const last = await plannedTask(3);
    await alice.post(`/api/tasks/${last}/plan/request-changes`).send({ version: 3, feedback: "One more round please" }).expect(409);
    await alice.post(`/api/tasks/${last}/plan/approve`).send({ version: 3 }).expect(200);
  });

  it("fails the task if the approved work cannot be enqueued", async () => {
    const id = await plannedTask();
    queue.fail = true;
    await alice.post(`/api/tasks/${id}/plan/approve`).send({ version: 1 }).expect(503);
    queue.fail = false;
    const task = await prisma.agentTask.findUniqueOrThrow({ where: { id } });
    expect(task).toMatchObject({ status: "FAILED", failureReason: "Could not enqueue the task" });
  });

  it("lists patch attempts on the task and serves each diff only to users who can see the task", async () => {
    const id = await plannedTask();
    await prisma.implementationPlan.update({ where: { taskId_version: { taskId: id, version: 1 } }, data: { status: "APPROVED", approvedAt: new Date() } });
    const plan = await prisma.implementationPlan.findUniqueOrThrow({ where: { taskId_version: { taskId: id, version: 1 } } });
    const run = await prisma.agentRun.create({ data: { taskId: id, attemptNumber: 2, stage: "GENERATING_PATCH", model: "claude-opus-5-5", status: "SUCCEEDED" } });
    const files = [{ path: "src/pagination.ts", change: "modify", additions: 1, deletions: 1 }];
    const diff = "diff --git a/src/pagination.ts b/src/pagination.ts\n-  return Math.floor(t / s);\n+  return Math.ceil(t / s);\n";
    await prisma.patch.create({
      data: {
        taskId: id,
        version: 1,
        planId: plan.id,
        runId: run.id,
        baseSha: SHA,
        branchName: `codepilot/fix-${id.slice(0, 8)}`,
        commitSha: "c".repeat(40),
        treeSha: "e".repeat(40),
        summary: "Use Math.ceil",
        commitMessage: "Fix pagination",
        model: "claude-opus-5-5",
        patchContent: diff,
        diffHash: "f".repeat(64),
        files,
        unchangedPlanFiles: [],
        additions: 1,
        deletions: 1,
      },
    });

    const stored = await prisma.patch.findFirstOrThrow({ where: { taskId: id } });
    await prisma.testRun.create({
      data: {
        taskId: id,
        patchId: stored.id,
        runnerImage: "codepilot/sandbox-node:22",
        status: "FAILED",
        startedAt: new Date(),
        completedAt: new Date(),
        results: {
          create: [
            { position: 0, profileId: "test", kind: "test", command: "pnpm run test", status: "FAILED", exitCode: 1, outputSummary: "expected 4, received 3", durationMs: 1200 },
          ],
        },
      },
    });

    const detail = (await bob.get(`/api/tasks/${id}`).expect(200)).body as TaskDetail;
    expect(detail.checks).toEqual([
      expect.objectContaining({
        patchVersion: 1,
        status: "FAILED",
        runnerImage: "codepilot/sandbox-node:22",
        results: [
          {
            profileId: "test",
            kind: "test",
            command: "pnpm run test",
            status: "FAILED",
            exitCode: 1,
            durationMs: 1200,
            output: "expected 4, received 3",
            outputTruncated: false,
          },
        ],
      }),
    ]);
    expect(detail.patches).toEqual([
      expect.objectContaining({ version: 1, status: "PROPOSED", planVersion: 1, commitSha: "c".repeat(40), files, additions: 1, deletions: 1 }),
    ]);
    expect(detail.patches[0]).not.toHaveProperty("diff");

    const patch = (await bob.get(`/api/tasks/${id}/patches/1`).expect(200)).body as PatchDetail;
    expect(patch).toMatchObject({ version: 1, branchName: `codepilot/fix-${id.slice(0, 8)}`, diff });

    await bob.get(`/api/tasks/${id}/patches/2`).expect(404);
    await bob.get(`/api/tasks/${id}/patches/0`).expect(404);
    await bob.get(`/api/tasks/${id}/patches/99999999999`).expect(404);
    await bob.get(`/api/tasks/${id}/patches/one`).expect(400);

    const privateTask = (await alice.post("/api/tasks").send(describeTask(aliceOnly.id)).expect(201)).body as TaskDetail;
    const copy = await prisma.patch.findFirstOrThrow({ where: { taskId: id }, omit: { id: true, createdAt: true, files: true } });
    await prisma.patch.create({ data: { ...copy, taskId: privateTask.id, files: [], patchContent: "secret diff" } });
    await bob.get(`/api/tasks/${privateTask.id}/patches/1`).expect(404);
    await request(app.getHttpServer()).get(`/api/tasks/${id}/patches/1`).expect(401);
  });

  it("lets maintainers configure checks, suggests them from the latest snapshot, and audits changes", async () => {
    await prisma.repositorySnapshot.create({
      data: {
        repositoryId: shared.id,
        commitSha: SHA,
        profile: {
          languages: { typescript: 2 },
          primaryLanguage: "typescript",
          supported: true,
          packageManager: "pnpm",
          typescript: true,
          frameworks: [],
          testFrameworks: ["Jest"],
          scripts: { test: "jest", lint: "eslint ." },
          monorepo: false,
          instructionFiles: [],
          testFileCount: 1,
          directories: { src: 2 },
        },
        stats: { indexedFiles: 2, indexedBytes: 100, skipped: {}, truncated: false },
        paths: ["package.json"],
      },
    });

    const viewed = (await bob.get(`/api/repositories/${shared.id}/checks`).expect(200)).body as RepositoryChecksResponse;
    expect(viewed).toMatchObject({ configured: null, canEdit: false, updatedBy: null });
    expect(viewed.suggested?.checks.map((c) => c.id)).toEqual(["lint", "test"]);
    expect(viewed.suggested?.install?.args).toContain("--ignore-scripts");

    const checks: RepositoryChecks = {
      install: { id: "install", executable: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts"], timeoutMs: 300_000 },
      checks: [{ id: "test", kind: "test", executable: "pnpm", args: ["run", "test"], timeoutMs: 600_000 }],
    };
    await bob.put(`/api/repositories/${shared.id}/checks`).send(checks).expect(403);
    // WRITE is enough to run tasks, but not to decide what runs in the sandbox.
    await alice.put(`/api/repositories/${aliceOnly.id}/checks`).send(checks).expect(403);

    const saved = (await alice.put(`/api/repositories/${shared.id}/checks`).send(checks).expect(200)).body as RepositoryChecksResponse;
    expect(saved).toMatchObject({ configured: checks, canEdit: true, updatedBy: `t-alice-${base}` });
    expect((await bob.get(`/api/repositories/${shared.id}/checks`).expect(200)).body.configured).toEqual(checks);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "repository.checks_updated" }, orderBy: { createdAt: "desc" } });
    expect(audit.metadata).toMatchObject({ install: "pnpm install --frozen-lockfile --ignore-scripts", checks: ["test: pnpm run test"] });

    const withScripts = { ...checks, install: { ...checks.install!, args: ["install"] } };
    const rejected = await alice.put(`/api/repositories/${shared.id}/checks`).send(withScripts).expect(400);
    expect(JSON.stringify(rejected.body)).toMatch(/lifecycle scripts/);
    await alice.put(`/api/repositories/${shared.id}/checks`).send({ ...checks, checks: [{ ...checks.checks[0], executable: "bash" }] }).expect(400);
    await alice.put(`/api/repositories/${shared.id}/checks`).send({ ...checks, shell: "sh -c x" }).expect(400);

    const withoutInstall = (await alice.put(`/api/repositories/${shared.id}/checks`).send({ ...checks, install: null }).expect(200)).body as RepositoryChecksResponse;
    expect(withoutInstall.configured?.install).toBeNull();
    await bob.get(`/api/repositories/${aliceOnly.id}/checks`).expect(404);
  });

  /** A task at READY_FOR_REVIEW with a verified patch version 1. */
  async function reviewableTask(): Promise<{ id: string; patchId: string }> {
    const id = await plannedTask();
    const plan = await prisma.implementationPlan.update({
      where: { taskId_version: { taskId: id, version: 1 } },
      data: { status: "APPROVED", approvedAt: new Date() },
    });
    const run = await prisma.agentRun.create({ data: { taskId: id, attemptNumber: 2, stage: "GENERATING_PATCH", model: "claude-opus-5-5", status: "SUCCEEDED" } });
    const patch = await prisma.patch.create({
      data: {
        taskId: id,
        version: 1,
        planId: plan.id,
        runId: run.id,
        baseSha: SHA,
        branchName: `codepilot/fix-${id.slice(0, 8)}`,
        commitSha: "c".repeat(40),
        treeSha: "e".repeat(40),
        summary: "Use Math.ceil",
        commitMessage: "Fix pagination",
        model: "claude-opus-5-5",
        patchContent: "diff",
        diffHash: "f".repeat(64),
        files: [],
        unchangedPlanFiles: [],
        additions: 1,
        deletions: 1,
        status: "VERIFIED",
      },
    });
    await prisma.agentTask.update({ where: { id }, data: { status: "READY_FOR_REVIEW" } });
    return { id, patchId: patch.id };
  }

  it("opens a pull request only for the verified patch under review, with WRITE permission", async () => {
    const { id } = await reviewableTask();
    await bob.post(`/api/tasks/${id}/pull-request`).send({ patchVersion: 1 }).expect(403);
    await alice.post(`/api/tasks/${id}/pull-request`).send({ patchVersion: 2 }).expect(409);
    await alice.post(`/api/tasks/${id}/pull-request`).send({ patchVersion: 1, draft: false }).expect(400);

    const detail = (await alice.post(`/api/tasks/${id}/pull-request`).send({ patchVersion: 1 }).expect(200)).body as TaskDetail;
    expect(detail.status).toBe("OPENING_PR");
    expect(queue.jobIds).toContain(taskJobId(id, "pr-v1"));
    expect(detail.events.at(-1)).toMatchObject({ fromStatus: "READY_FOR_REVIEW", toStatus: "OPENING_PR", payload: { reason: "pull_request_requested", patchVersion: 1 } });
    expect(await prisma.auditLog.count({ where: { taskId: id, action: "pull_request.requested" } })).toBe(1);

    // A second click (or a second reviewer) finds the task already moving.
    await alice.post(`/api/tasks/${id}/pull-request`).send({ patchVersion: 1 }).expect(409);

    await alice.post(`/api/tasks/${id}/cancel`).expect(200);
    expect(queue.removed).toContain(taskJobId(id, "pr-v1"));
  });

  it("shows the opened pull request on the task", async () => {
    const { id, patchId } = await reviewableTask();
    await prisma.pullRequest.create({
      data: {
        taskId: id,
        repositoryId: shared.id,
        patchId,
        githubPrNumber: 4_000 + (base % 1_000),
        githubPrUrl: "https://github.com/acme/shop/pull/4",
        headSha: "c".repeat(40),
        branchName: `codepilot/fix-${id.slice(0, 8)}`,
        baseBranch: "main",
        status: "DRAFT",
      },
    });
    const detail = (await bob.get(`/api/tasks/${id}`).expect(200)).body as TaskDetail;
    expect(detail.pullRequest).toMatchObject({ url: "https://github.com/acme/shop/pull/4", status: "DRAFT", patchVersion: 1, baseBranch: "main", mergedAt: null });
  });

  it("pages tasks with a cursor and filters them by status group", async () => {
    const created: string[] = [];
    for (let i = 0; i < 3; i++) created.push(((await alice.post("/api/tasks").send(describeTask(aliceOnly.id)).expect(201)).body as TaskDetail).id);
    await prisma.agentTask.update({ where: { id: created[0] }, data: { status: "FAILED", failureReason: "test" } });

    const all = ((await alice.get(`/api/tasks?repositoryId=${aliceOnly.id}&limit=100`).expect(200)).body as TaskPage).items.map((t) => t.id);
    const first = (await alice.get(`/api/tasks?repositoryId=${aliceOnly.id}&limit=2`).expect(200)).body as TaskPage;
    expect(first.items.map((t) => t.id)).toEqual(all.slice(0, 2));
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await alice.get(`/api/tasks?repositoryId=${aliceOnly.id}&limit=2&cursor=${first.nextCursor}`).expect(200)).body as TaskPage;
    expect(second.items.map((t) => t.id)).toEqual(all.slice(2, 4));

    const failed = (await alice.get(`/api/tasks?repositoryId=${aliceOnly.id}&group=failed`).expect(200)).body as TaskPage;
    expect(failed.items.map((t) => t.id)).toContain(created[0]);
    expect(failed.items.every((t) => t.group === "failed" && t.status === "FAILED")).toBe(true);

    await alice.get("/api/tasks?cursor=bm90LWEtY3Vyc29y").expect(400);
    await alice.get("/api/tasks?limit=0").expect(400);
  });

  it("summarizes the dashboard from tasks the user can see", async () => {
    const reviewable = (await alice.post("/api/tasks").send(describeTask(aliceOnly.id)).expect(201)).body as TaskDetail;
    await prisma.agentTask.update({ where: { id: reviewable.id }, data: { status: "AWAITING_PLAN_APPROVAL" } });

    const mine = (await alice.get("/api/dashboard").expect(200)).body as DashboardResponse;
    expect(mine.counts.review).toBeGreaterThanOrEqual(1);
    expect(mine.needsReview.map((t) => t.id)).toContain(reviewable.id);
    expect(mine.needsReview.every((t) => t.group === "review")).toBe(true);
    expect(mine.recent.length).toBeLessThanOrEqual(10);
    expect(Object.keys(mine.pullRequests).sort()).toEqual(["CLOSED", "DRAFT", "MERGED", "OPEN"]);
    expect(mine.repositories.visible).toBeGreaterThanOrEqual(2);
    expect(mine.usage.days).toBe(30);

    // Bob cannot see Alice's private repository, so its tasks are not in his counts or lists.
    const bobs = (await bob.get("/api/dashboard").expect(200)).body as DashboardResponse;
    expect(bobs.needsReview.map((t) => t.id)).not.toContain(reviewable.id);
    expect(bobs.recent.every((t) => t.repositoryId !== aliceOnly.id)).toBe(true);
    await request(app.getHttpServer()).get("/api/dashboard").expect(401);
  });

  it("reports the user's own usage by day, model, provider, and repository", async () => {
    const owner = await prisma.user.findFirstOrThrow({ where: { githubId: BigInt(ids.alice) } });
    const task = (await alice.post("/api/tasks").send(describeTask(shared.id)).expect(201)).body as TaskDetail;
    const model = `usage-model-${base}`;
    const today = new Date();
    const threeDaysAgo = new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000);
    for (const createdAt of [today, today, threeDaysAgo]) {
      await prisma.usageRecord.create({
        data: { userId: owner.id, taskId: task.id, provider: "ollama", model, inputTokens: 1_000, outputTokens: 200, estimatedCost: "0.001000", createdAt },
      });
    }

    const report = (await alice.get("/api/usage?days=7").expect(200)).body as UsageReport;
    expect(report.days).toBe(7);
    expect(report.daily).toHaveLength(7);
    expect(report.daily.at(-1)!.key).toBe(today.toISOString().slice(0, 10));
    expect(report.byModel.find((m) => m.key === model)).toEqual({ key: model, inputTokens: 3_000, outputTokens: 600, estimatedCostUsd: 0.003, calls: 3 });
    expect(report.byProvider.find((p) => p.key === "ollama")?.calls).toBeGreaterThanOrEqual(3);
    expect(report.byRepository.map((r) => r.key)).toContain(shared.fullName);
    expect(report.totals.calls).toBe(report.daily.reduce((n, d) => n + d.calls, 0));

    // Usage is personal: Bob sees none of Alice's calls.
    const bobs = (await bob.get("/api/usage?days=7").expect(200)).body as UsageReport;
    expect(bobs.byModel.find((m) => m.key === model)).toBeUndefined();
    await alice.get("/api/usage?days=0").expect(400);
    await alice.get("/api/usage?days=91").expect(400);
  });

  it("shows a repository's index state, checks, issues, and task activity", async () => {
    await prisma.repositorySettings.upsert({
      where: { repositoryId: aliceOnly.id },
      create: { repositoryId: aliceOnly.id, checks: [{ id: "test", kind: "test", executable: "pnpm", args: ["test"], timeoutMs: 60_000 }] },
      update: { checks: [{ id: "test", kind: "test", executable: "pnpm", args: ["test"], timeoutMs: 60_000 }] },
    });
    await prisma.repositorySnapshot.upsert({
      where: { repositoryId_commitSha: { repositoryId: aliceOnly.id, commitSha: SHA } },
      create: {
        repositoryId: aliceOnly.id,
        commitSha: SHA,
        profile: {
          languages: { typescript: 1 },
          primaryLanguage: "typescript",
          supported: true,
          packageManager: "pnpm",
          typescript: true,
          frameworks: [],
          testFrameworks: ["Vitest"],
          scripts: {},
          monorepo: false,
          instructionFiles: [],
          testFileCount: 0,
          directories: {},
        },
        stats: { indexedFiles: 12, indexedBytes: 100, skipped: {}, truncated: false },
        paths: [],
      },
      update: {},
    });

    const detail = (await alice.get(`/api/repositories/${aliceOnly.id}`).expect(200)).body as RepositoryDetail;
    expect(detail).toMatchObject({ id: aliceOnly.id, fullName: aliceOnly.fullName, checksConfigured: true });
    expect(detail.latestSnapshot).toMatchObject({ commitSha: SHA, primaryLanguage: "typescript", packageManager: "pnpm", testFrameworks: ["Vitest"], indexedFiles: 12 });
    expect(detail.recentTasks.length).toBeGreaterThan(0);
    expect(detail.recentTasks.length).toBeLessThanOrEqual(5);
    expect(detail.recentTasks.every((t) => t.repositoryId === aliceOnly.id)).toBe(true);
    expect(Object.values(detail.taskCounts).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(detail.recentTasks.length);

    await bob.get(`/api/repositories/${aliceOnly.id}`).expect(404);
  });

  it("removes pending resume jobs when a task under review is cancelled", async () => {
    const id = await plannedTask(2);
    await alice.post(`/api/tasks/${id}/cancel`).expect(200);
    expect(queue.removed).toEqual(expect.arrayContaining([taskJobId(id, "start"), taskJobId(id, "plan-v2-approved"), taskJobId(id, "plan-v2-revise")]));
  });
});
