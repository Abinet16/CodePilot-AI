import type { HealthResponse } from "@codepilot/contracts";
import { TaskStatus } from "@codepilot/contracts";

export const dynamic = "force-dynamic";

const API_URL = process.env.API_URL ?? "http://localhost:4000/api";

async function fetchHealth(): Promise<HealthResponse | null> {
  try {
    const res = await fetch(`${API_URL}/health`, { cache: "no-store" });
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const health = await fetchHealth();

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 16px" }}>
      <h1 style={{ marginBottom: 4 }}>CodePilot AI</h1>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        Issue → plan → patch → verified checks → draft pull request, with a human approving every step that matters.
      </p>

      <section style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 16, marginTop: 32 }}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>System status</h2>
        {health ? (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {Object.entries(health.checks).map(([name, state]) => (
              <li key={name}>
                {name}: <strong style={{ color: state === "ok" ? "var(--ok)" : "var(--bad)" }}>{state}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ margin: 0, color: "var(--bad)" }}>API unreachable at {API_URL}</p>
        )}
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 16 }}>Task lifecycle</h2>
        <code style={{ fontSize: 13, color: "var(--muted)", wordBreak: "break-word" }}>
          {Object.values(TaskStatus).join(" · ")}
        </code>
      </section>
    </main>
  );
}
