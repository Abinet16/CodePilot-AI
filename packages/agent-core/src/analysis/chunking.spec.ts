import { chunkLines } from "./chunking";

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("chunkLines", () => {
  it("covers every line exactly once, without overlap", () => {
    const chunks = chunkLines(`${numbered(130)}\n`, { maxLines: 50 });
    expect(chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 50],
      [51, 100],
      [101, 130],
    ]);
    expect(chunks.map((c) => c.content).join("\n")).toBe(numbered(130));
  });

  it("prefers to split at a blank line", () => {
    const lines = numbered(20).split("\n");
    lines[7] = "";
    const chunks = chunkLines(lines.join("\n"), { maxLines: 10, lookback: 5 });
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 8 });
    expect(chunks[1]!.startLine).toBe(9);
  });

  it("bounds chunk size in characters", () => {
    const chunks = chunkLines(Array.from({ length: 10 }, () => "x".repeat(99)).join("\n"), { maxChars: 300 });
    expect(chunks.every((c) => c.content.length <= 300)).toBe(true);
    expect(chunks.at(-1)!.endLine).toBe(10);
  });

  it("returns nothing for an empty file", () => {
    expect(chunkLines("")).toEqual([]);
  });
});
