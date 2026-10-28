import { PrismaClient } from "@prisma/client";
import { StaleTransitionError, TaskStateStore } from "../src/task-state";

/** Requires a migrated PostgreSQL at DATABASE_URL (docker compose up -d postgres). */
describe("TaskStateStore (PostgreSQL)", () => {
  const prisma = new PrismaClient();
  const store = new TaskStateStore(prisma);
  let taskId: string;

  beforeAll(async () => {
    const suffix = Date.now();
    const user = await prisma.user.create({ data: { githubId: BigInt(suffix), githubLogin: `user-${suffix}` } });
    const installation = await prisma.githubInstallation.create({
      data: { installationId: BigInt(suffix), accountLogin: user.githubLogin },
    });
    const repo = await prisma.repository.create({
      data: {
        installationId: installation.id,
        githubRepoId: BigInt(suffix),
        owner: user.githubLogin,
        name: "demo",
        defaultBranch: "main",
      },
    });
    const task = await prisma.agentTask.create({
      data: { repositoryId: repo.id, requestedById: user.id, description: "Fix the pagination bug" },
    });
    taskId = task.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("persists a transition with an audit event and start time", async () => {
    await store.transition(taskId, "QUEUED", "ANALYZING");
    const task = await prisma.agentTask.findUniqueOrThrow({ where: { id: taskId }, include: { events: true } });
    expect(task.status).toBe("ANALYZING");
    expect(task.startedAt).not.toBeNull();
    expect(task.events).toHaveLength(1);
    expect(task.events[0]).toMatchObject({ fromStatus: "QUEUED", toStatus: "ANALYZING" });
  });

  it("lets exactly one of two racing transitions win", async () => {
    const results = await Promise.allSettled([
      store.transition(taskId, "ANALYZING", "PLANNING"),
      store.transition(taskId, "ANALYZING", "CANCELLED"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(StaleTransitionError);
    expect(await prisma.taskEvent.count({ where: { taskId } })).toBe(2);
  });
});
