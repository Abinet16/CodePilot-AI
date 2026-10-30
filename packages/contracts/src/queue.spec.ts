import { taskJobId } from "./queue";

describe("taskJobId", () => {
  const id = "3f1f6f0e-8d7a-4c39-9a51-0b1d2c3e4f50";

  it("gives each resume of a task its own job id", () => {
    const ids = new Set([taskJobId(id, "start"), taskJobId(id, "plan-v1-revise"), taskJobId(id, "plan-v2-approved")]);
    expect(ids.size).toBe(3);
  });

  it("is deterministic and avoids the colon BullMQ reserves in keys", () => {
    expect(taskJobId(id, "plan-v1-approved")).toBe(taskJobId(id, "plan-v1-approved"));
    expect(taskJobId(id, "start")).not.toContain(":");
  });
});
