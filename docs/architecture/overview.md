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
| `packages/agent-core` | Path, command, and repair policies; file filtering, project detection, symbol extraction, chunking, context budgeting; planning prompt, output schema, plan validation, model pricing | Perform I/O beyond the workspace path checks |
| `packages/github` | GitHub App JWT, installation tokens, installation-scoped REST calls (shared by API and worker) | Persist or log tokens |

## Task execution model

- The API inserts an `agent_tasks` row in `QUEUED` and enqueues `{ taskId }` with job id `<taskId>_start`. Each human resume gets its own deterministic id (`<taskId>_plan-v2-approved`, `<taskId>_plan-v1-revise`), so a repeated request collapses but a new resume is never swallowed by BullMQ remembering an older job.
- The worker loads the **persisted** status and drives the pipeline forward one stage at a time (`apps/worker/src/pipeline.ts`).
- **Timeouts.** Each stage runs under a wall-clock limit (`ANALYZE_TIMEOUT_SECONDS`, `PLAN_TIMEOUT_SECONDS`). The stage's abort signal fires at the deadline, and the pipeline fails the task even if a handler ignores the signal.
- **Retries.** Stages raise `TransientError` for failures that may pass later (provider rate limits and outages, dropped connections). The job is thrown back to BullMQ, which retries it with exponential backoff (3 attempts); every other error fails the task with a reason. Because stages resume from persisted state, a retry never repeats finished work.
- **Cancellation.** While a job runs, the worker polls the task every `CANCELLATION_POLL_MS`. Once the API has cancelled it, the job's signal aborts the in-flight git fetch or model call, the current run is recorded as `CANCELLED`, and the pipeline exits without touching the task. Pending jobs are removed from the queue; one that starts later finds the task terminal and exits.
- **Crashes.** A job whose worker dies is redelivered once its BullMQ lock lapses (`lockDuration` 60 s, at most 2 stalls) and resumes from the persisted status.
- Each transition is a compare-and-set (`UPDATE … WHERE status = :from`) plus a `task_events` row in a single transaction (`apps/worker/src/task-state.ts`). A cancel racing a worker, or two workers racing each other, cannot both win.
- The pipeline stops at human gates (`AWAITING_PLAN_APPROVAL`, `READY_FOR_REVIEW`). An approval in the API re-enqueues the task.
- External side effects (push, PR creation) are wrapped in `idempotency_keys` so a retry after a crash returns the original result instead of opening a second PR.

## Repository analysis (ANALYZING)

```
GitHub: default branch → head SHA ──pin──▶ agent_tasks.base_sha (set once; reused on retry)
snapshot for (repository, SHA) exists? ── yes ─────────────────────────────┐
        │ no                                                                │
        ▼                                                                   │
shallow fetch of that one SHA into .workspaces/<task>-<rand>/repo           │
(hardened git, token via env only) → walk without following symlinks        │
→ filter (secrets never opened) → chunk + symbols → one transaction:        │
repository_snapshots + repository_files + code_chunks + code_symbols        │
→ workspace deleted (always, in finally)                                    │
        ▼                                                                   ▼
retrieve: paths named in the task · symbol names · full-text (tsvector) · AGENTS.md
→ merge + rank + fit budget → agent_tasks.analysis (ContextPackage) → PLANNING
```

- Analysis never runs repository code. `git` runs with hooks, submodules, symlinks, and non-https protocols disabled and no user or system git config.
- A snapshot is written in a single transaction, so a half-indexed commit is never visible, and two workers indexing the same commit collapse to one row.
- Only TypeScript/JavaScript repositories proceed to planning in this release; others fail at analysis with the profile kept for inspection.

## Planning (PLANNING → AWAITING_PLAN_APPROVAL)

```
agent_tasks.analysis (ContextPackage) + issue/description [+ previous plan and reviewer feedback]
→ prompt: fixed system prompt + per-task message; every untrusted input fenced in <untrusted-NONCE>
→ Claude Messages API: structured output (JSON schema), adaptive thinking, server-side fallback
→ agent_runs row (attempt, tokens) + usage_records row (cost at the model that answered)
→ validate: Zod limits · path policy · modify/delete must exist at the pinned commit, create must not
   └─ invalid → problems fed back to the model, up to PLANNING_MAX_ATTEMPTS
→ implementation_plans (version n, PROPOSED) → AWAITING_PLAN_APPROVAL
   ├─ approve v n   → APPROVED, task → GENERATING_PATCH, re-enqueued
   └─ request changes → CHANGES_REQUESTED + feedback, task → PLANNING, version n+1 (at most 3)
```

