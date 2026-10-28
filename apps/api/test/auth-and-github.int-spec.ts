import { createHmac } from "node:crypto";
import type { RepositorySummary } from "@codepilot/contracts";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { AppModule } from "../src/app.module";
import { GITHUB_API } from "../src/github/github.client";
import { configureApp } from "../src/main";
import { FakeGitHub, repo } from "./fake-github";

const WEBHOOK_SECRET = "integration-webhook-secret";
Object.assign(process.env, {
  NODE_ENV: "test",
  WEB_ORIGIN: "http://localhost:3000",
  GITHUB_APP_ID: "1",
  GITHUB_APP_SLUG: "codepilot-test",
  GITHUB_APP_PRIVATE_KEY_PATH: "/not/read/because/github/is/faked",
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
});

// Unique GitHub ids per run, so the suite can share a database with other suites.
const base = Date.now() * 1000;
const ids = { alice: base + 1, bob: base + 2, installation: base + 10, shared: base + 20, aliceOnly: base + 21 };

describe("auth, repository access, and webhooks (PostgreSQL)", () => {
  let app: NestExpressApplication;
  const prisma = new PrismaClient();
  const github = new FakeGitHub();
  const installation = { id: ids.installation, account: { login: "acme" }, suspended_at: null };

  beforeAll(async () => {
    github.accounts.set("alice-code", {
      user: { id: ids.alice, login: `alice-${base}`, name: "Alice", email: null, avatar_url: null },
      installations: [
        {
          installation,
          repositories: [repo(ids.shared, "acme", `shared-${base}`, "admin"), repo(ids.aliceOnly, "acme", `private-${base}`, "push")],
        },
      ],
    });
    github.accounts.set("bob-code", {
      user: { id: ids.bob, login: `bob-${base}`, name: "Bob", email: null, avatar_url: null },
      installations: [{ installation, repositories: [repo(ids.shared, "acme", `shared-${base}`, "pull")] }],
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GITHUB_API)
      .useValue(github)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function login(code: string): Promise<{ agent: TestAgent; sessionCookie: string }> {
    const agent = request.agent(app.getHttpServer());
    const start = await agent.get("/api/auth/github/login?returnTo=/repositories").expect(302);
    const state = new URL(start.headers.location as string).searchParams.get("state");
    const done = await agent.get(`/api/auth/github/callback?code=${code}&state=${state}`).expect(302);
    expect(done.headers.location).toBe("http://localhost:3000/repositories");
    const setCookies = done.headers["set-cookie"] as unknown as string[];
    const sessionCookie = setCookies.find((c) => c.startsWith("cp_session="))!.split(";")[0]!;
    return { agent, sessionCookie };
  }

  const byName = (list: RepositorySummary[], name: string) => list.find((r) => r.name === name);

  function sendWebhook(event: string, deliveryId: string, payload: object, secret = WEBHOOK_SECRET) {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    return request(app.getHttpServer())
      .post("/api/github/webhooks")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", event)
      .set("X-GitHub-Delivery", deliveryId)
      .set("X-Hub-Signature-256", signature)
      .send(body);
  }

  describe("login", () => {
    it("redirects to GitHub with a state bound to an httpOnly cookie", async () => {
      const res = await request(app.getHttpServer()).get("/api/auth/github/login").expect(302);
      const url = new URL(res.headers.location as string);
      expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
      expect(url.searchParams.get("client_id")).toBe("client-id");
      expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/github/callback");
      const cookie = (res.headers["set-cookie"] as unknown as string[])[0]!;
      expect(cookie).toMatch(/^cp_oauth_state=.+HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);
    });

    it("rejects a callback whose state does not match the cookie (login CSRF)", async () => {
      const agent = request.agent(app.getHttpServer());
      await agent.get("/api/auth/github/login").expect(302);
      await agent.get("/api/auth/github/callback?code=alice-code&state=forged").expect(400);
      await request(app.getHttpServer()).get("/api/auth/github/callback?code=alice-code&state=x").expect(400);
    });

    it("creates a session, the user, and access from GitHub without storing the GitHub token", async () => {
      const { agent } = await login("alice-code");
      const me = await agent.get("/api/auth/me").expect(200);
      expect(me.body.githubLogin).toBe(`alice-${base}`);

      const repos = (await agent.get("/api/repositories").expect(200)).body as RepositorySummary[];
      expect(byName(repos, `shared-${base}`)?.permission).toBe("ADMIN");
      expect(byName(repos, `private-${base}`)?.permission).toBe("WRITE");
      expect(repos.every((r) => !r.enabled)).toBe(true);

      const audit = await prisma.auditLog.findMany({ where: { userId: me.body.id } });
      expect(audit.map((a) => a.action).sort()).toEqual(["auth.login", "github.access_synced"]);
      expect(JSON.stringify(audit)).not.toContain("user-token");
      const session = await prisma.session.findFirstOrThrow({ where: { userId: me.body.id } });
      expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("repository authorization", () => {
    it("requires a session", async () => {
      await request(app.getHttpServer()).get("/api/repositories").expect(401);
      await request(app.getHttpServer()).get("/api/repositories").set("Cookie", "cp_session=guessed").expect(401);
    });

    it("never shows or lets a user change a repository they cannot access on GitHub", async () => {
      const { agent } = await login("bob-code");
      const repos = (await agent.get("/api/repositories").expect(200)).body as RepositorySummary[];
      expect(repos.map((r) => r.name)).toContain(`shared-${base}`);
      expect(repos.map((r) => r.name)).not.toContain(`private-${base}`);

      const hidden = await prisma.repository.findUniqueOrThrow({ where: { githubRepoId: BigInt(ids.aliceOnly) } });
      await agent.patch(`/api/repositories/${hidden.id}`).send({ enabled: true }).expect(404);
    });

    it("requires write permission to enable a repository", async () => {
      const { agent } = await login("bob-code");
      const shared = await prisma.repository.findUniqueOrThrow({ where: { githubRepoId: BigInt(ids.shared) } });
      await agent.patch(`/api/repositories/${shared.id}`).send({ enabled: true }).expect(403);
    });

    it("lets a writer enable a repository and audits it", async () => {
      const { agent } = await login("alice-code");
      const target = await prisma.repository.findUniqueOrThrow({ where: { githubRepoId: BigInt(ids.aliceOnly) } });
      await agent.patch(`/api/repositories/${target.id}`).send({ enabled: true, installationId: "x" }).expect(400);
      await agent.patch(`/api/repositories/not-a-uuid`).send({ enabled: true }).expect(400);
      const res = await agent.patch(`/api/repositories/${target.id}`).send({ enabled: true }).expect(200);
      expect(res.body.enabled).toBe(true);
      expect(await prisma.auditLog.count({ where: { action: "repository.enabled", metadata: { path: ["repositoryId"], equals: target.id } } })).toBe(1);
    });

    it("revokes access that GitHub no longer reports at the next login", async () => {
      const alice = github.accounts.get("alice-code")!;
      const original = alice.installations[0]!.repositories;
      alice.installations[0]!.repositories = original.filter((r) => r.id !== ids.aliceOnly);
      try {
        const { agent } = await login("alice-code");
        const repos = (await agent.get("/api/repositories").expect(200)).body as RepositorySummary[];
        expect(byName(repos, `private-${base}`)).toBeUndefined();
        const target = await prisma.repository.findUniqueOrThrow({ where: { githubRepoId: BigInt(ids.aliceOnly) } });
        await agent.patch(`/api/repositories/${target.id}`).send({ enabled: false }).expect(404);
      } finally {
        alice.installations[0]!.repositories = original;
      }
    });
  });

  describe("sessions", () => {
    it("rejects a session after logout", async () => {
      const { agent, sessionCookie } = await login("alice-code");
      await agent.post("/api/auth/logout").expect(204);
      await request(app.getHttpServer()).get("/api/auth/me").set("Cookie", sessionCookie).expect(401);
    });

    it("rejects an expired session", async () => {
      const { sessionCookie } = await login("alice-code");
      const user = await prisma.user.findUniqueOrThrow({ where: { githubId: BigInt(ids.alice) } });
      await prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await request(app.getHttpServer()).get("/api/auth/me").set("Cookie", sessionCookie).expect(401);
    });

    it("ignores the attacker-controllable installation_id on the setup URL", async () => {
      const res = await request(app.getHttpServer()).get("/api/github/setup?installation_id=999&setup_action=install").expect(302);
      expect(res.headers.location).toBe("/api/auth/github/login?returnTo=/repositories");
    });
  });

  describe("webhooks", () => {
    const delivery = (name: string) => `${base}-${name}`;

    it("rejects unsigned, mis-signed, and tampered deliveries", async () => {
      await request(app.getHttpServer()).post("/api/github/webhooks").send({ zen: "hi" }).expect(401);
      await sendWebhook("ping", delivery("bad"), { zen: "hi" }, "wrong-secret").expect(401);
      expect(await prisma.webhookDelivery.count({ where: { deliveryId: delivery("bad") } })).toBe(0);
    });

    it("processes a delivery once and reports redeliveries as duplicates", async () => {
      expect((await sendWebhook("ping", delivery("ping"), { zen: "hi" }).expect(200)).body.outcome).toBe("processed");
      expect((await sendWebhook("ping", delivery("ping"), { zen: "hi" }).expect(200)).body.outcome).toBe("duplicate");
    });

    it("lets exactly one of several concurrent identical deliveries take effect", async () => {
      const payload = {
        action: "opened",
        issue: { number: 7, title: "Pagination skips the last page", body: "Steps...", state: "open" },
        repository: { id: ids.shared },
      };
      const results = await Promise.all(Array.from({ length: 5 }, () => sendWebhook("issues", delivery("issue-7"), payload)));
      const outcomes = results.map((r) => r.body.outcome).sort();
      expect(outcomes).toEqual(["duplicate", "duplicate", "duplicate", "duplicate", "processed"]);

      const shared = await prisma.repository.findUniqueOrThrow({ where: { githubRepoId: BigInt(ids.shared) } });
      const issues = await prisma.issue.findMany({ where: { repositoryId: shared.id } });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ githubIssueNumber: 7, state: "OPEN" });
    });

    it("updates an imported issue and ignores issues for unknown repositories", async () => {
      const closed = {
        action: "closed",
        issue: { number: 7, title: "Pagination skips the last page", body: "Steps...", state: "closed" },
        repository: { id: ids.shared },
      };
      await sendWebhook("issues", delivery("issue-7-closed"), closed).expect(200);
      const shared = await prisma.repository.findUniqueOrThrow({ where: { githubRepoId: BigInt(ids.shared) } });
      expect((await prisma.issue.findFirstOrThrow({ where: { repositoryId: shared.id, githubIssueNumber: 7 } })).state).toBe("CLOSED");

      const unknown = { ...closed, repository: { id: base + 999 } };
      expect((await sendWebhook("issues", delivery("issue-unknown"), unknown).expect(200)).body.outcome).toBe("ignored");
    });

    it("disables and revokes access when a repository is removed from the installation", async () => {
      const { agent } = await login("alice-code");
      const target = await prisma.repository.findUniqueOrThrow({ where: { githubRepoId: BigInt(ids.aliceOnly) } });
      await agent.patch(`/api/repositories/${target.id}`).send({ enabled: true }).expect(200);

      await sendWebhook("installation_repositories", delivery("repos-removed"), {
        action: "removed",
        installation: { id: ids.installation },
        repositories_removed: [{ id: ids.aliceOnly }],
      }).expect(200);

      const after = await prisma.repository.findUniqueOrThrow({ where: { id: target.id } });
      expect(after.enabled).toBe(false);
      expect(after.removedAt).not.toBeNull();
      expect(await prisma.repositoryAccess.count({ where: { repositoryId: target.id } })).toBe(0);
      const repos = (await agent.get("/api/repositories").expect(200)).body as RepositorySummary[];
      expect(byName(repos, `private-${base}`)).toBeUndefined();
    });

    it("marks the installation deleted and removes all of its repositories", async () => {
      await sendWebhook("installation", delivery("uninstall"), {
        action: "deleted",
        installation: { id: ids.installation, account: { login: "acme" } },
      }).expect(200);

      const row = await prisma.githubInstallation.findUniqueOrThrow({
        where: { installationId: BigInt(ids.installation) },
        include: { repositories: true },
      });
      expect(row.status).toBe("DELETED");
      expect(row.repositories.every((r) => r.removedAt && !r.enabled)).toBe(true);
      expect(await prisma.auditLog.count({ where: { action: "github.installation.deleted", metadata: { path: ["deliveryId"], equals: delivery("uninstall") } } })).toBe(1);
    });
  });
});
