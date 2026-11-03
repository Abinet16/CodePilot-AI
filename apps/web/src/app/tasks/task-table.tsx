import type { TaskListItem } from "@codepilot/contracts";
import Link from "next/link";
import { formatUsd, humanize, relativeTime } from "@/lib/format";
import { StatusBadge } from "./status-badge";

/** Task rows for the dashboard, the task list, and repository pages. Titles are untrusted text, rendered as text. */
export function TaskTable({ tasks, showRepository = true, empty }: { tasks: TaskListItem[]; showRepository?: boolean; empty: string }) {
  if (tasks.length === 0) return <p className="empty">{empty}</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Task</th>
          {showRepository && <th>Repository</th>}
          <th>Status</th>
          <th>Pull request</th>
          <th className="num">Cost</th>
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => (
          <tr key={task.id} className={task.group === "review" ? "attention" : undefined}>
            <td>
              <Link href={`/tasks/${task.id}`}>{task.title || "Untitled task"}</Link>
              <div className="muted small" title={new Date(task.updatedAt).toLocaleString()}>
                updated {relativeTime(task.updatedAt)}
              </div>
            </td>
            {showRepository && (
              <td>
                <Link href={`/repositories/${task.repositoryId}`} className="muted">
                  {task.repositoryFullName}
                </Link>
              </td>
            )}
            <td>
              <StatusBadge status={task.status} />
            </td>
            <td>
              {task.pullRequest ? (
                <a href={task.pullRequest.url} target="_blank" rel="noreferrer">
                  #{task.pullRequest.number}
                  <span className="muted small"> {humanize(task.pullRequest.status)}</span>
                </a>
              ) : (
                <span className="muted">–</span>
              )}
            </td>
            <td className="num">{formatUsd(task.estimatedCostUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
