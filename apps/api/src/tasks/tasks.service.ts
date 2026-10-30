import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type {
  AgentRunSummary,
  ContextPackage,
  CreateTaskRequest,
  ImplementationPlan,
  RepositoryPermission,
  TaskDetail,
  TaskJobKey,
  TaskSummary,
  UsageTotals,
} from "@codepilot/contracts";
import {
  ContextPackageSchema,
  ImplementationPlanSchema,
  MAX_PLAN_VERSIONS,
  MIN_PERMISSION_TO_ENABLE,
  TaskStatus,
  hasPermission,
  isTerminal,
} from "@codepilot/contracts";
import type { AgentRun, AgentTask, ImplementationPlan as PlanRow, Issue, Prisma, Repository, TaskEvent } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { TaskQueue } from "./task-queue";

type TaskRow = AgentTask & { repository: Repository; issue: Issue | null };

function title(task: TaskRow): string {
  if (task.issue) return `#${task.issue.githubIssueNumber} ${task.issue.title}`;
  return (task.description ?? "").split("\n")[0]!.slice(0, 120);
}

function toSummary(task: TaskRow): TaskSummary {
  return {
    id: task.id,
    repositoryId: task.repositoryId,
    repositoryFullName: `${task.repository.owner}/${task.repository.name}`,
    issueId: task.issueId,
    title: title(task),
    status: task.status,
    baseSha: task.baseSha,
    branchName: task.branchName,
    failureReason: task.failureReason,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
  };
}

type DetailRow = TaskRow & {
  events: TaskEvent[];
  runs: AgentRun[];
  plans: Array<PlanRow & { reviewedBy: { githubLogin: string } | null }>;
};

function runTokens(run: AgentRun): { inputTokens: number; outputTokens: number } {
  const u = (run.tokenUsage ?? {}) as Record<string, unknown>;
  const n = (key: string) => (typeof u[key] === "number" ? (u[key] as number) : 0);
  return { inputTokens: n("inputTokens") + n("cacheCreationInputTokens") + n("cacheReadInputTokens"), outputTokens: n("outputTokens") };
}

