import type { HealthResponse } from "@codepilot/contracts";
import { TaskStatus } from "@codepilot/contracts";
import { apiGet } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function HomePage({ searchParams }: { searchParams: Promise<{ login?: string }> }) {
  const [{ login }, health] = await Promise.all([searchParams, apiGet<HealthResponse>("/health")]);

  return (
    <>
      <h1>CodePilot AI</h1>
      <p className="muted">
        Issue → plan → patch → verified checks → draft pull request, with a human approving every step that matters.
      </p>

      {login === "denied" && <p className="notice">GitHub sign-in was cancelled.</p>}

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

      <section>
        <h2>Task lifecycle</h2>
        <code className="muted small">{Object.values(TaskStatus).join(" · ")}</code>
      </section>
    </>
  );
}
