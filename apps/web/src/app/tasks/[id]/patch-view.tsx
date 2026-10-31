import type { PatchSummary } from "@codepilot/contracts";

const STATUS_LABELS: Record<PatchSummary["status"], string> = {
  PROPOSED: "awaiting checks",
  VERIFIED: "checks passed",
  REJECTED: "rejected",
  SUPERSEDED: "superseded",
  SUBMITTED: "submitted",
};

/** What one patch attempt changed. The commit exists only in the worker's workspace until a PR is opened. */
export function PatchView({ patch }: { patch: PatchSummary }) {
  return (
    <div className="plan">
      <p className="muted small">
        Version {patch.version} · implements plan v{patch.planVersion} · {STATUS_LABELS[patch.status]} · {patch.model}
      </p>
      <p>
        <strong>{patch.commitMessage}</strong>
      </p>
      <p className="prewrap">{patch.summary}</p>
      <dl className="facts small">
        <dt>Branch</dt>
        <dd>
          <code>{patch.branchName}</code>
        </dd>
        <dt>Commit</dt>
        <dd>
          <code>{patch.commitSha.slice(0, 12)}</code> on <code>{patch.baseSha.slice(0, 12)}</code>
        </dd>
        <dt>Changes</dt>
        <dd>
          {patch.files.length} files · <span className="ok">+{patch.additions}</span> <span className="bad">−{patch.deletions}</span>
        </dd>
      </dl>
      <ul className="plan-files small">
        {patch.files.map((f) => (
          <li key={f.path}>
            <span className="tag">{f.change}</span> <code>{f.path}</code>{" "}
            <span className="muted">
              +{f.additions} −{f.deletions}
            </span>
          </li>
        ))}
      </ul>
      {patch.unchangedPlanFiles.length > 0 && (
        <p className="notice small">
          Planned but left unchanged: {patch.unchangedPlanFiles.map((p, i) => (
            <span key={p}>
              {i > 0 && ", "}
              <code>{p}</code>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
