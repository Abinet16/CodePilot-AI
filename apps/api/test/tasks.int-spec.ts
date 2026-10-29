import type { IssueSummary, RepositorySummary, TaskDetail, TaskSummary } from "@codepilot/contracts";
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
  readonly removed: string[] = [];
  fail = false;
  async enqueue(taskId: string): Promise<void> {
    if (this.fail) throw new Error("redis down");
    this.enqueued.push(taskId);
  }
  async remove(taskId: string): Promise<void> {
    this.removed.push(taskId);
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
    expect(task).toMatchObject({ status: "QUEUED", repositoryFullName: shared.fullName, title: "Fix the pagination off-by-one error", analysis: null });
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

    const aliceTasks = (await alice.get("/api/tasks").expect(200)).body as TaskSummary[];
    const bobTasks = (await bob.get("/api/tasks").expect(200)).body as TaskSummary[];
    expect(aliceTasks.some((t) => t.id === privateTask.id)).toBe(true);
    expect(bobTasks.some((t) => t.id === privateTask.id)).toBe(false);
    expect(bobTasks.length).toBeGreaterThan(0);

    const filtered = (await alice.get(`/api/tasks?repositoryId=${aliceOnly.id}`).expect(200)).body as TaskSummary[];
    expect(filtered.map((t) => t.id)).toEqual([privateTask.id]);
    await alice.get("/api/tasks?repositoryId=nope").expect(400);

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
    expect(queue.removed).toContain(task.id);

    await alice.post(`/api/tasks/${task.id}/cancel`).expect(409);
    expect(await prisma.auditLog.count({ where: { taskId: task.id, action: "task.cancelled" } })).toBe(1);
  });
});
