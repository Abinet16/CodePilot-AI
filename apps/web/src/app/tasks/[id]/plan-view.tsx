import type { PlanSummary } from "@codepilot/contracts";

const STATUS_LABELS: Record<PlanSummary["status"], string> = {
  PROPOSED: "awaiting review",
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
};

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <h3 className="small">{title}</h3>
      <ul className="small">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </>
  );
}

/** One plan version. Model output is rendered as text only, never as HTML. */
export function PlanView({ summary }: { summary: PlanSummary }) {
  const plan = summary.plan;
  return (
    <div className="plan">
      <p className="muted small">
        Version {summary.version} · <span className={summary.status === "APPROVED" ? "ok" : undefined}>{STATUS_LABELS[summary.status]}</span> ·{" "}
        {summary.model}
        {summary.reviewedBy && ` · reviewed by ${summary.reviewedBy}`}
      </p>
      {!plan ? (
        <p className="bad small">This plan no longer passes validation and is not shown.</p>
      ) : (
        <>
          <p className="prewrap">{plan.summary}</p>
          <h3 className="small">Files</h3>
          <ul className="plan-files small">
            {plan.affectedFiles.map((f) => (
              <li key={f.path}>
                <span className="tag">{f.change}</span> <code>{f.path}</code>
                <span className="muted"> — {f.reason}</span>
              </li>
            ))}
          </ul>
          <h3 className="small">Steps</h3>
          <ol className="small">
            {plan.implementationSteps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          <List title="Verification" items={plan.testPlan} />
          <List title="Assumptions" items={plan.assumptions} />
          <List title="Risks" items={plan.risks} />
        </>
      )}
      {summary.feedback && (
        <p className="notice small">
          <strong>Reviewer feedback:</strong> <span className="prewrap">{summary.feedback}</span>
        </p>
      )}
    </div>
  );
}
