import type { RepositorySummary, TaskPage, TaskStatusGroup } from "@codepilot/contracts";
import { TASK_STATUS_GROUP_NAMES } from "@codepilot/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { TaskTable } from "./task-table";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Tasks" };

const GROUP_LABELS: Record<TaskStatusGroup, string> = {
  review: "Needs review",
  active: "In progress",
  done: "PR opened",
  failed: "Failed",
  cancelled: "Cancelled",
};

type Search = { group?: string; repositoryId?: string; cursor?: string };

function href(params: Search): string {
  const query = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
  const text = query.toString();
  return text ? `/tasks?${text}` : "/tasks";
}

export default async function TasksPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const group = TASK_STATUS_GROUP_NAMES.includes(search.group as TaskStatusGroup) ? (search.group as TaskStatusGroup) : undefined;
  const repositoryId = search.repositoryId && /^[0-9a-f-]{36}$/.test(search.repositoryId) ? search.repositoryId : undefined;
  const cursor = search.cursor && /^[A-Za-z0-9_-]{1,200}$/.test(search.cursor) ? search.cursor : undefined;

  const query = new URLSearchParams({ limit: "25" });
  if (group) query.set("group", group);
  if (repositoryId) query.set("repositoryId", repositoryId);
  if (cursor) query.set("cursor", cursor);

  const [tasks, repos] = await Promise.all([apiGet<TaskPage>(`/tasks?${query}`), apiGet<RepositorySummary[]>("/repositories")]);
  if (!tasks.ok && tasks.status === 401) redirect("/api/auth/github/login?returnTo=/tasks");

  return (
    <>
      <div className="heading-row">
        <h1>Tasks</h1>
        <Link className="button" href="/tasks/new">
          New task
        </Link>
      </div>
      <p className="muted">Tasks on repositories you can access, newest first.</p>

      <nav className="tabs" aria-label="Filter by status">
        <Link href={href({ repositoryId })} aria-current={!group ? "page" : undefined}>
          All
        </Link>
        {TASK_STATUS_GROUP_NAMES.map((g) => (
          <Link key={g} href={href({ group: g, repositoryId })} aria-current={group === g ? "page" : undefined}>
            {GROUP_LABELS[g]}
          </Link>
        ))}
      </nav>

      {repos.ok && repos.data.length > 1 && (
        <form className="filters" action="/tasks" method="get">
          {group && <input type="hidden" name="group" value={group} />}
          <label htmlFor="repository-filter">Repository</label>
          <select id="repository-filter" name="repositoryId" defaultValue={repositoryId ?? ""}>
            <option value="">All repositories</option>
            {repos.data.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </select>
          <button className="button secondary" type="submit">
            Filter
          </button>
        </form>
      )}

      {!tasks.ok ? (
        <p className="bad">Could not load tasks.</p>
      ) : (
        <>
          <TaskTable
            tasks={tasks.data.items}
            empty={group || repositoryId ? "No tasks match this filter." : "No tasks yet. Enable a repository, then start a task from an issue or a description."}
          />
          <div className="pager">
            {cursor ? <Link href={href({ group, repositoryId })}>← Newest</Link> : <span />}
            {tasks.data.nextCursor && <Link href={href({ group, repositoryId, cursor: tasks.data.nextCursor })}>Older tasks →</Link>}
          </div>
        </>
      )}
    </>
  );
}
