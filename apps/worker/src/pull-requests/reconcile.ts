import { nextPullRequestState } from "@codepilot/agent-core";
import type { PullRequestGitHub } from "@codepilot/github";
import { GitHubApiError } from "@codepilot/github";
import type { PrismaClient } from "@prisma/client";

export interface ReconcileOptions {
  /** Pull requests confirmed more recently than this are skipped. */
  staleAfterMs: number;
  /** Bounds GitHub API calls per run. */
  limit: number;
  now?: Date;
}

export interface ReconcileResult {
  checked: number;
  updated: number;
  failed: number;
}

/**
 * Brings open and draft pull requests in step with GitHub, for anything a
 * webhook missed (delivery failures, downtime, an app without the webhook
 * subscribed). The same state rules as the webhook apply, so a late webhook
 * and a reconciliation can never undo each other.
 */
export async function reconcilePullRequests(prisma: PrismaClient, github: PullRequestGitHub, options: ReconcileOptions): Promise<ReconcileResult> {
  const now = options.now ?? new Date();
  const rows = await prisma.pullRequest.findMany({
    where: {
      status: { in: ["DRAFT", "OPEN"] },
      OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(now.getTime() - options.staleAfterMs) } }],
    },
    include: { repository: { include: { installation: true } } },
    orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } },
    take: options.limit,
  });

  const result: ReconcileResult = { checked: 0, updated: 0, failed: 0 };
  for (const row of rows) {
    result.checked++;
    const { repository } = row;
    try {
      const pr = await github.getPullRequest(repository.installation.installationId, repository.owner, repository.name, row.githubPrNumber);
      const update = nextPullRequestState(row, pr);
      await prisma.$transaction(async (tx) => {
        if (!update) {
          await tx.pullRequest.update({ where: { id: row.id }, data: { lastSyncedAt: now } });
          return;
        }
        const { event, ...data } = update;
        await tx.pullRequest.update({ where: { id: row.id }, data: { ...data, lastSyncedAt: now } });
        if (event) {
          await tx.taskEvent.create({ data: { taskId: row.taskId, eventType: event, payload: { number: row.githubPrNumber, source: "reconciliation" } } });
          result.updated++;
        }
      });
    } catch (err) {
      // One repository's failure (lost access, deleted PR) must not stop the others; try again next run.
      result.failed++;
      const reason = err instanceof GitHubApiError ? err.message : err instanceof Error ? err.message : String(err);
      console.warn(`[worker] could not reconcile PR #${row.githubPrNumber} of ${repository.owner}/${repository.name}: ${reason}`);
      await prisma.pullRequest.update({ where: { id: row.id }, data: { lastSyncedAt: now } });
    }
  }
  return result;
}
