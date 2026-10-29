import type { ProjectProfile } from "@codepilot/contracts";
import { CODE_LANGUAGES, SUPPORTED_LANGUAGES } from "./language";

export interface ProfileInput {
  /** Every regular file path seen in the tree, including ones that were not indexed (e.g. lockfiles). */
  paths: readonly string[];
  indexed: ReadonlyArray<{ path: string; language: string }>;
  /** Raw root package.json, if present. It is untrusted and may be malformed. */
  packageJson: string | null;
}

const FRAMEWORKS: Record<string, string> = {
  next: "Next.js",
  react: "React",
  vue: "Vue",
  nuxt: "Nuxt",
  svelte: "Svelte",
  "@sveltejs/kit": "SvelteKit",
  "@angular/core": "Angular",
  "@remix-run/react": "Remix",
  "@nestjs/core": "NestJS",
  express: "Express",
  fastify: "Fastify",
  koa: "Koa",
  hono: "Hono",
  "@prisma/client": "Prisma",
};

const TEST_FRAMEWORKS: Record<string, string> = {
  jest: "Jest",
  vitest: "Vitest",
  mocha: "Mocha",
  ava: "AVA",
  "@playwright/test": "Playwright",
  cypress: "Cypress",
};

const RELEVANT_SCRIPTS = ["test", "test:unit", "test:integration", "lint", "typecheck", "type-check", "build"];

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", ".github/copilot-instructions.md", "README.md"];

const MONOREPO_MARKERS = ["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json"];

const TEST_FILE = /(^|\/)__tests__\/|[._](test|spec)\.[cm]?[jt]sx?$/;

export function isTestFile(filePath: string): boolean {
  return TEST_FILE.test(filePath);
}

interface PackageJson {
  packageManager?: unknown;
  workspaces?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
}

function parsePackageJson(raw: string | null): PackageJson | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as PackageJson) : null;
  } catch {
    return null;
  }
}

function objectKeys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
}

function detectPackageManager(root: ReadonlySet<string>, pkg: PackageJson | null): ProjectProfile["packageManager"] {
  if (root.has("pnpm-lock.yaml")) return "pnpm";
  if (root.has("yarn.lock")) return "yarn";
  if (root.has("bun.lock") || root.has("bun.lockb")) return "bun";
  if (root.has("package-lock.json")) return "npm";
  const declared = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm") return declared;
  return pkg ? "npm" : null;
}

export function detectProjectProfile(input: ProfileInput): ProjectProfile {
  const pkg = parsePackageJson(input.packageJson);
  const rootFiles = new Set(input.paths.filter((p) => !p.includes("/")));
  const allPaths = new Set(input.paths);

  const languages: Record<string, number> = {};
  const directories: Record<string, number> = {};
  for (const file of input.indexed) {
    languages[file.language] = (languages[file.language] ?? 0) + 1;
    const top = file.path.includes("/") ? file.path.slice(0, file.path.indexOf("/")) : ".";
    directories[top] = (directories[top] ?? 0) + 1;
  }

  const code = Object.entries(languages)
    .filter(([lang]) => CODE_LANGUAGES.has(lang))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const primaryLanguage = code[0]?.[0] ?? null;

  const deps = new Set([...objectKeys(pkg?.dependencies), ...objectKeys(pkg?.devDependencies), ...objectKeys(pkg?.peerDependencies)]);
  const scripts: Record<string, string> = {};
  for (const name of RELEVANT_SCRIPTS) {
    const value = pkg?.scripts?.[name];
    if (typeof value === "string") scripts[name] = value.slice(0, 200);
  }
  const scriptText = Object.values(scripts).join(" ");

  const testFrameworks = Object.entries(TEST_FRAMEWORKS)
    .filter(([dep, name]) => deps.has(dep) || scriptText.includes(name.toLowerCase()))
    .map(([, name]) => name);
  if (/node --test\b/.test(scriptText)) testFrameworks.push("node:test");

  const topDirectories = Object.fromEntries(
    Object.entries(directories)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 30),
  );

  return {
    languages,
    primaryLanguage,
    supported: primaryLanguage !== null && SUPPORTED_LANGUAGES.has(primaryLanguage),
    packageManager: detectPackageManager(rootFiles, pkg),
    typescript: deps.has("typescript") || rootFiles.has("tsconfig.json") || (languages.typescript ?? 0) > 0,
    frameworks: Object.entries(FRAMEWORKS)
      .filter(([dep]) => deps.has(dep))
      .map(([, name]) => name),
    testFrameworks,
    scripts,
    monorepo: MONOREPO_MARKERS.some((m) => rootFiles.has(m)) || pkg?.workspaces !== undefined,
    instructionFiles: INSTRUCTION_FILES.filter((f) => allPaths.has(f)),
    testFileCount: input.indexed.filter((f) => isTestFile(f.path)).length,
    directories: topDirectories,
  };
}
