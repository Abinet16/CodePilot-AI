import { ApprovePlanRequestSchema, PlanningOutcomeSchema, RequestPlanChangesRequestSchema } from "./plan";

describe("PlanningOutcomeSchema", () => {
  const validPlan = {
    summary: "Fix off-by-one in pagination",
    assumptions: [],
    affectedFiles: [{ path: "src/paginate.ts", change: "modify", reason: "Contains the bug" }],
    implementationSteps: ["Use < instead of <= in the loop bound"],
    testPlan: ["Add a regression test for the last page"],
    risks: [],
  };

  it("accepts a well-formed plan", () => {
    expect(PlanningOutcomeSchema.safeParse({ kind: "plan", plan: validPlan }).success).toBe(true);
  });

  it("accepts an explicit rejection", () => {
    const result = PlanningOutcomeSchema.safeParse({ kind: "rejected", reason: "Requirements are ambiguous" });
    expect(result.success).toBe(true);
  });

  it("rejects a plan that touches no files", () => {
    const result = PlanningOutcomeSchema.safeParse({ kind: "plan", plan: { ...validPlan, affectedFiles: [] } });
    expect(result.success).toBe(false);
  });

  it("requires each affected file to say how it changes", () => {
    const missing = { ...validPlan, affectedFiles: [{ path: "src/a.ts", reason: "x" }] };
    const unknown = { ...validPlan, affectedFiles: [{ path: "src/a.ts", change: "rename", reason: "x" }] };
    expect(PlanningOutcomeSchema.safeParse({ kind: "plan", plan: missing }).success).toBe(false);
    expect(PlanningOutcomeSchema.safeParse({ kind: "plan", plan: unknown }).success).toBe(false);
  });
});

describe("plan review requests", () => {
  it("names the reviewed version and rejects unknown fields", () => {
    expect(ApprovePlanRequestSchema.safeParse({ version: 1 }).success).toBe(true);
    expect(ApprovePlanRequestSchema.safeParse({}).success).toBe(false);
    expect(ApprovePlanRequestSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(ApprovePlanRequestSchema.safeParse({ version: 1, status: "APPROVED" }).success).toBe(false);
  });

  it("requires meaningful feedback when requesting changes", () => {
    expect(RequestPlanChangesRequestSchema.safeParse({ version: 2, feedback: "Also update the README example" }).success).toBe(true);
    expect(RequestPlanChangesRequestSchema.safeParse({ version: 2, feedback: "   no    " }).success).toBe(false);
    expect(RequestPlanChangesRequestSchema.safeParse({ version: 2 }).success).toBe(false);
  });
});
