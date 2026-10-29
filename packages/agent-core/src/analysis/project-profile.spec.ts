import { detectProjectProfile, isTestFile } from "./project-profile";

describe("detectProjectProfile", () => {
  const packageJson = JSON.stringify({
    scripts: { test: "jest --ci", lint: "eslint .", start: "node server.js", typecheck: "tsc --noEmit" },
    dependencies: { next: "15.0.0", react: "19.0.0", "@prisma/client": "6.0.0" },
    devDependencies: { typescript: "5.9.3", jest: "29.7.0", "@playwright/test": "1.0.0" },
  });

  it("detects a TypeScript Next.js app with pnpm and Jest", () => {
    const profile = detectProjectProfile({
      paths: ["package.json", "pnpm-lock.yaml", "tsconfig.json", "AGENTS.md", "src/app/page.tsx", "src/lib/a.ts", "src/lib/a.test.ts"],
      indexed: [
        { path: "src/app/page.tsx", language: "typescript" },
        { path: "src/lib/a.ts", language: "typescript" },
        { path: "src/lib/a.test.ts", language: "typescript" },
        { path: "scripts/x.js", language: "javascript" },
        { path: "AGENTS.md", language: "markdown" },
      ],
      packageJson,
    });

    expect(profile).toMatchObject({
      primaryLanguage: "typescript",
      supported: true,
      packageManager: "pnpm",
      typescript: true,
      frameworks: ["Next.js", "React", "Prisma"],
      testFrameworks: ["Jest", "Playwright"],
      scripts: { test: "jest --ci", lint: "eslint .", typecheck: "tsc --noEmit" },
      monorepo: false,
      instructionFiles: ["AGENTS.md"],
      testFileCount: 1,
      directories: { src: 3, scripts: 1, ".": 1 },
    });
    expect(profile.scripts).not.toHaveProperty("start");
  });

  it("flags unsupported ecosystems and tolerates a malformed package.json", () => {
    const profile = detectProjectProfile({
      paths: ["package.json", "main.py"],
      indexed: [
        { path: "main.py", language: "python" },
        { path: "lib/util.py", language: "python" },
      ],
      packageJson: "{ not json",
    });
    expect(profile.primaryLanguage).toBe("python");
    expect(profile.supported).toBe(false);
    expect(profile.packageManager).toBeNull();
  });

  it("detects monorepos and the declared package manager", () => {
    const profile = detectProjectProfile({
      paths: ["package.json"],
      indexed: [],
      packageJson: JSON.stringify({ packageManager: "yarn@4.1.0", workspaces: ["packages/*"] }),
    });
    expect(profile.packageManager).toBe("yarn");
    expect(profile.monorepo).toBe(true);
    expect(profile.primaryLanguage).toBeNull();
  });
});

describe("isTestFile", () => {
  it.each(["a.test.ts", "src/a.spec.tsx", "src/__tests__/a.ts", "a_test.js"])("treats %s as a test", (p) => {
    expect(isTestFile(p)).toBe(true);
  });
  it.each(["src/test-utils.ts", "src/contest.ts", "src/spec.md"])("does not treat %s as a test", (p) => {
    expect(isTestFile(p)).toBe(false);
  });
});
