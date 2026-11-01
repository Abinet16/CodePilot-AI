import type { ProjectProfile } from "@codepilot/contracts";
import { suggestChecks } from "./suggest";

const profile = (overrides: Partial<ProjectProfile>): ProjectProfile => ({
  languages: { typescript: 3 },
  primaryLanguage: "typescript",
  supported: true,
  packageManager: "pnpm",
  typescript: true,
  frameworks: [],
  testFrameworks: ["Jest"],
  scripts: {},
  monorepo: false,
  instructionFiles: [],
  testFileCount: 1,
  directories: {},
  ...overrides,
});

describe("suggestChecks", () => {
  it("proposes install and the verification scripts the project defines", () => {
    expect(suggestChecks(profile({ scripts: { test: "jest", lint: "eslint .", typecheck: "tsc --noEmit", dev: "next" } }))).toEqual({
      install: { id: "install", executable: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts"], timeoutMs: 600_000 },
      checks: [
        { id: "typecheck", kind: "typecheck", executable: "pnpm", args: ["run", "typecheck"], timeoutMs: 300_000 },
        { id: "lint", kind: "lint", executable: "pnpm", args: ["run", "lint"], timeoutMs: 300_000 },
        { id: "test", kind: "test", executable: "pnpm", args: ["run", "test"], timeoutMs: 600_000 },
      ],
    });
  });

  it("uses npm ci for npm projects", () => {
    expect(suggestChecks(profile({ packageManager: "npm", scripts: { test: "vitest run" } }))?.install?.args).toEqual(["ci", "--ignore-scripts"]);
  });

  it("suggests nothing without a supported package manager or any verification script", () => {
    expect(suggestChecks(profile({ packageManager: "bun", scripts: { test: "bun test" } }))).toBeNull();
    expect(suggestChecks(profile({ scripts: { dev: "next dev" } }))).toBeNull();
  });
});
