import path from "node:path";
import type { ContextSnippet, RetrievalReason } from "@codepilot/contracts";
import { isTestFile } from "./project-profile";

export interface ChunkCandidate {
  path: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  reasons: readonly RetrievalReason[];
}

export interface ContextBudget {
  maxChars: number;
  maxSnippets: number;
  maxChunksPerFile: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = { maxChars: 48_000, maxSnippets: 16, maxChunksPerFile: 3 };

export interface AssembledContext {
  snippets: ContextSnippet[];
  usedChars: number;
  droppedSnippets: number;
}

const key = (c: { path: string; chunkIndex: number }) => `${c.path}\u0000${c.chunkIndex}`;

/**
 * Turns scored chunk candidates (possibly the same chunk found several ways)
 * into a context package that never exceeds the budget. Higher scores win;
 * adjacent chunks of one file are merged back into a single line range.
 */
export function assembleContext(candidates: readonly ChunkCandidate[], budget: ContextBudget = DEFAULT_CONTEXT_BUDGET): AssembledContext {
  const merged = new Map<string, ChunkCandidate & { reasons: RetrievalReason[] }>();
  for (const c of candidates) {
    const existing = merged.get(key(c));
    if (existing) {
      existing.score += c.score;
      for (const r of c.reasons) if (!existing.reasons.includes(r)) existing.reasons.push(r);
    } else {
      merged.set(key(c), { ...c, reasons: [...c.reasons] });
    }
  }

  const ranked = [...merged.values()].sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine,
  );

  const selected: typeof ranked = [];
  const perFile = new Map<string, number>();
  let usedChars = 0;
  for (const c of ranked) {
    if (selected.length >= budget.maxSnippets) break;
    if ((perFile.get(c.path) ?? 0) >= budget.maxChunksPerFile) continue;
    if (usedChars + c.content.length > budget.maxChars) continue;
    selected.push(c);
    perFile.set(c.path, (perFile.get(c.path) ?? 0) + 1);
    usedChars += c.content.length;
  }

  const byFile = new Map<string, typeof selected>();
  for (const c of selected) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c]);

  const snippets: ContextSnippet[] = [];
  for (const [filePath, chunks] of byFile) {
    chunks.sort((a, b) => a.startLine - b.startLine);
    let current: ContextSnippet | null = null;
    for (const c of chunks) {
      if (current && current.endLine + 1 === c.startLine) {
        current.endLine = c.endLine;
        current.content += `\n${c.content}`;
        current.score = Math.max(current.score, c.score);
        for (const r of c.reasons) if (!current.reasons.includes(r)) current.reasons.push(r);
      } else {
        current = { path: filePath, startLine: c.startLine, endLine: c.endLine, content: c.content, score: c.score, reasons: [...c.reasons] };
        snippets.push(current);
      }
    }
  }
  snippets.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine);

  return { snippets, usedChars, droppedSnippets: merged.size - selected.length };
}

const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;

/** Test files that, by naming convention, exercise the given source files. */
export function findRelatedTests(sourcePaths: readonly string[], allPaths: readonly string[], limit = 20): string[] {
  const stems = new Set(
    sourcePaths.filter((p) => SOURCE_EXTENSION.test(p) && !isTestFile(p)).map((p) => path.posix.basename(p).replace(SOURCE_EXTENSION, "")),
  );
  if (stems.size === 0) return [];

  const related: string[] = [];
  for (const candidate of allPaths) {
    if (!isTestFile(candidate)) continue;
    const stem = path.posix.basename(candidate).replace(SOURCE_EXTENSION, "").replace(/[._](test|spec)$/, "");
    if (stems.has(stem)) related.push(candidate);
    if (related.length >= limit) break;
  }
  return related.sort();
}
