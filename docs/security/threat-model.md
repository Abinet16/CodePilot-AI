# Threat model

Everything that comes from a repository (source, comments, README, config, test output) and every GitHub issue body is **untrusted input**. Model output derived from it is also untrusted.

| Threat | Control | Where | Status |
| --- | --- | --- | --- |
| Model writes outside the workspace (`../`, absolute paths) | Path normalization + traversal rejection | `agent-core/path-policy.ts` | ✅ tested |
| Symlink planted in repo redirects a write outside the workspace | `realpath` of deepest existing ancestor must stay in workspace | `agent-core/path-policy.ts` | ✅ tested |
| Model edits secrets, `.git`, CI workflows | Denied segments, basenames, and prefixes | `agent-core/path-policy.ts` | ✅ tested |
| Model runs arbitrary shell commands | Model picks a **profile id** only; profiles are human-configured, executable allowlisted, args checked for shell metacharacters, run via `execFile` | `agent-core/command-policy.ts` | ✅ tested (execution in week 6) |
| Infinite repair loop burns tokens/compute | Bounded repair budget; safety violations fail immediately | `agent-core/repair-policy.ts` | ✅ tested |
| Concurrent workers / cancel race corrupt state | Compare-and-set transitions in a transaction | `worker/task-state.ts` | ✅ integration-tested |
| Duplicate job delivery duplicates work | `jobId = taskId`; pipeline resumes from persisted status | `worker` | ✅ smoke-tested |
| Forged webhook | HMAC-SHA256 over raw body, constant-time compare, verified before parsing | `api/github/webhooks.controller.ts` | ✅ integration-tested |
| Duplicate webhook delivery creates duplicate records | Delivery row inserted in the same transaction as its effects; PK conflict ⇒ `duplicate` | `api/github/webhook.service.ts` | ✅ tested with 5 concurrent deliveries |
| Duplicate PR on retry | `idempotency_keys` around push and PR creation | schema | ⏳ week 7 |
| Credentials leak into queue payloads or logs | Jobs carry ids only; GitHub user token never persisted; installation tokens in memory only; audit metadata redacted (sensitive keys and token patterns) | `contracts/queue.ts`, `api/audit/redact.ts` | ✅ tested |
| Install scripts exfiltrate secrets / reach network | Sandbox: no credentials, no Docker socket, network off by default, non-root, CPU/mem/disk/time limits | `services/sandbox-runner` | ⏳ week 6 |
| Prompt injection in repo files or issue bodies | Delimited untrusted context, no tool that can act outside policy, model cannot choose commands or paths unchecked | worker | ⏳ week 4 |
| Cross-tenant repository access | Access derived only from the user's own GitHub token; every query scoped through `repository_access`; unknown and forbidden look identical (404) | `api/repositories` | ✅ integration-tested |
| Stale access after GitHub revocation | Missing grants deleted at each sign-in; removal and uninstall webhooks revoke immediately | `api/github` | ✅ integration-tested |
| Webhook used to grant access | Webhooks only record state and remove access | `api/github/webhook.service.ts` | ✅ by design + tested |
| Login CSRF / OAuth code injection | Random `state` bound to an HttpOnly cookie, constant-time compare | `api/auth` | ✅ integration-tested |
| Open redirect after login | `returnTo` restricted to same-origin paths; re-sanitized on decode | `api/auth/oauth-state.ts` | ✅ tested |
| Session theft from DB leak | Only SHA-256 of session tokens stored; sessions revocable and expiring | `api/auth/session.service.ts` | ✅ integration-tested |
| Cross-site mutation (CSRF) | Same-origin `/api` proxy, `SameSite=Lax` cookie, JSON-only bodies | web + api | ✅ by design |
| Setup URL `installation_id` spoofing | Parameter ignored; access re-derived via login | `api/github/github.controller.ts` | ✅ tested |
| Bearer token sent to another host via pagination | `Link: rel=next` followed only to `https://api.github.com/` | `api/github/github.client.ts` | ✅ tested |

> A standard Docker container is not a complete security boundary for hostile code. For public multi-user access the sandbox must use a hardened runtime (gVisor, Firecracker, or a dedicated isolated worker pool).
