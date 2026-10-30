import { z } from "zod";
import type { ContextPackage } from "./analysis";
import type { PlanSummary } from "./plan";
import type { TaskStatus } from "./task-status";

export const CreateTaskRequestSchema = z
  .object({
    repositoryId: z.string().uuid(),
    issueId: z.string().uuid().optional(),
    /** Free-form task description when not driven by a GitHub issue. */
    description: z.string().min(10).max(10_000).optional(),
    requirePlanApproval: z.boolean().default(true),
  })
  .strict()
  .refine((v) => v.issueId !== undefined || v.description !== undefined, {
    message: "Either issueId or description is required",
  });

export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export interface TaskSummary {
  id: string;
  repositoryId: string;
  repositoryFullName: string;
  issueId: string | null;
  /** The issue title, or the first line of the description. */
  title: string;
  status: TaskStatus;
  baseSha: string | null;
  branchName: string | null;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface TaskEventSummary {
  id: string;
  eventType: string;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** One bounded model call made for a task, e.g. a planning attempt. */
export interface AgentRunSummary {
  attemptNumber: number;
  stage: TaskStatus;
  model: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  inputTokens: number;
  outputTokens: number;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** US dollars, from the list price of each model actually used. */
  estimatedCostUsd: number;
}

export interface TaskDetail extends TaskSummary {
  description: string | null;
  issue: { number: number; title: string; state: "OPEN" | "CLOSED" } | null;
  requirePlanApproval: boolean;
  /** Present once ANALYZING has completed. */
  analysis: ContextPackage | null;
  /** Oldest first; the last one is the current plan. */
  plans: PlanSummary[];
  runs: AgentRunSummary[];
  usage: UsageTotals;
  events: TaskEventSummary[];
}

export interface HealthResponse {
  status: "ok" | "degraded";
  checks: Record<string, "ok" | "error">;
}
