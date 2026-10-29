import type { ContextPackage } from "@codepilot/contracts";
import { ContextPackageSchema, TaskStatus } from "@codepilot/contracts";
import type { AnalysisLimits, ContextBudget } from "@codepilot/agent-core";
import {
  DEFAULT_ANALYSIS_LIMITS,
  DEFAULT_CONTEXT_BUDGET,
  assembleContext,
  buildRetrievalQuery,
  detectProjectProfile,
  findRelatedTests,
} from "@codepilot/agent-core";
import type { InstallationGitHub } from "@codepilot/github";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { StageHandler } from "../pipeline";
import { fetchCommit, githubRemoteUrl } from "./git";
import type { ContextRetriever } from "./retriever";
import { scanRepository } from "./scan";
import type { Snapshot, SnapshotStore } from "./snapshot-store";
import type { WorkspaceManager } from "./workspace";

export interface AnalyzeStageDeps {
  prisma: PrismaClient;
  /** Null when the GitHub App is not configured for this worker. */
  github: InstallationGitHub | null;
  snapshots: SnapshotStore;
  retriever: ContextRetriever;
  workspaces: WorkspaceManager;
  maxRepositorySizeMb: number;
  gitTimeoutMs: number;
  snapshotsToKeep: number;
  limits?: AnalysisLimits;
  budget?: ContextBudget;
  /** Overrides the clone URL; tests point this at a local fixture repository. */
  remoteUrl?: (owner: string, name: string) => string;
}

/** A task that cannot be analyzed for a reason the user can act on. */
export class AnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisError";
  }
}

/**
 * ANALYZING: pin the commit, index it (once per commit), and store a bounded
 * context package for planning. Safe to re-run after a crash: the pinned SHA
 * is reused and an existing snapshot is not indexed again.
 */
export function createAnalyzeStage(deps: AnalyzeStageDeps): StageHandler {
  return async ({ taskId, signal }) => {
    const task = await deps.prisma.agentTask.findUniqueOrThrow({
      where: { id: taskId },
      include: { repository: { include: { installation: true } }, issue: true },
    });
    const { repository } = task;
    const fullName = `${repository.owner}/${repository.name}`;

    if (!repository.enabled || repository.removedAt) throw new AnalysisError(`${fullName} is not enabled for the agent`);
    if (repository.installation.status !== "ACTIVE") throw new AnalysisError(`The GitHub App installation for ${fullName} is not active`);
    if (!deps.github) throw new AnalysisError("The GitHub App is not configured for the worker");
    const github = deps.github;
    const installationId = repository.installation.installationId;

    let branch = repository.defaultBranch;
    let commitSha = task.baseSha;
    if (!commitSha) {
      const meta = await github.getRepository(installationId, repository.owner, repository.name);
      if (meta.archived) throw new AnalysisError(`${fullName} is archived on GitHub`);
      if ((meta.size ?? 0) > deps.maxRepositorySizeMb * 1024) {
        throw new AnalysisError(`${fullName} is larger than the ${deps.maxRepositorySizeMb} MB analysis limit`);
      }
      branch = meta.default_branch;
      commitSha = await pinCommit(deps.prisma, taskId, branch, await github.getBranchHeadSha(installationId, repository.owner, repository.name, branch));
    }

    let snapshot = await deps.snapshots.find(repository.id, commitSha);
    if (!snapshot) {
      snapshot = await indexCommit(deps, taskId, repository, installationId, commitSha, signal);
      await deps.snapshots.prune(repository.id, deps.snapshotsToKeep);
    }

    const queryText = task.issue ? `${task.issue.title}\n\n${task.issue.body ?? ""}` : (task.description ?? "");
    const query = buildRetrievalQuery(queryText);
    const budget = deps.budget ?? DEFAULT_CONTEXT_BUDGET;
    const assembled = assembleContext(await deps.retriever.candidates(snapshot.id, query), budget);

    const analysis: ContextPackage = ContextPackageSchema.parse({
      repository: fullName,
      branch,
      commitSha,
      query: queryText.slice(0, 2_000),
      profile: snapshot.profile,
      stats: snapshot.stats,
      snippets: assembled.snippets,
      relatedTests: findRelatedTests(
        assembled.snippets.map((s) => s.path),
        snapshot.paths,
      ),
      budget: { maxChars: budget.maxChars, usedChars: assembled.usedChars, droppedSnippets: assembled.droppedSnippets },
    });

    await deps.prisma.$transaction([
      deps.prisma.agentTask.updateMany({
        where: { id: taskId, status: TaskStatus.ANALYZING },
        data: { analysis: analysis as unknown as Prisma.InputJsonObject },
      }),
      deps.prisma.taskEvent.create({
        data: {
          taskId,
          eventType: "analysis_completed",
          payload: { commitSha, snapshotId: snapshot.id, snippets: analysis.snippets.length, usedChars: assembled.usedChars },
        },
      }),
    ]);

    if (!snapshot.profile.supported) {
      throw new AnalysisError(
        `Primary language ${snapshot.profile.primaryLanguage ?? "unknown"} is not supported yet; this release supports TypeScript and JavaScript`,
      );
    }
    return TaskStatus.PLANNING;
  };
}

/** Records the analyzed commit exactly once. If another worker pinned first, its SHA wins. */
async function pinCommit(prisma: PrismaClient, taskId: string, branch: string, sha: string): Promise<string> {
  const pinned = await prisma.$transaction(async (tx) => {
    const { count } = await tx.agentTask.updateMany({
      where: { id: taskId, status: TaskStatus.ANALYZING, baseSha: null },
      data: { baseSha: sha },
    });
    if (count === 1) {
      await tx.taskEvent.create({ data: { taskId, eventType: "commit_pinned", payload: { branch, commitSha: sha } } });
    }
    return (await tx.agentTask.findUniqueOrThrow({ where: { id: taskId }, select: { baseSha: true } })).baseSha;
  });
  if (!pinned) throw new AnalysisError("Task left ANALYZING before its commit could be pinned");
  return pinned;
}

async function indexCommit(
  deps: AnalyzeStageDeps,
  taskId: string,
  repository: { id: string; owner: string; name: string },
  installationId: bigint,
  commitSha: string,
  signal: AbortSignal,
): Promise<Snapshot> {
  const workspace = await deps.workspaces.create(taskId);
  try {
    const remoteUrl = (deps.remoteUrl ?? githubRemoteUrl)(repository.owner, repository.name);
    await fetchCommit({
      repoDir: workspace.repoDir,
      homeDir: workspace.homeDir,
      remoteUrl,
      commitSha,
      token: remoteUrl.startsWith("https://github.com/") ? await deps.github!.getInstallationToken(installationId) : null,
      timeoutMs: deps.gitTimeoutMs,
      signal,
      allowFileProtocol: remoteUrl.startsWith("file://"),
    });

    const scan = await scanRepository(workspace.repoDir, deps.limits ?? DEFAULT_ANALYSIS_LIMITS);
    const profile = detectProjectProfile({
      paths: scan.paths,
      indexed: scan.files,
      packageJson: scan.files.find((f) => f.path === "package.json")?.content ?? null,
    });
    return await deps.snapshots.save(repository.id, commitSha, scan, profile);
  } finally {
    await workspace.remove();
  }
}
