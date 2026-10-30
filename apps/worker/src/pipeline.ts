import { TaskStatus, isTerminal } from "@codepilot/contracts";

/**
 * A stage handles the work for one active status and returns the next status.
 * Stages are filled in week by week (analysis in week 3, planning in week 4, ...).
 */
export type StageHandler = (ctx: StageContext) => Promise<TaskStatus>;

export interface StageContext {
  taskId: string;
  /** Aborted when the task is cancelled, the stage times out, or the worker stops. */
  signal: AbortSignal;
}

export class NotImplementedStageError extends Error {
  constructor(readonly status: TaskStatus) {
    super(`No stage handler is implemented for ${status} yet`);
    this.name = "NotImplementedStageError";
  }
}

/**
 * A failure that may succeed if the same stage runs again later: rate limits,
 * provider outages, dropped connections. Stages are safe to re-run, so the
 * job is retried with backoff instead of failing the task.
 */
export class TransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransientError";
  }
}

export class StageTimeoutError extends Error {
  constructor(
    readonly status: TaskStatus,
    readonly timeoutMs: number,
  ) {
    super(`${status} did not finish within ${Math.round(timeoutMs / 1000)}s`);
    this.name = "StageTimeoutError";
  }
}

/** Statuses at which the pipeline stops and waits for a human. */
const HUMAN_GATES: ReadonlySet<TaskStatus> = new Set([TaskStatus.AWAITING_PLAN_APPROVAL, TaskStatus.READY_FOR_REVIEW]);

export interface PipelineDeps {
  stages: Partial<Record<TaskStatus, StageHandler>>;
  loadStatus: (taskId: string) => Promise<TaskStatus>;
  transition: (taskId: string, from: TaskStatus, to: TaskStatus) => Promise<void>;
  fail: (taskId: string, from: TaskStatus, reason: string) => Promise<void>;
  /** Wall-clock limit per stage. A stage without one runs until it returns or the job is aborted. */
  stageTimeoutsMs?: Partial<Record<TaskStatus, number>>;
  /** True when the queue will run this job again if it throws (attempts remain). */
  canRetry?: boolean;
  /** Called before a transient error is handed back to the queue for a retry. */
  onRetry?: (taskId: string, status: TaskStatus, reason: string) => Promise<void>;
}

/**
 * Runs one stage under the stage timeout. The handler gets a signal that
 * aborts on timeout as well as on the job's own signal; the race guarantees
 * the pipeline moves on even if a handler ignores its signal.
 */
async function runStage(handler: StageHandler, taskId: string, status: TaskStatus, signal: AbortSignal, timeoutMs?: number): Promise<TaskStatus> {
  if (!timeoutMs) return handler({ taskId, signal });

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new StageTimeoutError(status, timeoutMs)), timeoutMs);
  const stageSignal = AbortSignal.any([signal, timeout.signal]);
  try {
    return await new Promise<TaskStatus>((resolve, reject) => {
      stageSignal.addEventListener("abort", () => reject(stageSignal.reason), { once: true });
      handler({ taskId, signal: stageSignal }).then(resolve, reject);
    });
  } catch (err) {
    // Whatever the handler threw after the deadline, the cause is the timeout.
    if (timeout.signal.aborted && !signal.aborted) throw timeout.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drives a task forward from its persisted status until it reaches a terminal
 * status or a human gate. Because it always starts from the persisted status,
 * re-running a job after a worker crash resumes instead of restarting.
 *
 * If `signal` aborts (cancellation or shutdown), the pipeline stops without
 * touching the task: whoever aborted it owns the status.
 */
export async function runPipeline(taskId: string, deps: PipelineDeps, signal: AbortSignal): Promise<TaskStatus> {
  let status = await deps.loadStatus(taskId);

  while (!isTerminal(status) && !HUMAN_GATES.has(status)) {
    if (signal.aborted) return deps.loadStatus(taskId);
    const handler = deps.stages[status];
    try {
      if (!handler) throw new NotImplementedStageError(status);
      const next = await runStage(handler, taskId, status, signal, deps.stageTimeoutsMs?.[status]);
      await deps.transition(taskId, status, next);
      status = next;
    } catch (err) {
      if (signal.aborted) return deps.loadStatus(taskId);
      const reason = err instanceof Error ? err.message : String(err);
      if (err instanceof TransientError && deps.canRetry) {
        await deps.onRetry?.(taskId, status, reason);
        throw err;
      }
      await deps.fail(taskId, status, reason);
      return TaskStatus.FAILED;
    }
  }
  return status;
}
