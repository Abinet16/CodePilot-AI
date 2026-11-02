"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const ERRORS: Record<number, string> = {
  403: "Needs write access",
  409: "The task or patch changed; reload to see the latest",
  503: "The task queue is unavailable; try again",
};

/** The human gate before anything is pushed: names the verified patch version the reviewer read. */
export function OpenPullRequestButton({ taskId, patchVersion }: { taskId: string; patchVersion: number }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setPending(true);
    setError(null);
    const res = await fetch(`/api/tasks/${taskId}/pull-request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ patchVersion }),
    });
    if (res.ok) router.refresh();
    else setError(ERRORS[res.status] ?? "Request failed");
    setPending(false);
  }

  return (
    <div className="review">
      <p className="small">
        Opening a pull request pushes patch v{patchVersion} to its <code>codepilot/</code> branch and opens it as a <strong>draft</strong>. Nothing is
        merged; a person decides that on GitHub.
      </p>
      <div className="toggle">
        <button className="button" onClick={open} disabled={pending}>
          {pending ? "Opening…" : `Open draft PR for patch v${patchVersion}`}
        </button>
        {error && <span className="bad small">{error}</span>}
      </div>
    </div>
  );
}
