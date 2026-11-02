import { generateKeyPairSync } from "node:crypto";
import { GitHubAppClient, assertRepoCoordinates } from "./app-client";
import { GitHubApiError } from "./http";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const SHA = "a".repeat(40);

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Array<{ url: string; auth: string | undefined; method: string; body: unknown }> = [];
  const fn = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({
      url: href,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const path = href.replace("https://api.github.com", "");
    const route = routes[path];
    return route ? route() : new Response("{}", { status: 404 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const tokenRoute = () =>
  Response.json({ token: "ghs_installation", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });

describe("GitHubAppClient", () => {
  it("resolves a branch to its head SHA using an installation token", async () => {
    const { fn, calls } = fakeFetch({
      "/app/installations/7/access_tokens": tokenRoute,
      "/repos/acme/app/branches/release/1.x": () => Response.json({ commit: { sha: SHA } }),
    });
    const client = new GitHubAppClient("1", pem, fn);

    await expect(client.getBranchHeadSha(7n, "acme", "app", "release/1.x")).resolves.toBe(SHA);
    expect(calls[0]!.auth).toMatch(/^Bearer ey/);
    expect(calls[1]!.auth).toBe("Bearer ghs_installation");
  });

  it("reuses the cached installation token", async () => {
    const { fn, calls } = fakeFetch({
      "/app/installations/7/access_tokens": tokenRoute,
      "/repos/acme/app": () => Response.json({ id: 1, name: "app", owner: { login: "acme" }, default_branch: "main" }),
    });
    const client = new GitHubAppClient("1", pem, fn);
    await client.getRepository(7n, "acme", "app");
    await client.getRepository(7n, "acme", "app");
    expect(calls.filter((c) => c.url.endsWith("/access_tokens"))).toHaveLength(1);
  });

  it("rejects a malformed SHA from the API", async () => {
    const { fn } = fakeFetch({
      "/app/installations/7/access_tokens": tokenRoute,
      "/repos/acme/app/branches/main": () => Response.json({ commit: { sha: "not-a-sha" } }),
    });
    await expect(new GitHubAppClient("1", pem, fn).getBranchHeadSha(7n, "acme", "app", "main")).rejects.toThrow(/no commit/);
  });

  it("surfaces API failures without response bodies", async () => {
    const { fn } = fakeFetch({ "/app/installations/7/access_tokens": tokenRoute });
    const err = await new GitHubAppClient("1", pem, fn).getRepository(7n, "acme", "gone").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).status).toBe(404);
  });

  it("never sends a request for invalid coordinates", async () => {
    const { fn, calls } = fakeFetch({});
    const client = new GitHubAppClient("1", pem, fn);
    await expect(client.getRepository(7n, "acme", "../admin")).rejects.toThrow(/Invalid repository/);
    await expect(client.getBranchHeadSha(7n, "acme", "app", "main?x=1")).rejects.toThrow(/Invalid branch/);
    expect(calls).toHaveLength(0);
  });
});

describe("assertRepoCoordinates", () => {
  it.each([
    ["acme", "app", "main"],
    ["my-org", "my.repo_1", "feature/x-1"],
  ])("accepts %s/%s@%s", (owner, name, branch) => {
    expect(() => assertRepoCoordinates(owner, name, branch)).not.toThrow();
  });

  it.each([
    ["acme", "..", "main"],
    ["ac me", "app", "main"],
    ["acme", "app", "../main"],
    ["acme", "app", "-upload-pack=x"],
    ["acme", "app", "main/"],
    ["acme", "app", "a b"],
  ])("rejects %s/%s@%s", (owner, name, branch) => {
    expect(() => assertRepoCoordinates(owner, name, branch)).toThrow();
  });
});

describe("GitHubAppClient pull requests", () => {
  const pr = {
    number: 12,
    html_url: "https://github.com/acme/app/pull/12",
    state: "open",
    draft: true,
    merged_at: null,
    closed_at: null,
    created_at: "2026-11-02T10:00:00Z",
    updated_at: "2026-11-02T10:00:00Z",
    head: { ref: "codepilot/fix-1a2b3c4d", sha: SHA },
    base: { ref: "main" },
  };

  it("creates a draft pull request that maintainers of forks cannot push to", async () => {
    const { fn, calls } = fakeFetch({ "/app/installations/7/access_tokens": tokenRoute, "/repos/acme/app/pulls": () => Response.json(pr, { status: 201 }) });
    const created = await new GitHubAppClient("1", pem, fn).createPullRequest(7n, "acme", "app", {
      title: "Fix pagination",
      body: "body",
      head: "codepilot/fix-1a2b3c4d",
      base: "main",
      draft: true,
    });
    expect(created.number).toBe(12);
    expect(calls[1]).toMatchObject({
      method: "POST",
      body: { title: "Fix pagination", body: "body", head: "codepilot/fix-1a2b3c4d", base: "main", draft: true, maintainer_can_modify: false },
    });
  });

  it("finds an existing pull request for a branch, open or closed", async () => {
    const path = `/repos/acme/app/pulls?head=${encodeURIComponent("acme:codepilot/fix-1a2b3c4d")}&state=all&sort=created&direction=desc&per_page=10`;
    const { fn } = fakeFetch({ "/app/installations/7/access_tokens": tokenRoute, [path]: () => Response.json([pr]) });
    await expect(new GitHubAppClient("1", pem, fn).findPullRequestByHead(7n, "acme", "app", "codepilot/fix-1a2b3c4d")).resolves.toMatchObject({ number: 12 });
  });

  it("reports a missing branch as null and deletes branches idempotently", async () => {
    const { fn, calls } = fakeFetch({ "/app/installations/7/access_tokens": tokenRoute });
    const client = new GitHubAppClient("1", pem, fn);
    await expect(client.findBranchHeadSha(7n, "acme", "app", "codepilot/x-1")).resolves.toBeNull();
    await expect(client.deleteBranch(7n, "acme", "app", "codepilot/x-1")).resolves.toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: "https://api.github.com/repos/acme/app/git/refs/heads/codepilot/x-1" });
  });

  it("refuses names outside GitHub's rules before calling the API", async () => {
    const { fn, calls } = fakeFetch({});
    const client = new GitHubAppClient("1", pem, fn);
    await expect(client.deleteBranch(7n, "acme", "app", "../../hooks")).rejects.toThrow(/Invalid branch/);
    await expect(client.getPullRequest(7n, "acme", "app", -1)).rejects.toThrow(/Invalid pull request number/);
    expect(calls).toHaveLength(0);
  });
});
