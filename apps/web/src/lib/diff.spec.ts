import { parseUnifiedDiff } from "./diff";

const SHA = "a".repeat(40);

const diff = [
  `diff --git a/src/legacy.ts b/src/legacy.ts`,
  `deleted file mode 100644`,
  `index ${SHA}..${"0".repeat(40)}`,
  `--- a/src/legacy.ts`,
  `+++ /dev/null`,
  `@@ -1 +0,0 @@`,
  `-export const unused = true;`,
  `diff --git a/src/pagination.test.ts b/src/pagination.test.ts`,
  `new file mode 100644`,
  `index ${"0".repeat(40)}..${SHA}`,
  `--- /dev/null`,
  `+++ b/src/pagination.test.ts`,
  `@@ -0,0 +1,2 @@`,
  `+import { totalPages } from "./pagination";`,
  `+test("last page", () => expect(totalPages(10, 3)).toBe(4));`,
  `diff --git a/src/pagination.ts b/src/pagination.ts`,
  `index ${SHA}..${SHA}`,
  `--- a/src/pagination.ts`,
  `+++ b/src/pagination.ts`,
  `@@ -10,3 +10,3 @@ export function totalPages(total: number, size: number) {`,
  `   // pages`,
  `-  return Math.floor(total / size);`,
  `+  return Math.ceil(total / size);`,
  ` }`,
  `\\ No newline at end of file`,
  ``,
].join("\n");

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(diff);

  it("finds every file with its change kind and counts", () => {
    expect(files.map((f) => [f.path, f.change, f.additions, f.deletions])).toEqual([
      ["src/legacy.ts", "delete", 0, 1],
      ["src/pagination.test.ts", "create", 2, 0],
      ["src/pagination.ts", "modify", 1, 1],
    ]);
  });

  it("numbers old and new lines from the hunk header", () => {
    const lines = files[2]!.hunks[0]!.lines;
    expect(lines).toEqual([
      { kind: "context", text: "  // pages", oldLine: 10, newLine: 10 },
      { kind: "del", text: "  return Math.floor(total / size);", oldLine: 11, newLine: null },
      { kind: "add", text: "  return Math.ceil(total / size);", oldLine: null, newLine: 11 },
      { kind: "context", text: "}", oldLine: 12, newLine: 12 },
      { kind: "note", text: "No newline at end of file", oldLine: null, newLine: null },
    ]);
    expect(files[2]!.hunks[0]!.header).toMatch(/^@@ -10,3 \+10,3 @@ export function totalPages/);
  });

  it("starts new files at line 1", () => {
    expect(files[1]!.hunks[0]!.lines.map((l) => l.newLine)).toEqual([1, 2]);
  });

  it("marks binary changes and tolerates an empty diff", () => {
    const binary = parseUnifiedDiff(`diff --git a/logo.png b/logo.png\nindex ${SHA}..${SHA}\nGIT binary patch\nliteral 12\nabc\n`);
    expect(binary).toEqual([{ path: "logo.png", change: "modify", binary: true, additions: 0, deletions: 0, hunks: [] }]);
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("does not treat file header lines inside a hunk as headers", () => {
    const tricky = [`diff --git a/a.md b/a.md`, `--- a/a.md`, `+++ b/a.md`, `@@ -1 +1 @@`, `---- a/heading`, `++++ b/heading`].join("\n");
    const [file] = parseUnifiedDiff(tricky);
    expect(file).toMatchObject({ path: "a.md", additions: 1, deletions: 1 });
  });
});
