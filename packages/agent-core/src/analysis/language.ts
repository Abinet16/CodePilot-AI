import path from "node:path";

const BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".css": "css",
  ".scss": "css",
  ".html": "html",
  ".vue": "vue",
  ".svelte": "svelte",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".sql": "sql",
  ".prisma": "prisma",
  ".sh": "shell",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".txt": "text",
};

const BY_BASENAME: Record<string, string> = {
  Dockerfile: "docker",
  Makefile: "make",
  ".gitignore": "text",
  ".editorconfig": "text",
  ".nvmrc": "text",
};

/** Languages whose source the agent can plan and patch in this release. */
export const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set(["typescript", "javascript"]);

/** Languages counted as "code" when choosing the primary language. */
export const CODE_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript",
  "javascript",
  "vue",
  "svelte",
  "python",
  "go",
  "rust",
  "java",
  "kotlin",
  "ruby",
  "php",
  "csharp",
]);

/** Returns the language for an indexable text file, or null if the file is not indexed. */
export function detectLanguage(filePath: string): string | null {
  const base = path.posix.basename(filePath);
  return BY_BASENAME[base] ?? BY_EXTENSION[path.posix.extname(base).toLowerCase()] ?? null;
}
