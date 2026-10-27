import { PlanningOutcomeSchema } from "./plan";

describe("PlanningOutcomeSchema", () => {
  const validPlan = {
    summary: "Fix off-by-one in pagination",
    assumptions: [],
    affectedFiles: [{ path: "src/paginate.ts", reason: "Contains the bug" }],
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
});
