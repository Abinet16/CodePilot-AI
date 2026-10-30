import type { TaskStatus } from "@codepilot/contracts";
import { TaskCancelledError, watchForCancellation } from "./cancellation";

describe("watchForCancellation", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("aborts once the task becomes terminal", async () => {
    let status: TaskStatus = "PLANNING";
    const controller = new AbortController();
    const stop = watchForCancellation("t1", async () => status, controller, 1_000);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(controller.signal.aborted).toBe(false);

    status = "CANCELLED";
    await jest.advanceTimersByTimeAsync(1_000);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(TaskCancelledError);
    stop();
  });

  it("keeps watching after a failed poll", async () => {
    const load = jest.fn<Promise<TaskStatus>, [string]>().mockRejectedValueOnce(new Error("db blip")).mockResolvedValue("CANCELLED");
    const controller = new AbortController();
    watchForCancellation("t1", load, controller, 500);

    await jest.advanceTimersByTimeAsync(500);
    expect(controller.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(500);
    expect(controller.signal.aborted).toBe(true);
  });

  it("stops polling when the job finishes", async () => {
    const load = jest.fn(async (): Promise<TaskStatus> => "PLANNING");
    const stop = watchForCancellation("t1", load, new AbortController(), 500);
    await jest.advanceTimersByTimeAsync(500);
    stop();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
