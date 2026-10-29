import { generateKeyPairSync } from "node:crypto";
import { GitHubAppClient, assertRepoCoordinates } from "./app-client";
import { GitHubApiError } from "./http";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const SHA = "a".repeat(40);

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const fn = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
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
