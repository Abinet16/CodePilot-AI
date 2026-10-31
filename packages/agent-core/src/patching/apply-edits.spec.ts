import { applyEdits } from "./apply-edits";

const source = "export function paginate(total: number, size: number) {\n  return Math.floor(total / size);\n}\n";

describe("applyEdits", () => {
  it("replaces text that occurs exactly once", () => {
    const result = applyEdits("src/p.ts", source, [{ find: "Math.floor", replace: "Math.ceil" }]);
    expect(result).toEqual({ ok: true, content: source.replace("Math.floor", "Math.ceil") });
  });

  it("applies edits in order against the edited text", () => {
    const result = applyEdits("a.ts", "a\nb\n", [
      { find: "a\n", replace: "a\nx\n" },
      { find: "x\nb", replace: "x\ny" },
    ]);
    expect(result).toEqual({ ok: true, content: "a\nx\ny\n" });
  });

  it("treats replacement text literally, including $ patterns", () => {
    const result = applyEdits("a.ts", "const a = 1;\n", [{ find: "1", replace: "'$&$1'" }]);
    expect(result).toEqual({ ok: true, content: "const a = '$&$1';\n" });
  });

  it("reports text that is missing or ambiguous, for every failing edit", () => {
    const result = applyEdits("src/p.ts", "x\nx\n", [
      { find: "y", replace: "z" },
      { find: "x", replace: "z" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual([expect.stringMatching(/^src\/p.ts edit 1: .*does not occur/), expect.stringMatching(/^src\/p.ts edit 2: .*more than once/)]);
  });

  it("rejects edits that change nothing", () => {
    expect(applyEdits("a.ts", "same\n", [{ find: "same", replace: "same" }])).toMatchObject({ ok: false, problems: [expect.stringMatching(/unchanged/)] });
  });
});