- The worker checks the task's token budget (`TASK_TOKEN_BUDGET`, input plus output across all calls) before every model call.
- A declined task (`kind: "rejected"`) or a provider refusal fails the task with the reason. Neither is retried.
- If a crash happens after a plan is stored but before the transition, the re-run reuses that plan instead of paying for another call.
- Tasks created with `requirePlanApproval: false` store their plan as `APPROVED` and continue straight to `GENERATING_PATCH`.

## Patch generation (GENERATING_PATCH → RUNNING_CHECKS)

```
approved plan + pinned commit
→ workspace: fetch base_sha (hardened git), switch to codepilot/<slug>-<task id>
→ read planned files: regular tracked text files only (no symlinks, submodules, binaries), size-limited
→ prompt: fixed system prompt + plan + current file contents, all untrusted text fenced
→ Claude (streamed): { files: [{ path, change, edits: [{ find, replace }] | content }] }
→ validate: Zod · path policy · file and change kind must match the plan · each find matches exactly once
   └─ invalid → problems fed back, up to PATCH_MAX_ATTEMPTS
→ write (realpath re-checked, new files O_EXCL) → git add <those paths> → status must show nothing else
→ commit (fixed identity, task trailers) → diff vs base: kinds must match, size and binary limits
   └─ too large / binary → reset to base, problems fed back
→ patches (version n: plan, run, base, commit, tree, diff, per-file stats) → RUNNING_CHECKS
→ workspace deleted
```

- Nothing is pushed. The stored diff rebuilds the same tree on a fresh checkout of `base_sha`, so later stages reconstruct the workspace from the database instead of keeping it.
- A patch stored before a crash is reused for the same approved plan.
- Planned files the patch left alone are recorded and shown to the reviewer.

## Checks and repair (RUNNING_CHECKS ⇄ REPAIRING → READY_FOR_REVIEW)

```
latest patch (version n)
→ workspace: fetch base_sha, apply stored diff, tree must equal patches.tree_sha
→ repository_settings: install + checks (maintainer-configured, policy re-validated)
→ sandbox (one container per command, see services/sandbox-runner):
     install: network on, --ignore-scripts      checks: --network none
     non-root · read-only root · cap-drop ALL · memory/CPU/pids/time limits · empty environment
→ test_runs (verification of patch n) + test_results (per command: status, exit code, bounded, masked output)
→ decideAfterChecks
   ├─ all pass          → patch VERIFIED → READY_FOR_REVIEW (human gate)
   ├─ some fail         → patch REJECTED → REPAIRING (while repairs < MAX_REPAIR_ATTEMPTS) else FAILED
   ├─ timeout           → FAILED (safety boundary)
   └─ could not complete→ FAILED (install, missing executable, memory limit, tree mismatch, no sandbox)

REPAIRING: rebuild patch n as a commit on the task branch → failing output (fenced) + patched files
→ model edits within planForRepair(plan) → patch n+1, diff cumulative from base_sha → RUNNING_CHECKS
```

- The worker drives Docker through its CLI. It never mounts the Docker socket, credentials, or its own environment into a container.
- A verification that finished is never re-run after a crash; one left `RUNNING` is marked `ERRORED` and run again.

## Pull requests (READY_FOR_REVIEW → OPENING_PR → PR_OPENED)

```
reviewer: POST /tasks/:id/pull-request { patchVersion }   (WRITE+, CAS, audited)
→ OPENING_PR: idempotency key open-pr:<task>:<patch>
→ rebuild commit (stored diff on base, tree verified, fixed identity and date → same SHA every time)
→ GitHub: branch absent → push --force-with-lease=<branch>: (create only)
          branch at our SHA → skip push;  branch elsewhere → fail, untouched
→ GitHub: PR for this head exists → reuse;  else create draft PR (body: evidence, neutralized text)
→ pull_requests row (unique per task), patch SUBMITTED, key COMPLETED → PR_OPENED
   └─ permanent failure or cancel after push → delete the pushed branch

pull_request webhooks ─┐
reconciliation job ────┴→ nextPullRequestState (ignores reports older than github_updated_at) → status, task event
```

See [state-machine.md](./state-machine.md), [data-model.md](./data-model.md), [ADR 0004](../decisions/0004-repository-analysis-and-retrieval.md), [ADR 0005](../decisions/0005-structured-planning-and-orchestration.md), [ADR 0006](../decisions/0006-patch-generation-and-git-workflow.md), [ADR 0007](../decisions/0007-sandboxed-checks-and-bounded-repair.md), and [ADR 0008](../decisions/0008-pull-request-integration.md).
