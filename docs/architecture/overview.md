# Architecture overview

CodePilot AI is a **modular monolith API** plus a **separate worker** for long-running agent jobs, with untrusted code execution pushed into an **isolated sandbox runner**.

```
 Browser ──HTTPS──▶ apps/web (Next.js)
                        │ REST
                        ▼
                  apps/api (NestJS) ──────────────▶ GitHub API (App installation tokens)
                   │          │  ▲ webhooks (signature-verified, deduped by delivery id)
          Prisma   │          │ BullMQ: { taskId } only
                   ▼          ▼
              PostgreSQL     Redis
                   ▲          │
                   │          ▼
                  apps/worker (agent orchestration)
                   │   │
                   │   └──▶ LLM provider (planning, patching, explanations)
                   ▼
         services/sandbox-runner (ephemeral container per check run;
         no DB creds, no GitHub creds, no Docker socket, restricted network)
```

## Boundaries

| Component | Owns | Must never |
| --- | --- | --- |
| `apps/web` | UI, plan/diff review, approvals | Hold GitHub tokens or call the LLM |
| `apps/api` | Auth, GitHub App, webhooks, task CRUD, approvals, audit | Run repository code or long agent work in the request path |
| `apps/worker` | State machine execution, context retrieval, LLM calls, git operations | Execute repository code directly (delegates to sandbox) |
| `services/sandbox-runner` | Running configured command profiles in a disposable container | Receive credentials, the DB URL, or arbitrary commands |
| `packages/contracts` | Task statuses, transitions, plan schema, queue payloads | Depend on any runtime service |
| `packages/agent-core` | Path, command, and repair policies; tool interfaces | Perform I/O beyond the workspace path checks |

## Task execution model

- The API inserts an `agent_tasks` row in `QUEUED` and enqueues `{ taskId }` with `jobId = taskId` (duplicate enqueues collapse).
- The worker loads the **persisted** status and drives the pipeline forward one stage at a time (`apps/worker/src/pipeline.ts`).
- Each transition is a compare-and-set (`UPDATE … WHERE status = :from`) plus a `task_events` row in a single transaction (`apps/worker/src/task-state.ts`). A cancel racing a worker, or two workers racing each other, cannot both win.
- The pipeline stops at human gates (`AWAITING_PLAN_APPROVAL`, `READY_FOR_REVIEW`). An approval in the API re-enqueues the task.
- External side effects (push, PR creation) are wrapped in `idempotency_keys` so a retry after a crash returns the original result instead of opening a second PR.

See [state-machine.md](./state-machine.md) and [data-model.md](./data-model.md).
