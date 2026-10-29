import type { TaskStatus } from "@codepilot/contracts";
import { isTerminal } from "@codepilot/contracts";

export function StatusBadge({ status }: { status: TaskStatus }) {
  const tone = status === "FAILED" ? "bad" : status === "PR_OPENED" ? "ok" : isTerminal(status) ? "muted" : "active";
  return <span className={`status ${tone}`}>{status.toLowerCase().replace(/_/g, " ")}</span>;
}
