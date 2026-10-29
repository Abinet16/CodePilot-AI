import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import type { IndexStats } from "@codepilot/contracts";
import type { AnalysisLimits, SkipReason } from "@codepilot/agent-core";
import { DEFAULT_ANALYSIS_LIMITS, classifyContent, classifyPath, detectLanguage, isExcludedDirectory } from "@codepilot/agent-core";

export interface ScannedFile {
  path: string;
  language: string;
  content: string;
  sizeBytes: number;
  contentHash: string;
}

export interface ScanResult {
  files: ScannedFile[];
  /** Every regular file path seen, indexed or not (bounded by maxWalkEntries). */
  paths: string[];
  stats: IndexStats;
}

async function readNoFollow(file: string): Promise<Buffer> {
  // O_NOFOLLOW: a path that is (or became) a symlink fails instead of being read through.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Walks a checked-out repository without following symlinks, applies the
 * agent-core file filter before any file is opened, and stops at the
 * configured file, byte, and entry limits.
 */
export async function scanRepository(root: string, limits: AnalysisLimits = DEFAULT_ANALYSIS_LIMITS): Promise<ScanResult> {
  const files: ScannedFile[] = [];
  const paths: string[] = [];
  const skipped: Partial<Record<SkipReason, number>> = {};
  const skip = (reason: SkipReason) => (skipped[reason] = (skipped[reason] ?? 0) + 1);
  let indexedBytes = 0;
  let visited = 0;
  let truncated = false;

  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const entries = (await readdir(path.join(root, relDir), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (++visited > limits.maxWalkEntries) {
        truncated = true;
        stack.length = 0;
        break;
      }
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (isExcludedDirectory(entry.name)) skip("excluded_dir");
        else stack.push(rel);
        continue;
      }
      if (!entry.isFile()) {
        skip("not_regular_file");
        continue;
      }
      paths.push(rel);

      const pathReason = classifyPath(rel);
      if (pathReason) {
        skip(pathReason);
        continue;
      }
      const abs = path.join(root, rel);
      const { size } = await lstat(abs);
      if (size > limits.maxFileBytes) {
        skip("too_large");
        continue;
      }
      if (files.length >= limits.maxIndexedFiles || indexedBytes + size > limits.maxTotalBytes) {
        skip("limit");
        truncated = true;
        continue;
      }

      const buffer = await readNoFollow(abs);
      const contentReason = classifyContent(buffer, limits);
      if (contentReason) {
        skip(contentReason);
        continue;
      }
      indexedBytes += buffer.length;
      files.push({
        path: rel,
        language: detectLanguage(rel)!,
        content: buffer.toString("utf8"),
        sizeBytes: buffer.length,
        contentHash: createHash("sha256").update(buffer).digest("hex"),
      });
    }
  }

  return {
    files,
    paths: paths.sort(),
    stats: { indexedFiles: files.length, indexedBytes, skipped: skipped as Record<string, number>, truncated },
  };
}
