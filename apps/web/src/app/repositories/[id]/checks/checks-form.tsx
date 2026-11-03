"use client";

import type { CheckKind, RepositoryChecks, RepositoryChecksResponse } from "@codepilot/contracts";
import { useState } from "react";

interface Row {
  id: string;
  kind: CheckKind;
  command: string;
  timeoutMinutes: number;
}

interface FormState {
  install: { enabled: boolean; command: string; timeoutMinutes: number };
  checks: Row[];
}

const toCommand = (p: { executable: string; args: string[] }) => [p.executable, ...p.args].join(" ");
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

function toForm(config: RepositoryChecks | null): FormState {
  return {
    install: config?.install
      ? { enabled: true, command: toCommand(config.install), timeoutMinutes: minutes(config.install.timeoutMs) }
      : { enabled: false, command: "", timeoutMinutes: 10 },
    checks: (config?.checks ?? []).map((c) => ({ id: c.id, kind: c.kind, command: toCommand(c), timeoutMinutes: minutes(c.timeoutMs) })),
  };
}

/** Commands are split on whitespace and never passed to a shell, so quoting is not supported. */
function split(command: string): { executable: string; args: string[] } {
  const [executable = "", ...args] = command.trim().split(/\s+/);
  return { executable, args };
}

function toConfig(form: FormState): RepositoryChecks {
  return {
    install: form.install.enabled ? { id: "install", ...split(form.install.command), timeoutMs: form.install.timeoutMinutes * 60_000 } : null,
    checks: form.checks.map((c) => ({ id: c.id.trim(), kind: c.kind, ...split(c.command), timeoutMs: c.timeoutMinutes * 60_000 })),
  };
}

/** `kinds` comes from the server page, so this client bundle does not load @codepilot/contracts at runtime. */
export function ChecksForm({
  repositoryId,
  configured,
  suggested,
  canEdit,
  kinds,
}: {
  repositoryId: string;
  configured: RepositoryChecks | null;
  suggested: RepositoryChecks | null;
  canEdit: boolean;
  kinds: readonly CheckKind[];
}) {
  const [form, setForm] = useState<FormState>(toForm(configured));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const updateRow = (i: number, patch: Partial<Row>) => setForm((f) => ({ ...f, checks: f.checks.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  async function save() {
    setPending(true);
    setMessage(null);
    const res = await fetch(`/api/repositories/${repositoryId}/checks`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toConfig(form)),
    });
    if (res.ok) {
      setForm(toForm(((await res.json()) as RepositoryChecksResponse).configured));
      setMessage({ ok: true, text: "Saved. New verifications use these checks." });
    } else {
      const body = (await res.json().catch(() => null)) as { message?: string | string[] } | null;
      const detail = Array.isArray(body?.message) ? body.message.join("; ") : body?.message;
      setMessage({ ok: false, text: res.status === 403 ? "Needs maintain access" : (detail ?? "Save failed") });
    }
    setPending(false);
  }

  const disabled = !canEdit || pending;

  return (
    <div className="form">
      {suggested && canEdit && (
        <p className="small">
          <button className="button secondary" type="button" onClick={() => setForm(toForm(suggested))} disabled={disabled}>
            Use detected checks
          </button>{" "}
          <span className="muted">From the package.json scripts of the latest analyzed commit. Review them before saving.</span>
        </p>
      )}

      <h3 className="small">Install</h3>
      <label className="inline small">
        <input
          type="checkbox"
          checked={form.install.enabled}
          disabled={disabled}
          onChange={(e) => setForm((f) => ({ ...f, install: { ...f.install, enabled: e.target.checked } }))}
        />
        Install dependencies first (npm, pnpm, or yarn with --ignore-scripts)
      </label>
      {form.install.enabled && (
        <div className="check-row">
          <input
            value={form.install.command}
            disabled={disabled}
            placeholder="pnpm install --frozen-lockfile --ignore-scripts"
            onChange={(e) => setForm((f) => ({ ...f, install: { ...f.install, command: e.target.value } }))}
          />
          <input
            type="number"
            min={1}
            max={15}
            value={form.install.timeoutMinutes}
            disabled={disabled}
            aria-label="Install timeout in minutes"
            onChange={(e) => setForm((f) => ({ ...f, install: { ...f.install, timeoutMinutes: Number(e.target.value) } }))}
          />
          <span className="muted small">min</span>
        </div>
      )}

      <h3 className="small">Checks, in order</h3>
      {form.checks.length === 0 && <p className="muted small">No checks yet.</p>}
      {form.checks.map((row, i) => (
        <div key={i} className="check-row">
          <input value={row.id} disabled={disabled} aria-label="Check id" placeholder="test" onChange={(e) => updateRow(i, { id: e.target.value })} />
          <select value={row.kind} disabled={disabled} aria-label="Check kind" onChange={(e) => updateRow(i, { kind: e.target.value as CheckKind })}>
            {kinds.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
          <input value={row.command} disabled={disabled} aria-label="Command" placeholder="pnpm run test" onChange={(e) => updateRow(i, { command: e.target.value })} />
          <input
            type="number"
            min={1}
            max={15}
            value={row.timeoutMinutes}
            disabled={disabled}
            aria-label="Timeout in minutes"
            onChange={(e) => updateRow(i, { timeoutMinutes: Number(e.target.value) })}
          />
          <span className="muted small">min</span>
          {canEdit && (
            <button className="button secondary" type="button" disabled={disabled} onClick={() => setForm((f) => ({ ...f, checks: f.checks.filter((_, j) => j !== i) }))}>
              Remove
            </button>
          )}
        </div>
      ))}

      {canEdit && (
        <div className="toggle">
          <button
            className="button secondary"
            type="button"
            disabled={disabled || form.checks.length >= 10}
            onClick={() => setForm((f) => ({ ...f, checks: [...f.checks, { id: "", kind: "test", command: "", timeoutMinutes: 10 }] }))}
          >
            Add check
          </button>
          <button className="button" type="button" disabled={disabled || form.checks.length === 0} onClick={save}>
            {pending ? "Saving…" : "Save checks"}
          </button>
          {message && <span className={message.ok ? "ok small" : "bad small"}>{message.text}</span>}
        </div>
      )}
    </div>
  );
}
