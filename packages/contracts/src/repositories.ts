import { z } from "zod";

/** Mirrors the RepositoryPermission enum in prisma/schema.prisma, lowest to highest. */
export const REPOSITORY_PERMISSIONS = ["READ", "TRIAGE", "WRITE", "MAINTAIN", "ADMIN"] as const;
export type RepositoryPermission = (typeof REPOSITORY_PERMISSIONS)[number];

export function hasPermission(actual: RepositoryPermission, required: RepositoryPermission): boolean {
  return REPOSITORY_PERMISSIONS.indexOf(actual) >= REPOSITORY_PERMISSIONS.indexOf(required);
}

/** Minimum permission a user needs on GitHub to enable the agent or run tasks on a repository. */
export const MIN_PERMISSION_TO_ENABLE: RepositoryPermission = "WRITE";

export interface RepositorySummary {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  enabled: boolean;
  permission: RepositoryPermission;
  installationStatus: "ACTIVE" | "SUSPENDED" | "DELETED";
}

/** An issue imported from GitHub webhooks. Its title and body are untrusted text. */
export interface IssueSummary {
  id: string;
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  updatedAt: string;
}

export const UpdateRepositoryRequestSchema = z.object({ enabled: z.boolean() }).strict();
export type UpdateRepositoryRequest = z.infer<typeof UpdateRepositoryRequestSchema>;

export interface CurrentUser {
  id: string;
  githubLogin: string;
  name: string | null;
  avatarUrl: string | null;
}
