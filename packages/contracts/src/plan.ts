import { z } from "zod";

/**
 * Structured plan the model must produce before any code changes.
 * Paths here are untrusted model output; agent-core's path policy validates
 * them against the workspace before anything is written.
 */
export const PLAN_FILE_CHANGES = ["modify", "create", "delete"] as const;
export type PlanFileChange = (typeof PLAN_FILE_CHANGES)[number];

export const ImplementationPlanSchema = z.object({
  summary: z.string().min(1).max(2_000),
  assumptions: z.array(z.string().max(500)).max(20),
  affectedFiles: z
    .array(
      z.object({
        path: z.string().min(1).max(500),
        /** Whether the file exists at the pinned commit decides which of these is valid. */
        change: z.enum(PLAN_FILE_CHANGES),
        reason: z.string().min(1).max(500),
      }),
    )
    .min(1)
    .max(25),
  implementationSteps: z.array(z.string().min(1).max(1_000)).min(1).max(30),
  testPlan: z.array(z.string().max(1_000)).max(20),
  risks: z.array(z.string().max(500)).max(20),
});

export type ImplementationPlan = z.infer<typeof ImplementationPlanSchema>;

/** The model may also decline a task that is ambiguous or unsafe. */
export const PlanningOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), plan: ImplementationPlanSchema }),
  z.object({ kind: z.literal("rejected"), reason: z.string().min(1).max(2_000) }),
]);

export type PlanningOutcome = z.infer<typeof PlanningOutcomeSchema>;

/** Mirrors PlanStatus in the Prisma schema. */
export const PLAN_STATUSES = ["PROPOSED", "APPROVED", "CHANGES_REQUESTED"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Each revision costs a model call; a task gets at most this many plan versions. */
export const MAX_PLAN_VERSIONS = 3;

/** Reviews name the version they saw, so a reviewer never approves a plan they have not read. */
export const ApprovePlanRequestSchema = z.object({ version: z.number().int().positive() }).strict();
export type ApprovePlanRequest = z.infer<typeof ApprovePlanRequestSchema>;

export const RequestPlanChangesRequestSchema = z
  .object({
    version: z.number().int().positive(),
    feedback: z.string().trim().min(10).max(4_000),
  })
  .strict();
export type RequestPlanChangesRequest = z.infer<typeof RequestPlanChangesRequestSchema>;

export interface PlanSummary {
  version: number;
  status: PlanStatus;
  /** Null when the stored plan no longer passes validation; it is withheld rather than shown. */
  plan: ImplementationPlan | null;
  model: string;
  feedback: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}
