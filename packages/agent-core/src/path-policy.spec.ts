import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PathPolicyError, normalizeRelativePath, resolveWorkspacePath } from "./path-policy";

function violationOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof PathPolicyError) return err.violation;
    throw err;
  }
  return undefined;
}

describe("normalizeRelativePath", () => {
  it.each([
    ["src/index.ts", "src/index.ts"],
    ["./src/utils/../index.ts", "src/index.ts"],
    ["src\\windows\\style.ts", "src/windows/style.ts"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeRelativePath(input)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    [".", "empty"],
    ["src/\0evil.ts", "null_byte"],
    ["/etc/passwd", "absolute"],
    ["C:/Windows/system32", "absolute"],
    ["../outside.ts", "traversal"],
    ["src/../../outside.ts", "traversal"],
    [".git/config", "denied_segment"],
    ["node_modules/pkg/index.js", "denied_segment"],
    [".env", "denied_file"],
    ["config/.env.production", "denied_file"],
    ["certs/server.key", "denied_file"],
    [".github/workflows/ci.yml", "denied_prefix"],
  ])("rejects %j as %s", (input, violation) => {
    expect(violationOf(() => normalizeRelativePath(input))).toBe(violation);
  });
});

describe("resolveWorkspacePath", () => {
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "cp-ws-"));
    outside = await mkdtemp(path.join(os.tmpdir(), "cp-out-"));
    await mkdir(path.join(workspace, "src"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("resolves a new file inside the workspace", async () => {
    const resolved = await resolveWorkspacePath(workspace, "src/new/file.ts");
    expect(resolved.endsWith(path.join("src", "new", "file.ts"))).toBe(true);
  });

  it("rejects writes through a symlink that escapes the workspace", async () => {
    await symlink(outside, path.join(workspace, "src", "escape"));
    await expect(resolveWorkspacePath(workspace, "src/escape/pwned.ts")).rejects.toMatchObject({
      violation: "outside_workspace",
    });
  });
});
