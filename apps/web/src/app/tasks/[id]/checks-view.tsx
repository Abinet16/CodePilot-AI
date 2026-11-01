import type { TestRunSummary } from "@codepilot/contracts";

const STATUS_CLASS: Record<TestRunSummary["status"], string | undefined> = {
  QUEUED: "muted",
  RUNNING: "muted",
  PASSED: "ok",
  FAILED: "bad",
  ERRORED: "bad",
  TIMED_OUT: "bad",
};

function label(status: TestRunSummary["status"]): string {
  return status.toLowerCase().replace("_", " ");
}

/** One verification of a patch. Check output is untrusted text, rendered as text only. */
export function ChecksView({ run }: { run: TestRunSummary }) {
  return (
    <div className="plan">
      <p className="muted small">
        Patch v{run.patchVersion ?? "?"} · <span className={STATUS_CLASS[run.status]}>{label(run.status)}</span> · {run.runnerImage}
        {run.completedAt && ` · ${new Date(run.completedAt).toLocaleTimeString()}`}
      </p>
      {run.error && <p className="notice bad small">{run.error}</p>}
      {run.results.length === 0 ? (
        <p className="muted small">{run.status === "RUNNING" ? "Running…" : "No checks ran."}</p>
      ) : (
        <table className="table small">
          <thead>
            <tr>
              <th>Check</th>
              <th>Command</th>
              <th>Result</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {run.results.map((r) => (
              <tr key={r.profileId}>
                <td>
                  {r.profileId} <span className="tag">{r.kind}</span>
                </td>
                <td>
                  <code>{r.command}</code>
                </td>
                <td className={STATUS_CLASS[r.status]}>
                  {label(r.status)}
                  {r.exitCode !== null && r.status !== "PASSED" && ` (exit ${r.exitCode})`}
                </td>
                <td>{(r.durationMs / 1000).toFixed(1)}s</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {run.results
        .filter((r) => r.output.trim() !== "")
        .map((r) => (
          <details key={r.profileId} className="snippet" open={r.status !== "PASSED"}>
            <summary>
              Output of <code>{r.profileId}</code>
              {r.outputTruncated && <span className="tag">truncated</span>}
            </summary>
            <pre>{r.output}</pre>
          </details>
        ))}
    </div>
  );
}
