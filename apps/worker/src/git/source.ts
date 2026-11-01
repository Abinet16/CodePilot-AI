import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { InstallationGitHub } from "@codepilot/github";
import type { Workspace } from "../analysis/workspace";
import { GitError, fetchCommit, githubRemoteUrl } from "./git";
import type { CommitIdentity, LocalRepo } from "./patch-ops";
import { applyDiff, commitStaged, createBranch } from "./patch-ops";

export interface SourceDeps {
  /** Null when the GitHub App is not configured for this worker. */
  github: InstallationGitHub | null;
  /** Overrides the clone URL; tests point this at a local fixture repository. */
  remoteUrl?: (owner: string, name: string) => string;
  gitTimeoutMs: number;
}

export interface SourceRepository {
  owner: string;
  name: string;
  installation: { installationId: bigint };
}

export interface CheckoutOptions {
  baseSha: string;
  signal: AbortSignal;
  /** Creates and switches to this branch at the base. */
  branch?: string;
  /** A stored patch to apply on top of the base, verified against its tree SHA. */
  patch?: { diff: string; treeSha: string; commit?: { message: string; identity: CommitIdentity } };
}

/** The applied diff did not produce the tree that was stored with it. */
export class PatchIntegrityError extends Error {
  constructor(expected: string, actual: string) {
    super(`The rebuilt patch does not match what was stored (tree ${actual}, expected ${expected})`);
    this.name = "PatchIntegrityError";
  }
}

/**
 * Checks out the pinned commit into a workspace and, optionally, re-applies a
 * stored patch. The stored diff, not any long-lived checkout, is the source of
 * truth: the rebuilt tree must equal the tree recorded with the patch.
 */
export async function checkoutForTask(
  deps: SourceDeps,
  repository: SourceRepository,
  workspace: Workspace,
  options: CheckoutOptions,
): Promise<{ repo: LocalRepo; headSha: string }> {
  const remoteUrl = (deps.remoteUrl ?? githubRemoteUrl)(repository.owner, repository.name);
  const fromGitHub = remoteUrl.startsWith("https://github.com/");
  if (fromGitHub && !deps.github) throw new GitError("The GitHub App is not configured for the worker");

  await fetchCommit({
    repoDir: workspace.repoDir,
    homeDir: workspace.homeDir,
    remoteUrl,
    commitSha: options.baseSha,
    token: fromGitHub ? await deps.github!.getInstallationToken(repository.installation.installationId) : null,
    timeoutMs: deps.gitTimeoutMs,
    signal: options.signal,
    allowFileProtocol: remoteUrl.startsWith("file://"),
  });
  const repo: LocalRepo = { repoDir: workspace.repoDir, homeDir: workspace.homeDir, timeoutMs: deps.gitTimeoutMs, signal: options.signal };
  if (options.branch) await createBranch(repo, options.branch);

  let headSha = options.baseSha;
  if (options.patch) {
    const diffFile = path.join(workspace.dir, "patch.diff");
    await writeFile(diffFile, options.patch.diff);
    const tree = await applyDiff(repo, diffFile);
    if (tree !== options.patch.treeSha) throw new PatchIntegrityError(options.patch.treeSha, tree);
    if (options.patch.commit) headSha = await commitStaged(repo, options.patch.commit.message, options.patch.commit.identity);
  }
  return { repo, headSha };
}
