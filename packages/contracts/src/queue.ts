/** Queue names and job payloads shared by the API (producer) and worker (consumer). */
export const QUEUES = {
  AGENT_TASKS: "agent-tasks",
  /** Scheduled housekeeping, such as reconciling pull requests with GitHub. */
  MAINTENANCE: "maintenance",
} as const;

export const JOBS = {
  RUN_TASK: "run-task",
  RECONCILE_PULL_REQUESTS: "reconcile-pull-requests",
} as const;

/**
 * Job payloads carry identifiers only. Credentials, tokens, and repository
 * content are loaded by the worker at execution time and never enqueued.
 */
export interface RunTaskJob {
  taskId: string;
}

/**
 * Why a task is being (re)enqueued. A task is enqueued once when created and
 * again each time a human resumes it from a gate, so each resume needs its
 * own job id: BullMQ ignores an add whose id it still remembers.
 */
export type TaskJobKey = "start" | `plan-v${number}-approved` | `plan-v${number}-revise` | `pr-v${number}`;

/** Deterministic, so a retried request cannot enqueue the same step twice. */
export function taskJobId(taskId: string, key: TaskJobKey): string {
  return `${taskId}_${key}`;
}
