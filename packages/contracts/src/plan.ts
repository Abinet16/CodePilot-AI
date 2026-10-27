import { z } from "zod";

/**
 * Structured plan the model must produce before any code changes.
 * Paths here are untrusted model output; agent-core's path policy validates
 * them against the workspace before anything is written.
 */
export const ImplementationPlanSchema = z.object({
  summary: z.string().min(1).max(2_000),
  assumptions: z.array(z.string().max(500)).max(20),
  affectedFiles: z
    .array(
      z.object({
        path: z.string().min(1).max(500),
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
