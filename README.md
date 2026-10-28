# CodePilot AI

A repository-aware AI coding agent with controlled execution and human review. It takes a GitHub issue to a tested, reviewable **draft** pull request, and it never merges or deploys on its own.

```
issue → analyze repo (pinned SHA) → structured plan → [human approves] → patch in isolated workspace
      → sandboxed checks → bounded repair → [human reviews diff] → draft PR with test evidence
```

## Status

| Release | Outcome | State |
| --- | --- | --- |
| Week 1 | Monorepo, schema, state machine, safety policies, CI | ✅ done |
| Week 2 | GitHub sign-in, GitHub App, webhooks, repository access, audit log | ✅ done |
| `v0.1` | Secure GitHub connection and repository analysis | ⏳ week 3 |
| `v0.2` | Structured plans and patch generation | ⏳ weeks 4–5 |
| `v0.3` | Sandboxed tests and bounded repair loop | ⏳ week 6 |
| `v0.4` | Automated draft pull requests | ⏳ week 7 |
| `v1.0` | Deployed, evaluated, documented product | ⏳ weeks 8–10 |

## Repository layout

```
apps/web               Next.js dashboard
apps/api               NestJS REST API (auth, GitHub App, webhooks, tasks)
apps/worker            BullMQ consumer that drives the agent state machine
packages/contracts     Task statuses + transitions, plan schema, queue payloads (zod)
packages/agent-core    Path, command, and repair policies for untrusted model output
packages/config        Shared tsconfig and Jest preset
services/sandbox-runner  Isolated execution of configured check commands (week 6)
prisma/                Schema and migrations
docs/                  Architecture, data model, threat model, ADRs
```

## Getting started

Requirements: Node 22+, pnpm 11, Docker.

```bash
cp .env.example .env
pnpm setup              # install, generate Prisma client, build shared packages
pnpm infra:up           # PostgreSQL 16 + Redis 7
pnpm db:deploy          # apply migrations
pnpm dev                # web :3000, api :4000/api, worker
```

Check `http://localhost:4000/api/health`, or open `http://localhost:3000` to see system status.

To sign in and connect repositories, create a GitHub App first: see [docs/api/github-app-setup.md](docs/api/github-app-setup.md). Without one, GitHub routes return `503` in development. Endpoints are listed in [docs/api/endpoints.md](docs/api/endpoints.md).

## Quality gates

```bash
pnpm lint
pnpm typecheck
pnpm test               # unit tests (no infrastructure needed)
pnpm test:integration   # needs PostgreSQL from `pnpm infra:up`
```

CI (`.github/workflows/ci.yml`) runs all of the above, plus a schema-drift check and `pnpm audit`.

## Safety principles

- Repository access comes only from GitHub, checked with the user's own token at sign-in. Webhooks can revoke access but never grant it.
- The model never chooses shell commands or raw file paths unchecked. It picks a **command profile id**, and every proposed path is normalized and symlink-checked against the workspace.
- Secrets, `.git`, and CI workflow files are not writable by the agent.
- Queue jobs carry identifiers only. Credentials are minted on demand and never persisted.
- Every state transition is a compare-and-set with an audit event; retries resume rather than duplicate.
- Draft PRs only. Unexecuted tests are never reported as passing.

See [docs/architecture/overview.md](docs/architecture/overview.md) and [docs/security/threat-model.md](docs/security/threat-model.md).
