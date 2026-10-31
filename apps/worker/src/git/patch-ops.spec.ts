import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFixtureRepo } from "../../test/git-fixture";
import { fetchCommit } from "./git";
import type { LocalRepo } from "./patch-ops";
import { applyDiff, commitPaths, createBranch, diffFromBase, resetTo, trackedModes } from "./patch-ops";

const identity = { name: "CodePilot AI", email: "codepilot@invalid" };

describe("patch git operations", () => {
  const fixture = createFixtureRepo({
    "src/pagination.ts": "export const pages = (t: number, s: number) => Math.floor(t / s);\n",
    "src/legacy.ts": "export {};\n",
    "link.ts": { symlink: "src/legacy.ts" },
  });
  const work = mkdtempSync(path.join(tmpdir(), "codepilot-patch-ops-"));
  let n = 0;

  async function checkout(): Promise<LocalRepo> {
    const repoDir = path.join(work, `repo-${++n}`);
    await fetchCommit({ repoDir, homeDir: work, remoteUrl: fixture.url, commitSha: fixture.commitSha, token: null, timeoutMs: 30_000, allowFileProtocol: true });
    return { repoDir, homeDir: work, timeoutMs: 30_000 };
  }

  const show = (repo: LocalRepo, ...args: string[]) => execFileSync("git", ["-c", "core.symlinks=false", "-C", repo.repoDir, ...args], { env: { PATH: process.env.PATH, HOME: work } }).toString();

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("reports tracked modes, so symlinks can be refused", async () => {
    const repo = await checkout();
    const modes = await trackedModes(repo, ["src/pagination.ts", "link.ts", "src/new.ts"]);
    expect(Object.fromEntries(modes)).toEqual({ "src/pagination.ts": "100644", "link.ts": "120000" });
  });

  it("commits exactly the patched files on a new branch with a fixed identity", async () => {
    const repo = await checkout();
    await createBranch(repo, "codepilot/fix-1a2b3c4d");
    writeFileSync(path.join(repo.repoDir, "src/pagination.ts"), "export const pages = (t: number, s: number) => Math.ceil(t / s);\n");
    writeFileSync(path.join(repo.repoDir, "src/pagination.test.ts"), "test('x', () => {});\n");
    unlinkSync(path.join(repo.repoDir, "src/legacy.ts"));

    const { commitSha, treeSha } = await commitPaths(repo, ["src/pagination.ts", "src/pagination.test.ts", "src/legacy.ts"], "Fix pagination\n\nBody", identity);
    expect(show(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("codepilot/fix-1a2b3c4d");
    expect(show(repo, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%P|%T", commitSha).trim()).toBe(
      `CodePilot AI <codepilot@invalid>|CodePilot AI <codepilot@invalid>|${fixture.commitSha}|${treeSha}`,
    );

    const { diff, files, binary } = await diffFromBase(repo, fixture.commitSha);
    expect(files).toEqual([
      { path: "src/legacy.ts", change: "delete", additions: 0, deletions: 1 },
      { path: "src/pagination.test.ts", change: "create", additions: 1, deletions: 0 },
      { path: "src/pagination.ts", change: "modify", additions: 1, deletions: 1 },
    ]);
    expect(binary).toEqual([]);
    expect(diff).toContain("+export const pages = (t: number, s: number) => Math.ceil(t / s);");

    // The stored diff rebuilds the same tree on a fresh checkout of the base.
    const fresh = await checkout();
    const diffFile = path.join(work, "patch.diff");
    writeFileSync(diffFile, diff);
    expect(await applyDiff(fresh, diffFile)).toBe(treeSha);
  });

  it("refuses to commit changes outside the validated paths", async () => {
    const repo = await checkout();
    writeFileSync(path.join(repo.repoDir, "src/pagination.ts"), "changed\n");
    writeFileSync(path.join(repo.repoDir, "stray.ts"), "sneaky\n");
    await expect(commitPaths(repo, ["src/pagination.ts"], "Fix", identity)).rejects.toThrow(/Unexpected changes outside the patch: stray.ts/);
  });

  it("refuses an empty commit", async () => {
    const repo = await checkout();
    await expect(commitPaths(repo, ["src/pagination.ts"], "Nothing", identity)).rejects.toThrow(/no changes/);
  });

  it("resets the working tree to the base between attempts", async () => {
    const repo = await checkout();
    writeFileSync(path.join(repo.repoDir, "src/pagination.ts"), "changed\n");
    await commitPaths(repo, ["src/pagination.ts"], "Attempt", identity);
    writeFileSync(path.join(repo.repoDir, "untracked.ts"), "x\n");

    await resetTo(repo, fixture.commitSha);
    expect(show(repo, "rev-parse", "HEAD").trim()).toBe(fixture.commitSha);
    expect(show(repo, "status", "--porcelain")).toBe("");
  });

  it("rejects a branch name git would not accept", async () => {
    const repo = await checkout();
    await expect(createBranch(repo, "codepilot/bad..name")).rejects.toThrow(/check-ref-format failed/);
  });
});
