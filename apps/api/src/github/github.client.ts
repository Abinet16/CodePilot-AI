import { readFileSync } from "node:fs";
import { ServiceUnavailableException } from "@nestjs/common";
import { GITHUB_API_BASE, GitHubApiError, GitHubAppClient, GitHubRepository, githubHeaders, nextLink } from "@codepilot/github";
import type { GitHubAppSettings } from "../config";

export { GitHubApiError, nextLink };
export type { GitHubRepository };

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

export interface GitHubInstallation {
  id: number;
  account: { login: string } | null;
  suspended_at: string | null;
}

/** Everything the API needs from GitHub, so tests can substitute a fake. */
export interface GitHubApi {
  /** Exchanges an OAuth code for a short-lived user token. The caller must not persist it. */
  exchangeOAuthCode(code: string, redirectUri: string): Promise<string>;
  getAuthenticatedUser(userToken: string): Promise<GitHubUser>;
  /** Installations of this app that the user can access. */
  listUserInstallations(userToken: string): Promise<GitHubInstallation[]>;
  /** Repositories in an installation that this user can access, with their permissions. */
  listUserInstallationRepositories(userToken: string, installationId: number): Promise<GitHubRepository[]>;
  getInstallationToken(installationId: bigint): Promise<string>;
}

export const GITHUB_API = Symbol("GITHUB_API");

const MAX_PAGES = 50;

export class GitHubHttpClient implements GitHubApi {
  private readonly app: GitHubAppClient;

  constructor(
    private readonly settings: GitHubAppSettings,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.app = new GitHubAppClient(settings.appId, readFileSync(settings.privateKeyPath, "utf8"), fetchFn);
  }

  async exchangeOAuthCode(code: string, redirectUri: string): Promise<string> {
    const res = await this.fetchFn("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string };
    if (!res.ok || !body.access_token) throw new GitHubApiError(res.status, "POST /login/oauth/access_token");
    return body.access_token;
  }

  getAuthenticatedUser(userToken: string): Promise<GitHubUser> {
    return this.request<GitHubUser>("/user", userToken);
  }

  listUserInstallations(userToken: string): Promise<GitHubInstallation[]> {
    return this.paginate<GitHubInstallation>("/user/installations", userToken, "installations");
  }

  listUserInstallationRepositories(userToken: string, installationId: number): Promise<GitHubRepository[]> {
    return this.paginate<GitHubRepository>(`/user/installations/${installationId}/repositories`, userToken, "repositories");
  }

  getInstallationToken(installationId: bigint): Promise<string> {
    return this.app.getInstallationToken(installationId);
  }

  private async request<T>(path: string, token: string): Promise<T> {
    const res = await this.fetchFn(`${GITHUB_API_BASE}${path}`, { headers: githubHeaders(token) });
    if (!res.ok) throw new GitHubApiError(res.status, `GET ${path}`);
    return (await res.json()) as T;
  }

  /** Follows Link: rel="next" headers for list endpoints that wrap results in an object. */
  private async paginate<T>(path: string, token: string, key: string): Promise<T[]> {
    const items: T[] = [];
    let url: string | null = `${GITHUB_API_BASE}${path}?per_page=100`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res: Response = await this.fetchFn(url, { headers: githubHeaders(token) });
      if (!res.ok) throw new GitHubApiError(res.status, `GET ${path}`);
      const body = (await res.json()) as Record<string, T[]>;
      items.push(...(body[key] ?? []));
      url = nextLink(res.headers.get("link"));
    }
    return items;
  }
}

/** Used when the GitHub App is not configured (local development without an app). */
export class UnconfiguredGitHubApi implements GitHubApi {
  private fail(): never {
    throw new ServiceUnavailableException("GitHub App is not configured on this server");
  }
  exchangeOAuthCode(): Promise<string> {
    this.fail();
  }
  getAuthenticatedUser(): Promise<GitHubUser> {
    this.fail();
  }
  listUserInstallations(): Promise<GitHubInstallation[]> {
    this.fail();
  }
  listUserInstallationRepositories(): Promise<GitHubRepository[]> {
    this.fail();
  }
  getInstallationToken(): Promise<string> {
    this.fail();
  }
}
