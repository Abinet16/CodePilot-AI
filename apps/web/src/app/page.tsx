import type { DashboardResponse, HealthResponse } from "@codepilot/contracts";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { formatTokens, formatUsd } from "@/lib/format";
import { TaskTable } from "./tasks/task-table";

export const dynamic = "force-dynamic";

export default async function HomePage({ searchParams }: { searchParams: Promise<{ login?: string }> }) {
  const [{ login }, dashboard] = await Promise.all([searchParams, apiGet<DashboardResponse>("/dashboard")]);
  if (dashboard.ok) return <Dashboard data={dashboard.data} />;
  return <Landing loginDenied={login === "denied"} />;
}

function Dashboard({ data }: { data: DashboardResponse }) {
  const { counts, pullRequests, repositories, usage } = data;
  const openPrs = pullRequests.DRAFT + pullRequests.OPEN;
  return (
    <>
      <div className="heading-row">
        <h1>Dashboard</h1>
        <Link className="button" href="/tasks/new">
          New task
        </Link>
      </div>
      <p className="muted">Everything the agent is doing on repositories you can access, and what is waiting on you.</p>

      <div className="stats">
        <Link className="stat" href="/tasks?group=review">
          <strong>{counts.review}</strong>
          <span>waiting for review</span>
        </Link>
        <Link className="stat" href="/tasks?group=active">
          <strong>{counts.active}</strong>
          <span>in progress</span>
        </Link>
        <Link className="stat" href="/tasks?group=done">
          <strong>{counts.done}</strong>
          <span>PRs opened · {openPrs} open, {pullRequests.MERGED} merged</span>
        </Link>
        <Link className="stat" href="/tasks?group=failed">
          <strong>{counts.failed}</strong>
          <span>failed</span>
        </Link>
        <Link className="stat" href="/usage">
          <strong>{formatUsd(usage.estimatedCostUsd)}</strong>
          <span>
            {formatTokens(usage.inputTokens + usage.outputTokens)} tokens in {usage.days} days
          </span>
        </Link>
      </div>

      <section className="card">
        <h2>Waiting for you</h2>
        <p className="muted small">Plans to approve and verified patches to review, oldest first.</p>
        <TaskTable tasks={data.needsReview} empty="Nothing is waiting for review." />
      </section>

      <section className="card">
        <div className="heading-row">
          <h2>Recent tasks</h2>
          <Link className="small" href="/tasks">
            All tasks →
          </Link>
        </div>
        <TaskTable
          tasks={data.recent}
          empty={repositories.enabled === 0 ? "No tasks yet. Enable a repository to start one." : "No tasks yet. Start one from an issue or a description."}
        />
      </section>

      <p className="muted small">
        {repositories.enabled} of {repositories.visible} repositories enabled · <Link href="/repositories">Manage repositories</Link>
      </p>
    </>
  );
}

async function Landing({ loginDenied }: { loginDenied: boolean }) {
  const health = await apiGet<HealthResponse>("/health");
  return (
    <>
      <h1>CodePilot AI</h1>
      <p className="muted">
        Issue → plan → patch → verified checks → draft pull request, with a human approving every step that matters.
      </p>
      {loginDenied && <p className="notice">GitHub sign-in was cancelled.</p>}
      <p>
        <a className="button" href="/api/auth/github/login">
          Sign in with GitHub
        </a>
      </p>
      <section className="card">
        <h2>System status</h2>
        {health.ok ? (
          <ul>
            {Object.entries(health.data.checks).map(([name, state]) => (
              <li key={name}>
                {name}: <strong className={state === "ok" ? "ok" : "bad"}>{state}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className="bad">API unreachable</p>
        )}
      </section>
    </>
  );
}
