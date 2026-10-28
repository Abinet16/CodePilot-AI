import type { GitHubApi, GitHubInstallation, GitHubRepository, GitHubUser } from "../src/github/github.client";
import { GitHubApiError } from "../src/github/github.client";

export interface FakeAccount {
  user: GitHubUser;
  installations: Array<{ installation: GitHubInstallation; repositories: GitHubRepository[] }>;
}

/** In-memory GitHub. An OAuth code maps to one account; tokens are derived from codes. */
export class FakeGitHub implements GitHubApi {
  readonly accounts = new Map<string, FakeAccount>();

  async exchangeOAuthCode(code: string): Promise<string> {
    if (!this.accounts.has(code)) throw new GitHubApiError(401, "POST /login/oauth/access_token");
    return `user-token:${code}`;
  }

  async getAuthenticatedUser(userToken: string): Promise<GitHubUser> {
    return this.account(userToken).user;
  }

  async listUserInstallations(userToken: string): Promise<GitHubInstallation[]> {
    return this.account(userToken).installations.map((i) => i.installation);
  }

  async listUserInstallationRepositories(userToken: string, installationId: number): Promise<GitHubRepository[]> {
    return this.account(userToken).installations.find((i) => i.installation.id === installationId)?.repositories ?? [];
  }

  async getInstallationToken(): Promise<string> {
    return "installation-token";
  }

  private account(userToken: string): FakeAccount {
    const account = this.accounts.get(userToken.replace(/^user-token:/, ""));
    if (!account) throw new GitHubApiError(401, "GET /user");
    return account;
  }
}

export function repo(
  id: number,
  owner: string,
  name: string,
  permission: "admin" | "push" | "pull",
): GitHubRepository {
  return {
    id,
    name,
    owner: { login: owner },
    default_branch: "main",
    private: true,
    archived: false,
    permissions: { admin: permission === "admin", push: permission !== "pull", pull: true },
  };
}
