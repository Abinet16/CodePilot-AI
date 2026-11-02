import type { PullRequestStatus } from "@codepilot/contracts";

/** The fields of a GitHub pull request (REST or webhook payload) that decide its status. */
export interface GitHubPullRequestState {
  state: "open" | "closed";
  draft?: boolean;
  merged_at: string | null;
  closed_at: string | null;
  updated_at: string;
  head: { sha: string };
}

export interface StoredPullRequestState {
  status: PullRequestStatus;
  headSha: string;
  githubUpdatedAt: Date | null;
}

export interface PullRequestUpdate {
  status: PullRequestStatus;
  headSha: string;
  githubUpdatedAt: Date;
  mergedAt: Date | null;
  closedAt: Date | null;
  /** A task event to record when the status changed, e.g. pull_request_merged. */
  event: string | null;
}

export function statusFromGitHub(pr: GitHubPullRequestState): PullRequestStatus {
  if (pr.merged_at) return "MERGED";
  if (pr.state === "closed") return "CLOSED";
  return pr.draft ? "DRAFT" : "OPEN";
}

const EVENTS: Record<PullRequestStatus, string> = {
  DRAFT: "pull_request_converted_to_draft",
  OPEN: "pull_request_ready_for_review",
  CLOSED: "pull_request_closed",
  MERGED: "pull_request_merged",
};

/**
 * Decides how a stored pull request changes given what GitHub reports.
 * Returns null for a report older than the stored one: webhook deliveries
 * can arrive late or out of order, and must not roll the state back.
 * A merged pull request stays merged.
 */
export function nextPullRequestState(stored: StoredPullRequestState, incoming: GitHubPullRequestState): PullRequestUpdate | null {
  const updatedAt = new Date(incoming.updated_at);
  if (Number.isNaN(updatedAt.getTime())) return null;
  if (stored.githubUpdatedAt && updatedAt < stored.githubUpdatedAt) return null;

  const status = stored.status === "MERGED" ? "MERGED" : statusFromGitHub(incoming);
  const reopened = stored.status === "CLOSED" && (status === "OPEN" || status === "DRAFT");
  return {
    status,
    headSha: incoming.head.sha,
    githubUpdatedAt: updatedAt,
    mergedAt: incoming.merged_at ? new Date(incoming.merged_at) : null,
    closedAt: incoming.closed_at ? new Date(incoming.closed_at) : null,
    event: status === stored.status ? null : reopened ? "pull_request_reopened" : EVENTS[status],
  };
}
