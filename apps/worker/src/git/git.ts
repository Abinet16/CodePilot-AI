import { execFile } from "node:child_process";
import { COMMIT_SHA } from "@codepilot/github";

export interface FetchCommitOptions {
  /** Directory to initialize; must be empty or missing. */
  repoDir: string;
  /** Directory used as HOME so no user or machine git configuration applies. */
  homeDir: string;
  remoteUrl: string;
  commitSha: string;
  /** Installation token. Passed through the environment only, never in argv or .git/config. */
  token: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Test fixtures use local file:// remotes; production only ever speaks https. */
  allowFileProtocol?: boolean;
}

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Settings that keep a hostile repository inert during fetch and checkout:
 * no hooks, no submodules, no symlinks on disk, no fsmonitor, no other protocols.
 */
export function hardeningConfig(allowFileProtocol = false): string[] {
  const settings = [
    "protocol.allow=never",
    "protocol.https.allow=always",
    ...(allowFileProtocol ? ["protocol.file.allow=always"] : []),
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    "core.symlinks=false",
    "submodule.recurse=false",
    "advice.detachedHead=false",
  ];
  return settings.flatMap((s) => ["-c", s]);
}

/**
 * A minimal environment. The token travels as an http.extraHeader scoped to
 * github.com through GIT_CONFIG_* variables, so it never appears in the
 * process list, the remote URL, or anything written to disk.
 */
export function gitEnvironment(homeDir: string, token: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: homeDir,
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    Object.assign(env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    });
  }
  return env;
}

export function githubRemoteUrl(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}.git`;
}

export function runGit(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
  maxBuffer = 1024 * 1024,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { env, timeout: timeoutMs, signal, maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr).trim().slice(0, 500);
        reject(new GitError(`git ${command} failed: ${detail || err.message}`));
      } else {
        resolve(String(stdout));
      }
    });
  });
}

/**
 * Fetches exactly one commit (shallow, no tags, no submodules) into a fresh
 * repository and checks it out detached. Verifies HEAD afterwards, so the
 * analyzed tree is provably the pinned commit.
 */
export async function fetchCommit(options: FetchCommitOptions): Promise<void> {
  const { repoDir, homeDir, remoteUrl, commitSha, token, timeoutMs, signal } = options;
  if (!COMMIT_SHA.test(commitSha)) throw new GitError(`Invalid commit SHA: ${JSON.stringify(commitSha)}`);

  const env = gitEnvironment(homeDir, token);
  const config = hardeningConfig(options.allowFileProtocol);

  await runGit("init", ["init", "--quiet", "--template=", repoDir], env, timeoutMs, signal);
  await runGit(
    "fetch",
    [...config, "-C", repoDir, "fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", remoteUrl, commitSha],
    env,
    timeoutMs,
    signal,
  );
  await runGit("checkout", [...config, "-C", repoDir, "checkout", "--quiet", "--detach", commitSha], env, timeoutMs, signal);

  const head = (await runGit("rev-parse", ["-C", repoDir, "rev-parse", "HEAD"], env, timeoutMs, signal)).trim();
  if (head !== commitSha) throw new GitError(`Checked out ${head}, expected ${commitSha}`);
}
