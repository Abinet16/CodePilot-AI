import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { MIN_PERMISSION_TO_ENABLE, RepositorySummary, hasPermission } from "@codepilot/contracts";
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
}
