import { z } from "zod";

/** Opening a PR names the verified patch version the reviewer looked at. */
export const OpenPullRequestRequestSchema = z.object({ patchVersion: z.number().int().positive() }).strict();
export type OpenPullRequestRequest = z.infer<typeof OpenPullRequestRequestSchema>;

/** Mirrors PullRequestStatus in the Prisma schema. */
export const PULL_REQUEST_STATUSES = ["DRAFT", "OPEN", "CLOSED", "MERGED"] as const;
export type PullRequestStatus = (typeof PULL_REQUEST_STATUSES)[number];

export interface PullRequestSummary {
  number: number;
  url: string;
  status: PullRequestStatus;
  /** The patch version that was pushed. */
  patchVersion: number | null;
  branchName: string;
  baseBranch: string;
  /** The head commit on GitHub, updated by webhooks and reconciliation. */
  headSha: string;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  /** When CodePilot last confirmed the state with GitHub. */
  lastSyncedAt: string | null;
}
