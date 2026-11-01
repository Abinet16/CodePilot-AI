# ADR 0007: Sandboxed checks and bounded repair

- Status: Accepted
- Date: 2026-11-01

## Context

Week 6 runs a repository's tests, linting, and type checks against each patch. This is the first time CodePilot executes repository code, and that code is untrusted: a package.json script, a test, or a dependency can do anything the process running it can. The results must be tied to the exact patch they verified. When checks fail, the model gets a bounded number of chances to fix them.

## Decision

1. **Checks are configured by a maintainer, never by the model.**
   - A repository has an optional install command and an ordered list of checks (`test`, `lint`, `typecheck`, `build`). Each is a command profile: an allowlisted executable, arguments without shell metacharacters, and a timeout.
   - Saving them requires `MAINTAIN` on GitHub; `WRITE` runs tasks but does not decide what executes. Every change is audited.
   - Profiles are validated when saved and again before every run.
   - Suggestions come from the script **names** in package.json (`pnpm run test`), never the script bodies, and are not used until saved.
   - A repository without checks fails at `RUNNING_CHECKS` with a clear reason. A check that did not run is never reported as passing.
2. **Every command runs in a fresh Docker container** (`services/sandbox-runner`):
   - `--network none`.
   - Read-only root filesystem.
   - Writable `/workspace` (the rebuilt checkout), `/cache`, and a size-limited `/tmp`.
   - Non-root user, `--cap-drop ALL`, `no-new-privileges`, and `--init`.
   - Memory without swap, CPU, process-count, and open-file limits.
   - A wall-clock timeout, enforced with `docker kill`.
   - An environment built from scratch: no database URL, GitHub token, or model key exists in the container.
   - Containers are labeled, removed after every run, and swept at worker startup.
   - Docker is driven through its CLI with `execFile`, so no new dependency and no shell.
3. **The install step is the only one with network access, and it runs no dependency code.**
   - It must be `npm|pnpm|yarn install|ci` with `--ignore-scripts` (or `--mode=skip-build` for yarn 2+). The policy enforces this, not a convention.
   - Packages that need postinstall builds will not work. That is the price of not running arbitrary install scripts with network access.
4. **Checks run on the stored patch, rebuilt and verified.** The worker checks out `base_sha`, applies the stored diff, and refuses to run anything unless the resulting tree equals the patch's stored `tree_sha`. What was verified is provably what was reviewed.
5. **Results are bounded and sanitized.**
   - The runner keeps the head and tail of each command's output in bounded memory.
   - `summarizeOutput` then strips terminal escapes and control characters, masks token-shaped secrets with the same patterns as the audit log, and trims to `CHECK_OUTPUT_CHARS`, keeping most of the end, where failures print.
   - Results are stored per command, linked to the verification (`test_runs`) and to the patch version it checked.
6. **Decisions follow `decideAfterChecks`.**
   - All checks pass: the patch becomes `VERIFIED` and the task goes to `READY_FOR_REVIEW`.
   - Checks fail: the patch becomes `REJECTED`, and the task goes to `REPAIRING` while repairs for this plan are below `MAX_REPAIR_ATTEMPTS` (default 2); otherwise the task fails.
   - A timeout is a safety boundary and fails the task immediately.
   - A run that could not complete fails the task without judging the patch. That covers a missing executable, a failed install, the memory limit, a tree mismatch, or an unavailable sandbox.
7. **A repair is a new patch version under the same plan.**
   - The repair stage rebuilds the rejected patch as a commit on the task branch. It gives the model the failing output (fenced as untrusted) and the patched files.
   - It accepts edits only within `planForRepair(plan)`: planned files that now exist may be modified, and nothing outside the plan may be touched.
   - The new version's diff is stored **cumulatively from the base**, so checks rebuild every version the same way and earlier versions stay intact.
   - The prompt tells the model to decline rather than weaken or delete tests.

## Consequences

- The deliverable holds: every patch version has its own verification and per-check results, visible on the task page.
- The worker needs the Docker daemon, which is root-equivalent on its host. A standard container is not a complete boundary for hostile code. A public deployment must run checks on a hardened runtime (gVisor, Kata, Firecracker) or a dedicated, isolated pool, and the worker host must hold nothing else of value.
- Disk use inside `/workspace` is not quota-limited by Docker's default storage driver; the workspace is deleted after each verification.
- There is no baseline run of the checks on the unpatched commit yet. A check that already failed before the patch looks like a patch failure and consumes repairs. Baseline runs belong with the evaluation work in week 9.
- Full logs are not kept beyond the bounded summary; `log_object_key` stays empty until object storage exists.
