import type { ChunkCandidate } from "./context-builder";
import { assembleContext, findRelatedTests } from "./context-builder";

function chunk(path: string, chunkIndex: number, score: number, size = 100, reasons: ChunkCandidate["reasons"] = ["text_match"]): ChunkCandidate {
  const startLine = chunkIndex * 10 + 1;
  return { path, chunkIndex, startLine, endLine: startLine + 9, content: "x".repeat(size), score, reasons };
}

describe("assembleContext", () => {
  it("combines the same chunk found several ways", () => {
    const { snippets } = assembleContext([chunk("a.ts", 0, 1), chunk("a.ts", 0, 5, 100, ["symbol_match"])]);
    expect(snippets).toHaveLength(1);
    expect(snippets[0]).toMatchObject({ score: 6, reasons: ["text_match", "symbol_match"] });
  });

  it("never exceeds the character budget and reports what was dropped", () => {
    const result = assembleContext([chunk("a.ts", 0, 9, 600), chunk("b.ts", 0, 8, 600), chunk("c.ts", 0, 7, 300)], {
      maxChars: 1_000,
      maxSnippets: 10,
      maxChunksPerFile: 3,
    });
    expect(result.snippets.map((s) => s.path)).toEqual(["a.ts", "c.ts"]);
    expect(result.usedChars).toBe(900);
    expect(result.droppedSnippets).toBe(1);
  });

  it("limits chunks per file and total snippets", () => {
    const many = [0, 2, 4, 6].map((i) => chunk("big.ts", i, 10 - i));
    const result = assembleContext([...many, chunk("small.ts", 0, 1)], { maxChars: 10_000, maxSnippets: 3, maxChunksPerFile: 2 });
    expect(result.snippets.filter((s) => s.path === "big.ts")).toHaveLength(2);
    expect(result.snippets).toHaveLength(3);
  });

  it("merges adjacent chunks of a file into one line range", () => {
    const { snippets } = assembleContext([chunk("a.ts", 1, 3), chunk("a.ts", 0, 2), chunk("a.ts", 3, 1)]);
    expect(snippets.map((s) => [s.startLine, s.endLine])).toEqual([
      [1, 20],
      [31, 40],
    ]);
    expect(snippets[0]!.content).toBe(`${"x".repeat(100)}\n${"x".repeat(100)}`);
  });
});

describe("findRelatedTests", () => {
  it("matches tests to sources by file stem", () => {
    const all = ["src/auth/session.ts", "src/auth/session.spec.ts", "test/session.test.ts", "src/__tests__/other.ts", "src/user.spec.ts"];
    expect(findRelatedTests(["src/auth/session.ts", "README.md"], all)).toEqual(["src/auth/session.spec.ts", "test/session.test.ts"]);
  });
});
