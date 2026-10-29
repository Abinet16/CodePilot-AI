import path from "node:path";
import { SECRET_FILE_PATTERNS } from "../path-policy";
import { detectLanguage } from "./language";

/**
 * Decides which repository files are indexed. Path rules run before a file is
 * opened, so secrets are never read at all; content rules then drop binary,
 * oversized, and minified files.
 */

export type SkipReason =
  | "excluded_dir"
  | "secret"
  | "lockfile"
  | "generated"
  | "unsupported_type"
  | "not_regular_file"
  | "too_large"
  | "binary"
  | "long_lines"
  | "limit";

export interface AnalysisLimits {
  maxFileBytes: number;
  maxLineLength: number;
  maxIndexedFiles: number;
  maxTotalBytes: number;
  /** Directory entries visited before the walk stops, so a hostile tree cannot stall the worker. */
  maxWalkEntries: number;
}

export const DEFAULT_ANALYSIS_LIMITS: AnalysisLimits = {
  maxFileBytes: 200_000,
  maxLineLength: 2_000,
  maxIndexedFiles: 5_000,
  maxTotalBytes: 40_000_000,
  maxWalkEntries: 50_000,
};

const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".vercel",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".yarn",
  ".pnpm-store",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".workspaces",
]);

const EXTRA_SECRET_PATTERNS = [/^\.netrc$/i, /^\.pgpass$/i, /\.(jks|keystore)$/i];

const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "go.sum",
]);

const GENERATED = [/\.min\.(js|css)$/i, /\.map$/i, /\.snap$/i, /\.generated\.[a-z]+$/i, /^next-env\.d\.ts$/];

export function isExcludedDirectory(name: string): boolean {
  return EXCLUDED_DIRECTORIES.has(name);
}

/** Path-only decision for a repository-relative POSIX path. Returns null when the file may be read. */
export function classifyPath(relativePath: string): SkipReason | null {
  const segments = relativePath.split("/");
  if (segments.slice(0, -1).some(isExcludedDirectory)) return "excluded_dir";

  const base = path.posix.basename(relativePath);
  if (SECRET_FILE_PATTERNS.some((re) => re.test(base)) || EXTRA_SECRET_PATTERNS.some((re) => re.test(base))) return "secret";
  if (LOCKFILES.has(base)) return "lockfile";
  if (GENERATED.some((re) => re.test(base))) return "generated";
  if (detectLanguage(relativePath) === null) return "unsupported_type";
  return null;
}

/** Content decision for a file that passed classifyPath. */
export function classifyContent(content: Buffer, limits: AnalysisLimits = DEFAULT_ANALYSIS_LIMITS): SkipReason | null {
  if (content.length > limits.maxFileBytes) return "too_large";
  // git treats a NUL byte as the mark of a binary file; PostgreSQL text cannot store one either.
  if (content.includes(0)) return "binary";

  let lineStart = 0;
  for (let i = 0; i <= content.length; i++) {
    if (i === content.length || content[i] === 0x0a) {
      if (i - lineStart > limits.maxLineLength) return "long_lines";
      lineStart = i + 1;
    }
  }
  return null;
}
