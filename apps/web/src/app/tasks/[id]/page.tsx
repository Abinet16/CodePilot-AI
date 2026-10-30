import type { TaskDetail } from "@codepilot/contracts";
import { MAX_PLAN_VERSIONS, isTerminal } from "@codepilot/contracts";
import { notFound, redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { StatusBadge } from "../status-badge";
import { AutoRefresh } from "./auto-refresh";
import { CancelButton } from "./cancel-button";
import { PlanReview } from "./plan-review";
import { PlanView } from "./plan-view";

export const dynamic = "force-dynamic";

const REASON_LABELS: Record<string, string> = {
  path_mentioned: "path mentioned",
  symbol_match: "symbol",
  text_match: "text match",
  instructions: "repo instructions",
};

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await apiGet<TaskDetail>(`/tasks/${encodeURIComponent(id)}`);
  if (!result.ok && result.status === 401) redirect(`/api/auth/github/login?returnTo=/tasks/${encodeURIComponent(id)}`);
  if (!result.ok && (result.status === 404 || result.status === 400)) notFound();
  if (!result.ok) return <p className="bad">Could not load the task.</p>;

  const task = result.data;
  const analysis = task.analysis;
  const active = !isTerminal(task.status) && task.status !== "AWAITING_PLAN_APPROVAL" && task.status !== "READY_FOR_REVIEW";
  const currentPlan = task.plans.at(-1);
  const earlierPlans = task.plans.slice(0, -1).reverse();
  const awaitingReview = task.status === "AWAITING_PLAN_APPROVAL" && currentPlan?.status === "PROPOSED";

  return (
    <>
      {active && <AutoRefresh />}
      <div className="heading-row">
        <h1>{task.title || "Untitled task"}</h1>
        {!isTerminal(task.status) && <CancelButton taskId={task.id} />}
      </div>
      <p className="muted">
        {task.repositoryFullName} · <StatusBadge status={task.status} />
      </p>
      {task.failureReason && <p className="notice bad">{task.failureReason}</p>}
      {task.description && <p className="prewrap">{task.description}</p>}

      <section className="card">
        <h2>Pinned commit</h2>
        {task.baseSha ? (
          <p>
            <a href={`https://github.com/${task.repositoryFullName}/tree/${task.baseSha}`} target="_blank" rel="noreferrer">
              <code>{task.baseSha.slice(0, 12)}</code>
            </a>
            {analysis && <span className="muted"> on {analysis.branch}</span>}
          </p>
        ) : (
          <p className="muted">Not pinned yet.</p>
        )}
      </section>

      {currentPlan && (
        <section className="card">
          <h2>Implementation plan</h2>
          <PlanView summary={currentPlan} />
          {awaitingReview && (
            <PlanReview taskId={task.id} version={currentPlan.version} canRevise={currentPlan.version < MAX_PLAN_VERSIONS} />
          )}
          {earlierPlans.map((p) => (
            <details key={p.version} className="snippet">
              <summary>Version {p.version}</summary>
              <PlanView summary={p} />
            </details>
          ))}
        </section>
      )}
      {!currentPlan && task.status === "PLANNING" && (
        <section className="card">
          <h2>Implementation plan</h2>
          <p className="muted">The agent is writing a plan…</p>
        </section>
      )}

      {task.runs.length > 0 && (
        <section className="card">
          <h2>Model usage</h2>
          <p className="muted small">
            {task.usage.inputTokens.toLocaleString()} input · {task.usage.outputTokens.toLocaleString()} output tokens · about $
            {task.usage.estimatedCostUsd.toFixed(4)}
          </p>
          <table className="table small">
            <thead>
              <tr>
                <th>#</th>
                <th>Stage</th>
                <th>Model</th>
                <th>Status</th>
                <th>Tokens in / out</th>
              </tr>
            </thead>
            <tbody>
              {task.runs.map((r) => (
                <tr key={r.attemptNumber}>
                  <td>{r.attemptNumber}</td>
                  <td>{r.stage}</td>
                  <td>{r.model}</td>
                  <td className={r.status === "FAILED" ? "bad" : undefined} title={r.error ?? undefined}>
                    {r.status.toLowerCase()}
                  </td>
                  <td>
                    {r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {analysis && (
        <>
          <section className="card">
            <h2>Project</h2>
            <dl className="facts">
              <dt>Language</dt>
              <dd>
                {analysis.profile.primaryLanguage ?? "unknown"}
                {!analysis.profile.supported && <span className="tag bad">unsupported</span>}
              </dd>
              <dt>Package manager</dt>
              <dd>{analysis.profile.packageManager ?? "none"}</dd>
              <dt>Frameworks</dt>
              <dd>{analysis.profile.frameworks.join(", ") || "none detected"}</dd>
              <dt>Tests</dt>
              <dd>
                {analysis.profile.testFrameworks.join(", ") || "none detected"} · {analysis.profile.testFileCount} test files
              </dd>
              <dt>Scripts</dt>
              <dd>{Object.keys(analysis.profile.scripts).join(", ") || "none"}</dd>
              <dt>Indexed</dt>
              <dd>
                {analysis.stats.indexedFiles} files ({Math.round(analysis.stats.indexedBytes / 1024)} KB)
                {analysis.stats.truncated && <span className="tag bad">truncated</span>}
              </dd>
            </dl>
          </section>

          <section className="card">
            <h2>Relevant code</h2>
            <p className="muted small">
              {analysis.snippets.length} snippets · {analysis.budget.usedChars.toLocaleString()} of {analysis.budget.maxChars.toLocaleString()}{" "}
              characters
              {analysis.budget.droppedSnippets > 0 && ` · ${analysis.budget.droppedSnippets} lower-ranked chunks left out`}
            </p>
            {analysis.snippets.map((s) => (
              <details key={`${s.path}:${s.startLine}`} className="snippet">
                <summary>
                  <code>
                    {s.path}:{s.startLine}–{s.endLine}
                  </code>
                  {s.reasons.map((r) => (
                    <span key={r} className="tag">
                      {REASON_LABELS[r] ?? r}
                    </span>
                  ))}
                </summary>
                {/* Repository content is rendered as text only, never as HTML. */}
                <pre>{s.content}</pre>
              </details>
            ))}
            {analysis.relatedTests.length > 0 && (
              <>
                <h3 className="small">Related tests</h3>
                <ul className="small">
                  {analysis.relatedTests.map((t) => (
                    <li key={t}>
                      <code>{t}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </>
      )}

      <section className="card">
        <h2>History</h2>
        <ol className="events small">
          {task.events.map((e) => (
            <li key={e.id}>
              <span className="muted">{new Date(e.createdAt).toLocaleTimeString()}</span>{" "}
              {e.eventType === "status_changed" ? `${e.fromStatus ?? "–"} → ${e.toStatus ?? "–"}` : e.eventType.replace(/_/g, " ")}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
