import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFixtureRepo } from "../../test/git-fixture";
import { fetchCommit, gitEnvironment, hardeningConfig } from "./git";

describe("gitEnvironment", () => {
  it("passes the token as a github.com-scoped header through the environment only", () => {
    const env = gitEnvironment("/tmp/home", "ghs_secret");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraHeader");
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0!.replace("Authorization: Basic ", ""), "base64").toString()).toBe("x-access-token:ghs_secret");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("does not inherit the worker's environment", () => {
    process.env.SOME_WORKER_SECRET = "x";
    expect(gitEnvironment("/tmp/home", null)).not.toHaveProperty("SOME_WORKER_SECRET");
    delete process.env.SOME_WORKER_SECRET;
  });
});

describe("hardeningConfig", () => {
  it("disables hooks, symlinks, submodules, and non-https protocols", () => {
    const config = hardeningConfig().filter((a) => a !== "-c");
    expect(config).toEqual(
      expect.arrayContaining(["protocol.allow=never", "protocol.https.allow=always", "core.hooksPath=/dev/null", "core.symlinks=false", "submodule.recurse=false"]),
    );
    expect(config).not.toContain("protocol.file.allow=always");
  });
});

describe("fetchCommit", () => {
  const fixture = createFixtureRepo({
    "src/index.ts": "export const a = 1;\n",
    "escape-link": { symlink: "/etc/passwd" },
  });
  const work = mkdtempSync(path.join(tmpdir(), "codepilot-fetch-"));
  const base = { homeDir: work, remoteUrl: fixture.url, commitSha: fixture.commitSha, timeoutMs: 30_000 };

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("checks out exactly the pinned commit, with symlinks materialized as plain files", async () => {
    const repoDir = path.join(work, "ok");
    await fetchCommit({ ...base, repoDir, token: "ghs_secret", allowFileProtocol: true });

    expect(readFileSync(path.join(repoDir, "src/index.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(lstatSync(path.join(repoDir, "escape-link")).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(repoDir, ".git/config"), "utf8")).not.toMatch(/ghs_secret|extraheader|Basic/i);
    expect(existsSync(path.join(repoDir, ".git/hooks"))).toBe(false);
  });

  it("refuses non-https remotes unless explicitly allowed", async () => {
    await expect(fetchCommit({ ...base, repoDir: path.join(work, "denied"), token: null })).rejects.toThrow(/git fetch failed/);
  });

  it("rejects a malformed SHA before running git", async () => {
    await expect(fetchCommit({ ...base, repoDir: path.join(work, "bad"), commitSha: "main", token: null })).rejects.toThrow(/Invalid commit SHA/);
    expect(existsSync(path.join(work, "bad"))).toBe(false);
  });

  it("fails for a commit the remote does not have", async () => {
    await expect(
      fetchCommit({ ...base, repoDir: path.join(work, "missing"), commitSha: "b".repeat(40), token: null, allowFileProtocol: true }),
    ).rejects.toThrow(/git fetch failed/);
  });
});
