import { z } from "zod";
import { isPricedModel } from "@codepilot/agent-core";

/** Treats `KEY=` lines in .env as unset rather than as an empty string. */
const optionalString = z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional());

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  /** Repairs per approved plan after failing checks; 0 fails the task on the first failing check. */
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
  /** Patch generation implements the approved plan. A patch carries whole new files, so it gets a larger output limit. */
  PATCH_MODEL: z
    .string()
    .default("claude-opus-5-5")
    .refine(isPricedModel, { message: "has no entry in MODEL_PRICING, so its usage could not be costed" }),
  PATCH_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  PATCH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  PATCH_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(8_000).max(128_000).default(32_000),
  /** Largest file the agent may edit or create. */
  PATCH_MAX_FILE_KB: z.coerce.number().int().min(16).max(2_048).default(256),
  /** Added plus deleted lines one patch may contain. */
  PATCH_MAX_CHANGED_LINES: z.coerce.number().int().min(10).max(20_000).default(1_500),
  /** Author and committer of agent commits. The default address is deliberately unroutable (.invalid). */
  PATCH_AUTHOR_NAME: z.string().min(1).max(100).default("CodePilot AI"),
  PATCH_AUTHOR_EMAIL: z.string().email().default("codepilot@codepilot.invalid"),

  /** Checks run in Docker containers. Off means tasks fail at RUNNING_CHECKS with a clear reason. */
  SANDBOX_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  SANDBOX_IMAGE: z.string().min(1).default("codepilot/sandbox-node:22"),
  SANDBOX_MEMORY_MB: z.coerce.number().int().min(128).max(16_384).default(2_048),
  SANDBOX_CPUS: z.coerce.number().min(0.25).max(16).default(2),
  SANDBOX_PIDS: z.coerce.number().int().min(32).max(4_096).default(512),
  SANDBOX_TMPFS_MB: z.coerce.number().int().min(16).max(8_192).default(512),
  /** Output kept from each command (head and tail), and the part of it stored and shown to the model. */
  CHECK_OUTPUT_KB: z.coerce.number().int().min(4).max(4_096).default(256),
  CHECK_OUTPUT_CHARS: z.coerce.number().int().min(500).max(100_000).default(8_000),

  /** Input plus output tokens one task may spend across all of its model calls. */
  TASK_TOKEN_BUDGET: z.coerce.number().int().min(10_000).default(400_000),
  MODEL_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(1_800).default(300),

  /** Wall-clock limits per stage; a stage that runs longer fails the task. */
  ANALYZE_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3_600).default(600),
  PLAN_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3_600).default(900),
  PATCH_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3_600).default(1_200),
  CHECKS_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(7_200).default(1_800),
  REPAIR_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3_600).default(1_200),
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
