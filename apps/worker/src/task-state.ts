import { TaskStatus, assertTransition, isTerminal } from "@codepilot/contracts";
import type { Prisma, PrismaClient } from "@prisma/client";

export class StaleTransitionError extends Error {
  constructor(
    readonly taskId: string,
    readonly expected: TaskStatus,
  ) {
    super(`Task ${taskId} is no longer in ${expected}; another worker or a cancellation moved it`);
    this.name = "StaleTransitionError";
  }
}

/**
 * Persists task transitions. Each transition is a compare-and-set on the
 * current status plus an event row, in one transaction, so concurrent workers
 * or a cancellation racing a worker cannot both win.
 */
export class TaskStateStore {
  constructor(private readonly prisma: PrismaClient) {}

  async transition(
    taskId: string,
    from: TaskStatus,
    to: TaskStatus,
    payload: Prisma.InputJsonObject = {},
    extra: Prisma.AgentTaskUpdateManyMutationInput = {},
  ): Promise<void> {
    assertTransition(from, to);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.agentTask.updateMany({
        where: { id: taskId, status: from },
        data: {
          ...extra,
          status: to,
          ...(from === TaskStatus.QUEUED ? { startedAt: now } : {}),
          ...(isTerminal(to) ? { completedAt: now } : {}),
        },
      });
      if (count !== 1) throw new StaleTransitionError(taskId, from);

      await tx.taskEvent.create({
        data: { taskId, eventType: "status_changed", fromStatus: from, toStatus: to, payload },
      });
    });
  }

  async fail(taskId: string, from: TaskStatus, reason: string): Promise<void> {
    await this.transition(taskId, from, TaskStatus.FAILED, { reason }, { failureReason: reason });
  }
}
