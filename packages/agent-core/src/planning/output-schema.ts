import type { PlanningOutcome } from "@codepilot/contracts";
import { PLAN_FILE_CHANGES, PlanningOutcomeSchema } from "@codepilot/contracts";

const stringList = { type: "array", items: { type: "string" } } as const;

/**
 * JSON schema the model's answer is constrained to (structured outputs).
 * Structured outputs support neither length limits nor a top-level union, so
 * this is a flat object with nullable branches; toPlanningOutcome folds it into
 * PlanningOutcome and the Zod schema enforces every limit afterwards.
 */
export const PLANNING_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "plan", "reason"],
  properties: {
    kind: { type: "string", enum: ["plan", "rejected"] },
    reason: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: 'Why the task was declined. Null when kind is "plan".',
    },
    plan: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["summary", "assumptions", "affectedFiles", "implementationSteps", "testPlan", "risks"],
          properties: {
            summary: { type: "string" },
            assumptions: stringList,
            affectedFiles: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["path", "change", "reason"],
                properties: {
                  path: { type: "string" },
                  change: { type: "string", enum: [...PLAN_FILE_CHANGES] },
                  reason: { type: "string" },
                },
              },
            },
            implementationSteps: stringList,
            testPlan: stringList,
            risks: stringList,
          },
        },
        { type: "null" },
      ],
      description: 'The implementation plan. Null when kind is "rejected".',
    },
  },
} as const;

export type ParsedOutcome = { ok: true; outcome: PlanningOutcome } | { ok: false; problems: string[] };

/** Validates raw model output. Problems are phrased so they can be fed back to the model. */
export function toPlanningOutcome(raw: unknown): ParsedOutcome {
  if (typeof raw !== "object" || raw === null) return { ok: false, problems: ["The answer was not a JSON object."] };
  const { kind, plan, reason } = raw as Record<string, unknown>;
  const candidate = kind === "plan" ? { kind, plan } : kind === "rejected" ? { kind, reason } : { kind };

  const parsed = PlanningOutcomeSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, outcome: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "answer"}: ${i.message}`),
  };
}
