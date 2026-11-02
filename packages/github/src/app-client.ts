import { createAppJwt } from "./app-jwt";
import { GITHUB_API_BASE, GitHubApiError, githubHeaders } from "./http";
import { InstallationTokenCache } from "./installation-token-cache";

export interface GitHubRepository {
  id: number;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  archived: boolean;
  /** Repository size in KB, as reported by GitHub. */
  size?: number;
  /** The authenticated user's permissions; present on user-scoped listings. */
  permissions?: { admin: boolean; maintain?: boolean; push: boolean; triage?: boolean; pull: boolean };
}

/** Calls made as the app's installation rather than as a user. */
export interface InstallationGitHub {
  /** Short-lived installation token. Callers must never persist, enqueue, or log it. */
  getInstallationToken(installationId: bigint): Promise<string>;
  getRepository(installationId: bigint, owner: string, name: string): Promise<GitHubRepository>;
  /** Resolves a branch to the exact commit SHA it points at right now. */
  getBranchHeadSha(installationId: bigint, owner: string, name: string, branch: string): Promise<string>;
}

export interface GitHubPullRequest {
  number: number;
  html_url: string;
  state: "open" | "closed";
  draft?: boolean;
  merged_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  head: { ref: string; sha: string; repo?: { id: number } | null };
  base: { ref: string };
}

export interface NewPullRequest {
  title: string;
  body: string;
  /** Branch in the same repository; forks are never used. */
  head: string;
  base: string;
  draft: boolean;
}

/** Calls that change a repository: pushing is done with git, everything else here. */
export interface PullRequestGitHub extends InstallationGitHub {
  /** The branch's head commit, or null when the branch does not exist. */
  findBranchHeadSha(installationId: bigint, owner: string, name: string, branch: string): Promise<string | null>;
  deleteBranch(installationId: bigint, owner: string, name: string, branch: string): Promise<void>;
  /** The newest pull request (open or closed) whose head is `branch` in this repository. */
  findPullRequestByHead(installationId: bigint, owner: string, name: string, branch: string): Promise<GitHubPullRequest | null>;
  createPullRequest(installationId: bigint, owner: string, name: string, pr: NewPullRequest): Promise<GitHubPullRequest>;
  getPullRequest(installationId: bigint, owner: string, name: string, number: number): Promise<GitHubPullRequest>;
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;
export const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * Owner, repository, and branch names end up in URLs and git arguments, so
 * anything outside GitHub's own character rules is rejected rather than escaped.
 */
export function assertRepoCoordinates(owner: string, name: string, branch?: string): void {
  for (const part of [owner, name]) {
    if (!NAME.test(part) || part === "." || part === "..") throw new Error(`Invalid repository name: ${JSON.stringify(part)}`);
  }
  if (branch !== undefined && (!BRANCH.test(branch) || branch.includes("..") || /^[-/]|\/$/.test(branch))) {
    throw new Error(`Invalid branch name: ${JSON.stringify(branch)}`);
  }
}

export class GitHubAppClient implements PullRequestGitHub {
  private readonly tokens: InstallationTokenCache;

  constructor(
    private readonly appId: string,
    private readonly privateKeyPem: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.tokens = new InstallationTokenCache((id) => this.mintInstallationToken(id));
  }

  getInstallationToken(installationId: bigint): Promise<string> {
    return this.tokens.get(installationId);
  }

  invalidateInstallationToken(installationId: bigint): void {
    this.tokens.invalidate(installationId);
  }

  async getRepository(installationId: bigint, owner: string, name: string): Promise<GitHubRepository> {
    assertRepoCoordinates(owner, name);
    return this.get<GitHubRepository>(installationId, `/repos/${owner}/${name}`);
  }

  async getBranchHeadSha(installationId: bigint, owner: string, name: string, branch: string): Promise<string> {
    assertRepoCoordinates(owner, name, branch);
    const body = await this.get<{ commit?: { sha?: string } }>(installationId, `/repos/${owner}/${name}/branches/${branch}`);
    const sha = body.commit?.sha;
    if (!sha || !COMMIT_SHA.test(sha)) throw new Error(`GitHub returned no commit for branch ${JSON.stringify(branch)}`);
    return sha;
  }

  async findBranchHeadSha(installationId: bigint, owner: string, name: string, branch: string): Promise<string | null> {
    try {
      return await this.getBranchHeadSha(installationId, owner, name, branch);
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return null;
      throw err;
    }
  }

  async deleteBranch(installationId: bigint, owner: string, name: string, branch: string): Promise<void> {
    assertRepoCoordinates(owner, name, branch);
    // Already gone counts as deleted.
    await this.request(installationId, "DELETE", `/repos/${owner}/${name}/git/refs/heads/${branch}`, undefined, [404, 422]);
  }

  async findPullRequestByHead(installationId: bigint, owner: string, name: string, branch: string): Promise<GitHubPullRequest | null> {
    assertRepoCoordinates(owner, name, branch);
    const head = encodeURIComponent(`${owner}:${branch}`);
    const list = await this.get<GitHubPullRequest[]>(installationId, `/repos/${owner}/${name}/pulls?head=${head}&state=all&sort=created&direction=desc&per_page=10`);
    return list.find((pr) => pr.head.ref === branch) ?? null;
  }

  async createPullRequest(installationId: bigint, owner: string, name: string, pr: NewPullRequest): Promise<GitHubPullRequest> {
    assertRepoCoordinates(owner, name, pr.head);
    assertRepoCoordinates(owner, name, pr.base);
    const body = { title: pr.title, body: pr.body, head: pr.head, base: pr.base, draft: pr.draft, maintainer_can_modify: false };
    return (await this.request(installationId, "POST", `/repos/${owner}/${name}/pulls`, body)) as GitHubPullRequest;
  }

  async getPullRequest(installationId: bigint, owner: string, name: string, number: number): Promise<GitHubPullRequest> {
    assertRepoCoordinates(owner, name);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid pull request number: ${number}`);
    return this.get<GitHubPullRequest>(installationId, `/repos/${owner}/${name}/pulls/${number}`);
  }

  private get<T>(installationId: bigint, path: string): Promise<T> {
    return this.request(installationId, "GET", path) as Promise<T>;
  }

  private async request(installationId: bigint, method: string, path: string, body?: unknown, tolerated: number[] = []): Promise<unknown> {
    const token = await this.getInstallationToken(installationId);
    const headers: Record<string, string> = githubHeaders(token);
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.fetchFn(`${GITHUB_API_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (tolerated.includes(res.status)) return null;
    if (!res.ok) throw new GitHubApiError(res.status, `${method} ${path.split("?")[0]}`);
    return res.status === 204 ? null : res.json();
  }

  private async mintInstallationToken(installationId: bigint) {
    const jwt = createAppJwt(this.appId, this.privateKeyPem);
    const endpoint = `/app/installations/${installationId}/access_tokens`;
    const res = await this.fetchFn(`${GITHUB_API_BASE}${endpoint}`, { method: "POST", headers: githubHeaders(jwt) });
    if (!res.ok) throw new GitHubApiError(res.status, `POST ${endpoint}`);
    const body = (await res.json()) as { token: string; expires_at: string };
    return { token: body.token, expiresAt: new Date(body.expires_at) };
  }
}
