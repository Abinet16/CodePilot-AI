import type { ImplementationPlan, PatchProposal } from "@codepilot/contracts";
import { DEFAULT_PATCH_LIMITS, checkDiffLimits, reviewPatch } from "./patch-review";

const plan: ImplementationPlan = {
  summary: "Count the last partial page",
  assumptions: [],
  affectedFiles: [
    { path: "src/pagination.ts", change: "modify", reason: "Holds the bug" },
    { path: "src/pagination.test.ts", change: "create", reason: "Regression test" },
    { path: "src/legacy.ts", change: "delete", reason: "Unused" },
  ],
  implementationSteps: ["Use Math.ceil"],
  testPlan: [],
  risks: [],
};

const originals = new Map([
  ["src/pagination.ts", "export const pages = (t: number, s: number) => Math.floor(t / s);\n"],
  ["src/legacy.ts", "export {};\n"],
]);

function proposal(files: PatchProposal["files"]): PatchProposal {
  return { summary: "Fix", commitMessage: "Fix pagination", files };
}

describe("reviewPatch", () => {
  it("turns a patch that follows the plan into full file contents", () => {
    const result = reviewPatch(
      proposal([
        { path: "./src/pagination.ts", change: "modify", edits: [{ find: "Math.floor", replace: "Math.ceil" }] },
        { path: "src/pagination.test.ts", change: "create", content: "test('last page', () => {});\n" },
        { path: "src/legacy.ts", change: "delete" },
      ]),
      plan,
      originals,
    );
    expect(result).toEqual({
      ok: true,
      changes: [
        { path: "src/pagination.ts", change: "modify", content: "export const pages = (t: number, s: number) => Math.ceil(t / s);\n" },
        { path: "src/pagination.test.ts", change: "create", content: "test('last page', () => {});\n" },
        { path: "src/legacy.ts", change: "delete", content: null },
      ],
      unchangedPlanFiles: [],
    });
  });

  it("lists planned files the patch leaves alone", () => {
    const result = reviewPatch(proposal([{ path: "src/legacy.ts", change: "delete" }]), plan, originals);
    expect(result).toMatchObject({ ok: true, unchangedPlanFiles: ["src/pagination.ts", "src/pagination.test.ts"] });
  });

  it("refuses files outside the plan, other change kinds, and policy violations", () => {
    const result = reviewPatch(
      proposal([
        { path: "src/other.ts", change: "create", content: "x" },
        { path: "src/legacy.ts", change: "modify", edits: [{ find: "export", replace: "x" }] },
        { path: ".github/workflows/ci.yml", change: "create", content: "on: push" },
        { path: "../outside.ts", change: "create", content: "x" },
      ]),
      plan,
      originals,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([
      "src/other.ts is not in the approved plan; only change the files the plan lists.",
      'src/legacy.ts must be a "delete" change, as the approved plan states, not "modify".',
      expect.stringMatching(/workflows.*denied prefix/),
      expect.stringMatching(/outside.*traversal/),
    ]);
  });

  it("refuses duplicate entries, failed edits, binary text, and oversized files", () => {
    const limits = { ...DEFAULT_PATCH_LIMITS, maxFileBytes: 64 };
    const result = reviewPatch(
      proposal([
        { path: "src/pagination.ts", change: "modify", edits: [{ find: "nowhere", replace: "x" }] },
        { path: "src/pagination.ts", change: "modify", edits: [{ find: "Math", replace: "M" }] },
        { path: "src/pagination.test.ts", change: "create", content: "x".repeat(65) },
      ]),
      plan,
      originals,
      limits,
    );
    expect(result).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/does not occur/), expect.stringMatching(/more than once; put all edits/), expect.stringMatching(/exceed 64 bytes/)],
    });

    const binary = reviewPatch(proposal([{ path: "src/pagination.test.ts", change: "create", content: "a\0b" }]), plan, originals);
    expect(binary).toMatchObject({ ok: false, problems: [expect.stringMatching(/binary/)] });
  });
});

describe("checkDiffLimits", () => {
  const stats = [{ path: "a.ts", change: "modify" as const, additions: 900, deletions: 700 }];

  it("accepts a diff within the limits", () => {
    expect(checkDiffLimits(stats, 10_000, { ...DEFAULT_PATCH_LIMITS, maxChangedLines: 1_600 })).toEqual([]);
  });

  it("reports too many changed lines and an oversized diff", () => {
    expect(checkDiffLimits(stats, 2 * 1024 * 1024)).toEqual([expect.stringMatching(/1600 lines/), expect.stringMatching(/2048 KB/)]);
  });
});
