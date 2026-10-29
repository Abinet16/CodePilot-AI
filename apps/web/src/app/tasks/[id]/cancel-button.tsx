"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function CancelButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    if (!window.confirm("Cancel this task?")) return;
    setPending(true);
    setError(null);
    const res = await fetch(`/api/tasks/${taskId}/cancel`, { method: "POST" });
    if (res.ok) router.refresh();
    else setError(res.status === 403 ? "Needs write access" : res.status === 409 ? "Task already finished" : "Cancel failed");
    setPending(false);
  }

  return (
    <span className="toggle">
      <button className="button secondary" onClick={cancel} disabled={pending}>
        {pending ? "Cancelling…" : "Cancel task"}
      </button>
      {error && <span className="bad small">{error}</span>}
    </span>
  );
}
