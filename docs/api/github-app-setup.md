# GitHub App setup

CodePilot AI uses a GitHub App, not personal access tokens. Create one at **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App** (or under an organization's settings).

## App settings

| Field | Local development value |
| --- | --- |
| Homepage URL | `http://localhost:3000` |
| Callback URL | `http://localhost:3000/api/auth/github/callback` |
| Expire user authorization tokens | ✅ on |
| Request user authorization (OAuth) during installation | ❌ off (the Setup URL re-runs login instead) |
| Setup URL | `http://localhost:3000/api/github/setup` |
| Redirect on update | ✅ on |
| Webhook → Active | ✅ on |
| Webhook URL | a public tunnel to `http://localhost:4000/api/github/webhooks` (see below) |
| Webhook secret | a long random string, e.g. `openssl rand -hex 32` |
| Where can this app be installed? | Only on this account (until you are ready for others) |

### Permissions (least privilege, by milestone)

| Permission | Access | Needed from |
| --- | --- | --- |
| Metadata | Read | Week 2 (mandatory) |
| Contents | Read | Week 3 (clone and analyze) |
| Issues | Read | Week 2 (issue ingestion) |
| Contents | **Read & write** | Week 7 (push task branches) |
| Pull requests | Read & write | Week 7 (open draft PRs) |

Grant only what the current milestone needs. Each permission increase makes installers re-approve, which is the point.

### Webhook events

`Installation` and `Installation repositories` are delivered automatically. Also subscribe to **Issues** and **Repository**.

## Local configuration

1. Generate a private key on the app page and save it outside the repository, e.g. `~/.config/codepilot/app.pem` (`chmod 600`).
2. Fill in `.env`:

   ```bash
   GITHUB_APP_ID=123456
   GITHUB_APP_SLUG=your-app-slug          # from https://github.com/apps/<slug>
   GITHUB_APP_PRIVATE_KEY_PATH=/Users/you/.config/codepilot/app.pem
   GITHUB_CLIENT_ID=Iv23li...
   GITHUB_CLIENT_SECRET=...
   GITHUB_WEBHOOK_SECRET=...
   ```

3. Forward webhooks to your machine, for example with [smee.io](https://smee.io):

   ```bash
   npx smee-client --url https://smee.io/<channel> --target http://localhost:4000/api/github/webhooks
   ```

   The API verifies `X-Hub-Signature-256` over the raw body. Proxies that re-encode the body break signatures, and `smee-client` forwards it unchanged.

4. `pnpm dev`, open `http://localhost:3000`, sign in, then **Add repositories on GitHub**.

## How access is decided

- Signing in exchanges the OAuth code for a short-lived **user token**, used once to list `GET /user/installations` and `GET /user/installations/{id}/repositories`, then discarded.
- A user sees a repository only if GitHub returned it for **their** token, with the permission GitHub reported. Anything GitHub no longer returns is revoked at the next sign-in.
- Webhooks only record GitHub state and **remove** access (repository removed, app uninstalled). They never grant access.
- The agent works on a repository only after a user with **write** permission or higher enables it.
