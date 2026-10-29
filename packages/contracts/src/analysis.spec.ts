import { ContextPackageSchema } from "./analysis";
import { CreateTaskRequestSchema } from "./api";

const validPackage = {
  repository: "acme/app",
  branch: "main",
  commitSha: "a".repeat(40),
  query: "fix paginate",
  profile: {
    languages: { typescript: 3 },
    primaryLanguage: "typescript",
    supported: true,
    packageManager: "pnpm",
    typescript: true,
    frameworks: ["Next.js"],
    testFrameworks: ["Jest"],
    scripts: { test: "jest" },
    monorepo: false,
    instructionFiles: ["AGENTS.md"],
    testFileCount: 1,
    directories: { src: 3 },
  },
  stats: { indexedFiles: 3, indexedBytes: 900, skipped: { secret: 1 }, truncated: false },
  snippets: [{ path: "src/a.ts", startLine: 1, endLine: 20, content: "export {}", score: 10, reasons: ["path_mentioned"] }],
  relatedTests: [],
  budget: { maxChars: 48_000, usedChars: 9, droppedSnippets: 0 },
};

describe("ContextPackageSchema", () => {
  it("accepts a well-formed package", () => {
    expect(ContextPackageSchema.parse(validPackage)).toEqual(validPackage);
  });

  it("requires a full commit SHA and known retrieval reasons", () => {
    expect(ContextPackageSchema.safeParse({ ...validPackage, commitSha: "main" }).success).toBe(false);
    const badReason = { ...validPackage, snippets: [{ ...validPackage.snippets[0], reasons: ["model_said_so"] }] };
    expect(ContextPackageSchema.safeParse(badReason).success).toBe(false);
  });
});

describe("CreateTaskRequestSchema", () => {
  const repositoryId = "11111111-2222-4333-8444-555555555555";

  it("needs an issue or a description and defaults to plan approval", () => {
    expect(CreateTaskRequestSchema.safeParse({ repositoryId }).success).toBe(false);
    expect(CreateTaskRequestSchema.parse({ repositoryId, description: "Fix the flaky login test" }).requirePlanApproval).toBe(true);
  });

  it("rejects unknown fields such as a client-chosen commit", () => {
    expect(CreateTaskRequestSchema.safeParse({ repositoryId, description: "Fix the flaky login test", baseSha: "a".repeat(40) }).success).toBe(false);
  });
});
