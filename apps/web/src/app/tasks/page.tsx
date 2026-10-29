import type { TaskSummary } from "@codepilot/contracts";
import Link from "next/link";
import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { StatusBadge } from "./status-badge";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const tasks = await apiGet<TaskSummary[]>("/tasks");
  if (!tasks.ok && tasks.status === 401) redirect("/api/auth/github/login?returnTo=/tasks");

  return (
    <>
      <div className="heading-row">
        <h1>Tasks</h1>
        <Link className="button" href="/tasks/new">
          New task
        </Link>
      </div>
      <p className="muted">Tasks on repositories you can access. Each one is analyzed at a pinned commit before any planning starts.</p>

      {!tasks.ok ? (
        <p className="bad">Could not load tasks.</p>
      ) : tasks.data.length === 0 ? (
        <section className="card">
          <p>No tasks yet. Enable a repository, then start a task from an issue or a description.</p>
        </section>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Repository</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {tasks.data.map((task) => (
              <tr key={task.id}>
                <td>
                  <Link href={`/tasks/${task.id}`}>{task.title || "Untitled task"}</Link>
                  <div className="muted small">{new Date(task.createdAt).toLocaleString()}</div>
                </td>
                <td>{task.repositoryFullName}</td>
                <td>
                  <StatusBadge status={task.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
