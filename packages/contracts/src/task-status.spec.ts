import {
  InvalidTransitionError,
  TaskStatus,
  allowedTransitions,
  assertTransition,
  canTransition,
  isTerminal,
} from "./task-status";

describe("task state machine", () => {
  it("follows the happy path from QUEUED to PR_OPENED", () => {
    const path: TaskStatus[] = [
      "QUEUED",
      "ANALYZING",
      "PLANNING",
      "AWAITING_PLAN_APPROVAL",
      "GENERATING_PATCH",
      "RUNNING_CHECKS",
      "READY_FOR_REVIEW",
      "OPENING_PR",
      "PR_OPENED",
    ];
    for (let i = 1; i < path.length; i++) {
      expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
    }
  });

  it("allows the repair loop between checks and repair", () => {
    expect(canTransition("RUNNING_CHECKS", "REPAIRING")).toBe(true);
    expect(canTransition("REPAIRING", "RUNNING_CHECKS")).toBe(true);
  });

  it("allows FAILED and CANCELLED from every active state", () => {
    for (const status of Object.values(TaskStatus)) {
      if (isTerminal(status)) continue;
      expect(canTransition(status, "FAILED")).toBe(true);
      expect(canTransition(status, "CANCELLED")).toBe(true);
    }
  });

  it("has no transitions out of terminal states", () => {
    for (const status of ["PR_OPENED", "FAILED", "CANCELLED"] as const) {
      expect(allowedTransitions(status)).toEqual([]);
    }
  });

  it("rejects skipping verification", () => {
    expect(canTransition("GENERATING_PATCH", "OPENING_PR")).toBe(false);
    expect(canTransition("GENERATING_PATCH", "READY_FOR_REVIEW")).toBe(false);
    expect(() => assertTransition("GENERATING_PATCH", "OPENING_PR")).toThrow(InvalidTransitionError);
  });
});
