import { z } from "zod";
import { isPricedModel } from "@codepilot/agent-core";

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

  /** Planning calls the Claude API. Without a key, tasks fail at PLANNING with a clear reason. */
  ANTHROPIC_API_KEY: optionalString,
  PLANNING_MODEL: z
    .string()
    .default("claude-opus-5-5")
    .refine(isPricedModel, { message: "has no entry in MODEL_PRICING, so its usage could not be costed" }),
  PLANNING_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  /** Model calls per planning round before invalid output fails the task. */
  PLANNING_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  PLANNING_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(4_000).max(64_000).default(16_000),
  /** Input plus output tokens one task may spend across all of its model calls. */
  TASK_TOKEN_BUDGET: z.coerce.number().int().min(10_000).default(400_000),
  MODEL_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(1_800).default(300),

  /** Wall-clock limits per stage; a stage that runs longer fails the task. */
  ANALYZE_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3_600).default(600),
  PLAN_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3_600).default(900),
  /** How often a running job checks whether its task was cancelled. */
  CANCELLATION_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
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
