import type { PullRequestSummary } from "@codepilot/contracts";

const STATUS: Record<PullRequestSummary["status"], { label: string; className?: string }> = {
  DRAFT: { label: "draft" },
  OPEN: { label: "open", className: "ok" },
  MERGED: { label: "merged", className: "ok" },
  CLOSED: { label: "closed", className: "bad" },
};

export function PullRequestView({ pr }: { pr: PullRequestSummary }) {
  const status = STATUS[pr.status];
  return (
    <div className="plan">
      <p>
        <a href={pr.url} target="_blank" rel="noreferrer">
          Pull request #{pr.number}
        </a>{" "}
        · <span className={status.className}>{status.label}</span>
      </p>
      <dl className="facts small">
        <dt>Branch</dt>
        <dd>
          <code>{pr.branchName}</code> → <code>{pr.baseBranch}</code>
        </dd>
        <dt>Head</dt>
        <dd>
          <code>{pr.headSha.slice(0, 12)}</code>
          {pr.patchVersion !== null && <span className="muted"> (patch v{pr.patchVersion})</span>}
        </dd>
        {pr.mergedAt && (
          <>
            <dt>Merged</dt>
            <dd>{new Date(pr.mergedAt).toLocaleString()}</dd>
          </>
        )}
        {!pr.mergedAt && pr.closedAt && (
          <>
            <dt>Closed</dt>
            <dd>{new Date(pr.closedAt).toLocaleString()}</dd>
          </>
        )}
        <dt>Synced</dt>
        <dd>{pr.lastSyncedAt ? new Date(pr.lastSyncedAt).toLocaleString() : "not yet"}</dd>
      </dl>
    </div>
  );
}
