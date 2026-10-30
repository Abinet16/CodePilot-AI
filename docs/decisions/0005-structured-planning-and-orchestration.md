# ADR 0005: Structured planning and task orchestration

- Status: Accepted
- Date: 2026-10-30

## Context

Week 4 turns an issue into a plan a developer can review before any code is written. That is the first step that calls a model. Model calls cost money and fail in ways the rest of the pipeline does not: they hit rate limits, they can be refused, and they produce output in whatever shape they like. The planning prompt is also built from untrusted text: issue bodies, repository code, and reviewer notes. The task pipeline also needs real timeouts, retries, and cancellation.

## Decision

1. **Plans come back as structured output, then get validated again.** The Messages API call uses `output_config.format` with a JSON schema (`PLANNING_OUTPUT_SCHEMA`). Structured outputs do not support length limits or a top-level union, so the schema is a flat object with nullable `plan` and `reason`. `toPlanningOutcome` folds that into `PlanningOutcome`, and Zod enforces every limit. Each affected file must say whether it is a `modify`, `create`, or `delete`, which is checked against the pinned commit's file list. Paths also go through the existing path policy. Invalid output is fed back to the model as a list of problems, for up to `PLANNING_MAX_ATTEMPTS` calls.
2. **The model has no tools during planning.** It reads a bounded context package and returns JSON. Nothing it says can run a command, fetch a URL, or read a file. That is the main defence against prompt injection. The second defence is fencing: every untrusted input is wrapped in `<untrusted-NONCE>` blocks, where the nonce is random per request, so repository text cannot close its own block. The fixed system prompt says fenced text is data. The third defence is the human approval gate.
3. **Claude Opus 5.5 by default, with adaptive thinking and `effort: high`.** Planning quality decides whether everything downstream is worth doing, so it gets the strongest default model. The model and effort are configuration (`PLANNING_MODEL`, `PLANNING_EFFORT`). Server-side fallback (`fallbacks: "default"`) re-runs a policy refusal on a fallback model in the same call. Usage is priced at the model that actually answered (`response.model`). A refusal that survives the fallback fails the task and is not retried.
4. **Every call is recorded and budgeted.** One `agent_runs` row per call (stage, model, tokens, error) and one `usage_records` row per billed call (cost from `MODEL_PRICING`). Before each call the worker checks the task's total against `TASK_TOKEN_BUDGET`. Plans are capped at 3 versions per task. The startup config refuses a model with no price, so usage is never recorded at zero cost.
5. **Reviews are compare-and-sets that name a version.** Approve and request-changes carry the plan version the reviewer saw. The API updates the plan `WHERE status = 'PROPOSED'` and the task `WHERE status = 'AWAITING_PLAN_APPROVAL'` in one transaction, so a stale or concurrent review gets `409`. Requested changes send the task back to `PLANNING`, and the next version is written with the previous plan and the feedback in the prompt.
6. **Each resume gets its own job id.** BullMQ ignores an `add` whose id it still remembers, and completed jobs are kept. Under `jobId = taskId`, an approval after the first run would have been silently dropped. Job ids are now `<taskId>_<reason>` (`start`, `plan-v2-approved`, `plan-v1-revise`). They are deterministic, so a repeated request still collapses.
7. **Three kinds of failure, handled differently.**
   - *Transient* errors (`TransientError`: rate limits, 5xx/529, connection errors, after the SDK's own two retries) are thrown back to BullMQ, which retries the job with exponential backoff while attempts remain. Stages resume from persisted state, so finished work is not repeated. For example, a plan stored before a crash is reused.
   - *Timeouts* are per stage (`ANALYZE_TIMEOUT_SECONDS`, `PLAN_TIMEOUT_SECONDS`). At the deadline the stage's signal aborts, and the pipeline fails the task even if the handler ignores the signal.
   - *Cancellation* comes from the API. The worker polls the task while a job runs and aborts the job's signal, which reaches the in-flight model call or git fetch. The run is recorded as `CANCELLED` and the pipeline exits without writing a status.

## Consequences

- An approved plan is the contract for week 5. Patch generation can refuse to touch files the plan did not list.
- Validation problems, invalid attempts (`plan_invalid` events), declines, and retries are all visible in the task history, so a reviewer can see why a plan looks the way it does.
- Polling for cancellation costs one indexed primary-key read per running job per interval. A Redis pub/sub signal would be faster, but it adds a second source of truth. Polling is enough at this scale.
- `@anthropic-ai/sdk` is pinned to 0.135.0. The 1.x line was a week old when this was written, which is under the release-age gate in ADR 0002.
- The price table must be updated by hand when models or prices change. A wrong price gives wrong cost reports, but it never blocks a task.
