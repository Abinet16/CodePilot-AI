import { PATCH_OUTPUT_SCHEMA, toPatchOutcome } from "./output-schema";

function closed(node: unknown): boolean {
  if (typeof node !== "object" || node === null) return true;
  const n = node as Record<string, unknown>;
  if (n.type === "object" && n.additionalProperties !== false) return false;
  return Object.values(n).every((v) => (Array.isArray(v) ? v.every(closed) : closed(v)));
}

describe("PATCH_OUTPUT_SCHEMA", () => {
  it("closes every object, as structured outputs require", () => {
    expect(closed(PATCH_OUTPUT_SCHEMA)).toBe(true);
  });
});

describe("toPatchOutcome", () => {
  const files = [
    { path: "src/a.ts", change: "modify", edits: [{ find: "a", replace: "b" }], content: null },
    { path: "src/b.test.ts", change: "create", edits: null, content: "test('b', () => {});\n" },
    { path: "src/c.ts", change: "delete", edits: null, content: null },
  ];

  it("keeps only the field each change kind uses", () => {
    const result = toPatchOutcome({ kind: "patch", reason: null, patch: { summary: "s", commitMessage: "Fix a", files } });
    expect(result).toEqual({
      ok: true,
      outcome: {
        kind: "patch",
        patch: {
          summary: "s",
          commitMessage: "Fix a",
          files: [
            { path: "src/a.ts", change: "modify", edits: [{ find: "a", replace: "b" }] },
            { path: "src/b.test.ts", change: "create", content: "test('b', () => {});\n" },
            { path: "src/c.ts", change: "delete" },
          ],
        },
      },
    });
  });

  it("accepts a rejection with a reason", () => {
    expect(toPatchOutcome({ kind: "rejected", reason: "The plan targets the wrong file", patch: null })).toEqual({
      ok: true,
      outcome: { kind: "rejected", reason: "The plan targets the wrong file" },
    });
  });

  it("explains what is wrong in terms the model can act on", () => {
    const missingEdits = { kind: "patch", reason: null, patch: { summary: "s", commitMessage: "Fix", files: [{ ...files[0], edits: null }] } };
    const result = toPatchOutcome(missingEdits);
    expect(result).toMatchObject({ ok: false, problems: [expect.stringMatching(/^patch\.files\.0\.edits: /)] });
    expect(toPatchOutcome("nope")).toEqual({ ok: false, problems: ["The answer was not a JSON object."] });
    expect(toPatchOutcome({ kind: "patch", patch: null })).toMatchObject({ ok: false });
  });
});
