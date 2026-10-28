# ADR 0003: GitHub-derived repository access and opaque sessions

- Status: Accepted
- Date: 2026-10-28

## Context

The original schema linked each `github_installations` row to one `user_id`. An organization installation is shared by many people with different permissions on different repositories, and the installation webhook's `sender` is not proof of who should see what.

## Decision

1. **Access is a user × repository relation (`repository_access`) derived only from the user's own GitHub token** at sign-in (`/user/installations`, `/user/installations/{id}/repositories`). Access not returned by GitHub is revoked in the same transaction.
2. **Webhooks never grant access.** They record installation and repository state, and only ever *remove* access.
3. `github_installations.user_id` is dropped. Repositories leaving an installation are soft-removed (`removed_at`), so task history survives.
4. **Explicit opt-in:** `repositories.enabled` defaults to false. Enabling requires WRITE or higher on GitHub.
5. **Opaque server-side sessions** instead of JWTs: a random 256-bit token in an `HttpOnly; SameSite=Lax` cookie, stored as SHA-256. Sessions are revocable on logout and by expiry.
6. **The GitHub user token is never persisted.** It lives only for the duration of the OAuth callback. Installation tokens are minted on demand and cached in memory only.
7. The dashboard proxies `/api` so the browser stays same-origin. This removes credentialed CORS from the browser path and lets `SameSite=Lax` block cross-site mutations.

## Consequences

- Permission changes on GitHub take effect at the user's next sign-in, and removals take effect immediately via webhook. Sessions are capped at `SESSION_TTL_HOURS` to bound staleness.
- No background job can act "as the user" on GitHub. Agent actions use the installation token, scoped to enabled repositories.
- Revoking a user's sessions is a single `UPDATE`.
