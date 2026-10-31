# ADR 0006: Patch generation and the Git workflow

- Status: Accepted
- Date: 2026-10-31

## Context

Week 5 turns an approved plan into code. This is the first stage where model output changes files, so it is where path policy, the plan contract, and Git hygiene have to hold. The result must be inspectable before anything leaves the worker. Week 6 runs checks against it, and week 7 pushes it. Attempts also need a history: a repair in week 6 writes a new patch, and it must not erase the one it replaces.

## Decision

1. **The approved plan is the contract.** A patch may only touch files the approved plan lists, with the change kind the plan states (`modify`, `create`, `delete`). A file outside the plan, or a different change kind, is a validation problem, fed back to the model like an invalid plan. A planned file the patch leaves alone is allowed, and it is recorded in `unchanged_plan_files` so the reviewer sees what was skipped. Changing the scope means requesting changes to the plan, not working around it.
2. **Edits are find/replace, applied exactly once.** For `modify`, the model returns edits whose `find` text must occur exactly once in the current file, applied in order. For `create`, it returns the whole file. This uses far fewer output tokens than rewriting whole files. It fails loudly instead of landing in the wrong place, and the failure ("edit 2: the find text occurs more than once") is something the model can fix on the next attempt. Line-number diffs from the model were rejected because they are brittle: an off-by-one silently corrupts a file.
3. **Validate in layers before anything is committed.**
   - Zod limits on the structured output.
   - The path policy (denied segments, secret files, CI workflows, traversal).
   - Plan conformance.
   - The checkout itself: only regular tracked files (mode `100644`/`100755`) are edited, never symlinks or submodules. Binary files are refused. Files to create must not exist. Every file is under `PATCH_MAX_FILE_KB`.
   - Each write re-resolves the path with `realpath`. A new file is created with `O_EXCL`.
   - After the commit, the diff is checked against `PATCH_MAX_CHANGED_LINES` and a 1 MB diff limit, and binary results are rejected. An oversized diff resets the branch to the base and goes back to the model.
4. **One task, one branch, under a fixed prefix.** The branch is `codepilot/<title-slug>-<first 8 of task id>`. The slug comes from untrusted text, so it is reduced to `[a-z0-9-]`. It is checked against `codepilot/[a-z0-9-]+`, `git check-ref-format`, and the repository's default branch. It is reserved once per task with a compare-and-set, and `(repository_id, branch_name)` is unique.
5. **Commits are made in the disposable workspace with a fixed identity.**
   - Settings: hardened git config as in ADR 0004, no hooks, no signing, and `PATCH_AUTHOR_NAME`/`PATCH_AUTHOR_EMAIL` as author and committer (default `codepilot@codepilot.invalid`, an unroutable address).
   - `git add` names exactly the validated paths. Before committing, `git status` must show nothing else.
   - After committing, the diff's paths and change kinds must equal the validated change set.
   - The message is the model's one-line subject, its summary as the body, and `CodePilot-Task` / `CodePilot-Plan` trailers.
   - Nothing is pushed in this stage.
6. **The stored diff is the source of truth, and it is reproducible.** The workspace is deleted when the stage ends. `patches` keeps the diff (`git diff --binary --full-index` against the base), the commit SHA, and the **tree SHA**. Applying the diff to a fresh checkout of `base_sha` must produce that tree. A test proves this, and weeks 6 and 7 rebuild the workspace this way instead of keeping long-lived checkouts.
7. **Patches are versioned attempts.** `(task_id, version)` is unique. Each patch row links to the approved plan it implements and the run that produced it. The old `(task_id, diff_hash)` uniqueness was dropped, because a repair may reproduce an earlier diff and both attempts belong in the history. If a crash happens after the patch is stored, the re-run reuses the patch for that plan.
8. **The model client streams.** Patches can be tens of thousands of output tokens, so the Anthropic adapter uses `messages.stream(...).finalMessage()` for every stage. Planning and patching share one `StructuredModel` interface, the same retry classification, and the same token budget.

## Consequences

- A reviewer sees exactly what will be pushed. The task page shows the commit, the branch, per-file counts, planned files that were skipped, and the diff (rendered as text).
- `RUNNING_CHECKS` has no handler until week 6, so a task with a patch currently fails there with a clear reason. The patch remains stored and visible.
- Find/replace needs the model to copy text exactly. Failed matches cost an attempt; `PATCH_MAX_ATTEMPTS` bounds that.
- Large refactors that exceed the line or file limits are out of scope by design; the agent targets small, reviewable changes.
- Commit SHAs differ between rebuilds (timestamps), so later stages compare tree SHAs, not commit SHAs. Week 7 will recreate the commit with the stored message when it pushes.
