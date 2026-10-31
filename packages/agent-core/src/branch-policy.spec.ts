import { BranchPolicyError, assertTaskBranch, taskBranchName } from "./branch-policy";

const TASK_ID = "1a2b3c4d-0000-4000-8000-000000000000";

describe("taskBranchName", () => {
  it("builds a readable name from the title and the task id", () => {
    expect(taskBranchName(TASK_ID, "#42 Fix the login redirect")).toBe("codepilot/42-fix-the-login-redirect-1a2b3c4d");
  });

  it("strips anything git or a shell could interpret", () => {
    const name = taskBranchName(TASK_ID, "../../main; rm -rf / @{upstream} ~1 ^ : ? * [ \\ .lock Ünïcödé");
    expect(name).toMatch(/^codepilot\/[a-z0-9-]+$/);
    expect(name).not.toMatch(/\.\.|--/);
    expect(name.endsWith("-1a2b3c4d")).toBe(true);
  });

  it("falls back to the task id when the title has no usable characters", () => {
    expect(taskBranchName(TASK_ID, "!!! ???")).toBe("codepilot/1a2b3c4d");
  });

  it("keeps long titles under the length limit", () => {
    expect(taskBranchName(TASK_ID, "word ".repeat(100)).length).toBeLessThanOrEqual(100);
  });

  it("rejects an invalid task id", () => {
    expect(() => taskBranchName("../main", "x")).toThrow(/task id/);
  });
});

describe("assertTaskBranch", () => {
  it("accepts agent branches only", () => {
    expect(() => assertTaskBranch("codepilot/fix-1a2b3c4d", ["main"])).not.toThrow();
    for (const branch of ["main", "feature/x", "codepilot/", "codepilot/Fix", "codepilot/a..b", "codepilot/a/b", "codepilot/-a"]) {
      expect(() => assertTaskBranch(branch, ["main"])).toThrow(BranchPolicyError);
    }
  });

  it("refuses a protected branch even when it matches the prefix", () => {
    expect(() => assertTaskBranch("codepilot/release", ["codepilot/release"])).toThrow(/protected/);
  });
});
