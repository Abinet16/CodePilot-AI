import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceManager } from "./workspace";

const TASK = "11111111-2222-4333-8444-555555555555";

describe("WorkspaceManager", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codepilot-ws-"));
  const manager = new WorkspaceManager(root);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("creates a private per-task directory and removes it without following symlinks", async () => {
    const victim = mkdtempSync(path.join(tmpdir(), "codepilot-victim-"));
    writeFileSync(path.join(victim, "keep.txt"), "keep");

    const ws = await manager.create(TASK);
    expect(path.dirname(ws.dir)).toBe(path.resolve(root));
    mkdirSync(ws.repoDir);
    symlinkSync(victim, path.join(ws.repoDir, "link"));

    await ws.remove();
    expect(existsSync(ws.dir)).toBe(false);
    expect(existsSync(path.join(victim, "keep.txt"))).toBe(true);
    rmSync(victim, { recursive: true, force: true });
  });

  it("rejects task ids that could escape the root", async () => {
    await expect(manager.create("../../etc")).rejects.toThrow(/Invalid task id/);
  });

  it("sweeps only stale workspace directories", async () => {
    const stale = await manager.create(TASK);
    const fresh = await manager.create(TASK);
    const unrelated = path.join(root, "not-a-workspace");
    mkdirSync(unrelated);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(stale.dir, old, old);
    utimesSync(unrelated, old, old);

    expect(await manager.sweep(60_000)).toBe(1);
    expect(existsSync(stale.dir)).toBe(false);
    expect(existsSync(fresh.dir)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });
});
