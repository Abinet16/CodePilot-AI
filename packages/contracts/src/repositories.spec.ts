import { UpdateRepositoryRequestSchema, hasPermission } from "./repositories";

describe("hasPermission", () => {
  it("treats higher permissions as satisfying lower requirements", () => {
    expect(hasPermission("ADMIN", "WRITE")).toBe(true);
    expect(hasPermission("WRITE", "WRITE")).toBe(true);
    expect(hasPermission("TRIAGE", "WRITE")).toBe(false);
    expect(hasPermission("READ", "TRIAGE")).toBe(false);
  });
});

describe("UpdateRepositoryRequestSchema", () => {
  it("rejects unknown fields so clients cannot set server-owned columns", () => {
    expect(UpdateRepositoryRequestSchema.safeParse({ enabled: true, installationId: "x" }).success).toBe(false);
    expect(UpdateRepositoryRequestSchema.safeParse({ enabled: "yes" }).success).toBe(false);
    expect(UpdateRepositoryRequestSchema.safeParse({ enabled: false }).success).toBe(true);
  });
});
