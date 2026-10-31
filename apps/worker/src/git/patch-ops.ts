import type { PatchFileStat, PlanFileChange } from "@codepilot/contracts";
import { COMMIT_SHA } from "@codepilot/github";
import { GitError, gitEnvironment, hardeningConfig, runGit } from "./git";

/** A checked-out workspace repository. No credentials: nothing here talks to a remote. */
export interface LocalRepo {
  repoDir: string;
  homeDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CommitIdentity {
  name: string;
  email: string;
}

/** Mode of a regular tracked file. Symlinks (120000) and submodules (160000) are never edited. */
export const REGULAR_FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

/** Generous enough for the largest diff the patch limits allow, plus headers. */
const DIFF_BUFFER_BYTES = 8 * 1024 * 1024;

function git(repo: LocalRepo, command: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, maxBuffer?: number): Promise<string> {
  const env = { ...gitEnvironment(repo.homeDir, null), ...extraEnv };
  return runGit(command, [...hardeningConfig(), "-c", "commit.gpgsign=false", "-C", repo.repoDir, command, ...args], env, repo.timeoutMs, repo.signal, maxBuffer);
}

function splitZ(output: string): string[] {
  return output.split("\0").filter((s) => s.length > 0);
}

/** Creates `branch` at the current commit and switches to it. */
export async function createBranch(repo: LocalRepo, branch: string): Promise<void> {
  await git(repo, "check-ref-format", ["--branch", branch]);
  await git(repo, "switch", ["--quiet", "--create", branch]);
}

/** Index modes for the given paths. Paths that are not tracked are absent from the map. */
export async function trackedModes(repo: LocalRepo, paths: readonly string[]): Promise<Map<string, string>> {
  const modes = new Map<string, string>();
  if (paths.length === 0) return modes;
  for (const entry of splitZ(await git(repo, "ls-files", ["--stage", "-z", "--", ...paths]))) {
    const tab = entry.indexOf("\t");
    modes.set(entry.slice(tab + 1), entry.slice(0, entry.indexOf(" ")));
  }
  return modes;
}

/**
 * Stages exactly `paths` and commits them. Fails if anything else in the
 * working tree changed, so a commit can only ever contain the validated files.
 */
export async function commitPaths(
  repo: LocalRepo,
  paths: readonly string[],
  message: string,
  identity: CommitIdentity,
): Promise<{ commitSha: string; treeSha: string }> {
  await git(repo, "add", ["--all", "--", ...paths]);

  const expected = new Set(paths);
  const changed = splitZ(await git(repo, "status", ["--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])).map((e) => e.slice(3));
  const stray = changed.filter((p) => !expected.has(p));
  if (stray.length > 0) throw new GitError(`Unexpected changes outside the patch: ${stray.slice(0, 5).join(", ")}`);
  if (changed.length === 0) throw new GitError("The patch produced no changes to commit");

  await git(repo, "commit", ["--quiet", "--no-verify", "--cleanup=verbatim", "-m", message], {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  });
  const commitSha = (await git(repo, "rev-parse", ["HEAD"])).trim();
  const treeSha = (await git(repo, "rev-parse", ["HEAD^{tree}"])).trim();
  return { commitSha, treeSha };
}

export interface CommittedDiff {
  /** Unified diff, applicable with `git apply` to a checkout of the base. */
  diff: string;
  files: PatchFileStat[];
  /** Paths git reports as binary changes. */
  binary: string[];
}

const NAME_STATUS: Record<string, PlanFileChange> = { A: "create", M: "modify", D: "delete" };

/** The diff between `baseSha` and HEAD, with per-file line counts and change kinds. */
export async function diffFromBase(repo: LocalRepo, baseSha: string): Promise<CommittedDiff> {
  if (!COMMIT_SHA.test(baseSha)) throw new GitError(`Invalid commit SHA: ${JSON.stringify(baseSha)}`);
  const common = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", baseSha, "HEAD", "--"];
  const diff = await git(repo, "diff", ["--binary", "--full-index", ...common], {}, DIFF_BUFFER_BYTES);

  const kinds = new Map<string, PlanFileChange>();
  const nameStatus = splitZ(await git(repo, "diff", ["--name-status", "-z", ...common]));
  for (let i = 0; i + 1 < nameStatus.length; i += 2) {
    const kind = NAME_STATUS[nameStatus[i]!];
    if (!kind) throw new GitError(`Unexpected change type ${nameStatus[i]} for ${nameStatus[i + 1]}`);
    kinds.set(nameStatus[i + 1]!, kind);
  }

  const files: PatchFileStat[] = [];
  const binary: string[] = [];
  for (const entry of splitZ(await git(repo, "diff", ["--numstat", "-z", ...common]))) {
    const [added, deleted, path] = entry.split("\t") as [string, string, string];
    if (added === "-") binary.push(path);
    files.push({ path, change: kinds.get(path) ?? "modify", additions: Number(added) || 0, deletions: Number(deleted) || 0 });
  }
  return { diff, files, binary };
}

/** Discards every change since `sha`, tracked or not. Used between invalid attempts. */
export async function resetTo(repo: LocalRepo, sha: string): Promise<void> {
  await git(repo, "reset", ["--quiet", "--hard", sha]);
  await git(repo, "clean", ["-q", "-d", "--force", "-x"]);
}

/**
 * Applies a stored diff to a checkout of its base and returns the resulting
 * tree. Comparing it with the stored tree SHA proves the rebuilt workspace is
 * exactly the patch that was reviewed.
 */
export async function applyDiff(repo: LocalRepo, diffFile: string): Promise<string> {
  await git(repo, "apply", ["--index", "--whitespace=nowarn", "--", diffFile]);
  return (await git(repo, "write-tree", [])).trim();
}
