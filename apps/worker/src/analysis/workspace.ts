import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Workspace directory names: `<taskId>-<random>`. Only these are ever swept. */
const WORKSPACE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}$/;

export interface Workspace {
  dir: string;
  repoDir: string;
  homeDir: string;
  remove(): Promise<void>;
}

/** Disposable per-task directories under WORKSPACE_ROOT. */
export class WorkspaceManager {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async create(taskId: string): Promise<Workspace> {
    if (!UUID.test(taskId)) throw new Error(`Invalid task id for workspace: ${JSON.stringify(taskId)}`);
    const dir = path.join(this.root, `${taskId}-${randomBytes(4).toString("hex")}`);
    const repoDir = path.join(dir, "repo");
    const homeDir = path.join(dir, "home");
    await mkdir(homeDir, { recursive: true, mode: 0o700 });
    return {
      dir,
      repoDir,
      homeDir,
      // rm never follows symlinks, so links planted by the repository cannot redirect the delete.
      remove: () => rm(dir, { recursive: true, force: true }),
    };
  }

  /** Removes workspaces left behind by a crashed worker. Returns how many were removed. */
  async sweep(maxAgeMs: number, now = Date.now()): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of entries) {
      if (!WORKSPACE_NAME.test(name)) continue;
      const dir = path.join(this.root, name);
      const info = await stat(dir).catch(() => null);
      if (info?.isDirectory() && now - info.mtimeMs > maxAgeMs) {
        await rm(dir, { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }
}
