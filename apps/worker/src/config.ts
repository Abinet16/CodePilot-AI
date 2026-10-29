import { z } from "zod";

/** Treats `KEY=` lines in .env as unset rather than as an empty string. */
const optionalString = z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional());

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  MAX_REPAIR_ATTEMPTS: z.coerce.number().int().min(0).max(5).default(2),
  WORKSPACE_ROOT: z.string().default("./.workspaces"),

  /** The worker authenticates as the GitHub App to read repositories. */
  GITHUB_APP_ID: optionalString,
  GITHUB_APP_PRIVATE_KEY_PATH: optionalString,

  /** Repositories larger than this on GitHub (full history, in MB) are not cloned. */
  MAX_REPOSITORY_SIZE_MB: z.coerce.number().int().min(1).max(10_000).default(1_024),
  GIT_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(1_800).default(180),
  /** Indexed commits kept per repository; older snapshots are deleted. */
  SNAPSHOTS_TO_KEEP: z.coerce.number().int().min(1).max(50).default(5),
});

export type WorkerConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid worker environment:\n${issues}`);
  }
  return parsed.data;
}
