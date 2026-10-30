import type { ImplementationPlan } from "@codepilot/contracts";
import { reviewPlanPaths } from "./plan-review";

const existing = new Set(["src/a.ts", "src/a.test.ts", "README.md"]);

function planWith(affectedFiles: ImplementationPlan["affectedFiles"]): ImplementationPlan {
  return { summary: "s", assumptions: [], affectedFiles, implementationSteps: ["x"], testPlan: [], risks: [] };
}

describe("reviewPlanPaths", () => {
  it("accepts existing files to modify and new files to create, normalizing paths", () => {
    const review = reviewPlanPaths(
      planWith([
        { path: "./src/a.ts", change: "modify", reason: "bug" },
        { path: "src/b.ts", change: "create", reason: "helper" },
        { path: "README.md", change: "delete", reason: "obsolete" },
      ]),
      existing,
    );
    expect(review.ok).toBe(true);
    if (review.ok) expect(review.plan.affectedFiles.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts", "README.md"]);
  });

  it("rejects paths the policy forbids", () => {
    const review = reviewPlanPaths(
      planWith([
        { path: "../outside.ts", change: "create", reason: "x" },
        { path: ".env", change: "modify", reason: "x" },
        { path: ".github/workflows/ci.yml", change: "modify", reason: "x" },
        { path: "/etc/passwd", change: "modify", reason: "x" },
      ]),
      existing,
    );
    expect(review.ok).toBe(false);
    if (!review.ok) {
      expect(review.problems).toHaveLength(4);
      expect(review.problems[0]).toMatch(/traversal/);
      expect(review.problems[1]).toMatch(/denied file/);
    }
  });

  it("checks the change kind against the pinned commit", () => {
    const review = reviewPlanPaths(
      planWith([
        { path: "src/missing.ts", change: "modify", reason: "x" },
        { path: "src/a.ts", change: "create", reason: "x" },
      ]),
      existing,
    );
    expect(review).toEqual({
      ok: false,
      problems: [
        'src/missing.ts does not exist at the pinned commit; use "create" for a new file, or correct the path.',
        'src/a.ts already exists; use "modify" instead of "create".',
      ],
    });
  });

  it("rejects the same file listed twice under different spellings", () => {
    const review = reviewPlanPaths(
      planWith([
        { path: "src/a.ts", change: "modify", reason: "x" },
        { path: "src/../src/a.ts", change: "modify", reason: "y" },
      ]),
      existing,
    );
    expect(review).toEqual({ ok: false, problems: ["src/a.ts is listed more than once."] });
  });
});
