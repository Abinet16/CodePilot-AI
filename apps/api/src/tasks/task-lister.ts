import { BadRequestException, Injectable } from "@nestjs/common";
import type { ListTasksQuery, TaskListItem, TaskPage, TaskStatusGroup, TaskSummary } from "@codepilot/contracts";
import { TASK_STATUS_GROUPS, TASK_STATUS_GROUP_NAMES, statusGroupOf } from "@codepilot/contracts";
import type { AgentTask, Issue, Prisma, Repository } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export type TaskRow = AgentTask & { repository: Repository; issue: Issue | null };

function title(task: TaskRow): string {
  if (task.issue) return `#${task.issue.githubIssueNumber} ${task.issue.title}`;
  return (task.description ?? "").split("\n")[0]!.slice(0, 120);
}

export function toSummary(task: TaskRow): TaskSummary {
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

/** Tasks a user may see: on repositories they can access on GitHub that are still installed. */
export function visibleTasks(userId: string): Prisma.AgentTaskWhereInput {
  return { repository: { removedAt: null, access: { some: { userId } } } };
}

/** Cursor over (createdAt desc, id desc), encoded so it is opaque and URL-safe. */
function encodeCursor(task: { createdAt: Date; id: string }): string {
  return Buffer.from(`${task.createdAt.toISOString()}|${task.id}`).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const createdAt = new Date(iso ?? "");
  if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/.test(id ?? "")) throw new BadRequestException("Invalid cursor");
  return { createdAt, id: id! };
}

const listInclude = {
  repository: true,
  issue: true,
  pullRequests: { select: { githubPrNumber: true, githubPrUrl: true, status: true } },
} satisfies Prisma.AgentTaskInclude;

/**
 * Task lists for the task page, the dashboard, and repository pages. Every
 * query starts from what the user can see, so the lists never disagree with
 * the task detail about visibility.
 */
@Injectable()
export class TaskLister {
  constructor(private readonly prisma: PrismaService) {}

  async page(userId: string, query: ListTasksQuery): Promise<TaskPage> {
    const where: Prisma.AgentTaskWhereInput = {
      AND: [
        visibleTasks(userId),
        query.repositoryId ? { repositoryId: query.repositoryId } : {},
        query.group ? { status: { in: [...TASK_STATUS_GROUPS[query.group]] } } : {},
        query.cursor ? this.after(decodeCursor(query.cursor)) : {},
      ],
    };
    const rows = await this.prisma.agentTask.findMany({
      where,
      include: listInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
    });
    const more = rows.length > query.limit;
    const items = await this.toItems(rows.slice(0, query.limit));
    return { items, nextCursor: more ? encodeCursor(rows[query.limit - 1]!) : null };
  }

  /** Items in the given order; `where` is combined with the visibility rule. */
  async items(userId: string, where: Prisma.AgentTaskWhereInput, orderBy: Prisma.AgentTaskOrderByWithRelationInput, take: number): Promise<TaskListItem[]> {
    const rows = await this.prisma.agentTask.findMany({ where: { AND: [visibleTasks(userId), where] }, include: listInclude, orderBy, take });
    return this.toItems(rows);
  }

  /** Visible tasks per status group, every group present. */
  async counts(userId: string, where: Prisma.AgentTaskWhereInput = {}): Promise<Record<TaskStatusGroup, number>> {
    const grouped = await this.prisma.agentTask.groupBy({ by: ["status"], where: { AND: [visibleTasks(userId), where] }, _count: { _all: true } });
    const counts = Object.fromEntries(TASK_STATUS_GROUP_NAMES.map((g) => [g, 0])) as Record<TaskStatusGroup, number>;
    for (const row of grouped) counts[statusGroupOf(row.status)] += row._count._all;
    return counts;
  }

  private after(cursor: { createdAt: Date; id: string }): Prisma.AgentTaskWhereInput {
    return { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] };
  }

  /** Adds the last activity and cost of each task with two grouped queries, not one per task. */
  private async toItems(rows: Array<Prisma.AgentTaskGetPayload<{ include: typeof listInclude }>>): Promise<TaskListItem[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [latest, costs] = await Promise.all([
      this.prisma.taskEvent.groupBy({ by: ["taskId"], where: { taskId: { in: ids } }, _max: { createdAt: true } }),
      this.prisma.usageRecord.groupBy({ by: ["taskId"], where: { taskId: { in: ids } }, _sum: { estimatedCost: true } }),
    ]);
    const updated = new Map(latest.map((l) => [l.taskId, l._max.createdAt]));
    const cost = new Map(costs.map((c) => [c.taskId, Number(c._sum.estimatedCost ?? 0)]));

    return rows.map((row) => {
      const pr = row.pullRequests[0];
      return {
        ...toSummary(row),
        group: statusGroupOf(row.status),
        updatedAt: (updated.get(row.id) ?? row.createdAt).toISOString(),
        pullRequest: pr ? { number: pr.githubPrNumber, url: pr.githubPrUrl, status: pr.status } : null,
        estimatedCostUsd: cost.get(row.id) ?? 0,
      };
    });
  }
}
