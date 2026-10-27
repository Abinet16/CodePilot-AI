import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  MAX_REPAIR_ATTEMPTS: z.coerce.number().int().min(0).max(5).default(2),
  WORKSPACE_ROOT: z.string().default("./.workspaces"),
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
