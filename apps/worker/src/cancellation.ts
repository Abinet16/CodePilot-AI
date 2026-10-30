import type { TaskStatus } from "@codepilot/contracts";
import { isTerminal } from "@codepilot/contracts";

export class TaskCancelledError extends Error {
  constructor(readonly taskId: string) {
    super(`Task ${taskId} was cancelled`);
    this.name = "TaskCancelledError";
  }
}

/**
 * Polls the task while a job runs and aborts `controller` once the task is
 * terminal (normally a user cancellation through the API). The abort reaches
 * in-flight git fetches and model calls, so a cancelled task stops spending
 * time and tokens within one poll interval rather than at its next transition.
 *
 * Returns a function that stops watching.
 */
export function watchForCancellation(
  taskId: string,
  loadStatus: (taskId: string) => Promise<TaskStatus>,
  controller: AbortController,
  intervalMs: number,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const poll = async () => {
    if (stopped) return;
    try {
      if (isTerminal(await loadStatus(taskId))) {
        controller.abort(new TaskCancelledError(taskId));
        return;
      }
    } catch {
      // A failed poll is not a cancellation; try again next interval.
    }
    if (!stopped) timer = setTimeout(poll, intervalMs);
  };
  timer = setTimeout(poll, intervalMs);

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
