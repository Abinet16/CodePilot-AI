"use client";

import type { IssueSummary, RepositorySummary, TaskDetail } from "@codepilot/contracts";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

interface Props {
  repositories: RepositorySummary[];
  selectedId: string;
  issues: IssueSummary[];
}

export function NewTaskForm({ repositories, selectedId, issues }: Props) {
  const router = useRouter();
  const [issueId, setIssueId] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositoryId: selectedId,
        ...(issueId ? { issueId } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    });
    if (res.ok) {
      router.push(`/tasks/${((await res.json()) as TaskDetail).id}`);
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { message?: string; issues?: Array<{ message: string }> };
    setError(body.issues?.[0]?.message ?? body.message ?? "Could not create the task");
    setPending(false);
  }

  return (
    <form className="card form" onSubmit={submit}>
      <label>
        Repository
        <select value={selectedId} onChange={(e) => router.push(`/tasks/new?repositoryId=${e.target.value}`)}>
          {repositories.map((r) => (
            <option key={r.id} value={r.id}>
              {r.fullName}
            </option>
          ))}
        </select>
      </label>

      <label>
        Issue <span className="muted small">(optional)</span>
        <select value={issueId} onChange={(e) => setIssueId(e.target.value)}>
          <option value="">No issue: describe the task below</option>
          {issues.map((i) => (
            <option key={i.id} value={i.id}>
              #{i.number} {i.title}
            </option>
          ))}
        </select>
      </label>

      <label>
        Description {issueId && <span className="muted small">(optional with an issue)</span>}
        <textarea
          rows={6}
          maxLength={10_000}
          value={description}
          placeholder="What should change? Mention files or functions if you know them, e.g. `paginate` in src/pagination.ts"
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      {error && <p className="bad small">{error}</p>}
      <div>
        <button className="button" type="submit" disabled={pending || (!issueId && description.trim().length < 10)}>
          {pending ? "Starting…" : "Start task"}
        </button>
      </div>
    </form>
  );
}
