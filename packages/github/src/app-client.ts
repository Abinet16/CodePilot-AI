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

export class GitHubAppClient implements InstallationGitHub {
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

  private async get<T>(installationId: bigint, path: string): Promise<T> {
    const token = await this.getInstallationToken(installationId);
    const res = await this.fetchFn(`${GITHUB_API_BASE}${path}`, { headers: githubHeaders(token) });
    if (!res.ok) throw new GitHubApiError(res.status, `GET ${path}`);
    return (await res.json()) as T;
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