function toRunSummary(run: AgentRun): AgentRunSummary {
  return {
    attemptNumber: run.attemptNumber,
    stage: run.stage,
    model: run.model,
    status: run.status,
    ...runTokens(run),
    error: run.error,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

function toDetail(task: DetailRow, usage: UsageTotals): TaskDetail {
  // Stored analysis is re-validated on the way out; anything malformed is withheld, not passed through.
  const analysis = task.analysis ? ContextPackageSchema.safeParse(task.analysis) : null;
  return {
    ...toSummary(task),
    description: task.description,
    issue: task.issue ? { number: task.issue.githubIssueNumber, title: task.issue.title, state: task.issue.state } : null,
    requirePlanApproval: task.requirePlanApproval,
    analysis: analysis?.success ? (analysis.data as ContextPackage) : null,
    plans: task.plans.map((p) => {
      const plan = ImplementationPlanSchema.safeParse(p.planJson);
      return {
        version: p.version,
        status: p.status,
        plan: plan.success ? (plan.data as ImplementationPlan) : null,
        model: p.model,
        feedback: p.feedback,
        reviewedBy: p.reviewedBy?.githubLogin ?? null,
        reviewedAt: p.reviewedAt?.toISOString() ?? null,
        createdAt: p.createdAt.toISOString(),
      };
    }),
    runs: task.runs.map(toRunSummary),
    usage,
    events: task.events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      payload: e.payload as Record<string, unknown>,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

const detailInclude = {
  repository: true,
  issue: true,
  events: { orderBy: { createdAt: "asc" } },
  runs: { orderBy: { attemptNumber: "asc" } },
  plans: { orderBy: { version: "asc" }, include: { reviewedBy: { select: { githubLogin: true } } } },
} satisfies Prisma.AgentTaskInclude;

/**
 * Tasks are visible to everyone with access to their repository and can be
 * started or cancelled by those with WRITE or higher. As with repositories,
 * a task the user cannot see is reported as not found.
 */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: TaskQueue,
  ) {}

  async create(userId: string, request: CreateTaskRequest): Promise<TaskDetail> {
    const access = await this.access(userId, request.repositoryId);
    if (!access) throw new NotFoundException("Repository not found");
    this.requireWrite(access.permission);
    if (!access.repository.enabled) throw new ConflictException("The agent is not enabled for this repository");
    if (access.repository.installation.status !== "ACTIVE") {
      throw new ConflictException("The GitHub App installation for this repository is not active");
    }

    if (request.issueId) {
      const issue = await this.prisma.issue.findFirst({ where: { id: request.issueId, repositoryId: request.repositoryId } });
      if (!issue) throw new NotFoundException("Issue not found");
      if (issue.state !== "OPEN") throw new ConflictException("The issue is closed");
    }

    const task = await this.prisma.$transaction(async (tx) => {
      const created = await tx.agentTask.create({
        data: {
          repositoryId: request.repositoryId,
          issueId: request.issueId ?? null,
          description: request.description ?? null,
          requirePlanApproval: request.requirePlanApproval,
          requestedById: userId,
        },
      });
      await tx.taskEvent.create({ data: { taskId: created.id, eventType: "task_created", toStatus: TaskStatus.QUEUED, payload: {} } });
      await this.audit.record({ userId, taskId: created.id, action: "task.created", metadata: { repositoryId: request.repositoryId } }, tx);
      return created;
    });

    try {
      await this.queue.enqueue(task.id);
    } catch (err) {
      this.logger.error(`Could not enqueue task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      await this.failUnqueued(task.id, TaskStatus.QUEUED);
      throw new ServiceUnavailableException("The task queue is unavailable; please try again");
    }
    return this.get(userId, task.id);
  }

  async list(userId: string, repositoryId?: string): Promise<TaskSummary[]> {
    const tasks = await this.prisma.agentTask.findMany({
      where: { repository: { removedAt: null, access: { some: { userId } } }, ...(repositoryId ? { repositoryId } : {}) },
      include: { repository: true, issue: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return tasks.map(toSummary);
  }

  async get(userId: string, taskId: string): Promise<TaskDetail> {
    const task = await this.prisma.agentTask.findFirst({
      where: { id: taskId, repository: { removedAt: null, access: { some: { userId } } } },
      include: detailInclude,
    });
    if (!task) throw new NotFoundException("Task not found");
    const sum = await this.prisma.usageRecord.aggregate({
      where: { taskId },
      _sum: { inputTokens: true, outputTokens: true, estimatedCost: true },
    });
    return toDetail(task, {
      inputTokens: sum._sum.inputTokens ?? 0,
      outputTokens: sum._sum.outputTokens ?? 0,
      estimatedCostUsd: Number(sum._sum.estimatedCost ?? 0),
    });
  }

  async cancel(userId: string, taskId: string): Promise<TaskDetail> {
    const task = await this.writableTask(userId, taskId);
    if (isTerminal(task.status)) throw new ConflictException(`Task is already ${task.status}`);

    await this.prisma.$transaction(async (tx) => {
      // Compare-and-set against the status we read; a worker transition in between wins and we report a conflict.
      const { count } = await tx.agentTask.updateMany({
        where: { id: taskId, status: task.status },
        data: { status: TaskStatus.CANCELLED, completedAt: new Date() },
      });
      if (count !== 1) throw new ConflictException("Task status changed; reload and try again");
      await tx.taskEvent.create({
        data: { taskId, eventType: "status_changed", fromStatus: task.status, toStatus: TaskStatus.CANCELLED, payload: { reason: "cancelled_by_user" } },
      });
      await this.audit.record({ userId, taskId, action: "task.cancelled", metadata: { fromStatus: task.status } }, tx);
    });

    const latest = await this.prisma.implementationPlan.findFirst({ where: { taskId }, orderBy: { version: "desc" } });
    const keys: TaskJobKey[] = ["start", ...(latest ? ([`plan-v${latest.version}-approved`, `plan-v${latest.version}-revise`] as const) : [])];
    await this.queue.remove(taskId, keys).catch(() => undefined);
    return this.get(userId, taskId);
  }

  /** Approves the plan awaiting review and resumes the task at GENERATING_PATCH. */
  async approvePlan(userId: string, taskId: string, version: number): Promise<TaskDetail> {
    const task = await this.writableTask(userId, taskId);
    this.requireAwaitingReview(task.status);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await this.claimPlan(tx, taskId, version, { status: "APPROVED", reviewedById: userId, reviewedAt: now, approvedAt: now });
      await this.resume(tx, taskId, TaskStatus.GENERATING_PATCH, { reason: "plan_approved", version });
      await this.audit.record({ userId, taskId, action: "plan.approved", metadata: { version } }, tx);
    });
    await this.enqueueOrFail(taskId, `plan-v${version}-approved`, TaskStatus.GENERATING_PATCH);
    return this.get(userId, taskId);
  }

  /** Sends the plan back to PLANNING with the reviewer's feedback; the worker writes the next version. */
  async requestPlanChanges(userId: string, taskId: string, version: number, feedback: string): Promise<TaskDetail> {
    const task = await this.writableTask(userId, taskId);
    this.requireAwaitingReview(task.status);
    if (version >= MAX_PLAN_VERSIONS) {
      throw new ConflictException(`Plan version ${version} is the last revision allowed; approve it or cancel the task`);
    }

    await this.prisma.$transaction(async (tx) => {
      await this.claimPlan(tx, taskId, version, { status: "CHANGES_REQUESTED", feedback, reviewedById: userId, reviewedAt: new Date() });
      await this.resume(tx, taskId, TaskStatus.PLANNING, { reason: "plan_changes_requested", version });
      await this.audit.record({ userId, taskId, action: "plan.changes_requested", metadata: { version } }, tx);
    });
    await this.enqueueOrFail(taskId, `plan-v${version}-revise`, TaskStatus.PLANNING);
    return this.get(userId, taskId);
  }

  private async writableTask(userId: string, taskId: string): Promise<AgentTask> {
    const task = await this.prisma.agentTask.findUnique({ where: { id: taskId } });
    const access = task ? await this.access(userId, task.repositoryId) : null;
    if (!task || !access) throw new NotFoundException("Task not found");
    this.requireWrite(access.permission);
    return task;
  }

  private requireAwaitingReview(status: TaskStatus): void {
    if (status !== TaskStatus.AWAITING_PLAN_APPROVAL) throw new ConflictException(`Task is ${status}, not awaiting plan approval`);
  }

  /**
   * Compare-and-set on the plan: only the version currently awaiting review
   * can be reviewed, and only once, even with two reviewers racing.
   */
  private async claimPlan(tx: Prisma.TransactionClient, taskId: string, version: number, data: Prisma.ImplementationPlanUncheckedUpdateManyInput) {
    const { count } = await tx.implementationPlan.updateMany({ where: { taskId, version, status: "PROPOSED" }, data });
    if (count !== 1) throw new ConflictException(`Plan version ${version} is not the plan awaiting review; reload and try again`);
  }

  private async resume(tx: Prisma.TransactionClient, taskId: string, to: TaskStatus, payload: Prisma.InputJsonObject) {
    const from = TaskStatus.AWAITING_PLAN_APPROVAL;
    const { count } = await tx.agentTask.updateMany({ where: { id: taskId, status: from }, data: { status: to } });
    if (count !== 1) throw new ConflictException("Task status changed; reload and try again");
    await tx.taskEvent.create({ data: { taskId, eventType: "status_changed", fromStatus: from, toStatus: to, payload } });
  }

  private async enqueueOrFail(taskId: string, key: TaskJobKey, status: TaskStatus): Promise<void> {
    try {
      await this.queue.enqueue(taskId, key);
    } catch (err) {
      this.logger.error(`Could not enqueue task ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
      await this.failUnqueued(taskId, status);
      throw new ServiceUnavailableException("The task queue is unavailable; please try again");
    }
  }

  private access(userId: string, repositoryId: string) {
    return this.prisma.repositoryAccess
      .findUnique({
        where: { userId_repositoryId: { userId, repositoryId } },
        include: { repository: { include: { installation: true } } },
      })
      .then((a) => (a && !a.repository.removedAt ? a : null));
  }

  private requireWrite(permission: RepositoryPermission): void {
    if (!hasPermission(permission, MIN_PERMISSION_TO_ENABLE)) {
      throw new ForbiddenException(`Requires ${MIN_PERMISSION_TO_ENABLE} permission on GitHub`);
    }
  }

  private async failUnqueued(taskId: string, from: TaskStatus): Promise<void> {
    const reason = "Could not enqueue the task";
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.agentTask.updateMany({
        where: { id: taskId, status: from },
        data: { status: TaskStatus.FAILED, failureReason: reason, completedAt: new Date() },
      });
      if (count === 1) {
        await tx.taskEvent.create({ data: { taskId, eventType: "status_changed", fromStatus: from, toStatus: TaskStatus.FAILED, payload: { reason } } });
      }
    });
  }
}
