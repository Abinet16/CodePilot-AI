import { Injectable } from "@nestjs/common";
import type { DashboardResponse, PullRequestStatus, UsageReport, UsageTotalsByKey } from "@codepilot/contracts";
import { PULL_REQUEST_STATUSES, TASK_STATUS_GROUPS } from "@codepilot/contracts";
import { PrismaService } from "../prisma/prisma.service";
import { TaskLister, visibleTasks } from "../tasks/task-lister";

const DAY_MS = 24 * 60 * 60 * 1000;
/** A usage report reads at most this many rows; a window that large is far beyond one person's use. */
const MAX_USAGE_ROWS = 50_000;

type Totals = Omit<UsageTotalsByKey, "key">;
const empty = (): Totals => ({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, calls: 0 });

/** Start of the UTC day `days - 1` days before `now`, so the window covers `days` whole days including today. */
function windowStart(now: Date, days: number): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (days - 1) * DAY_MS);
}

/** Rounds to the micro-dollar the database stores, so sums of Decimals do not drift. */
const dollars = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lister: TaskLister,
  ) {}

  async overview(userId: string, now = new Date()): Promise<DashboardResponse> {
    const usageDays = 30;
    const [counts, needsReview, recent, prs, visible, enabled, usage] = await Promise.all([
      this.lister.counts(userId),
      this.lister.items(userId, { status: { in: [...TASK_STATUS_GROUPS.review] } }, { createdAt: "asc" }, 10),
      this.lister.items(userId, {}, { createdAt: "desc" }, 10),
      this.prisma.pullRequest.groupBy({ by: ["status"], where: { task: visibleTasks(userId) }, _count: { _all: true } }),
      this.prisma.repositoryAccess.count({ where: { userId, repository: { removedAt: null } } }),
      this.prisma.repositoryAccess.count({ where: { userId, repository: { removedAt: null, enabled: true } } }),
      this.prisma.usageRecord.aggregate({
        where: { userId, createdAt: { gte: windowStart(now, usageDays) } },
        _sum: { inputTokens: true, outputTokens: true, estimatedCost: true },
      }),
    ]);

    const pullRequests = Object.fromEntries(PULL_REQUEST_STATUSES.map((s) => [s, 0])) as Record<PullRequestStatus, number>;
    for (const row of prs) pullRequests[row.status] = row._count._all;

    return {
      counts,
      needsReview,
      recent,
      pullRequests,
      repositories: { visible, enabled },
      usage: {
        days: usageDays,
        inputTokens: usage._sum.inputTokens ?? 0,
        outputTokens: usage._sum.outputTokens ?? 0,
        estimatedCostUsd: dollars(Number(usage._sum.estimatedCost ?? 0)),
      },
    };
  }

  /** The user's own model usage, by day, model, provider, and repository. */
  async usage(userId: string, days: number, now = new Date()): Promise<UsageReport> {
    const since = windowStart(now, days);
    const rows = await this.prisma.usageRecord.findMany({
      where: { userId, createdAt: { gte: since } },
      select: {
        createdAt: true,
        model: true,
        provider: true,
        inputTokens: true,
        outputTokens: true,
        estimatedCost: true,
        task: { select: { repository: { select: { owner: true, name: true } } } },
      },
      orderBy: { createdAt: "asc" },
      take: MAX_USAGE_ROWS,
    });

    const daily = new Map<string, Totals>();
    for (let i = 0; i < days; i++) daily.set(new Date(since.getTime() + i * DAY_MS).toISOString().slice(0, 10), empty());
    const byModel = new Map<string, Totals>();
    const byProvider = new Map<string, Totals>();
    const byRepository = new Map<string, Totals>();
    const totals = empty();

    for (const row of rows) {
      const repository = row.task ? `${row.task.repository.owner}/${row.task.repository.name}` : "(deleted task)";
      for (const [map, key] of [
        [daily, row.createdAt.toISOString().slice(0, 10)],
        [byModel, row.model],
        [byProvider, row.provider],
        [byRepository, repository],
      ] as const) {
        const entry = map.get(key) ?? empty();
        add(entry, row);
        map.set(key, entry);
      }
      add(totals, row);
    }

    const list = (map: Map<string, Totals>, sort: boolean) => {
      const entries = [...map].map(([key, t]) => ({ key, ...t, estimatedCostUsd: dollars(t.estimatedCostUsd) }));
      return sort ? entries.sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.calls - a.calls) : entries;
    };
    return {
      days,
      since: since.toISOString(),
      totals: { ...totals, estimatedCostUsd: dollars(totals.estimatedCostUsd) },
      daily: list(daily, false),
      byModel: list(byModel, true),
      byProvider: list(byProvider, true),
      byRepository: list(byRepository, true),
    };
  }
}

function add(target: Totals, row: { inputTokens: number; outputTokens: number; estimatedCost: unknown }): void {
  target.inputTokens += row.inputTokens;
  target.outputTokens += row.outputTokens;
  target.estimatedCostUsd += Number(row.estimatedCost);
  target.calls += 1;
}
