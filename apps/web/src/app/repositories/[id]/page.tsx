import type { RepositoryDetail } from "@codepilot/contracts";
import { MIN_PERMISSION_TO_ENABLE, hasPermission } from "@codepilot/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { relativeTime, shortSha } from "@/lib/format";
import { TaskTable } from "../../tasks/task-table";
import { RepositoryToggle } from "../repository-toggle";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Repository" };

export default async function RepositoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await apiGet<RepositoryDetail>(`/repositories/${encodeURIComponent(id)}`);
  if (!result.ok && result.status === 401) redirect(`/api/auth/github/login?returnTo=/repositories/${encodeURIComponent(id)}`);
  if (!result.ok && (result.status === 404 || result.status === 400)) notFound();
  if (!result.ok) return <p className="bad">Could not load the repository.</p>;

  const repo = result.data;
  const canStart = repo.enabled && repo.installationStatus === "ACTIVE" && hasPermission(repo.permission, MIN_PERMISSION_TO_ENABLE);
  const snapshot = repo.latestSnapshot;

  return (
    <>
      <p className="small">
        <Link href="/repositories">← Repositories</Link>
      </p>
      <div className="heading-row">
        <h1>{repo.fullName}</h1>
        <span className="toggle">
          <RepositoryToggle
            repository={repo}
            canChange={hasPermission(repo.permission, MIN_PERMISSION_TO_ENABLE) && repo.installationStatus === "ACTIVE"}
            reason={`Requires ${MIN_PERMISSION_TO_ENABLE.toLowerCase()} access and an active installation`}
          />
          {canStart && (
            <Link className="button" href={`/tasks/new?repositoryId=${repo.id}`}>
              New task
            </Link>
          )}
        </span>
      </div>
      <p className="muted">
        <a href={`https://github.com/${repo.fullName}`} target="_blank" rel="noreferrer">
          View on GitHub
        </a>{" "}
        · default branch <code>{repo.defaultBranch}</code> · your access: {repo.permission.toLowerCase()}
        {repo.isPrivate && " · private"}
      </p>
      {repo.installationStatus !== "ACTIVE" && <p className="notice bad">The GitHub App installation is {repo.installationStatus.toLowerCase()}.</p>}

      <div className="stats">
        <Link className="stat" href={`/tasks?repositoryId=${repo.id}&group=review`}>
          <strong>{repo.taskCounts.review}</strong>
          <span>waiting for review</span>
        </Link>
        <Link className="stat" href={`/tasks?repositoryId=${repo.id}&group=active`}>
          <strong>{repo.taskCounts.active}</strong>
          <span>in progress</span>
        </Link>
        <Link className="stat" href={`/tasks?repositoryId=${repo.id}&group=done`}>
          <strong>{repo.taskCounts.done}</strong>
          <span>PRs opened</span>
        </Link>
        <Link className="stat" href={`/tasks?repositoryId=${repo.id}&group=failed`}>
          <strong>{repo.taskCounts.failed}</strong>
          <span>failed</span>
        </Link>
        <Link className="stat" href={`/tasks/new?repositoryId=${repo.id}`}>
          <strong>{repo.openIssues}</strong>
          <span>open issues</span>
        </Link>
      </div>

      <div className="grid-2">
        <section className="card">
          <h2>Index</h2>
          {snapshot ? (
            <dl className="facts">
              <dt>Commit</dt>
              <dd>
                <code>{shortSha(snapshot.commitSha)}</code> <span className="muted">indexed {relativeTime(snapshot.indexedAt)}</span>
              </dd>
              <dt>Language</dt>
              <dd>{snapshot.primaryLanguage ?? "unknown"}</dd>
              <dt>Package manager</dt>
              <dd>{snapshot.packageManager ?? "none detected"}</dd>
              <dt>Tests</dt>
              <dd>{snapshot.testFrameworks.join(", ") || "none detected"}</dd>
              <dt>Files</dt>
              <dd>{snapshot.indexedFiles.toLocaleString()} indexed</dd>
            </dl>
          ) : (
            <p className="muted small">Not indexed yet. The first task analyzes the head of the default branch.</p>
          )}
        </section>
        <section className="card">
          <h2>Checks</h2>
          {repo.checksConfigured ? (
            <p className="small">
              <span className="ok">Configured.</span> Patches are verified in the sandbox before review.
            </p>
          ) : (
            <p className="small">
              <span className="bad">Not configured.</span> Tasks stop at checks until a maintainer sets them up.
            </p>
          )}
          <p className="small">
            <Link href={`/repositories/${repo.id}/checks`}>{repo.checksConfigured ? "View checks →" : "Set up checks →"}</Link>
          </p>
        </section>
      </div>

      <section className="card">
        <div className="heading-row">
          <h2>Recent tasks</h2>
          <Link className="small" href={`/tasks?repositoryId=${repo.id}`}>
            All tasks for this repository →
          </Link>
        </div>
        <TaskTable tasks={repo.recentTasks} showRepository={false} empty="No tasks on this repository yet." />
      </section>
    </>
  );
}
