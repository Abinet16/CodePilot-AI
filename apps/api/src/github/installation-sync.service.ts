import { Inject, Injectable } from "@nestjs/common";
import type { RepositoryPermission } from "@codepilot/contracts";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { GITHUB_API, GitHubApi, GitHubInstallation, GitHubRepository } from "./github.client";

export function permissionFrom(permissions: GitHubRepository["permissions"]): RepositoryPermission | null {
  if (!permissions) return null;
  if (permissions.admin) return "ADMIN";
  if (permissions.maintain) return "MAINTAIN";
  if (permissions.push) return "WRITE";
  if (permissions.triage) return "TRIAGE";
  if (permissions.pull) return "READ";
  return null;
}

export interface SyncResult {
  installations: number;
  repositories: number;
  revoked: number;
}

/**
 * Rebuilds a user's repository access from GitHub using the user's own token.
 * This is the only path that grants access: it reflects exactly what GitHub
 * says this user can reach, and revokes anything GitHub no longer lists.
 */
@Injectable()
export class InstallationSyncService {
  constructor(
    @Inject(GITHUB_API) private readonly github: GitHubApi,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async syncForUser(userId: string, userToken: string): Promise<SyncResult> {
    // Fetch everything from GitHub first so the transaction holds no locks during network I/O.
    const installations = await this.github.listUserInstallations(userToken);
    const grants: Array<{ installation: GitHubInstallation; repositories: GitHubRepository[] }> = [];
    for (const installation of installations) {
      const repositories = installation.suspended_at
        ? []
        : await this.github.listUserInstallationRepositories(userToken, installation.id);
      grants.push({ installation, repositories });
    }

    return this.prisma.$transaction(
      async (tx) => {
        const granted: string[] = [];
        for (const { installation, repositories } of grants) {
          const status = installation.suspended_at ? "SUSPENDED" : "ACTIVE";
          const accountLogin = installation.account?.login ?? "unknown";
          const row = await tx.githubInstallation.upsert({
            where: { installationId: BigInt(installation.id) },
            create: { installationId: BigInt(installation.id), accountLogin, status },
            update: { accountLogin, status },
          });

          for (const repo of repositories) {
            const permission = permissionFrom(repo.permissions);
            if (!permission) continue;
            const details = {
              installationId: row.id,
              owner: repo.owner.login,
              name: repo.name,
              defaultBranch: repo.default_branch,
              isPrivate: repo.private,
            };
            const repository = await tx.repository.upsert({
              where: { githubRepoId: BigInt(repo.id) },
              create: { ...details, githubRepoId: BigInt(repo.id) },
              update: { ...details, removedAt: null },
            });
            await tx.repositoryAccess.upsert({
              where: { userId_repositoryId: { userId, repositoryId: repository.id } },
              create: { userId, repositoryId: repository.id, permission },
              update: { permission, syncedAt: new Date() },
            });
            granted.push(repository.id);
          }
        }

        const { count: revoked } = await tx.repositoryAccess.deleteMany({
          where: { userId, repositoryId: { notIn: granted } },
        });
        const result = { installations: grants.length, repositories: granted.length, revoked };
        await this.audit.record({ userId, action: "github.access_synced", metadata: { ...result } }, tx);
        return result;
      },
      { timeout: 30_000 },
    );
  }
}
