import type { CheckResultSummary, PatchFileStat } from "@codepilot/contracts";
import { ContextPackageSchema, ImplementationPlanSchema, TaskStatus } from "@codepilot/contracts";
import { assertTaskBranch, buildPullRequest } from "@codepilot/agent-core";
import type { GitHubPullRequest, PullRequestGitHub } from "@codepilot/github";
import { GitHubApiError } from "@codepilot/github";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { WorkspaceManager } from "../analysis/workspace";
import { githubRemoteUrl } from "../git/git";
import type { CommitIdentity } from "../git/patch-ops";
import { pushNewBranch } from "../git/patch-ops";
import { checkoutForTask } from "../git/source";
import { commitMessage } from "../patching/patch-round";
import type { StageHandler } from "../pipeline";
import { TransientError } from "../pipeline";

export interface OpenPullRequestDeps {
  prisma: PrismaClient;
  /** Null when the GitHub App is not configured for this worker. */
  github: PullRequestGitHub | null;
  workspaces: WorkspaceManager;
  gitTimeoutMs: number;
  author: CommitIdentity;
  /** Overrides the push URL; tests point this at a local fixture repository. */
  remoteUrl?: (owner: string, name: string) => string;
}

/** A pull request that cannot be opened for a reason the user can act on. Not retried. */
export class PullRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PullRequestError";
  }
}

interface OpenedResult {
  number: number;
  url: string;
  headSha: string;
}

/**
 * OPENING_PR: push the verified patch to the task branch and open a draft PR.
 *
 * Every external effect is safe to repeat:
 * - the commit is rebuilt with a fixed date, so a retry pushes the identical SHA;
 * - the push only creates the branch, or finds it already at that SHA;
 * - an existing PR for the branch is reused instead of opening another;
 * - an idempotency key records the finished PR, so a crash after GitHub
 *   answered but before the database caught up does not repeat anything.
 *
 * If the stage fails for good or is cancelled after pushing and before a PR
 * exists, it deletes the branch it pushed.
 */
