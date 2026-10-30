import type { TaskStatus } from "@codepilot/contracts";
import type { TokenUsage } from "@codepilot/agent-core";
import { estimateCostUsd, isPricedModel } from "@codepilot/agent-core";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

export interface StartedRun {
  id: string;
  attemptNumber: number;
}

export interface RunOutcome {
  status: "SUCCEEDED" | "FAILED" | "CANCELLED";
  error?: string;
  /** Absent when the call never reached the provider, so nothing was billed. */
  usage?: TokenUsage;
  /** The model that answered, when it differs from the one requested. */
  servedModel?: string;
}

/**
 * Bookkeeping for model calls: one agent_runs row per call, with its tokens,
 * and one usage_records row per billed call, priced at the model that
 * actually answered. These rows are what the task token budget is checked against.
 */
export class RunRecorder {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider = "anthropic",
  ) {}

  /** Attempt numbers count every model call on the task, across stages and retries. */
  async start(taskId: string, stage: TaskStatus, model: string): Promise<StartedRun> {
    for (let tries = 0; ; tries++) {
      const last = await this.prisma.agentRun.findFirst({ where: { taskId }, orderBy: { attemptNumber: "desc" }, select: { attemptNumber: true } });
      const attemptNumber = (last?.attemptNumber ?? 0) + 1;
      try {
        const run = await this.prisma.agentRun.create({ data: { taskId, stage, model, attemptNumber } });
        return { id: run.id, attemptNumber };
      } catch (err) {
        // Another worker took the same number; read again and take the next.
        const conflict = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
        if (!conflict || tries >= 3) throw err;
      }
    }
  }

  async finish(runId: string, outcome: RunOutcome): Promise<void> {
    const run = await this.prisma.agentRun.findUniqueOrThrow({ where: { id: runId }, include: { task: { select: { requestedById: true } } } });
    const usage = outcome.usage;
    const served = outcome.servedModel ?? run.model;

    await this.prisma.$transaction(async (tx) => {
      await tx.agentRun.update({
        where: { id: runId },
        data: {
          status: outcome.status,
          error: outcome.error?.slice(0, 2_000) ?? null,
          tokenUsage: usage ? { ...usage, model: served } : {},
          completedAt: new Date(),
        },
      });
      if (!usage) return;
      await tx.usageRecord.create({
        data: {
          userId: run.task.requestedById,
          taskId: run.taskId,
          runId,
          provider: this.provider,
          model: served,
          inputTokens: usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens,
          outputTokens: usage.outputTokens,
          // A fallback model missing from the price table is billed at the requested model's price.
          estimatedCost: estimateCostUsd(isPricedModel(served) ? served : run.model, usage),
        },
      });
    });
  }

  /** Tokens billed to the task so far, input and output. */
  async tokensUsed(taskId: string): Promise<number> {
    const sum = await this.prisma.usageRecord.aggregate({ where: { taskId }, _sum: { inputTokens: true, outputTokens: true } });
    return (sum._sum.inputTokens ?? 0) + (sum._sum.outputTokens ?? 0);
  }
}
