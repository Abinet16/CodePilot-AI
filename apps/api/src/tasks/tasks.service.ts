import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { ContextPackage, CreateTaskRequest, RepositoryPermission, TaskDetail, TaskSummary } from "@codepilot/contracts";
import { ContextPackageSchema, MIN_PERMISSION_TO_ENABLE, TaskStatus, hasPermission, isTerminal } from "@codepilot/contracts";
import type { AgentTask, Issue, Prisma, Repository, TaskEvent } from "@prisma/client";
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

function toDetail(task: TaskRow & { events: TaskEvent[] }): TaskDetail {
  // Stored analysis is re-validated on the way out; anything malformed is withheld, not passed through.
  const analysis = task.analysis ? ContextPackageSchema.safeParse(task.analysis) : null;
  return {
    ...toSummary(task),
    description: task.description,
    issue: task.issue ? { number: task.issue.githubIssueNumber, title: task.issue.title, state: task.issue.state } : null,
    requirePlanApproval: task.requirePlanApproval,
    analysis: analysis?.success ? (analysis.data as ContextPackage) : null,
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
      await this.failUnqueued(task.id);
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
    return toDetail(task);
  }

  async cancel(userId: string, taskId: string): Promise<TaskDetail> {
    const task = await this.prisma.agentTask.findUnique({ where: { id: taskId } });
    const access = task ? await this.access(userId, task.repositoryId) : null;
    if (!task || !access) throw new NotFoundException("Task not found");
    this.requireWrite(access.permission);
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

    await this.queue.remove(taskId).catch(() => undefined);
    return this.get(userId, taskId);
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

  private async failUnqueued(taskId: string): Promise<void> {
    const reason = "Could not enqueue the task";
    await this.prisma.$transaction([
      this.prisma.agentTask.updateMany({
        where: { id: taskId, status: TaskStatus.QUEUED },
        data: { status: TaskStatus.FAILED, failureReason: reason, completedAt: new Date() },
      }),
      this.prisma.taskEvent.create({
        data: { taskId, eventType: "status_changed", fromStatus: TaskStatus.QUEUED, toStatus: TaskStatus.FAILED, payload: { reason } },
      }),
    ]);
  }
}
