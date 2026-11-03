import { ListTasksQuerySchema, TASK_STATUS_GROUPS, statusGroupOf } from "./dashboard";
import { TaskStatus } from "./task-status";

describe("task status groups", () => {
  it("puts every status in exactly one group", () => {
    const grouped = Object.values(TASK_STATUS_GROUPS).flat();
    expect([...grouped].sort()).toEqual(Object.values(TaskStatus).sort());
  });

  it("treats human gates as review and the rest by outcome", () => {
    expect(statusGroupOf("AWAITING_PLAN_APPROVAL")).toBe("review");
    expect(statusGroupOf("READY_FOR_REVIEW")).toBe("review");
    expect(statusGroupOf("REPAIRING")).toBe("active");
    expect(statusGroupOf("PR_OPENED")).toBe("done");
    expect(statusGroupOf("FAILED")).toBe("failed");
  });
});

describe("ListTasksQuerySchema", () => {
  it("defaults the page size and coerces numbers from the query string", () => {
    expect(ListTasksQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(ListTasksQuerySchema.parse({ group: "review", limit: "10" })).toEqual({ group: "review", limit: 10 });
  });

  it("rejects unknown groups, oversized pages, odd cursors, and unknown parameters", () => {
    for (const query of [{ group: "everything" }, { limit: "500" }, { cursor: "../x" }, { status: "FAILED" }]) {
      expect(ListTasksQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});
