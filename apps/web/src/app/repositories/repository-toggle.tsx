"use client";

import type { RepositorySummary } from "@codepilot/contracts";
import { MIN_PERMISSION_TO_ENABLE, hasPermission } from "@codepilot/contracts";
import { useState } from "react";

export function RepositoryToggle({ repository }: { repository: RepositorySummary }) {
  const [enabled, setEnabled] = useState(repository.enabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canChange = hasPermission(repository.permission, MIN_PERMISSION_TO_ENABLE) && repository.installationStatus === "ACTIVE";

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
      <button
        className={enabled ? "button" : "button secondary"}
        disabled={!canChange || pending}
        title={canChange ? undefined : `Requires ${MIN_PERMISSION_TO_ENABLE.toLowerCase()} access and an active installation`}
        onClick={toggle}
      >
        {enabled ? "Enabled" : "Disabled"}
      </button>
      {error && <span className="bad small">{error}</span>}
    </span>
  );
}
