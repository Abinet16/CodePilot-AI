import { readFileSync } from "node:fs";
import { ServiceUnavailableException } from "@nestjs/common";
import type { GitHubAppSettings } from "../config";
import { createAppJwt } from "./app-jwt";
import { InstallationTokenCache } from "./installation-token-cache";

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

export interface GitHubRepository {
  id: number;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  archived: boolean;
  /** The authenticated user's permissions; present on user-scoped listings. */
  permissions?: { admin: boolean; maintain?: boolean; push: boolean; triage?: boolean; pull: boolean };
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

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
  ) {
    // Deliberately excludes response bodies and headers, which may echo credentials.
    super(`GitHub API ${endpoint} responded ${status}`);
    this.name = "GitHubApiError";
  }
}

const API_BASE = "https://api.github.com";
const MAX_PAGES = 50;

export class GitHubHttpClient implements GitHubApi {
  private readonly privateKey: string;
  private readonly installationTokens: InstallationTokenCache;

  constructor(
    private readonly settings: GitHubAppSettings,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.privateKey = readFileSync(settings.privateKeyPath, "utf8");
    this.installationTokens = new InstallationTokenCache((id) => this.mintInstallationToken(id));
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
    return this.installationTokens.get(installationId);
  }

  private async mintInstallationToken(installationId: bigint) {
    const jwt = createAppJwt(this.settings.appId, this.privateKey);
    const endpoint = `/app/installations/${installationId}/access_tokens`;
    const res = await this.fetchFn(`${API_BASE}${endpoint}`, { method: "POST", headers: this.headers(jwt) });
    if (!res.ok) throw new GitHubApiError(res.status, `POST ${endpoint}`);
    const body = (await res.json()) as { token: string; expires_at: string };
    return { token: body.token, expiresAt: new Date(body.expires_at) };
  }

  private async request<T>(path: string, token: string): Promise<T> {
    const res = await this.fetchFn(`${API_BASE}${path}`, { headers: this.headers(token) });
    if (!res.ok) throw new GitHubApiError(res.status, `GET ${path}`);
    return (await res.json()) as T;
  }

  /** Follows Link: rel="next" headers for list endpoints that wrap results in an object. */
  private async paginate<T>(path: string, token: string, key: string): Promise<T[]> {
    const items: T[] = [];
    let url: string | null = `${API_BASE}${path}?per_page=100`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res: Response = await this.fetchFn(url, { headers: this.headers(token) });
      if (!res.ok) throw new GitHubApiError(res.status, `GET ${path}`);
      const body = (await res.json()) as Record<string, T[]>;
      items.push(...(body[key] ?? []));
      url = nextLink(res.headers.get("link"));
    }
    return items;
  }

  private headers(token: string): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "codepilot-ai",
    };
  }
}

export function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.split(",").find((part) => /rel="next"/.test(part));
  const url = match?.match(/<([^>]+)>/)?.[1];
  // Only follow links back to the GitHub API, never to an arbitrary host.
  return url?.startsWith(`${API_BASE}/`) ? url : null;
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
