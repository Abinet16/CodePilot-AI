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
| PATCH | `/repositories/:id` | session, WRITE+ | Body `{ "enabled": boolean }` (strict). Returns `404` if the user has no access (existence is not revealed), `403` below WRITE, and `409` when enabling under an inactive installation. |

## Status codes

| Code | Meaning |
| --- | --- |
| 400 | Invalid body, UUID, OAuth state, or missing webhook headers |
| 401 | No/expired/revoked session, or bad webhook signature |
| 502 | GitHub API call failed during login |
| 503 | GitHub App not configured on this server (development only) |
