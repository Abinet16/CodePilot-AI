# API endpoints

All routes are under `/api`. The browser reaches them through the dashboard origin (`WEB_ORIGIN/api/*`, proxied by Next.js), so cookies are first-party.

## Authentication

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/auth/github/login?returnTo=/path` | none | Sets a 10-minute `cp_oauth_state` cookie and redirects to GitHub. `returnTo` must be a same-origin path, otherwise `/` is used. |
| GET | `/auth/github/callback` | state cookie | Verifies `state`, exchanges the code, upserts the user, syncs repository access, sets `cp_session`, and redirects to `WEB_ORIGIN + returnTo`. `?error=` from GitHub redirects to `/?login=denied`. |
| POST | `/auth/logout` | optional | Revokes the session server-side and clears the cookie. `204`. |
| GET | `/auth/me` | session | `CurrentUser` |

Session cookie: `cp_session`, `HttpOnly`, `SameSite=Lax`, `Secure` when `WEB_ORIGIN` is https, expiring after `SESSION_TTL_HOURS`. Only its SHA-256 hash is stored.

## GitHub

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/github/install` | session | Redirects to the app's installation page on GitHub |
| GET | `/github/setup` | none | GitHub's post-install Setup URL. Ignores `installation_id` and re-runs login to re-sync access. |
| POST | `/github/webhooks` | HMAC signature | Verifies `X-Hub-Signature-256`, dedupes by `X-GitHub-Delivery`, and returns `{ "outcome": "processed" \| "ignored" \| "duplicate" }` |

Handled events: `ping`, `installation` (created, deleted, suspend, unsuspend), `installation_repositories` (added, removed), `issues` (all actions; pull requests ignored), `repository` (renamed, transferred, edited, privatized, publicized).

## Repositories

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/repositories` | session | `RepositorySummary[]` the user can access on GitHub |
| GET | `/repositories/:id/issues` | session | Open `IssueSummary[]` imported via webhooks (newest first, max 100). `404` without access. |
| PATCH | `/repositories/:id` | session, WRITE+ | Body `{ "enabled": boolean }` (strict). Returns `404` if the user has no access (existence is not revealed), `403` below WRITE, and `409` when enabling under an inactive installation. |

## Tasks

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/tasks` | session, WRITE+ | Body `{ repositoryId, issueId?, description?, requirePlanApproval? }` (strict; an issue or a description of 10+ characters is required). Creates a `QUEUED` task and enqueues `{ taskId }`. `404` without access or for an issue from another repository, `403` below WRITE, `409` if the repository is not enabled, its installation is inactive, or the issue is closed, `503` if the queue is unavailable (the task is marked `FAILED`). Returns `TaskDetail` (`201`). |
| GET | `/tasks?repositoryId=` | session | Newest 50 `TaskSummary[]` on repositories the user can access, optionally filtered |
| GET | `/tasks/:id` | session | `TaskDetail`: status, pinned `baseSha`, the `analysis` context package once ANALYZING completes, every plan version (`plans`, oldest first), model calls (`runs`), token and cost totals (`usage`), and the event history. A stored plan that no longer validates is returned with `plan: null`. `404` without access. |
| POST | `/tasks/:id/cancel` | session, WRITE+ | Compare-and-set to `CANCELLED` from any active status and drop waiting jobs; a running job notices within `CANCELLATION_POLL_MS` and aborts its model call. `409` if the task already finished or changed concurrently. |
| POST | `/tasks/:id/plan/approve` | session, WRITE+ | Body `{ "version": n }` (strict). Approves the plan awaiting review, moves the task `AWAITING_PLAN_APPROVAL → GENERATING_PATCH`, and enqueues it. `409` if the task is not awaiting approval or `n` is not the version under review (both checked with compare-and-set, so a second reviewer gets `409`), `503` if the queue is unavailable (the task is marked `FAILED`). Audited as `plan.approved`. |
| POST | `/tasks/:id/plan/request-changes` | session, WRITE+ | Body `{ "version": n, "feedback": string }` (strict, feedback 10–4000 characters). Marks the plan `CHANGES_REQUESTED`, moves the task back to `PLANNING`, and enqueues it; the worker writes version `n + 1` with the feedback. `409` as for approve, or when `n` is already the last allowed version (3). Audited as `plan.changes_requested`. |

A task the user cannot see is reported as `404`, exactly like a task that does not exist.

## Status codes

| Code | Meaning |
| --- | --- |
| 400 | Invalid body, UUID, OAuth state, or missing webhook headers |
| 403 | Authenticated, but below the GitHub permission the action needs |
| 404 | Not found, or not visible to this user |
| 409 | Conflicts with current state (repository disabled, installation inactive, task already finished, plan not under review, revision limit reached) |
| 401 | No/expired/revoked session, or bad webhook signature |
| 502 | GitHub API call failed during login |
| 503 | GitHub App not configured on this server (development only), or the task queue is unavailable |
