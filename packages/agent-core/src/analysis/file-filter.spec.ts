import { DEFAULT_ANALYSIS_LIMITS, classifyContent, classifyPath } from "./file-filter";

describe("classifyPath", () => {
  it.each([
    "src/index.ts",
    "apps/web/src/app/page.tsx",
    "README.md",
    "package.json",
    "Dockerfile",
    ".github/workflows/ci.yml",
    "src/types.d.ts",
  ])("indexes %s", (p) => {
    expect(classifyPath(p)).toBeNull();
  });

  it.each([
    ["node_modules/react/index.js", "excluded_dir"],
    ["packages/a/dist/index.js", "excluded_dir"],
    [".git/config", "excluded_dir"],
    [".env", "secret"],
    ["config/.env.production", "secret"],
    ["certs/server.key", "secret"],
    ["deploy/id_rsa", "secret"],
    [".npmrc", "secret"],
    [".netrc", "secret"],
    ["pnpm-lock.yaml", "lockfile"],
    ["package-lock.json", "lockfile"],
    ["public/vendor.min.js", "generated"],
    ["dist-map/app.js.map", "generated"],
    ["src/__snapshots__/a.test.ts.snap", "generated"],
    ["assets/logo.png", "unsupported_type"],
    ["bin/tool", "unsupported_type"],
  ])("skips %s as %s", (p, reason) => {
    expect(classifyPath(p)).toBe(reason);
  });
});

describe("classifyContent", () => {
  it("accepts ordinary source", () => {
    expect(classifyContent(Buffer.from("export const a = 1;\n"))).toBeNull();
  });

  it("rejects binary, oversized, and minified content", () => {
    expect(classifyContent(Buffer.from([0x50, 0x4b, 0x00, 0x03]))).toBe("binary");
    expect(classifyContent(Buffer.alloc(DEFAULT_ANALYSIS_LIMITS.maxFileBytes + 1, 0x61))).toBe("too_large");
    expect(classifyContent(Buffer.from(`ok\n${"x".repeat(DEFAULT_ANALYSIS_LIMITS.maxLineLength + 1)}\n`))).toBe("long_lines");
  });
});
