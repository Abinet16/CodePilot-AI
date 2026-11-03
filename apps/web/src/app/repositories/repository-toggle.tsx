"use client";

import type { RepositorySummary } from "@codepilot/contracts";
import { useState } from "react";

/**
 * Enables or disables the agent on a repository. Whether the user may change
 * it is decided by the server page and passed in, so this client bundle does
 * not load @codepilot/contracts (and zod) at runtime.
 */
export function RepositoryToggle({ repository, canChange, reason }: { repository: RepositorySummary; canChange: boolean; reason?: string }) {
  const [enabled, setEnabled] = useState(repository.enabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setPending(true);
    setError(null);
    const res = await fetch(`/api/repositories/${repository.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !enabled }),
    });
    if (res.ok) {
      setEnabled(((await res.json()) as RepositorySummary).enabled);
    } else {
      setError(res.status === 403 ? "Needs write access" : "Update failed");
    }
    setPending(false);
  }

  return (
    <span className="toggle">
      <button className={enabled ? "button" : "button secondary"} disabled={!canChange || pending} title={canChange ? undefined : reason} onClick={toggle}>
        {enabled ? "Enabled" : "Disabled"}
      </button>
      {error && <span className="bad small">{error}</span>}
    </span>
  );
}
