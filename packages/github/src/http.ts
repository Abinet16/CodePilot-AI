export const GITHUB_API_BASE = "https://api.github.com";

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

export function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "codepilot-ai",
  };
}

export function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.split(",").find((part) => /rel="next"/.test(part));
  const url = match?.match(/<([^>]+)>/)?.[1];
  // Only follow links back to the GitHub API, never to an arbitrary host.
  return url?.startsWith(`${GITHUB_API_BASE}/`) ? url : null;
}
