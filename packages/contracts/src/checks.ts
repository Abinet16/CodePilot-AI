import { z } from "zod";
import type { RepositoryPermission } from "./repositories";

/**
 * Checks are configured per repository by a maintainer. The model never
 * supplies a command; it only ever sees the results. agent-core's command
 * policy validates every profile before it is stored or run.
 */
export const CHECK_KINDS = ["test", "lint", "typecheck", "build"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export const CommandProfileSchema = z
  .object({
    id: z.string().min(1).max(63),
    /** Executable name, resolved on the sandbox PATH. Never a path. */
    executable: z.string().min(1).max(32),
    args: z.array(z.string().max(256)).max(32),
    timeoutMs: z.number().int().positive(),
  })
  .strict();

export type CommandProfileInput = z.infer<typeof CommandProfileSchema>;

export const CheckProfileSchema = CommandProfileSchema.extend({ kind: z.enum(CHECK_KINDS) }).strict();
export type CheckProfile = z.infer<typeof CheckProfileSchema>;

export const RepositoryChecksSchema = z
  .object({
    /** Installs dependencies with the network on and install scripts off. Null when the project needs no install. */
    install: CommandProfileSchema.nullable(),
    /** Run in order with the network off. */
    checks: z.array(CheckProfileSchema).min(1).max(10),
  })
  .strict();

export type RepositoryChecks = z.infer<typeof RepositoryChecksSchema>;

/** Configuring what runs in the sandbox is a maintainer decision. */
export const MIN_PERMISSION_TO_CONFIGURE_CHECKS: RepositoryPermission = "MAINTAIN";

export interface RepositoryChecksResponse {
  /** Null until a maintainer saves a configuration; tasks fail at RUNNING_CHECKS without one. */
  configured: RepositoryChecks | null;
  /** Detected from the latest indexed commit's package.json scripts. Never used until saved. */
  suggested: RepositoryChecks | null;
  updatedBy: string | null;
  updatedAt: string | null;
  canEdit: boolean;
}

/** Mirrors TestRunStatus in the Prisma schema. */
export const TEST_RUN_STATUSES = ["QUEUED", "RUNNING", "PASSED", "FAILED", "ERRORED", "TIMED_OUT"] as const;
export type TestRunStatus = (typeof TEST_RUN_STATUSES)[number];

export interface CheckResultSummary {
  profileId: string;
  kind: CheckKind | "install";
  /** The command as run, for display. */
  command: string;
  status: TestRunStatus;
  /** Null when the command was killed (timeout, memory limit) or never started. */
  exitCode: number | null;
  durationMs: number;
  /** Bounded, ANSI-stripped, secret-masked output. Untrusted text: render as text only. */
  output: string;
  outputTruncated: boolean;
}

export interface TestRunSummary {
  id: string;
  /** The patch version these checks verified. */
  patchVersion: number | null;
  status: TestRunStatus;
  runnerImage: string;
  /** Why the run could not complete, when status is ERRORED or TIMED_OUT. */
  error: string | null;
  results: CheckResultSummary[];
  startedAt: string | null;
  completedAt: string | null;
}
