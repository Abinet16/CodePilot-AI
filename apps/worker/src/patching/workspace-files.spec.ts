import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImplementationPlan } from "@codepilot/contracts";
import { PathPolicyError } from "@codepilot/agent-core";
import { createFixtureRepo } from "../../test/git-fixture";
import { fetchCommit } from "../git/git";
import type { LocalRepo } from "../git/patch-ops";
import { readPlannedFiles, writeChanges } from "./workspace-files";

function plan(affectedFiles: ImplementationPlan["affectedFiles"]): ImplementationPlan {
  return { summary: "s", assumptions: [], affectedFiles, implementationSteps: ["x"], testPlan: [], risks: [] };
}

const file = (path: string, change: "modify" | "create" | "delete") => ({ path, change, reason: "r" });

describe("planned workspace files", () => {
  const fixture = createFixtureRepo({
    "src/a.ts": "export const a = 1;\n",
    "src/big.ts": "x".repeat(2_048),
    "src/blob.bin": "a\0b",
    "link.ts": { symlink: "src/a.ts" },
  });
  const work = mkdtempSync(path.join(tmpdir(), "codepilot-files-"));
  let n = 0;

  async function checkout(): Promise<LocalRepo> {
    const repoDir = path.join(work, `repo-${++n}`);
    await fetchCommit({ repoDir, homeDir: work, remoteUrl: fixture.url, commitSha: fixture.commitSha, token: null, timeoutMs: 30_000, allowFileProtocol: true });
    return { repoDir, homeDir: work, timeoutMs: 30_000 };
  }

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("returns the contents of files to modify and checks the rest", async () => {
    const repo = await checkout();
    const contents = await readPlannedFiles(repo, plan([file("src/a.ts", "modify"), file("src/big.ts", "delete"), file("src/new.ts", "create")]), 1_024);
    expect(Object.fromEntries(contents)).toEqual({ "src/a.ts": "export const a = 1;\n" });
  });

  it.each([
    [file("link.ts", "modify"), /symlink or submodule/],
    [file("src/blob.bin", "modify"), /binary file/],
    [file("src/big.ts", "modify"), /over the 1 KB limit/],
    [file("src/a.ts", "create"), /already exists/],
    [file("src/missing.ts", "delete"), /not a tracked file/],
  ])("refuses %o", async (planned, message) => {
    const repo = await checkout();
    await expect(readPlannedFiles(repo, plan([planned]), 1_024)).rejects.toThrow(message);
  });

  it("writes, creates, and deletes files inside the checkout", async () => {
    const repo = await checkout();
    await writeChanges(repo.repoDir, [
      { path: "src/a.ts", change: "modify", content: "export const a = 2;\n" },
      { path: "src/deep/new.ts", change: "create", content: "export {};\n" },
      { path: "src/big.ts", change: "delete", content: null },
    ]);
    expect(readFileSync(path.join(repo.repoDir, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(readFileSync(path.join(repo.repoDir, "src/deep/new.ts"), "utf8")).toBe("export {};\n");
    expect(existsSync(path.join(repo.repoDir, "src/big.ts"))).toBe(false);
  });

  it("never writes through a symlinked directory planted in the checkout", async () => {
    const repo = await checkout();
    const outside = mkdtempSync(path.join(tmpdir(), "codepilot-outside-"));
    symlinkSync(outside, path.join(repo.repoDir, "escape"));
    await expect(writeChanges(repo.repoDir, [{ path: "escape/pwned.ts", change: "create", content: "x" }])).rejects.toBeInstanceOf(PathPolicyError);
    expect(existsSync(path.join(outside, "pwned.ts"))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it("does not overwrite a file that appeared after validation", async () => {
    const repo = await checkout();
    await expect(writeChanges(repo.repoDir, [{ path: "src/a.ts", change: "create", content: "x" }])).rejects.toThrow(/EEXIST/);
  });
});
