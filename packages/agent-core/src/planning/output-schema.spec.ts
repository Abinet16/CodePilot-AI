import { ImplementationPlanSchema } from "@codepilot/contracts";
import { PLANNING_OUTPUT_SCHEMA, toPlanningOutcome } from "./output-schema";

const plan = {
  summary: "Fix the bound",
  assumptions: [],
  affectedFiles: [{ path: "src/a.ts", change: "modify", reason: "bug" }],
  implementationSteps: ["Change <= to <"],
  testPlan: ["Add a test"],
  risks: [],
};

describe("PLANNING_OUTPUT_SCHEMA", () => {
  it("asks for exactly the fields the plan contract has", () => {
    const planBranch = PLANNING_OUTPUT_SCHEMA.properties.plan.anyOf[0];
    expect([...planBranch.required].sort()).toEqual(Object.keys(ImplementationPlanSchema.shape).sort());
    expect(Object.keys(planBranch.properties).sort()).toEqual(Object.keys(ImplementationPlanSchema.shape).sort());
  });

  it("closes every object, as structured outputs require", () => {
    const objects: Array<Record<string, unknown>> = [];
    const visit = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (node && typeof node === "object") {
        if ((node as { type?: unknown }).type === "object") objects.push(node as Record<string, unknown>);
        Object.values(node).forEach(visit);
      }
    };
    visit(PLANNING_OUTPUT_SCHEMA);
    expect(objects.length).toBeGreaterThanOrEqual(3);
    for (const o of objects) expect(o.additionalProperties).toBe(false);
  });
});

describe("toPlanningOutcome", () => {
  it("folds the flat answer into a plan outcome", () => {
    const result = toPlanningOutcome({ kind: "plan", plan, reason: null });
    expect(result).toEqual({ ok: true, outcome: { kind: "plan", plan } });
  });

  it("folds a decline into a rejected outcome", () => {
    expect(toPlanningOutcome({ kind: "rejected", plan: null, reason: "Too vague" })).toEqual({
      ok: true,
      outcome: { kind: "rejected", reason: "Too vague" },
    });
  });

  it("reports limit violations the API cannot enforce, as feedback for the model", () => {
    const tooMany = { ...plan, affectedFiles: Array.from({ length: 26 }, (_, i) => ({ path: `f${i}.ts`, change: "create", reason: "x" })) };
    const result = toPlanningOutcome({ kind: "plan", plan: tooMany, reason: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toMatch(/^plan\.affectedFiles:/);
  });

  it("rejects non-objects and missing branches", () => {
    expect(toPlanningOutcome("plan").ok).toBe(false);
    expect(toPlanningOutcome({ kind: "plan", plan: null, reason: null }).ok).toBe(false);
    expect(toPlanningOutcome({ kind: "maybe" }).ok).toBe(false);
  });
});
