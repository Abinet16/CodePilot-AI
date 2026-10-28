import { z } from "zod";

/** Treats `KEY=` lines in .env as unset rather than as an empty string. */
const optionalString = z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional());

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  API_PORT: z.coerce.number().int().positive().default(4000),
  /** Public origin of the dashboard. The API is served under it at /api via the web proxy. */
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),

  GITHUB_APP_ID: optionalString,
  GITHUB_APP_SLUG: optionalString,
  GITHUB_APP_PRIVATE_KEY_PATH: optionalString,
  GITHUB_CLIENT_ID: optionalString,
  GITHUB_CLIENT_SECRET: optionalString,
  GITHUB_WEBHOOK_SECRET: optionalString,
});

export type ApiConfig = z.infer<typeof EnvSchema>;

export interface GitHubAppSettings {
  appId: string;
  slug: string;
  privateKeyPath: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
}

/** Fails fast at boot with a readable message instead of at first use. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid API environment:\n${issues}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === "production" && !githubSettings(config)) {
    throw new Error("Invalid API environment:\n  GITHUB_*: all GitHub App settings are required in production");
  }
  return config;
}

/** Returns null when the GitHub App is not configured (allowed outside production). */
export function githubSettings(config: ApiConfig): GitHubAppSettings | null {
  const { GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_WEBHOOK_SECRET } =
    config;
  if (
    !GITHUB_APP_ID ||
    !GITHUB_APP_SLUG ||
    !GITHUB_APP_PRIVATE_KEY_PATH ||
    !GITHUB_CLIENT_ID ||
    !GITHUB_CLIENT_SECRET ||
    !GITHUB_WEBHOOK_SECRET
  ) {
    return null;
  }
  return {
    appId: GITHUB_APP_ID,
    slug: GITHUB_APP_SLUG,
    privateKeyPath: GITHUB_APP_PRIVATE_KEY_PATH,
    clientId: GITHUB_CLIENT_ID,
    clientSecret: GITHUB_CLIENT_SECRET,
    webhookSecret: GITHUB_WEBHOOK_SECRET,
  };
}

export const API_CONFIG = Symbol("API_CONFIG");
