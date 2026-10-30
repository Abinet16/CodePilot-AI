"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const ERRORS: Record<number, string> = {
  400: "Feedback must be at least 10 characters",
  403: "Needs write access",
  409: "The plan changed; reload to see the latest version",
  503: "The task queue is unavailable; try again",
};

/** Approve the plan awaiting review, or send it back with feedback. Both name the version shown. */
export function PlanReview({ taskId, version, canRevise }: { taskId: string; version: number; canRevise: boolean }) {
  const router = useRouter();
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState<"approve" | "revise" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(action: "approve" | "revise") {
    setPending(action);
    setError(null);
    const path = action === "approve" ? "approve" : "request-changes";
    const body = action === "approve" ? { version } : { version, feedback };
    const res = await fetch(`/api/tasks/${taskId}/plan/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setFeedback("");
      router.refresh();
    } else {
      setError(ERRORS[res.status] ?? "Request failed");
    }
    setPending(null);
  }

  return (
    <div className="review">
      <div className="toggle">
        <button className="button" onClick={() => submit("approve")} disabled={pending !== null}>
          {pending === "approve" ? "Approving…" : `Approve plan v${version}`}
        </button>
        {error && <span className="bad small">{error}</span>}
      </div>
      {canRevise ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit("revise");
          }}
        >
          <label>
            Or request changes
            <textarea
              rows={3}
              maxLength={4000}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="What should the next version do differently?"
            />
          </label>
          <div>
            <button className="button secondary" type="submit" disabled={pending !== null || feedback.trim().length < 10}>
              {pending === "revise" ? "Sending…" : "Request changes"}
            </button>
          </div>
        </form>
      ) : (
        <p className="muted small">This is the last revision allowed. Approve it, or cancel the task.</p>
      )}
    </div>
  );
}
