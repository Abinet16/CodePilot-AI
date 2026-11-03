import type { TaskStatus } from "@codepilot/contracts";
import { buildProgress, describeEvent, describeStageTime } from "./progress";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 3, 12, minutes)).toISOString();
const move = (from: TaskStatus, to: TaskStatus, minutes: number) => ({ eventType: "status_changed", fromStatus: from, toStatus: to, createdAt: at(minutes) });

const stateOf = (stages: ReturnType<typeof buildProgress>) => Object.fromEntries(stages.map((s) => [s.status, s.state]));

describe("buildProgress", () => {
  it("marks finished, current, and upcoming stages and times the live one up to now", () => {
    const stages = buildProgress(
      { status: "PLANNING", createdAt: at(0), events: [move("QUEUED", "ANALYZING", 1), move("ANALYZING", "PLANNING", 4)] },
      new Date(at(6)),
    );
    expect(stateOf(stages)).toMatchObject({ QUEUED: "done", ANALYZING: "done", PLANNING: "current", AWAITING_PLAN_APPROVAL: "upcoming", PR_OPENED: "upcoming" });
    expect(stages.find((s) => s.status === "ANALYZING")?.durationMs).toBe(3 * 60_000);
    expect(stages.find((s) => s.status === "PLANNING")?.durationMs).toBe(2 * 60_000);
  });

  it("adds up repeated stages and skips the ones a task jumped over", () => {
    const events = [
      move("QUEUED", "ANALYZING", 1),
      move("ANALYZING", "PLANNING", 2),
      move("PLANNING", "GENERATING_PATCH", 3), // auto-approved: no plan review
      move("GENERATING_PATCH", "RUNNING_CHECKS", 4),
      move("RUNNING_CHECKS", "REPAIRING", 6),
      move("REPAIRING", "RUNNING_CHECKS", 7),
      move("RUNNING_CHECKS", "READY_FOR_REVIEW", 10),
    ];
    const stages = buildProgress({ status: "READY_FOR_REVIEW", createdAt: at(0), events }, new Date(at(20)));
    const checks = stages.find((s) => s.status === "RUNNING_CHECKS")!;
    expect(checks).toMatchObject({ state: "done", visits: 2, durationMs: 5 * 60_000 });
    expect(describeStageTime(checks)).toBe("5m · 2×");
    expect(stateOf(stages)).toMatchObject({ AWAITING_PLAN_APPROVAL: "skipped", READY_FOR_REVIEW: "current", OPENING_PR: "upcoming" });
  });

  it("marks the stage a task failed or was cancelled in", () => {
    const failed = buildProgress({ status: "FAILED", createdAt: at(0), events: [move("QUEUED", "ANALYZING", 1), move("ANALYZING", "FAILED", 2)] });
    expect(stateOf(failed)).toMatchObject({ QUEUED: "done", ANALYZING: "failed", PLANNING: "upcoming" });

    const cancelled = buildProgress({ status: "CANCELLED", createdAt: at(0), events: [move("QUEUED", "CANCELLED", 1)] });
    expect(stateOf(cancelled)).toMatchObject({ QUEUED: "cancelled", ANALYZING: "upcoming" });
  });

  it("completes the whole pipeline when the PR is opened", () => {
    const order: TaskStatus[] = ["QUEUED", "ANALYZING", "PLANNING", "AWAITING_PLAN_APPROVAL", "GENERATING_PATCH", "RUNNING_CHECKS", "READY_FOR_REVIEW", "OPENING_PR", "PR_OPENED"];
    const events = order.slice(1).map((to, i) => move(order[i]!, to, i + 1));
    const stages = buildProgress({ status: "PR_OPENED", createdAt: at(0), events });
    expect(stages.every((s) => s.state === "done" || (s.status === "REPAIRING" && s.state === "skipped"))).toBe(true);
  });
});

describe("describeEvent", () => {
  it("turns events into log lines with a tone", () => {
    expect(describeEvent({ eventType: "status_changed", fromStatus: "RUNNING_CHECKS", toStatus: "FAILED", payload: { reason: "Checks still failing" } })).toEqual({
      title: "running checks → failed",
      detail: "checks still failing",
      tone: "bad",
    });
    expect(describeEvent({ eventType: "patch_created", fromStatus: null, toStatus: null, payload: { version: 2, files: 3, additions: 10, deletions: 4 } })).toEqual({
      title: "Patch v2 committed",
      detail: "3 files, +10 −4",
      tone: "neutral",
    });
    expect(describeEvent({ eventType: "plan_invalid", fromStatus: null, toStatus: null, payload: { attempt: 1, problems: ["src/x.ts does not exist"] } })).toMatchObject({
      detail: "src/x.ts does not exist",
      tone: "bad",
    });
    expect(describeEvent({ eventType: "pull_request_merged", fromStatus: null, toStatus: null, payload: { number: 12, source: "webhook" } }).title).toBe("PR #12 merged");
  });

  it("falls back to the event type for anything new, and ignores odd payload values", () => {
    expect(describeEvent({ eventType: "something_new", fromStatus: null, toStatus: null, payload: {} }).title).toBe("something new");
    expect(describeEvent({ eventType: "branch_pushed", fromStatus: null, toStatus: null, payload: { branch: { evil: true } } }).title).toBe("Pushed ");
  });
});
