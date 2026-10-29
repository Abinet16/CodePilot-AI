import { z } from "zod";
import type { ContextPackage } from "./analysis";
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

export interface TaskDetail extends TaskSummary {
  description: string | null;
  issue: { number: number; title: string; state: "OPEN" | "CLOSED" } | null;
  requirePlanApproval: boolean;
  /** Present once ANALYZING has completed. */
  analysis: ContextPackage | null;
  events: TaskEventSummary[];
}

export interface HealthResponse {
  status: "ok" | "degraded";
  checks: Record<string, "ok" | "error">;
}
