import { z } from "zod";

/**
 * What repository analysis found, and the bounded context package handed to
 * planning. Snippet content is repository data and therefore untrusted.
 */

export const ProjectProfileSchema = z.object({
  /** Indexed file count per detected language. */
  languages: z.record(z.number().int().nonnegative()),
  primaryLanguage: z.string().nullable(),
  /** TypeScript/JavaScript is the supported ecosystem; others are analyzed but flagged. */
  supported: z.boolean(),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun"]).nullable(),
  typescript: z.boolean(),
  frameworks: z.array(z.string()),
  testFrameworks: z.array(z.string()),
  /** package.json scripts relevant to verification, e.g. { test: "jest" }. */
  scripts: z.record(z.string()),
  monorepo: z.boolean(),
  /** Contributor or agent instruction files found at the root, e.g. AGENTS.md. */
  instructionFiles: z.array(z.string()),
  testFileCount: z.number().int().nonnegative(),
  /** Top-level directories with their indexed file counts. */
  directories: z.record(z.number().int().nonnegative()),
});

export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;

export const RETRIEVAL_REASONS = ["path_mentioned", "symbol_match", "text_match", "instructions"] as const;
export type RetrievalReason = (typeof RETRIEVAL_REASONS)[number];

export const ContextSnippetSchema = z.object({
  path: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  content: z.string(),
  score: z.number(),
  reasons: z.array(z.enum(RETRIEVAL_REASONS)),
});

export type ContextSnippet = z.infer<typeof ContextSnippetSchema>;

export const IndexStatsSchema = z.object({
  indexedFiles: z.number().int().nonnegative(),
  indexedBytes: z.number().int().nonnegative(),
  skipped: z.record(z.number().int().nonnegative()),
  /** True when a file or byte limit stopped indexing early. */
  truncated: z.boolean(),
});

export type IndexStats = z.infer<typeof IndexStatsSchema>;

export const ContextPackageSchema = z.object({
  repository: z.string(),
  branch: z.string(),
  /** The exact commit every path and line range refers to. */
  commitSha: z.string().regex(/^[0-9a-f]{40}$/),
  query: z.string(),
  profile: ProjectProfileSchema,
  stats: IndexStatsSchema,
  snippets: z.array(ContextSnippetSchema),
  /** Test files that sit next to the selected source files. */
  relatedTests: z.array(z.string()),
  budget: z.object({ maxChars: z.number().int(), usedChars: z.number().int(), droppedSnippets: z.number().int() }),
});

export type ContextPackage = z.infer<typeof ContextPackageSchema>;
