import type { TaskDetail } from "@codepilot/contracts";
import { formatDuration, formatTokens, humanize } from "@/lib/format";
import { describeEvent } from "@/lib/progress";

/** Everything that happened to the task, oldest first. Payloads are untrusted and rendered as text. */
export function ExecutionLog({ events }: { events: TaskDetail["events"] }) {
  return (
    <ol className="log">
      {events.map((event) => {
        const { title, detail, tone } = describeEvent(event);
        return (
          <li key={event.id} className={tone}>
            <time dateTime={event.createdAt} title={new Date(event.createdAt).toLocaleString()}>
              {new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </time>
            <span>
              <span className="title">{title}</span>
              {detail && <span className="detail">{detail}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Each model call: stage, model, outcome, tokens, and why it failed. */
export function ModelCalls({ runs }: { runs: TaskDetail["runs"] }) {
  return (
    <table className="table small">
      <thead>
        <tr>
          <th>#</th>
          <th>Stage</th>
          <th>Model</th>
          <th>Result</th>
          <th className="num">Time</th>
          <th className="num">Tokens in / out</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.attemptNumber}>
            <td>{r.attemptNumber}</td>
            <td>{humanize(r.stage)}</td>
            <td>{r.model}</td>
            <td>
              <span className={r.status === "FAILED" ? "bad" : r.status === "SUCCEEDED" ? "ok" : undefined}>{r.status.toLowerCase()}</span>
              {r.error && <div className="muted">{r.error}</div>}
            </td>
            <td className="num">{r.completedAt ? formatDuration(new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) : "running"}</td>
            <td className="num">
              {formatTokens(r.inputTokens)} / {formatTokens(r.outputTokens)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
