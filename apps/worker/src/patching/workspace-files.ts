import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ImplementationPlan } from "@codepilot/contracts";
import type { FileChange } from "@codepilot/agent-core";
import { resolveWorkspacePath } from "@codepilot/agent-core";
import type { LocalRepo } from "../git/patch-ops";
import { REGULAR_FILE_MODES, trackedModes } from "../git/patch-ops";

/** A patch that cannot be produced for a reason the user can act on. Not retried. */
export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

/**
 * Checks every planned file against the checkout and returns the current text
 * of the files to modify. Only regular tracked text files may be modified or
 * deleted, and a file to create must not exist yet.
 */
export async function readPlannedFiles(repo: LocalRepo, plan: ImplementationPlan, maxFileBytes: number): Promise<Map<string, string>> {
  const modes = await trackedModes(
    repo,
    plan.affectedFiles.map((f) => f.path),
  );
  const contents = new Map<string, string>();

  for (const { path: rel, change } of plan.affectedFiles) {
    const abs = await resolveWorkspacePath(repo.repoDir, rel);
    const info = await lstat(abs).catch(() => null);

    if (change === "create") {
      if (modes.has(rel) || info) throw new PatchError(`The plan creates ${rel}, but it already exists at the pinned commit`);
      continue;
    }

    const mode = modes.get(rel);
    if (!mode || !info) throw new PatchError(`The plan changes ${rel}, but it is not a tracked file at the pinned commit`);
    if (!REGULAR_FILE_MODES.has(mode) || !info.isFile()) {
      throw new PatchError(`The plan changes ${rel}, which is a symlink or submodule; the agent only edits regular files`);
    }
    if (change === "delete") continue;

    if (info.size > maxFileBytes) {
      throw new PatchError(`${rel} is ${Math.ceil(info.size / 1024)} KB, over the ${Math.round(maxFileBytes / 1024)} KB limit for files the agent edits`);
    }
    const content = await readFile(abs, "utf8");
    if (content.includes("\0")) throw new PatchError(`${rel} is a binary file; the agent only edits text files`);
    contents.set(rel, content);
  }
  return contents;
}

/**
 * Writes validated changes into the checkout. Every path is resolved through
 * the path policy again here, immediately before the write, and a new file
 * is created exclusively so it can never overwrite one that appeared since.
 */
export async function writeChanges(repoDir: string, changes: readonly FileChange[]): Promise<void> {
  for (const change of changes) {
    const abs = await resolveWorkspacePath(repoDir, change.path);
    if (change.content === null) {
      await rm(abs);
    } else if (change.change === "create") {
      await mkdir(path.dirname(abs), { recursive: true });
      await resolveWorkspacePath(repoDir, change.path);
      await writeFile(abs, change.content, { flag: "wx", mode: 0o644 });
    } else {
      if (!(await lstat(abs)).isFile()) throw new PatchError(`${change.path} is no longer a regular file`);
      await writeFile(abs, change.content);
    }
  }
}
