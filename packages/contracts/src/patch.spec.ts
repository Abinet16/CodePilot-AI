import { PatchOutcomeSchema } from "./patch";

describe("PatchOutcomeSchema", () => {
  const patch = {
    summary: "Count the last partial page",
    commitMessage: "Fix pagination off-by-one",
    files: [
      { path: "src/pagination.ts", change: "modify", edits: [{ find: "Math.floor", replace: "Math.ceil" }] },
      { path: "src/pagination.test.ts", change: "create", content: "test('x', () => {});\n" },
      { path: "src/old.ts", change: "delete" },
    ],
  };

  it("accepts edits, new files, and deletions", () => {
    expect(PatchOutcomeSchema.safeParse({ kind: "patch", patch }).success).toBe(true);
  });

  it("accepts an explicit rejection", () => {
    expect(PatchOutcomeSchema.safeParse({ kind: "rejected", reason: "The plan names a file that cannot hold this change" }).success).toBe(true);
  });

  it("requires edits to find something and changes to touch a file", () => {
    const emptyFind = { ...patch, files: [{ path: "a.ts", change: "modify", edits: [{ find: "", replace: "x" }] }] };
    const noEdits = { ...patch, files: [{ path: "a.ts", change: "modify", edits: [] }] };
    expect(PatchOutcomeSchema.safeParse({ kind: "patch", patch: emptyFind }).success).toBe(false);
    expect(PatchOutcomeSchema.safeParse({ kind: "patch", patch: noEdits }).success).toBe(false);
    expect(PatchOutcomeSchema.safeParse({ kind: "patch", patch: { ...patch, files: [] } }).success).toBe(false);
  });

  it("keeps the commit message to one short line", () => {
    for (const commitMessage of ["Fix it\n\nCo-authored-by: someone", "x".repeat(73), "  "]) {
      expect(PatchOutcomeSchema.safeParse({ kind: "patch", patch: { ...patch, commitMessage } }).success).toBe(false);
    }
  });

  it("rejects a file entry whose fields do not match its change kind", () => {
    const createWithoutContent = { ...patch, files: [{ path: "a.ts", change: "create", edits: [{ find: "a", replace: "b" }] }] };
    expect(PatchOutcomeSchema.safeParse({ kind: "patch", patch: createWithoutContent }).success).toBe(false);
  });
});
