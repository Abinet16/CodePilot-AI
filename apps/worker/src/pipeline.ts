import { TaskStatus, isTerminal } from "@codepilot/contracts";

/**
 * A stage handles the work for one active status and returns the next status.
 * Stages are filled in week by week (analysis in week 3, planning in week 4, ...).
 */
export type StageHandler = (ctx: StageContext) => Promise<TaskStatus>;

export interface StageContext {
  taskId: string;
  signal: AbortSignal;
}

export class NotImplementedStageError extends Error {
  constructor(readonly status: TaskStatus) {
    super(`No stage handler is implemented for ${status} yet`);
    this.name = "NotImplementedStageError";
  }
}

/** Statuses at which the pipeline stops and waits for a human. */
const HUMAN_GATES: ReadonlySet<TaskStatus> = new Set([TaskStatus.AWAITING_PLAN_APPROVAL, TaskStatus.READY_FOR_REVIEW]);

export interface PipelineDeps {
  stages: Partial<Record<TaskStatus, StageHandler>>;
  loadStatus: (taskId: string) => Promise<TaskStatus>;
  transition: (taskId: string, from: TaskStatus, to: TaskStatus) => Promise<void>;
  fail: (taskId: string, from: TaskStatus, reason: string) => Promise<void>;
}

/**
 * Drives a task forward from its persisted status until it reaches a terminal
 * status or a human gate. Because it always starts from the persisted status,
 * re-running a job after a worker crash resumes instead of restarting.
 */
export async function runPipeline(taskId: string, deps: PipelineDeps, signal: AbortSignal): Promise<TaskStatus> {
  let status = await deps.loadStatus(taskId);

  while (!isTerminal(status) && !HUMAN_GATES.has(status)) {
    if (signal.aborted) return status;
    const handler = deps.stages[status];
    try {
      if (!handler) throw new NotImplementedStageError(status);
      const next = await handler({ taskId, signal });
      await deps.transition(taskId, status, next);
      status = next;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await deps.fail(taskId, status, reason);
      return TaskStatus.FAILED;
    }
  }
  return status;
}
