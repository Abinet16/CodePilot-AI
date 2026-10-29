import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface FixtureRepo {
  dir: string;
  url: string;
  commitSha: string;
}

/**
 * Creates a local git repository with one commit. Values of the form
 * `{ symlink: target }` become symlinks. The repository allows fetching any
 * SHA, as GitHub does for reachable commits.
 */
export function createFixtureRepo(files: Record<string, string | { symlink: string }>): FixtureRepo {
  const dir = mkdtempSync(path.join(tmpdir(), "codepilot-fixture-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-C", dir, ...args], {
      env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    })
      .toString()
      .trim();

  git("init", "--quiet", "--initial-branch=main");
  git("config", "uploadpack.allowAnySHA1InWant", "true");
  for (const [rel, value] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    if (typeof value === "string") writeFileSync(abs, value);
    else symlinkSync(value.symlink, abs);
  }
  git("add", "--all", "--force");
  git("commit", "--quiet", "-m", "fixture");
  return { dir, url: `file://${dir}`, commitSha: git("rev-parse", "HEAD") };
}
