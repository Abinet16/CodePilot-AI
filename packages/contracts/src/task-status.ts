/**
 * Agent task lifecycle. Every transition is persisted, so the allowed edges
 * here are the single source of truth for both the API and the worker.
 */
export const TaskStatus = {
  QUEUED: "QUEUED",
  ANALYZING: "ANALYZING",
  PLANNING: "PLANNING",
  AWAITING_PLAN_APPROVAL: "AWAITING_PLAN_APPROVAL",
  GENERATING_PATCH: "GENERATING_PATCH",
  RUNNING_CHECKS: "RUNNING_CHECKS",
  REPAIRING: "REPAIRING",
  READY_FOR_REVIEW: "READY_FOR_REVIEW",
  OPENING_PR: "OPENING_PR",
  PR_OPENED: "PR_OPENED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.PR_OPENED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
]);

/** Forward edges of the happy path and bounded repair loop. */
const FORWARD_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  QUEUED: [TaskStatus.ANALYZING],
  ANALYZING: [TaskStatus.PLANNING],
  PLANNING: [TaskStatus.AWAITING_PLAN_APPROVAL, TaskStatus.GENERATING_PATCH],
  // A rejected plan goes back to planning with reviewer feedback.
  AWAITING_PLAN_APPROVAL: [TaskStatus.GENERATING_PATCH, TaskStatus.PLANNING],
  GENERATING_PATCH: [TaskStatus.RUNNING_CHECKS],
  RUNNING_CHECKS: [TaskStatus.READY_FOR_REVIEW, TaskStatus.REPAIRING],
  REPAIRING: [TaskStatus.RUNNING_CHECKS],
  READY_FOR_REVIEW: [TaskStatus.OPENING_PR],
  OPENING_PR: [TaskStatus.PR_OPENED],
  PR_OPENED: [],
  FAILED: [],
  CANCELLED: [],
};

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function allowedTransitions(from: TaskStatus): TaskStatus[] {
  if (isTerminal(from)) return [];
  return [...FORWARD_TRANSITIONS[from], TaskStatus.FAILED, TaskStatus.CANCELLED];
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return allowedTransitions(from).includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`Invalid task transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
