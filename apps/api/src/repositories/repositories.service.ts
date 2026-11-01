import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { RepositoryChecks, RepositoryChecksResponse } from "@codepilot/contracts";
import {
  IssueSummary,
  MIN_PERMISSION_TO_CONFIGURE_CHECKS,
  MIN_PERMISSION_TO_ENABLE,
  ProjectProfileSchema,
  RepositoryChecksSchema,
  RepositorySummary,
  hasPermission,
} from "@codepilot/contracts";
import { CommandPolicyError, describeCommand, suggestChecks, validateRepositoryChecks } from "@codepilot/agent-core";
import { Prisma } from "@prisma/client";
import type { GithubInstallation, Repository, RepositoryAccess } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";

type AccessRow = RepositoryAccess & { repository: Repository & { installation: GithubInstallation } };

function toSummary({ permission, repository }: AccessRow): RepositorySummary {
  return {
    id: repository.id,
    owner: repository.owner,
    name: repository.name,
    fullName: `${repository.owner}/${repository.name}`,
    defaultBranch: repository.defaultBranch,
    isPrivate: repository.isPrivate,
    enabled: repository.enabled,
    permission,
    installationStatus: repository.installation.status,
  };
}

/**
 * Every query is scoped through repository_access for the calling user, so a
 * repository the user cannot reach on GitHub is indistinguishable from one
 * that does not exist.
 */
@Injectable()
export class RepositoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listForUser(userId: string): Promise<RepositorySummary[]> {
    const rows = await this.prisma.repositoryAccess.findMany({
      where: { userId, repository: { removedAt: null } },
      include: { repository: { include: { installation: true } } },
      orderBy: [{ repository: { owner: "asc" } }, { repository: { name: "asc" } }],
    });
    return rows.map(toSummary);
  }

  async listOpenIssues(userId: string, repositoryId: string): Promise<IssueSummary[]> {
    const access = await this.prisma.repositoryAccess.findUnique({
      where: { userId_repositoryId: { userId, repositoryId } },
      include: { repository: true },
    });
    if (!access || access.repository.removedAt) throw new NotFoundException("Repository not found");
    const issues = await this.prisma.issue.findMany({
      where: { repositoryId, state: "OPEN" },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return issues.map((i) => ({ id: i.id, number: i.githubIssueNumber, title: i.title, state: i.state, updatedAt: i.updatedAt.toISOString() }));
  }

  /** The saved check configuration, plus a suggestion from the latest indexed commit. */
  async getChecks(userId: string, repositoryId: string): Promise<RepositoryChecksResponse> {
    const access = await this.visible(userId, repositoryId);
    const [settings, snapshot] = await Promise.all([
      this.prisma.repositorySettings.findUnique({ where: { repositoryId }, include: { updatedBy: { select: { githubLogin: true } } } }),
      this.prisma.repositorySnapshot.findFirst({ where: { repositoryId }, orderBy: { indexedAt: "desc" }, select: { profile: true } }),
    ]);
    const stored = settings ? RepositoryChecksSchema.safeParse({ install: settings.installCommand ?? null, checks: settings.checks }) : null;
    const profile = snapshot ? ProjectProfileSchema.safeParse(snapshot.profile) : null;
    return {
      configured: stored?.success ? stored.data : null,
      suggested: profile?.success ? suggestChecks(profile.data) : null,
      updatedBy: settings?.updatedBy?.githubLogin ?? null,
      updatedAt: settings?.updatedAt?.toISOString() ?? null,
      canEdit: hasPermission(access.permission, MIN_PERMISSION_TO_CONFIGURE_CHECKS),
    };
  }

  /** Saves what the sandbox runs for this repository. Maintainers only, validated by the command policy, audited. */
  async setChecks(userId: string, repositoryId: string, checks: RepositoryChecks): Promise<RepositoryChecksResponse> {
    const access = await this.visible(userId, repositoryId);
    if (!hasPermission(access.permission, MIN_PERMISSION_TO_CONFIGURE_CHECKS)) {
      throw new ForbiddenException(`Requires ${MIN_PERMISSION_TO_CONFIGURE_CHECKS} permission on GitHub`);
    }
    try {
      validateRepositoryChecks(checks);
    } catch (err) {
      if (err instanceof CommandPolicyError) throw new BadRequestException(err.message);
      throw err;
    }

    const data = {
      installCommand: checks.install ?? Prisma.DbNull,
      checks: checks.checks as unknown as Prisma.InputJsonArray,
      updatedById: userId,
      updatedAt: new Date(),
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.repositorySettings.upsert({ where: { repositoryId }, create: { repositoryId, ...data }, update: data });
      await this.audit.record(
        {
          userId,
          action: "repository.checks_updated",
          metadata: {
            repositoryId,
            install: checks.install ? describeCommand(checks.install) : null,
            checks: checks.checks.map((c) => `${c.id}: ${describeCommand(c)}`),
          },
        },
        tx,
      );
    });
    return this.getChecks(userId, repositoryId);
  }

  async setEnabled(userId: string, repositoryId: string, enabled: boolean): Promise<RepositorySummary> {
    const access = await this.prisma.repositoryAccess.findUnique({
      where: { userId_repositoryId: { userId, repositoryId } },
      include: { repository: { include: { installation: true } } },
    });
    if (!access || access.repository.removedAt) throw new NotFoundException("Repository not found");
    if (!hasPermission(access.permission, MIN_PERMISSION_TO_ENABLE)) {
      throw new ForbiddenException(`Requires ${MIN_PERMISSION_TO_ENABLE} permission on GitHub`);
    }
    if (enabled && access.repository.installation.status !== "ACTIVE") {
      throw new ConflictException("The GitHub App installation for this repository is not active");
    }

    const repository = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.repository.update({ where: { id: repositoryId }, data: { enabled } });
      await this.audit.record(
        {
          userId,
          action: enabled ? "repository.enabled" : "repository.disabled",
          metadata: { repositoryId, fullName: `${updated.owner}/${updated.name}` },
        },
        tx,
      );
      return updated;
    });
    return toSummary({ ...access, repository: { ...repository, installation: access.repository.installation } });
  }

  private async visible(userId: string, repositoryId: string) {
    const access = await this.prisma.repositoryAccess.findUnique({ where: { userId_repositoryId: { userId, repositoryId } }, include: { repository: true } });
    if (!access || access.repository.removedAt) throw new NotFoundException("Repository not found");
    return access;
  }
}
