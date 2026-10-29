import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Validates file paths proposed by the model. Model output is untrusted: a
 * path is accepted only if it is relative, stays inside the workspace after
 * normalization and symlink resolution, and does not touch denied locations.
 */

const DENIED_SEGMENTS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".workspaces"]);

/** Files that commonly hold credentials. Never written by the agent, and never read during analysis. */
export const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.yarnrc(\.yml)?$/i,
  /\.(pem|key|p12|pfx|crt)$/i,
  /^id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
];

/** CI and repo-automation files can escalate privileges once merged. */
const DENIED_PREFIXES = [".github/workflows/", ".husky/"];

export type PathViolation =
  | "empty"
  | "null_byte"
  | "absolute"
  | "traversal"
  | "denied_segment"
  | "denied_file"
  | "denied_prefix"
  | "outside_workspace";

export class PathPolicyError extends Error {
  constructor(
    readonly requestedPath: string,
    readonly violation: PathViolation,
  ) {
    super(`Path rejected (${violation}): ${JSON.stringify(requestedPath)}`);
    this.name = "PathPolicyError";
  }
}

/**
 * Pure, filesystem-free check. Returns the normalized POSIX path relative to
 * the workspace root, or throws PathPolicyError.
 */
export function normalizeRelativePath(requested: string): string {
  if (requested.trim() === "") throw new PathPolicyError(requested, "empty");
  if (requested.includes("\0")) throw new PathPolicyError(requested, "null_byte");

  const posix = requested.replace(/\\/g, "/");
  if (posix.startsWith("/") || /^[a-zA-Z]:/.test(posix)) {
    throw new PathPolicyError(requested, "absolute");
  }

  const normalized = path.posix.normalize(posix).replace(/^\.\//, "");
  if (normalized === "." || normalized === "") throw new PathPolicyError(requested, "empty");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new PathPolicyError(requested, "traversal");
  }

  const segments = normalized.split("/");
  if (segments.some((s) => DENIED_SEGMENTS.has(s))) {
    throw new PathPolicyError(requested, "denied_segment");
  }
  const base = segments[segments.length - 1]!;
  if (SECRET_FILE_PATTERNS.some((re) => re.test(base))) {
    throw new PathPolicyError(requested, "denied_file");
  }
  if (DENIED_PREFIXES.some((p) => normalized.startsWith(p))) {
    throw new PathPolicyError(requested, "denied_prefix");
  }
  return normalized;
}

/**
 * Resolves a requested path against the workspace and verifies that the
 * deepest existing ancestor (after following symlinks) is still inside the
 * workspace. Guards against symlinks planted by a malicious repository.
 */
export async function resolveWorkspacePath(workspaceRoot: string, requested: string): Promise<string> {
  const relative = normalizeRelativePath(requested);
  const root = await realpath(workspaceRoot);
  const target = path.join(root, relative);

  let existing = target;
  for (;;) {
    try {
      const real = await realpath(existing);
      if (real !== root && !real.startsWith(root + path.sep)) {
        throw new PathPolicyError(requested, "outside_workspace");
      }
      break;
    } catch (err) {
      if (err instanceof PathPolicyError) throw err;
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(existing);
      if (parent === existing) throw new PathPolicyError(requested, "outside_workspace");
      existing = parent;
    }
  }
  return target;
}