export function createOpenPullRequestStage(deps: OpenPullRequestDeps): StageHandler {
  return async ({ taskId, signal }) => {
    const task = await deps.prisma.agentTask.findUniqueOrThrow({
      where: { id: taskId },
      include: {
        repository: { include: { installation: true } },
        issue: true,
        pullRequests: { select: { id: true } },
        patches: {
          where: { status: { in: ["VERIFIED", "SUBMITTED"] } },
          orderBy: { version: "desc" },
          take: 1,
          include: {
            plan: { include: { reviewedBy: { select: { githubLogin: true } } } },
            testRuns: { where: { status: "PASSED" }, orderBy: { completedAt: "desc" }, take: 1, include: { results: { orderBy: { position: "asc" } } } },
          },
        },
      },
    });
    if (task.pullRequests.length > 0) return TaskStatus.PR_OPENED;

    const patch = task.patches[0];
    const verification = patch?.testRuns[0];
    if (!patch || !verification) throw new PullRequestError("The task has no verified patch with passing checks");
    if (!deps.github) throw new PullRequestError("The GitHub App is not configured for the worker");
    const github = deps.github;

    const { repository } = task;
    const installationId = repository.installation.installationId;
    const analysis = ContextPackageSchema.safeParse(task.analysis);
    const baseBranch = analysis.success ? analysis.data.branch : repository.defaultBranch;
    assertTaskBranch(patch.branchName, [repository.defaultBranch, baseBranch]);

    const key = `open-pr:${taskId}:${patch.id}`;
    const claimed = await deps.prisma.idempotencyKey.upsert({ where: { key }, create: { key, scope: "open-pull-request" }, update: {} });
    if (claimed.state === "COMPLETED") {
      await record(deps.prisma, taskId, repository.id, patch.id, patch.branchName, baseBranch, key, claimed.result as unknown as OpenedResult);
      return TaskStatus.PR_OPENED;
    }

    const plan = ImplementationPlanSchema.safeParse(patch.plan.planJson);
    if (!plan.success) throw new PullRequestError(`Approved plan version ${patch.plan.version} is malformed`);
    const repairs = await deps.prisma.patch.count({ where: { taskId, planId: patch.planId, version: { lt: patch.version } } });
    const remoteUrl = (deps.remoteUrl ?? githubRemoteUrl)(repository.owner, repository.name);
    const fromGitHub = remoteUrl.startsWith("https://github.com/");

    let pushedSha: string | null = null;
    let opened: OpenedResult | null = null;
    const workspace = await deps.workspaces.create(taskId);
    try {
      const { repo, headSha } = await checkoutForTask({ github, gitTimeoutMs: deps.gitTimeoutMs, remoteUrl: () => remoteUrl }, repository, workspace, {
        baseSha: patch.baseSha,
        branch: patch.branchName,
        signal,
        patch: {
          diff: patch.patchContent,
          treeSha: patch.treeSha,
          commit: { message: commitMessage(patch.commitMessage, patch.summary, taskId, patch.plan.version), identity: deps.author, date: patch.createdAt },
        },
      });

      const remoteHead = await github.findBranchHeadSha(installationId, repository.owner, repository.name, patch.branchName).catch(classify);
      if (remoteHead !== null && remoteHead !== headSha) {
        throw new PullRequestError(`The branch ${patch.branchName} already exists on GitHub at a different commit; it was not overwritten`);
      }
      if (remoteHead === null) {
        await pushNewBranch(repo, {
          remoteUrl,
          branch: patch.branchName,
          token: fromGitHub ? await github.getInstallationToken(installationId) : null,
          protectedBranches: [repository.defaultBranch, baseBranch],
          allowFileProtocol: remoteUrl.startsWith("file://"),
        });
        pushedSha = headSha;
        await deps.prisma.taskEvent.create({ data: { taskId, eventType: "branch_pushed", payload: { branch: patch.branchName, commitSha: headSha } } });
      }

      let pr: GitHubPullRequest | null = await github.findPullRequestByHead(installationId, repository.owner, repository.name, patch.branchName).catch(classify);
      if (pr && pr.head.sha !== headSha) {
        throw new PullRequestError(`A pull request (#${pr.number}) for ${patch.branchName} already exists with a different commit`);
      }
      if (!pr) {
        const content = buildPullRequest({
          taskId,
          issue: task.issue ? { number: task.issue.githubIssueNumber, title: task.issue.title } : null,
          description: task.description,
          plan: plan.data,
          planVersion: patch.plan.version,
          planApprovedBy: patch.plan.reviewedBy?.githubLogin ?? null,
          patch: { ...patch, files: patch.files as unknown as PatchFileStat[] },
          repairs,
          baseBranch,
          checks: {
            runnerImage: verification.runnerImage,
            results: verification.results.map((r) => ({ ...r, kind: r.kind as CheckResultSummary["kind"] })),
          },
        });
        pr = await github
          .createPullRequest(installationId, repository.owner, repository.name, { ...content, head: patch.branchName, base: baseBranch, draft: true })
          .catch(classify);
      }
      opened = { number: pr.number, url: pr.html_url, headSha: pr.head.sha };

      await deps.prisma.idempotencyKey.update({
        where: { key },
        data: { state: "COMPLETED", result: opened as unknown as Prisma.InputJsonObject, completedAt: new Date() },
      });
      await record(deps.prisma, taskId, repository.id, patch.id, patch.branchName, baseBranch, key, opened);
      return TaskStatus.PR_OPENED;
    } catch (err) {
      // A pushed branch with no pull request is cleaned up, unless a retry will come back for it.
      const retrying = err instanceof TransientError && !signal.aborted;
      if (pushedSha && !opened && !retrying) {
        await github.deleteBranch(installationId, repository.owner, repository.name, patch.branchName).catch(() => undefined);
        await deps.prisma.taskEvent.create({ data: { taskId, eventType: "branch_deleted", payload: { branch: patch.branchName, reason: "pull request not opened" } } });
      }
      throw err;
    } finally {
      await workspace.remove();
    }
  };
}

/** Stores the opened PR and marks the patch submitted. Repeating it changes nothing. */
async function record(
  prisma: PrismaClient,
  taskId: string,
  repositoryId: string,
  patchId: string,
  branchName: string,
  baseBranch: string,
  key: string,
  opened: OpenedResult,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.pullRequest.findUnique({ where: { taskId } });
    if (existing) return;
    await tx.pullRequest.create({
      data: {
        taskId,
        repositoryId,
        patchId,
        githubPrNumber: opened.number,
        githubPrUrl: opened.url,
        headSha: opened.headSha,
        branchName,
        baseBranch,
        status: "DRAFT",
        lastSyncedAt: new Date(),
      },
    });
    await tx.patch.update({ where: { id: patchId }, data: { status: "SUBMITTED" } });
    await tx.taskEvent.create({ data: { taskId, eventType: "pull_request_opened", payload: { number: opened.number, url: opened.url, idempotencyKey: key } } });
  });
}

/**
 * GitHub rate limits and outages are retried by the queue; a refusal is not.
 * Messages never include response bodies, which can echo credentials.
 */
function classify(err: unknown): never {
  if (err instanceof GitHubApiError) {
    if (err.status === 429 || err.status >= 500) throw new TransientError(`GitHub is unavailable (${err.status}); will retry`, { cause: err });
    if (err.status === 401 || err.status === 403) {
      throw new PullRequestError(`GitHub refused the request (${err.status}); the app needs Contents and Pull requests write access on this repository`);
    }
    if (err.status === 422) throw new PullRequestError("GitHub rejected the pull request (422); check that draft pull requests are available for this repository");
    throw new PullRequestError(err.message);
  }
  if (err instanceof TypeError) throw new TransientError("Could not reach GitHub; will retry", { cause: err });
  throw err;
}
