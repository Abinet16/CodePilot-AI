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
| Hostile repository runs code during clone (hooks, filters, fsmonitor, submodules) | Fresh `git init --template=`, `core.hooksPath=/dev/null`, `core.fsmonitor=false`, no submodules, no user/system git config; analysis never executes repository code | `worker/analysis/git.ts` | ✅ tested |
| Repository symlink exfiltrates host files into the index | `core.symlinks=false` on checkout; walker uses `lstat`/`Dirent` and skips non-regular files; files opened with `O_NOFOLLOW`; workspace removal never follows links | `worker/analysis/{git,scan,workspace}.ts` | ✅ tested |
| Secrets in a repository end up in the database or model context | Secret files (`.env*`, keys, `.npmrc`, `.netrc`, …) are rejected by path before being opened; lockfiles, generated, binary, and minified files are skipped | `agent-core/analysis/file-filter.ts` | ✅ integration-tested |
| Installation token leaks via git | Token passed as a github.com-scoped `http.extraHeader` through `GIT_CONFIG_*` env vars: never in argv, the remote URL, `.git/config`, or logs; git gets a minimal environment | `worker/analysis/git.ts` | ✅ tested |
| Non-https remote or option injection through repo names | Owner, name, and branch validated against GitHub's character rules; `protocol.allow=never` except https; `--` before the remote | `github/app-client.ts`, `worker/analysis/git.ts` | ✅ tested |
| Huge or adversarial repository exhausts the worker | Size check before clone, shallow single-commit fetch, git timeout, caps on walked entries, indexed files, bytes, file size, and line length; stale workspaces swept at boot | `worker/analysis`, `agent-core/analysis` | ✅ tested |
| Analysis of a different commit than the one reported | SHA pinned once per task (compare-and-set), fetched by SHA, and `HEAD` verified after checkout | `worker/analysis/{analyze-stage,git}.ts` | ✅ integration-tested |
| Unbounded or malformed context reaches planning | Character, snippet, and per-file budgets; package validated by `ContextPackageSchema` on write and read; snippets rendered as text in the UI | `agent-core/analysis/context-builder.ts`, `api/tasks` | ✅ tested |
| Full-text query injection | Query terms reduced to `[a-z0-9]+` before `to_tsquery`, and passed as bound parameters | `agent-core/analysis/search-terms.ts`, `worker/analysis/retriever.ts` | ✅ tested |
| Task started or cancelled by a read-only collaborator | WRITE+ required to create or cancel; visibility through `repository_access`; unknown and forbidden tasks both 404 | `api/tasks` | ✅ integration-tested |
| Duplicate PR on retry | `idempotency_keys` around push and PR creation | schema | ⏳ week 7 |
| Credentials leak into queue payloads or logs | Jobs carry ids only; GitHub user token never persisted; installation tokens in memory only; audit metadata redacted (sensitive keys and token patterns) | `contracts/queue.ts`, `api/audit/redact.ts` | ✅ tested |
| Install scripts exfiltrate secrets / reach network | Sandbox: no credentials, no Docker socket, network off by default, non-root, CPU/mem/disk/time limits | `services/sandbox-runner` | ⏳ week 6 |
| Prompt injection in repo files or issue bodies | Delimited untrusted context, no tool that can act outside policy, model cannot choose commands or paths unchecked. Analysis only uses this text as search terms. | worker | ⏳ week 4 |
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
