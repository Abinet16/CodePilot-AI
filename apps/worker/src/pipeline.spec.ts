import { TaskStatus, assertTransition } from "@codepilot/contracts";
import type { PipelineDeps } from "./pipeline";
import { runPipeline } from "./pipeline";

function fakeDeps(initial: TaskStatus, stages: PipelineDeps["stages"]) {
  let current = initial;
  const history: string[] = [];
  const deps: PipelineDeps = {
    stages,
    loadStatus: async () => current,
    transition: async (_id, from, to) => {
      assertTransition(from, to);
      history.push(`${from}->${to}`);
      current = to;
    },
    fail: async (_id, from, reason) => {
      history.push(`${from}->FAILED (${reason})`);
      current = TaskStatus.FAILED;
    },
  };
  return { deps, history, get current() { return current; } };
}

describe("runPipeline", () => {
  const signal = new AbortController().signal;

  it("stops at the plan approval gate", async () => {
    const f = fakeDeps("QUEUED", {
      QUEUED: async () => "ANALYZING",
      ANALYZING: async () => "PLANNING",
      PLANNING: async () => "AWAITING_PLAN_APPROVAL",
    });
    expect(await runPipeline("t1", f.deps, signal)).toBe("AWAITING_PLAN_APPROVAL");
    expect(f.history).toEqual(["QUEUED->ANALYZING", "ANALYZING->PLANNING", "PLANNING->AWAITING_PLAN_APPROVAL"]);
  });

  it("resumes from the persisted status after a restart", async () => {
    const queued = jest.fn();
    const f = fakeDeps("GENERATING_PATCH", {
      QUEUED: queued,
      GENERATING_PATCH: async () => "RUNNING_CHECKS",
      RUNNING_CHECKS: async () => "READY_FOR_REVIEW",
    });
    expect(await runPipeline("t1", f.deps, signal)).toBe("READY_FOR_REVIEW");
    expect(queued).not.toHaveBeenCalled();
  });

  it("fails the task when a stage throws or is missing", async () => {
    const f = fakeDeps("QUEUED", { QUEUED: async () => "ANALYZING" });
    expect(await runPipeline("t1", f.deps, signal)).toBe("FAILED");
    expect(f.history.at(-1)).toMatch(/^ANALYZING->FAILED \(No stage handler/);
  });

  it("fails rather than performing an illegal transition", async () => {
    const f = fakeDeps("GENERATING_PATCH", { GENERATING_PATCH: async () => "OPENING_PR" });
    expect(await runPipeline("t1", f.deps, signal)).toBe("FAILED");
  });

  it("does nothing for a task that is already terminal", async () => {
    const f = fakeDeps("CANCELLED", {});
    expect(await runPipeline("t1", f.deps, signal)).toBe("CANCELLED");
    expect(f.history).toEqual([]);
  });
});
