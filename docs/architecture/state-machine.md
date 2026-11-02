# Agent task state machine

Source of truth: `packages/contracts/src/task-status.ts`. The Prisma enum mirrors it; transitions are enforced in code and covered by tests.

```mermaid
stateDiagram-v2
  [*] --> QUEUED
  QUEUED --> ANALYZING
  ANALYZING --> PLANNING
  PLANNING --> AWAITING_PLAN_APPROVAL: plan approval required
  PLANNING --> GENERATING_PATCH: auto-approved
  AWAITING_PLAN_APPROVAL --> GENERATING_PATCH: approved
  AWAITING_PLAN_APPROVAL --> PLANNING: changes requested
  GENERATING_PATCH --> RUNNING_CHECKS
  RUNNING_CHECKS --> READY_FOR_REVIEW: checks pass
  RUNNING_CHECKS --> REPAIRING: checks fail, repairs left
  REPAIRING --> RUNNING_CHECKS
  READY_FOR_REVIEW --> OPENING_PR: reviewer opens draft PR
  OPENING_PR --> PR_OPENED
  PR_OPENED --> [*]
  note right of REPAIRING: bounded by MAX_REPAIR_ATTEMPTS (default 2) per approved plan
```

Every non-terminal state may also move to `FAILED` or `CANCELLED`. Terminal states: `PR_OPENED`, `FAILED`, `CANCELLED`.

## Rules

1. **No skipping verification.** `GENERATING_PATCH` can only reach `READY_FOR_REVIEW` through `RUNNING_CHECKS`.
2. **Bounded repair.** `decideAfterChecks` in `agent-core` fails the task once the repair budget is spent, or immediately on a safety violation (timeout, resource limit, policy breach), even if checks passed.
3. **Resume, don't restart.** The worker always starts from the persisted status, so redelivery of a job after a crash continues from where it stopped.
4. **Humans gate side effects.** The agent never merges, and never opens a PR without a `READY_FOR_REVIEW → OPENING_PR` approval.
5. **Plans are reviewed by version.** Approving or requesting changes names the plan version the reviewer saw. Both are compare-and-sets on the task status and the plan status, so a stale or second review gets `409`. A task gets at most `MAX_PLAN_VERSIONS` (3) plans.
6. **Failures are classified.** Transient failures (rate limits, provider outages, dropped connections) leave the status unchanged and are retried by the queue with backoff. Everything else, including a stage timeout, a declined task, or an exhausted token budget, moves the task to `FAILED` with a reason.
7. **Cancellation wins.** `CANCELLED` is set by the API. A running job notices, aborts its in-flight work, and exits without writing a status.
8. **Patches implement the approved plan, nothing more.** `GENERATING_PATCH` only touches files the approved plan lists, with the change kind it states, and commits on the task's own `codepilot/…` branch. Every attempt is stored as a new patch version; none is overwritten.
9. **Checks verify the stored patch, in a sandbox.** `RUNNING_CHECKS` rebuilds the latest patch from its diff, refuses to run unless the tree matches the stored tree SHA, and runs only the maintainer-configured checks. Passing checks verify the patch (`READY_FOR_REVIEW`); failing checks reject it and move to `REPAIRING` while repairs for the plan remain; a timeout fails the task as a safety violation; a run that could not complete fails the task without judging the patch.
10. **Pull requests are opened by a person and are idempotent.** `READY_FOR_REVIEW → OPENING_PR` requires a reviewer naming the verified patch version. `OPENING_PR` pushes a reproducible commit only to a new task branch, reuses any PR already open for it, records the result under an idempotency key, and ends at `PR_OPENED`. The PR's own status (draft, open, closed, merged) is tracked separately, from webhooks and reconciliation.
