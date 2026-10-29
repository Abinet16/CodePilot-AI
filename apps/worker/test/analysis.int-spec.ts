import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ContextPackage, TaskStatus } from "@codepilot/contracts";
import { detectProjectProfile } from "@codepilot/agent-core";
import type { GitHubRepository, InstallationGitHub } from "@codepilot/github";
import { PrismaClient } from "@prisma/client";
import { createAnalyzeStage } from "../src/analysis/analyze-stage";
import { ContextRetriever } from "../src/analysis/retriever";
import { scanRepository } from "../src/analysis/scan";
import { SnapshotStore } from "../src/analysis/snapshot-store";
import { WorkspaceManager } from "../src/analysis/workspace";
import { runPipeline } from "../src/pipeline";
import { TaskStateStore } from "../src/task-state";
import type { FixtureRepo } from "./git-fixture";
import { createFixtureRepo } from "./git-fixture";

const SECRET = "sk_live_fixture_should_never_be_indexed";

const tsProject = {
  "package.json": JSON.stringify({
    scripts: { test: "jest", lint: "eslint ." },
    dependencies: { express: "5.0.0" },
    devDependencies: { jest: "29.7.0", typescript: "5.9.3" },
  }),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "AGENTS.md": "# Agent notes\n\nRun `pnpm test` before proposing changes.\n",
  ".env": `STRIPE_KEY=${SECRET}\n`,
  "src/pagination.ts": [
    "export interface Page<T> {",
    "  items: T[];",
    "  totalPages: number;",
    "}",
    "",
    "export function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {",
    "  const totalPages = Math.floor(items.length / pageSize);",
    "  return { items: items.slice(page * pageSize, (page + 1) * pageSize), totalPages };",
    "}",
    "",
  ].join("\n"),
  "src/pagination.test.ts": 'import { paginate } from "./pagination";\n\ntest("pages", () => expect(paginate([1], 0, 1).totalPages).toBe(1));\n',
  "src/users/user-service.ts": [
    "export class UserService {",
    "  async findById(identifier: string) {",
    "    return this.lookup(identifier);",
    "  }",
    "",
    "  private lookup(identifier: string) {",
    "    return { identifier };",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/unrelated.ts": "export const color = 'blue';\n",
};

/** Requires a migrated PostgreSQL at DATABASE_URL and git on PATH. */
describe("repository analysis (PostgreSQL + git)", () => {
  const prisma = new PrismaClient();
  const states = new TaskStateStore(prisma);
  const snapshots = new SnapshotStore(prisma);
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "codepilot-workspaces-"));
  const fixtures: FixtureRepo[] = [];
  const suffix = Date.now() * 1000;
  let seq = 0;
  let userId: string;
  let installationId: string;

  const remoteFor = new Map<string, FixtureRepo>();
  const clones: string[] = [];

  const github: InstallationGitHub = {
    getInstallationToken: async () => "installation-token",
    getRepository: async (_id, owner, name) =>
      ({ id: 1, name, owner: { login: owner }, default_branch: "main", private: true, archived: false, size: 10 }) as GitHubRepository,
    getBranchHeadSha: async (_id, _owner, name) => remoteFor.get(name)!.commitSha,
  };

  const analyze = createAnalyzeStage({
    prisma,
    github,
    snapshots,
    retriever: new ContextRetriever(prisma),
    workspaces: new WorkspaceManager(workspaceRoot),
    maxRepositorySizeMb: 100,
    gitTimeoutMs: 30_000,
    snapshotsToKeep: 2,
    remoteUrl: (_owner, name) => {
      clones.push(name);
      return remoteFor.get(name)!.url;
    },
  });

  async function createRepository(files: Parameters<typeof createFixtureRepo>[0], enabled = true) {
    const fixture = createFixtureRepo(files);
    fixtures.push(fixture);
    const name = `repo-${suffix}-${++seq}`;
    remoteFor.set(name, fixture);
    const repository = await prisma.repository.create({
      data: { installationId, githubRepoId: BigInt(suffix + seq), owner: "acme", name, defaultBranch: "main", enabled },
    });
    return { repository, fixture };
  }

  async function runTask(repositoryId: string, description: string) {
    const task = await prisma.agentTask.create({ data: { repositoryId, requestedById: userId, description } });
    const status = await runPipeline(
      task.id,
      {
        stages: {
          QUEUED: async () => "ANALYZING",
          ANALYZING: analyze,
          // Planning lands in week 4; stopping at the approval gate keeps the task inspectable.
          PLANNING: async () => "AWAITING_PLAN_APPROVAL",
        },
        loadStatus: async (id) => (await prisma.agentTask.findUniqueOrThrow({ where: { id } })).status as TaskStatus,
        transition: (id, from, to) => states.transition(id, from, to),
        fail: (id, from, reason) => states.fail(id, from, reason),
      },
      new AbortController().signal,
    );
    const stored = await prisma.agentTask.findUniqueOrThrow({ where: { id: task.id }, include: { events: { orderBy: { createdAt: "asc" } } } });
    return { status, task: stored, analysis: stored.analysis as unknown as ContextPackage | null };
  }

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { githubId: BigInt(suffix), githubLogin: `analyst-${suffix}` } });
    userId = user.id;
    installationId = (await prisma.githubInstallation.create({ data: { installationId: BigInt(suffix), accountLogin: "acme" } })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(workspaceRoot, { recursive: true, force: true });
    for (const f of fixtures) rmSync(f.dir, { recursive: true, force: true });
  });

  it("pins the commit, indexes it, and stores a bounded context package", async () => {
    const { repository, fixture } = await createRepository(tsProject);
    const { status, task, analysis } = await runTask(
      repository.id,
      "Fix the off-by-one in `paginate`: the last partial page is dropped. See src/pagination.ts",
    );

    expect(status).toBe("AWAITING_PLAN_APPROVAL");
    expect(task.baseSha).toBe(fixture.commitSha);
    expect(task.events.map((e) => e.eventType)).toEqual(expect.arrayContaining(["commit_pinned", "analysis_completed"]));

    expect(analysis).not.toBeNull();
    expect(analysis!.commitSha).toBe(fixture.commitSha);
    expect(analysis!.branch).toBe("main");
    expect(analysis!.snippets[0]).toMatchObject({ path: "src/pagination.ts", startLine: 1 });
    expect(analysis!.snippets[0]!.reasons).toEqual(expect.arrayContaining(["path_mentioned", "symbol_match"]));
    expect(analysis!.snippets.some((s) => s.path === "AGENTS.md" && s.reasons.includes("instructions"))).toBe(true);
    expect(analysis!.relatedTests).toEqual(["src/pagination.test.ts"]);
    expect(analysis!.budget.usedChars).toBeLessThanOrEqual(analysis!.budget.maxChars);
    expect(analysis!.profile).toMatchObject({
      primaryLanguage: "typescript",
      supported: true,
      packageManager: "pnpm",
      frameworks: ["Express"],
      testFrameworks: ["Jest"],
      instructionFiles: ["AGENTS.md"],
      testFileCount: 1,
    });
    expect(analysis!.stats.skipped).toMatchObject({ secret: 1, lockfile: 1 });
  });

  it("never stores secret files and always cleans up the workspace", async () => {
    expect(await prisma.codeChunk.count({ where: { content: { contains: SECRET } } })).toBe(0);
    expect(await prisma.repositoryFile.count({ where: { path: ".env" } })).toBe(0);
    expect(readdirSync(workspaceRoot)).toEqual([]);
  });

  it("finds code by full-text search when the task names no paths or symbols", async () => {
    const { repository } = await createRepository(tsProject);
    const { analysis } = await runTask(repository.id, "Looking up a user by identifier is slow and should be cached");
    const top = analysis!.snippets.find((s) => s.reasons.includes("text_match"));
    expect(top?.path).toBe("src/users/user-service.ts");
  });

  it("reuses the snapshot for a commit that is already indexed", async () => {
    const { repository } = await createRepository(tsProject);
    await runTask(repository.id, "Explain how pagination works in this project");
    const clonesBefore = clones.length;

    const second = await runTask(repository.id, "Add a pageSize limit to paginate");
    expect(second.status).toBe("AWAITING_PLAN_APPROVAL");
    expect(clones.length).toBe(clonesBefore);
    expect(await prisma.repositorySnapshot.count({ where: { repositoryId: repository.id } })).toBe(1);
  });

  it("indexes a commit only once when two workers race", async () => {
    const { repository, fixture } = await createRepository(tsProject);
    const scan = await scanRepository(fixture.dir);
    const profile = detectProjectProfile({ paths: scan.paths, indexed: scan.files, packageJson: null });
    const sha = "c".repeat(40);

    const [a, b] = await Promise.all([snapshots.save(repository.id, sha, scan, profile), snapshots.save(repository.id, sha, scan, profile)]);
    expect(a.id).toBe(b.id);
    expect(await prisma.repositorySnapshot.count({ where: { repositoryId: repository.id } })).toBe(1);
    expect(await prisma.repositoryFile.count({ where: { snapshotId: a.id } })).toBe(scan.files.length);
  });

  it("keeps only the newest snapshots per repository", async () => {
    const { repository, fixture } = await createRepository(tsProject);
    const scan = await scanRepository(fixture.dir);
    const profile = detectProjectProfile({ paths: scan.paths, indexed: scan.files, packageJson: null });
    for (const c of ["1", "2", "3"]) await snapshots.save(repository.id, c.repeat(40), scan, profile);

    expect(await snapshots.prune(repository.id, 2)).toBe(1);
    const remaining = await prisma.repositorySnapshot.findMany({ where: { repositoryId: repository.id }, orderBy: { indexedAt: "asc" } });
    expect(remaining.map((s) => s.commitSha)).toEqual(["2".repeat(40), "3".repeat(40)]);
  });

  it("fails clearly for an unsupported language but keeps the analysis", async () => {
    const { repository } = await createRepository({ "main.py": "def main():\n    pass\n", "lib/util.py": "X = 1\n" });
    const { status, task, analysis } = await runTask(repository.id, "Make main print hello");
    expect(status).toBe("FAILED");
    expect(task.failureReason).toMatch(/python is not supported yet/);
    expect(analysis?.profile.primaryLanguage).toBe("python");
  });

  it("refuses to analyze a repository that is not enabled", async () => {
    const { repository } = await createRepository(tsProject, false);
    const clonesBefore = clones.length;
    const { status, task } = await runTask(repository.id, "Fix the off-by-one in paginate");
    expect(status).toBe("FAILED");
    expect(task.failureReason).toMatch(/not enabled/);
    expect(task.baseSha).toBeNull();
    expect(clones.length).toBe(clonesBefore);
  });
});
