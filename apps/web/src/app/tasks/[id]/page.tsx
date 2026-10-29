import type { TaskDetail } from "@codepilot/contracts";
import { isTerminal } from "@codepilot/contracts";
import { notFound, redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { StatusBadge } from "../status-badge";
import { AutoRefresh } from "./auto-refresh";
import { CancelButton } from "./cancel-button";

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
