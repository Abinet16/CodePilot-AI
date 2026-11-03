import type { PatchDetail, TaskDetail } from "@codepilot/contracts";
import { MAX_PLAN_VERSIONS, isTerminal } from "@codepilot/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { formatDuration, formatTokens, formatUsd, relativeTime, shortSha } from "@/lib/format";
import { StatusBadge } from "../status-badge";
import { AutoRefresh } from "./auto-refresh";
import { CancelButton } from "./cancel-button";
import { ChecksView } from "./checks-view";
import { DiffView } from "./diff-view";
import { ExecutionLog, ModelCalls } from "./execution-log";
import { OpenPullRequestButton } from "./open-pr-button";
import { PatchView } from "./patch-view";
import { PlanReview } from "./plan-review";
import { PlanView } from "./plan-view";
import { ProgressStepper } from "./progress-stepper";
import { PullRequestView } from "./pull-request-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Task" };

const REASON_LABELS: Record<string, string> = {
  path_mentioned: "path mentioned",
  symbol_match: "symbol",
  text_match: "text match",
  instructions: "repo instructions",
};

export default async function TaskPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ patch?: string }> }) {
  const [{ id }, { patch: requestedPatch }] = await Promise.all([params, searchParams]);
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

  const latestPatch = task.patches.at(-1);
  const shownPatch = task.patches.find((p) => String(p.version) === requestedPatch) ?? latestPatch;
  const patchDetail = shownPatch ? await apiGet<PatchDetail>(`/tasks/${encodeURIComponent(id)}/patches/${shownPatch.version}`) : null;
  const elapsed = (task.completedAt ? new Date(task.completedAt).getTime() : Date.now()) - new Date(task.createdAt).getTime();

  return (
    <>
      {active && <AutoRefresh />}
      <p className="small">
        <Link href="/tasks">← Tasks</Link>
      </p>
      <div className="heading-row">
        <h1>{task.title || "Untitled task"}</h1>
        {!isTerminal(task.status) && <CancelButton taskId={task.id} />}
      </div>
      <p className="muted">
        <Link href={`/repositories/${task.repositoryId}`}>{task.repositoryFullName}</Link> · <StatusBadge status={task.status} /> · started{" "}
        {relativeTime(task.createdAt)} · {formatDuration(elapsed)}
        {task.completedAt ? " in total" : " so far"}
      </p>
      <ProgressStepper task={task} />
      {task.failureReason && <p className="notice bad">{task.failureReason}</p>}

      <section className="card">
        <h2>Overview</h2>
        <dl className="facts">
          {task.issue && (
            <>
              <dt>Issue</dt>
              <dd>
                <a href={`https://github.com/${task.repositoryFullName}/issues/${task.issue.number}`} target="_blank" rel="noreferrer">
                  #{task.issue.number}
                </a>{" "}
                {task.issue.title} <span className="muted">({task.issue.state.toLowerCase()})</span>
              </dd>
            </>
          )}
          {task.description && (
            <>
              <dt>Request</dt>
              <dd className="prewrap">{task.description}</dd>
            </>
          )}
          <dt>Pinned commit</dt>
          <dd>
            {task.baseSha ? (
              <>
                <a href={`https://github.com/${task.repositoryFullName}/tree/${task.baseSha}`} target="_blank" rel="noreferrer">
                  <code>{shortSha(task.baseSha)}</code>
                </a>
                {analysis && <span className="muted"> on {analysis.branch}</span>}
              </>
            ) : (
              <span className="muted">not pinned yet</span>
            )}
          </dd>
          {task.branchName && (
            <>
              <dt>Branch</dt>
              <dd>
                <code>{task.branchName}</code>
              </dd>
            </>
          )}
          {task.pullRequest && (
            <>
              <dt>Pull request</dt>
              <dd>
                <a href={task.pullRequest.url} target="_blank" rel="noreferrer">
                  #{task.pullRequest.number}
                </a>{" "}
                <span className="muted">{task.pullRequest.status.toLowerCase()}</span>
              </dd>
            </>
          )}
          <dt>Model usage</dt>
          <dd>
            {formatTokens(task.usage.inputTokens)} in · {formatTokens(task.usage.outputTokens)} out · about {formatUsd(task.usage.estimatedCostUsd)}
          </dd>
          <dt>Plan approval</dt>
          <dd>{task.requirePlanApproval ? "required" : "automatic"}</dd>
        </dl>
      </section>

      {(currentPlan || task.status === "PLANNING") && (
        <section className="card" id="plan">
          <h2>Implementation plan</h2>
          {currentPlan ? (
            <>
              <PlanView summary={currentPlan} />
              {awaitingReview && <PlanReview taskId={task.id} version={currentPlan.version} canRevise={currentPlan.version < MAX_PLAN_VERSIONS} />}
              {earlierPlans.map((p) => (
                <details key={p.version} className="snippet">
                  <summary>Version {p.version}</summary>
                  <PlanView summary={p} />
                </details>
              ))}
            </>
          ) : (
            <p className="muted">The agent is writing a plan…</p>
          )}
        </section>
      )}

      {(task.pullRequest || task.status === "OPENING_PR") && (
        <section className="card" id="pull-request">
          <h2>Pull request</h2>
          {task.pullRequest ? <PullRequestView pr={task.pullRequest} /> : <p className="muted">Pushing the branch and opening the draft pull request…</p>}
        </section>
      )}

      {(shownPatch || task.status === "GENERATING_PATCH") && (
        <section className="card" id="patch">
          <h2>Patch</h2>
          {!shownPatch ? (
            <p className="muted">The agent is writing the patch…</p>
          ) : (
            <>
              {task.patches.length > 1 && (
                <nav className="tabs" aria-label="Patch versions">
                  {task.patches.map((p) => (
                    <Link
                      key={p.version}
                      href={`/tasks/${task.id}?patch=${p.version}#patch`}
                      aria-current={p.version === shownPatch.version ? "page" : undefined}
                      scroll={false}
                    >
                      v{p.version}
                      <span className="count muted">{p.status.toLowerCase()}</span>
                    </Link>
                  ))}
                </nav>
              )}
              <PatchView patch={shownPatch} />
              {patchDetail?.ok ? <DiffView diff={patchDetail.data.diff} /> : <p className="bad small">Could not load the diff.</p>}
            </>
          )}
        </section>
      )}

      {(task.checks.length > 0 || task.status === "RUNNING_CHECKS") && (
        <section className="card" id="checks">
          <h2>Checks</h2>
          {task.status === "RUNNING_CHECKS" && task.checks.at(-1)?.status !== "RUNNING" && <p className="muted">Starting the sandbox…</p>}
          {task.status === "REPAIRING" && <p className="muted">Checks failed; the agent is repairing the patch…</p>}
          {task.status === "READY_FOR_REVIEW" && (
            <p className="notice small">Checks passed on patch v{latestPatch?.version}. Passing checks are evidence, not proof: review the diff.</p>
          )}
          {task.status === "READY_FOR_REVIEW" && latestPatch?.status === "VERIFIED" && (
            <OpenPullRequestButton taskId={task.id} patchVersion={latestPatch.version} />
          )}
          {[...task.checks].reverse().map((run, i) =>
            i === 0 ? (
              <ChecksView key={run.id} run={run} />
            ) : (
              <details key={run.id} className="snippet">
                <summary>
                  Patch v{run.patchVersion ?? "?"} · {run.status.toLowerCase().replace("_", " ")}
                </summary>
                <ChecksView run={run} />
              </details>
            ),
          )}
        </section>
      )}

      <section className="card" id="log">
        <h2>Execution log</h2>
        <ExecutionLog events={task.events} />
      </section>

      {task.runs.length > 0 && (
        <section className="card" id="model-calls">
          <h2>Model calls</h2>
          <p className="muted small">
            {task.runs.length} calls · {formatTokens(task.usage.inputTokens)} input and {formatTokens(task.usage.outputTokens)} output tokens · about{" "}
            {formatUsd(task.usage.estimatedCostUsd)}
          </p>
          <ModelCalls runs={task.runs} />
        </section>
      )}

      {analysis && (
        <section className="card" id="analysis">
          <h2>Repository analysis</h2>
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
            <dt>Indexed</dt>
            <dd>
              {analysis.stats.indexedFiles} files ({Math.round(analysis.stats.indexedBytes / 1024)} KB)
              {analysis.stats.truncated && <span className="tag bad">truncated</span>}
            </dd>
          </dl>
          <h3 className="small">Relevant code</h3>
          <p className="muted small">
            {analysis.snippets.length} snippets · {analysis.budget.usedChars.toLocaleString()} of {analysis.budget.maxChars.toLocaleString()} characters
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
        </section>
      )}
    </>
  );
}
