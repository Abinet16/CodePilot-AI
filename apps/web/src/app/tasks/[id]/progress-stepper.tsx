import type { TaskDetail } from "@codepilot/contracts";
import { buildProgress, describeStageTime } from "@/lib/progress";

const STATE_LABELS = {
  done: "done",
  current: "in progress",
  failed: "failed here",
  cancelled: "cancelled here",
  skipped: "skipped",
  upcoming: "not started",
} as const;

/** Where the task is in the pipeline, with the time spent in each stage. */
export function ProgressStepper({ task }: { task: Pick<TaskDetail, "status" | "createdAt" | "events"> }) {
  const stages = buildProgress(task);
  return (
    <ol className="stepper" aria-label="Task progress">
      {stages.map((stage) => (
        <li key={stage.status} data-state={stage.state} aria-current={stage.state === "current" ? "step" : undefined}>
          <strong>{stage.label}</strong>
          <span>{describeStageTime(stage) ?? STATE_LABELS[stage.state]}</span>
          <span className="visually-hidden"> ({STATE_LABELS[stage.state]})</span>
        </li>
      ))}
    </ol>
  );
}
