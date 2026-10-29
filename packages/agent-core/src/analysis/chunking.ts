export interface Chunk {
  index: number;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  content: string;
}

export interface ChunkOptions {
  maxLines: number;
  maxChars: number;
  /** How far back from a full chunk to look for a blank line to split on. */
  lookback: number;
}

const DEFAULTS: ChunkOptions = { maxLines: 60, maxChars: 6_000, lookback: 15 };

/**
 * Splits a file into non-overlapping line ranges. Chunks prefer to end at a
 * blank line so declarations are less often cut in half. Because ranges do not
 * overlap, adjacent chunks can later be merged back by concatenation.
 */
export function chunkLines(content: string, options: Partial<ChunkOptions> = {}): Chunk[] {
  const { maxLines, maxChars, lookback } = { ...DEFAULTS, ...options };
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();

  const chunks: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let chars = 0;
    while (end < lines.length && end - start < maxLines && (end === start || chars + lines[end]!.length + 1 <= maxChars)) {
      chars += lines[end]!.length + 1;
      end++;
    }
    if (end < lines.length) {
      for (let i = end - 1; i > start && i >= end - lookback; i--) {
        if (lines[i]!.trim() === "") {
          end = i + 1;
          break;
        }
      }
    }
    chunks.push({ index: chunks.length, startLine: start + 1, endLine: end, content: lines.slice(start, end).join("\n") });
    start = end;
  }
  return chunks;
}
