# ADR 0008: Pull request integration

- Status: Accepted
- Date: 2026-11-02

## Context

Week 7 completes the loop from issue to pull request. This is the first stage that changes anything on GitHub, and it involves several external steps that can each fail or be repeated: a push, a PR creation, and webhooks delivered late, twice, or not at all. A retry or a crashed worker must never produce a second PR, a force-pushed branch, or a PR claiming checks that did not run.

## Decision

1. **A person opens the PR.**
   - `READY_FOR_REVIEW → OPENING_PR` happens only through `POST /tasks/:id/pull-request` with the verified patch version the reviewer looked at.
   - It needs WRITE permission and is audited.
   - It is a compare-and-set on the task status, and the named version must be the latest and `VERIFIED`. A stale page or a second click gets `409`.
   - The PR is always a **draft**. The agent never marks it ready, approves it, or merges it.
2. **The push is reproducible and cannot overwrite anything.**
   - The commit is rebuilt from the stored diff on the pinned base, checked against the stored tree SHA. It uses the fixed agent identity and the patch's creation time as its date, so every rebuild has the **same commit SHA**.
   - The worker asks GitHub for the branch first. If it is missing, it pushes with `--force-with-lease=refs/heads/<branch>:`, which only creates. If it is already at our SHA, it skips the push. If it is anywhere else, it fails without touching it.
   - The refspec is always `HEAD:refs/heads/codepilot/…`, checked against the branch policy and the default branch.
   - The installation token travels only in the environment, as in ADR 0004.
3. **PR creation is idempotent at three levels.**
   - An `idempotency_keys` row (`open-pr:<task>:<patch>`) records the finished PR. A worker that crashes after GitHub answered but before the database caught up reads it instead of calling GitHub again.
   - Before creating a PR, the worker looks one up by head branch, so a lost response never leads to a duplicate.
   - `pull_requests.task_id` is unique, so a task can never record two PRs.
4. **The PR body is evidence, and untrusted text in it is inert.**
   - The body contains:
     - An AI-authorship note naming the model and who approved the plan.
     - The linked issue (`Resolves #n`).
     - The patch summary.
     - The files changed, with the plan's reasons.
     - A table of exactly the checks stored for that patch's passing verification.
     - The assumptions, risks, skipped planned files, the repair count, and that passing checks are not proof.
     - Provenance: task, base SHA, plan, and patch versions.
   - Model and issue text is neutralized: HTML escaped, mentions broken, images and links disabled. Reading the PR cannot ping anyone, track a reader, or show a disguised link.
5. **Failure cleanup.**
   - GitHub 429/5xx and network errors are transient: the queue retries, and the pushed branch is kept for the retry.
   - 401/403/422 fail the task with a reason the user can act on (missing write permissions, drafts unavailable).
   - If the stage fails permanently or is cancelled after pushing and before a PR exists, it deletes the branch it pushed.
6. **GitHub state is kept in step two ways, with one rule.**
   - `pull_request` webhooks, and a scheduled reconciliation job on a separate `maintenance` queue, both call `nextPullRequestState`.
   - That function ignores any report older than the stored `github_updated_at`, so late or out-of-order deliveries cannot roll a merge back, and a merged PR stays merged.
   - Webhook redeliveries are deduplicated by delivery id, as in week 2. Only PRs the agent opened are tracked.
   - Reconciliation (`PR_RECONCILE_INTERVAL_SECONDS`, default 10 minutes) only revisits draft or open PRs that have not been confirmed recently. One failing repository does not stop the rest.

## Consequences

- Deliverable: an issue goes to analysis, plan, approval, patch, checks, repair, review, and finally a draft PR with test evidence. Every external effect is safe to repeat.
- The GitHub App now needs **Contents: read & write** and **Pull requests: read & write**, and should subscribe to **Pull request** events. Installers must re-approve the permission increase.
- `PR_OPENED` is terminal for the task, while the PR's own status keeps changing (draft, open, closed, merged) on the `pull_requests` row and in task events.
- Commits are authored by the configured agent identity and pushed by the GitHub App installation. Signed commits are not supported yet.
- Draft PRs are not available on every GitHub plan for private repositories. In that case the task fails with a clear reason instead of silently opening a non-draft PR.
