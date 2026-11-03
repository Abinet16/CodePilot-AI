import type { UsageReport, UsageTotalsByKey } from "@codepilot/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { formatTokens, formatUsd } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Usage" };

const WINDOWS = [7, 30, 90] as const;

export default async function UsagePage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { days: requested } = await searchParams;
  const days = WINDOWS.find((d) => String(d) === requested) ?? 30;
  const result = await apiGet<UsageReport>(`/usage?days=${days}`);
  if (!result.ok && result.status === 401) redirect("/api/auth/github/login?returnTo=/usage");
  if (!result.ok) return <p className="bad">Could not load usage.</p>;

  const report = result.data;
  const { totals } = report;
  // Cost when there is any, so the chart shows spend; tokens for free providers such as Ollama.
  const byCost = totals.estimatedCostUsd > 0;
  const value = (d: UsageTotalsByKey) => (byCost ? d.estimatedCostUsd : d.inputTokens + d.outputTokens);
  const peak = Math.max(...report.daily.map(value), 0);

  return (
    <>
      <h1>Usage</h1>
      <p className="muted">
        Model calls made for tasks you started. Costs are estimates at list price; free tiers and local models are not billed.
      </p>

      <nav className="tabs" aria-label="Time window">
        {WINDOWS.map((d) => (
          <Link key={d} href={`/usage?days=${d}`} aria-current={d === days ? "page" : undefined}>
            Last {d} days
          </Link>
        ))}
      </nav>

      <div className="stats">
        <div className="stat">
          <strong>{formatUsd(totals.estimatedCostUsd)}</strong>
          <span>estimated cost</span>
        </div>
        <div className="stat">
          <strong>{formatTokens(totals.inputTokens)}</strong>
          <span>input tokens</span>
        </div>
        <div className="stat">
          <strong>{formatTokens(totals.outputTokens)}</strong>
          <span>output tokens</span>
        </div>
        <div className="stat">
          <strong>{totals.calls.toLocaleString()}</strong>
          <span>model calls</span>
        </div>
      </div>

      <section className="card">
        <h2>{byCost ? "Cost per day" : "Tokens per day"}</h2>
        {totals.calls === 0 ? (
          <p className="empty">No model calls in this window.</p>
        ) : (
          <>
            <div className="bars" role="img" aria-label={`${byCost ? "Cost" : "Tokens"} per day over the last ${days} days`}>
              {report.daily.map((d) => {
                const v = value(d);
                const label = `${d.key}: ${byCost ? formatUsd(d.estimatedCostUsd) : `${formatTokens(v)} tokens`}, ${d.calls} calls`;
                return <div key={d.key} title={label} data-empty={v === 0} style={{ height: `${peak > 0 ? Math.max(2, (v / peak) * 100) : 2}%` }} />;
              })}
            </div>
            <div className="bar-axis">
              <span>{report.daily[0]?.key}</span>
              <span>{report.daily.at(-1)?.key}</span>
            </div>
          </>
        )}
      </section>

      <div className="grid-2">
        <Breakdown title="By model" rows={report.byModel} />
        <Breakdown title="By provider" rows={report.byProvider} />
      </div>
      <Breakdown title="By repository" rows={report.byRepository} />
    </>
  );
}

function Breakdown({ title, rows }: { title: string; rows: UsageTotalsByKey[] }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="empty">Nothing yet.</p>
      ) : (
        <table className="table small">
          <thead>
            <tr>
              <th>{title.replace("By ", "")}</th>
              <th className="num">Calls</th>
              <th className="num">Tokens</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{r.key}</td>
                <td className="num">{r.calls.toLocaleString()}</td>
                <td className="num">{formatTokens(r.inputTokens + r.outputTokens)}</td>
                <td className="num">{formatUsd(r.estimatedCostUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
