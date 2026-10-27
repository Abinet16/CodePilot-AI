import { decideAfterChecks } from "./repair-policy";

describe("decideAfterChecks", () => {
  it("is ready for review when checks pass", () => {
    expect(decideAfterChecks({ passed: true }, 0, 2)).toEqual({ action: "ready_for_review" });
  });

  it("repairs while under the limit", () => {
    expect(decideAfterChecks({ passed: false }, 0, 2)).toEqual({ action: "repair", attempt: 1 });
    expect(decideAfterChecks({ passed: false }, 1, 2)).toEqual({ action: "repair", attempt: 2 });
  });

  it("fails once the repair limit is reached", () => {
    expect(decideAfterChecks({ passed: false }, 2, 2).action).toBe("fail");
  });

  it("fails immediately on a safety violation, even if checks passed", () => {
    expect(decideAfterChecks({ passed: true, safetyViolation: "memory limit" }, 0, 2).action).toBe("fail");
  });
});
