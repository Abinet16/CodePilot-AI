import { z } from "zod";
import type { TaskStatus } from "./task-status";

export const CreateTaskRequestSchema = z
  .object({
    repositoryId: z.string().uuid(),
    issueId: z.string().uuid().optional(),
    /** Free-form task description when not driven by a GitHub issue. */
    description: z.string().min(10).max(10_000).optional(),
    requirePlanApproval: z.boolean().default(true),
  })
  .refine((v) => v.issueId !== undefined || v.description !== undefined, {
    message: "Either issueId or description is required",
  });

export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export interface TaskSummary {
  id: string;
  repositoryId: string;
  issueId: string | null;
  status: TaskStatus;
  baseSha: string | null;
  branchName: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  checks: Record<string, "ok" | "error">;
}
