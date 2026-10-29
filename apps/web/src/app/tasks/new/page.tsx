import type { IssueSummary, RepositorySummary } from "@codepilot/contracts";
import { MIN_PERMISSION_TO_ENABLE, hasPermission } from "@codepilot/contracts";
import Link from "next/link";
import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { NewTaskForm } from "./new-task-form";

export const dynamic = "force-dynamic";

export default async function NewTaskPage({ searchParams }: { searchParams: Promise<{ repositoryId?: string }> }) {
  const { repositoryId } = await searchParams;
  const repos = await apiGet<RepositorySummary[]>("/repositories");
  if (!repos.ok && repos.status === 401) redirect("/api/auth/github/login?returnTo=/tasks/new");

  const eligible = repos.ok
    ? repos.data.filter((r) => r.enabled && r.installationStatus === "ACTIVE" && hasPermission(r.permission, MIN_PERMISSION_TO_ENABLE))
    : [];
  const selected = eligible.find((r) => r.id === repositoryId) ?? eligible[0];
  const issues = selected ? await apiGet<IssueSummary[]>(`/repositories/${selected.id}/issues`) : null;

  return (
    <>
      <h1>New task</h1>
      <p className="muted">
        The agent analyzes the repository at the current head of its default branch, then proposes a plan for you to approve.
      </p>
      {eligible.length === 0 ? (
        <section className="card">
          <p>
            No repositories are ready. <Link href="/repositories">Enable a repository</Link> you have write access to first.
          </p>
        </section>
      ) : (
        <NewTaskForm repositories={eligible} selectedId={selected!.id} issues={issues?.ok ? issues.data : []} />
      )}
    </>
  );
}
