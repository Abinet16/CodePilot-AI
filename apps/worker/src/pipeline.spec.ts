import { TaskStatus, assertTransition } from "@codepilot/contracts";
import type { PipelineDeps } from "./pipeline";
import { StageTimeoutError, TransientError, runPipeline } from "./pipeline";

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
  return {
    deps,
    history,
    get current() {
      return current;
    },
    setCurrent(status: TaskStatus) {
      current = status;
    },
  };
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

  it("fails a stage that exceeds its timeout, even if it ignores its signal", async () => {
    const f = fakeDeps("ANALYZING", { ANALYZING: () => new Promise(() => undefined) });
    f.deps.stageTimeoutsMs = { ANALYZING: 20 };
    expect(await runPipeline("t1", f.deps, signal)).toBe("FAILED");
    expect(f.history).toEqual(["ANALYZING->FAILED (ANALYZING did not finish within 0s)"]);
  });

  it("aborts the stage signal on timeout so the handler can stop its work", async () => {
    let seen: unknown;
    const f = fakeDeps("PLANNING", {
      PLANNING: ({ signal: s }) =>
        new Promise((_, reject) => s.addEventListener("abort", () => reject((seen = s.reason)), { once: true })),
    });
    f.deps.stageTimeoutsMs = { PLANNING: 20 };
    await runPipeline("t1", f.deps, signal);
    expect(seen).toBeInstanceOf(StageTimeoutError);
  });

  it("hands transient errors back to the queue while attempts remain", async () => {
    const onRetry = jest.fn(async () => undefined);
    const f = fakeDeps("PLANNING", {
      PLANNING: async () => {
        throw new TransientError("rate limited");
      },
    });
    Object.assign(f.deps, { canRetry: true, onRetry });
    await expect(runPipeline("t1", f.deps, signal)).rejects.toBeInstanceOf(TransientError);
    expect(onRetry).toHaveBeenCalledWith("t1", "PLANNING", "rate limited");
    expect(f.current).toBe("PLANNING");
  });

  it("fails the task on a transient error once attempts are used up", async () => {
    const f = fakeDeps("PLANNING", {
      PLANNING: async () => {
        throw new TransientError("rate limited");
      },
    });
    f.deps.canRetry = false;
    expect(await runPipeline("t1", f.deps, signal)).toBe("FAILED");
  });

  it("stops without failing the task when the job is aborted mid-stage", async () => {
    const controller = new AbortController();
    const f = fakeDeps("PLANNING", {
      PLANNING: ({ signal: s }) =>
        new Promise((_, reject) => {
          s.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          // Simulates the API cancelling the task while the stage runs.
          setTimeout(() => {
            f.setCurrent("CANCELLED");
            controller.abort();
          }, 5);
        }),
    });
    expect(await runPipeline("t1", f.deps, controller.signal)).toBe("CANCELLED");
    expect(f.history).toEqual([]);
  });
});
