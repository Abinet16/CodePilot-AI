import { z } from "zod";
import type { ProjectProfile } from "./analysis";
import type { TaskSummary } from "./api";
import type { PullRequestStatus } from "./pull-request";
import type { RepositorySummary } from "./repositories";
import { TaskStatus } from "./task-status";

/**
 * How the dashboard groups task statuses. "review" is where the agent waits
 * for a person; "active" is where the agent is working.
 */
export const TASK_STATUS_GROUPS = {
  review: [TaskStatus.AWAITING_PLAN_APPROVAL, TaskStatus.READY_FOR_REVIEW],
  active: [
    TaskStatus.QUEUED,
    TaskStatus.ANALYZING,
    TaskStatus.PLANNING,
    TaskStatus.GENERATING_PATCH,
    TaskStatus.RUNNING_CHECKS,
    TaskStatus.REPAIRING,
    TaskStatus.OPENING_PR,
  ],
  done: [TaskStatus.PR_OPENED],
  failed: [TaskStatus.FAILED],
  cancelled: [TaskStatus.CANCELLED],
} as const satisfies Record<string, readonly TaskStatus[]>;

export type TaskStatusGroup = keyof typeof TASK_STATUS_GROUPS;
export const TASK_STATUS_GROUP_NAMES = Object.keys(TASK_STATUS_GROUPS) as [TaskStatusGroup, ...TaskStatusGroup[]];

export function statusGroupOf(status: TaskStatus): TaskStatusGroup {
  return TASK_STATUS_GROUP_NAMES.find((g) => (TASK_STATUS_GROUPS[g] as readonly TaskStatus[]).includes(status))!;
}

/** Query string of GET /tasks. Unknown parameters are rejected rather than ignored. */
export const ListTasksQuerySchema = z
  .object({
    repositoryId: z.string().uuid().optional(),
    group: z.enum(TASK_STATUS_GROUP_NAMES).optional(),
    /** Opaque, from the previous page's nextCursor. */
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,200}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>;

export interface TaskListItem extends TaskSummary {
  group: TaskStatusGroup;
  /** When the task last changed: its newest event. */
  updatedAt: string;
  pullRequest: { number: number; url: string; status: PullRequestStatus } | null;
  estimatedCostUsd: number;
}

export interface TaskPage {
  items: TaskListItem[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface UsageTotalsByKey {
  key: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  calls: number;
}

/** The signed-in user's own model usage over a window of days. */
export interface UsageReport {
  days: number;
  since: string;
  totals: Omit<UsageTotalsByKey, "key">;
  /** One entry per UTC day in the window, oldest first, including days with no usage. */
  daily: UsageTotalsByKey[];
  byModel: UsageTotalsByKey[];
  byProvider: UsageTotalsByKey[];
  byRepository: UsageTotalsByKey[];
}

export const UsageQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).strict();
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

export interface DashboardResponse {
  counts: Record<TaskStatusGroup, number>;
  /** Tasks waiting on a person, oldest first: the reviewer's queue. */
  needsReview: TaskListItem[];
  recent: TaskListItem[];
  pullRequests: Record<PullRequestStatus, number>;
  repositories: { visible: number; enabled: number };
  usage: { days: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number };
}

export interface RepositoryDetail extends RepositorySummary {
  latestSnapshot: {
    commitSha: string;
    indexedAt: string;
    primaryLanguage: ProjectProfile["primaryLanguage"];
    packageManager: ProjectProfile["packageManager"];
    testFrameworks: string[];
    indexedFiles: number;
  } | null;
  checksConfigured: boolean;
  openIssues: number;
  taskCounts: Record<TaskStatusGroup, number>;
  recentTasks: TaskListItem[];
}
