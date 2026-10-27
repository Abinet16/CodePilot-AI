# Threat model

Everything that comes from a repository (source, comments, README, config, test output) and every GitHub issue body is **untrusted input**. Model output derived from it is also untrusted.

| Threat | Control | Where | Status |
| --- | --- | --- | --- |
| Model writes outside the workspace (`../`, absolute paths) | Path normalization + traversal rejection | `agent-core/path-policy.ts` | ✅ tested |
| Symlink planted in repo redirects a write outside the workspace | `realpath` of deepest existing ancestor must stay in workspace | `agent-core/path-policy.ts` | ✅ tested |
| Model edits secrets, `.git`, CI workflows | Denied segments, basenames, and prefixes | `agent-core/path-policy.ts` | ✅ tested |
| Model runs arbitrary shell commands | Model picks a **profile id** only; profiles are human-configured, executable allowlisted, args checked for shell metacharacters, run via `execFile` | `agent-core/command-policy.ts` | ✅ tested (execution in week 6) |
| Infinite repair loop burns tokens/compute | Bounded repair budget; safety violations fail immediately | `agent-core/repair-policy.ts` | ✅ tested |
| Concurrent workers / cancel race corrupt state | Compare-and-set transitions in a transaction | `worker/task-state.ts` | ✅ integration-tested |
| Duplicate job delivery duplicates work | `jobId = taskId`; pipeline resumes from persisted status | `worker` | ✅ smoke-tested |
| Duplicate webhook delivery creates duplicate tasks | `webhook_deliveries` primary key on delivery id | schema | ⏳ week 2 |
| Duplicate PR on retry | `idempotency_keys` around push and PR creation | schema | ⏳ week 7 |
| Credentials leak into queue payloads or logs | Jobs carry ids only; tokens minted on demand | `contracts/queue.ts` | ✅ by design |
| Install scripts exfiltrate secrets / reach network | Sandbox: no credentials, no Docker socket, network off by default, non-root, CPU/mem/disk/time limits | `services/sandbox-runner` | ⏳ week 6 |
| Prompt injection in repo files or issue bodies | Delimited untrusted context, no tool that can act outside policy, model cannot choose commands or paths unchecked | worker | ⏳ week 4 |
| Cross-tenant repository access | Every query scoped by installation → user; tests attempt cross-user access | api | ⏳ week 2 |

> A standard Docker container is not a complete security boundary for hostile code. For public multi-user access the sandbox must use a hardened runtime (gVisor, Firecracker, or a dedicated isolated worker pool).
