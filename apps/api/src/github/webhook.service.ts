import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";

export type WebhookOutcome = "processed" | "ignored" | "duplicate";

const Id = z.number().int().positive();

const InstallationEvent = z.object({
  action: z.string(),
  installation: z.object({ id: Id, account: z.object({ login: z.string() }).nullish() }),
});

const InstallationRepositoriesEvent = z.object({
  action: z.enum(["added", "removed"]),
  installation: z.object({ id: Id }),
  repositories_added: z.array(z.object({ id: Id })).default([]),
  repositories_removed: z.array(z.object({ id: Id })).default([]),
});

const IssuesEvent = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.enum(["open", "closed"]),
    pull_request: z.unknown().optional(),
  }),
  repository: z.object({ id: Id }),
});

const RepositoryEvent = z.object({
  action: z.string(),
  repository: z.object({
    id: Id,
    name: z.string(),
    owner: z.object({ login: z.string() }),
    default_branch: z.string(),
    private: z.boolean(),
  }),
});

type Tx = Prisma.TransactionClient;

/**
 * Applies GitHub webhook deliveries exactly once. The delivery row is inserted
 * in the same transaction as its effects: a redelivery hits the primary key
 * and is reported as a duplicate, while a failed attempt rolls back entirely
 * so GitHub's redelivery can process it cleanly.
 *
 * Webhooks never grant a user access to anything. They only record GitHub
 * state and revoke access when repositories or installations go away.
 */
@Injectable()
export class WebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async process(deliveryId: string, event: string, payload: unknown): Promise<WebhookOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.webhookDelivery.create({ data: { deliveryId, event } });
        const outcome = await this.dispatch(tx, deliveryId, event, payload);
        await tx.webhookDelivery.update({ where: { deliveryId }, data: { processedAt: new Date() } });
        return outcome;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return "duplicate";
      throw err;
    }
  }

  private dispatch(tx: Tx, deliveryId: string, event: string, payload: unknown): Promise<WebhookOutcome> {
    switch (event) {
      case "ping":
        return Promise.resolve("processed");
      case "installation":
        return this.onInstallation(tx, deliveryId, payload);
      case "installation_repositories":
        return this.onInstallationRepositories(tx, deliveryId, payload);
      case "issues":
        return this.onIssues(tx, payload);
      case "repository":
        return this.onRepository(tx, payload);
      default:
        return Promise.resolve("ignored");
    }
  }

  private async onInstallation(tx: Tx, deliveryId: string, payload: unknown): Promise<WebhookOutcome> {
    const parsed = InstallationEvent.safeParse(payload);
    if (!parsed.success) return "ignored";
    const { action, installation } = parsed.data;
    const installationId = BigInt(installation.id);
    const accountLogin = installation.account?.login ?? "unknown";

    const status = { created: "ACTIVE", unsuspend: "ACTIVE", suspend: "SUSPENDED", deleted: "DELETED" } as const;
    const next = status[action as keyof typeof status];
    if (!next) return "ignored";

    const row = await tx.githubInstallation.upsert({
      where: { installationId },
      create: { installationId, accountLogin, status: next },
      update: { status: next },
    });
    if (action === "deleted") {
      const repos = await tx.repository.findMany({ where: { installationId: row.id }, select: { id: true } });
      await this.removeRepositories(
        tx,
        repos.map((r) => r.id),
      );
    }
    await this.audit.record(
      { action: `github.installation.${action}`, metadata: { deliveryId, installationId, accountLogin } },
      tx,
    );
    return "processed";
  }

  private async onInstallationRepositories(tx: Tx, deliveryId: string, payload: unknown): Promise<WebhookOutcome> {
    const parsed = InstallationRepositoriesEvent.safeParse(payload);
    if (!parsed.success) return "ignored";
    const { action, repositories_added, repositories_removed } = parsed.data;

    if (action === "removed") {
      const repos = await tx.repository.findMany({
        where: { githubRepoId: { in: repositories_removed.map((r) => BigInt(r.id)) } },
        select: { id: true },
      });
      await this.removeRepositories(
        tx,
        repos.map((r) => r.id),
      );
    } else {
      // Re-added repositories become visible again but stay disabled. Access
      // for each user is granted at their next login sync, not here.
      await tx.repository.updateMany({
        where: { githubRepoId: { in: repositories_added.map((r) => BigInt(r.id)) } },
        data: { removedAt: null },
      });
    }
    await this.audit.record(
      {
        action: `github.repositories.${action}`,
        metadata: { deliveryId, added: repositories_added.length, removed: repositories_removed.length },
      },
      tx,
    );
    return "processed";
  }

  private async onIssues(tx: Tx, payload: unknown): Promise<WebhookOutcome> {
    const parsed = IssuesEvent.safeParse(payload);
    if (!parsed.success || parsed.data.issue.pull_request) return "ignored";
    const { action, issue, repository } = parsed.data;

    const repo = await tx.repository.findFirst({ where: { githubRepoId: BigInt(repository.id), removedAt: null } });
    if (!repo) return "ignored";

    const key = { repositoryId_githubIssueNumber: { repositoryId: repo.id, githubIssueNumber: issue.number } };
    if (action === "deleted") {
      await tx.issue.deleteMany({ where: { repositoryId: repo.id, githubIssueNumber: issue.number } });
      return "processed";
    }
    const fields = { title: issue.title, body: issue.body, state: issue.state === "open" ? "OPEN" : "CLOSED" } as const;
    await tx.issue.upsert({
      where: key,
      create: { repositoryId: repo.id, githubIssueNumber: issue.number, ...fields },
      update: fields,
    });
    return "processed";
  }

  private async onRepository(tx: Tx, payload: unknown): Promise<WebhookOutcome> {
    const parsed = RepositoryEvent.safeParse(payload);
    if (!parsed.success || !["renamed", "transferred", "edited", "privatized", "publicized"].includes(parsed.data.action)) {
      return "ignored";
    }
    const { repository } = parsed.data;
    const { count } = await tx.repository.updateMany({
      where: { githubRepoId: BigInt(repository.id) },
      data: {
        owner: repository.owner.login,
        name: repository.name,
        defaultBranch: repository.default_branch,
        isPrivate: repository.private,
      },
    });
    return count > 0 ? "processed" : "ignored";
  }

  /** Disables the agent and revokes every user's access; history rows are kept. */
  private async removeRepositories(tx: Tx, repositoryIds: string[]): Promise<void> {
    if (repositoryIds.length === 0) return;
    await tx.repository.updateMany({
      where: { id: { in: repositoryIds } },
      data: { removedAt: new Date(), enabled: false },
    });
    await tx.repositoryAccess.deleteMany({ where: { repositoryId: { in: repositoryIds } } });
  }
}
