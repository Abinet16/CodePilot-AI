import type { TaskEventSummary, TaskStatus } from "@codepilot/contracts";
import { formatDuration, humanize, shortSha } from "./format";

/** The stages a task moves through, in order, as the progress bar shows them. */
export const PIPELINE: ReadonlyArray<{ status: TaskStatus; label: string }> = [
  { status: "QUEUED", label: "Queued" },
  { status: "ANALYZING", label: "Analyze" },
  { status: "PLANNING", label: "Plan" },
  { status: "AWAITING_PLAN_APPROVAL", label: "Plan review" },
  { status: "GENERATING_PATCH", label: "Patch" },
  { status: "RUNNING_CHECKS", label: "Checks" },
  { status: "REPAIRING", label: "Repair" },
  { status: "READY_FOR_REVIEW", label: "Review" },
  { status: "OPENING_PR", label: "Open PR" },
  { status: "PR_OPENED", label: "PR opened" },
];

export type StageState = "done" | "current" | "failed" | "cancelled" | "skipped" | "upcoming";

export interface StageProgress {
  status: TaskStatus;
  label: string;
  state: StageState;
  /** Time spent in the stage across every visit; null if never entered. */
  durationMs: number | null;
  /** How often the task entered the stage (checks and repairs can repeat). */
  visits: number;
}

type StatusEvent = Pick<TaskEventSummary, "eventType" | "fromStatus" | "toStatus" | "createdAt">;

/**
 * Builds the progress bar from the persisted transitions. The time in a stage
 * runs from the transition into it to the transition out; the stage the task
 * is in now counts up to `now`.
 */
export function buildProgress(task: { status: TaskStatus; createdAt: string; events: StatusEvent[] }, now: Date = new Date()): StageProgress[] {
  const duration = new Map<TaskStatus, number>();
  const visits = new Map<TaskStatus, number>();
  let current: TaskStatus = "QUEUED";
  let since = new Date(task.createdAt).getTime();
  visits.set("QUEUED", 1);
  let endedFrom: TaskStatus | null = null;

  const transitions = task.events
    .filter((e) => e.eventType === "status_changed" && e.fromStatus && e.toStatus)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const event of transitions) {
    const at = new Date(event.createdAt).getTime();
    duration.set(current, (duration.get(current) ?? 0) + Math.max(0, at - since));
    current = event.toStatus!;
    since = at;
    if (current === "FAILED" || current === "CANCELLED") endedFrom = event.fromStatus;
    else visits.set(current, (visits.get(current) ?? 0) + 1);
  }
  const live = task.status !== "FAILED" && task.status !== "CANCELLED" && task.status !== "PR_OPENED";
  if (live) duration.set(current, (duration.get(current) ?? 0) + Math.max(0, now.getTime() - since));

  const reached = Math.max(
    ...PIPELINE.map((stage, i) => ((visits.get(stage.status) ?? 0) > 0 || stage.status === endedFrom ? i : -1)),
  );
  return PIPELINE.map((stage, i) => {
    const count = visits.get(stage.status) ?? 0;
    let state: StageState;
    if (stage.status === endedFrom) state = task.status === "CANCELLED" ? "cancelled" : "failed";
    else if (live && stage.status === task.status) state = "current";
    else if (count > 0) state = "done";
    else state = i < reached ? "skipped" : "upcoming";
    return {
      status: stage.status,
      label: stage.label,
      state,
      durationMs: count > 0 || duration.has(stage.status) ? (duration.get(stage.status) ?? 0) : null,
      visits: count,
    };
  });
}

export interface EventDescription {
  title: string;
  detail: string | null;
  tone: "ok" | "bad" | "neutral";
}

const str = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v) : "");
const first = (v: unknown): string => (Array.isArray(v) && v.length > 0 ? str(v[0]) : "");

/** One line of the execution log. Payload values are untrusted text and are only ever rendered as text. */
export function describeEvent(event: Pick<TaskEventSummary, "eventType" | "fromStatus" | "toStatus" | "payload">): EventDescription {
  const p = event.payload ?? {};
  switch (event.eventType) {
    case "task_created":
      return { title: "Task created", detail: null, tone: "neutral" };
    case "status_changed": {
      const to = event.toStatus ?? "";
      const tone = to === "FAILED" ? "bad" : to === "PR_OPENED" ? "ok" : "neutral";
      const reason = str(p.reason);
      return { title: `${humanize(event.fromStatus ?? "")} → ${humanize(to)}`, detail: reason ? humanize(reason) : null, tone };
    }
    case "commit_pinned":
      return { title: `Pinned ${str(p.branch)} at ${shortSha(str(p.commitSha))}`, detail: null, tone: "neutral" };
    case "analysis_completed":
      return { title: "Repository analyzed", detail: `${str(p.snippets)} snippets, ${Number(p.usedChars ?? 0).toLocaleString()} characters of context`, tone: "neutral" };
    case "plan_proposed":
      return { title: `Plan v${str(p.version)} proposed`, detail: `${str(p.affectedFiles)} files`, tone: "neutral" };
    case "plan_auto_approved":
      return { title: `Plan v${str(p.version)} auto-approved`, detail: null, tone: "neutral" };
    case "plan_invalid":
    case "patch_invalid":
      return {
        title: `${event.eventType === "plan_invalid" ? "Plan" : "Patch"} attempt ${str(p.attempt)} rejected by validation`,
        detail: first(p.problems) || null,
        tone: "bad",
      };
    case "stage_retry_scheduled":
      return { title: `Retry scheduled for ${humanize(str(p.status))}`, detail: str(p.reason) || null, tone: "neutral" };
    case "branch_reserved":
      return { title: `Branch ${str(p.branch)} reserved`, detail: null, tone: "neutral" };
    case "patch_created":
      return { title: `Patch v${str(p.version)} committed`, detail: `${str(p.files)} files, +${str(p.additions)} −${str(p.deletions)}`, tone: "neutral" };
    case "checks_started":
      return { title: `Checks started on patch v${str(p.patchVersion)}`, detail: null, tone: "neutral" };
    case "checks_passed":
      return { title: `Checks passed on patch v${str(p.patchVersion)}`, detail: null, tone: "ok" };
    case "checks_failed":
      return { title: `Checks ${humanize(str(p.status) || "failed")} on patch v${str(p.patchVersion)}`, detail: null, tone: "bad" };
    case "branch_pushed":
      return { title: `Pushed ${str(p.branch)}`, detail: shortSha(str(p.commitSha)), tone: "neutral" };
    case "branch_deleted":
      return { title: `Deleted ${str(p.branch)}`, detail: str(p.reason) || null, tone: "bad" };
    case "pull_request_opened":
      return { title: `Draft PR #${str(p.number)} opened`, detail: null, tone: "ok" };
    case "pull_request_merged":
      return { title: `PR #${str(p.number)} merged`, detail: str(p.source) ? `via ${str(p.source)}` : null, tone: "ok" };
    case "pull_request_closed":
      return { title: `PR #${str(p.number)} closed`, detail: str(p.source) ? `via ${str(p.source)}` : null, tone: "bad" };
    default:
      return { title: humanize(event.eventType), detail: null, tone: "neutral" };
  }
}

/** "3m 12s across 2 runs" for repeated stages. */
export function describeStageTime(stage: StageProgress): string | null {
  if (stage.durationMs === null) return null;
  const time = formatDuration(stage.durationMs);
  return stage.visits > 1 ? `${time} · ${stage.visits}×` : time;
}
