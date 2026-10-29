import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_ANALYSIS_LIMITS } from "@codepilot/agent-core";
import { scanRepository } from "./scan";

describe("scanRepository", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codepilot-scan-"));
  const outside = mkdtempSync(path.join(tmpdir(), "codepilot-outside-"));
  const write = (rel: string, content: string | Buffer) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  };

  beforeAll(() => {
    write("package.json", '{"name":"x"}');
    write("src/a.ts", "export const a = 1;\n");
    write("src/b.tsx", "export const B = () => null;\n");
    write(".env", "SECRET=1");
    write("node_modules/lib/index.js", "module.exports = 1;");
    write("pnpm-lock.yaml", "lockfileVersion: 9");
    write("logo.png", Buffer.from([0x89, 0x50]));
    write("src/blob.ts", Buffer.from([0x61, 0x00, 0x62]));
    write("src/huge.ts", "x".repeat(DEFAULT_ANALYSIS_LIMITS.maxFileBytes + 1));
    writeFileSync(path.join(outside, "secret.ts"), "export const stolen = true;\n");
    symlinkSync(path.join(outside, "secret.ts"), path.join(root, "src/link.ts"));
    symlinkSync(outside, path.join(root, "linked-dir"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("indexes only safe text files and never follows symlinks", async () => {
    const result = await scanRepository(root);
    expect(result.files.map((f) => f.path).sort()).toEqual(["package.json", "src/a.ts", "src/b.tsx"]);
    expect(result.files.some((f) => f.content.includes("stolen"))).toBe(false);
    expect(result.stats.skipped).toEqual({
      excluded_dir: 1,
      secret: 1,
      lockfile: 1,
      unsupported_type: 1,
      binary: 1,
      too_large: 1,
      not_regular_file: 2,
    });
    expect(result.paths).toEqual(expect.arrayContaining(["pnpm-lock.yaml", ".env"]));
    expect(result.paths).not.toContain("node_modules/lib/index.js");
  });

  it("records hashes, sizes, and languages", async () => {
    const a = (await scanRepository(root)).files.find((f) => f.path === "src/a.ts")!;
    expect(a).toMatchObject({ language: "typescript", sizeBytes: 20 });
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stops at the file limit and reports truncation", async () => {
    const result = await scanRepository(root, { ...DEFAULT_ANALYSIS_LIMITS, maxIndexedFiles: 2 });
    expect(result.files).toHaveLength(2);
    expect(result.stats.truncated).toBe(true);
    expect(result.stats.skipped.limit).toBe(2);
  });

  it("stops walking after the entry limit", async () => {
    const result = await scanRepository(root, { ...DEFAULT_ANALYSIS_LIMITS, maxWalkEntries: 3 });
    expect(result.stats.truncated).toBe(true);
  });
});
