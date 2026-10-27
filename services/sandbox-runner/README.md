# sandbox-runner (week 6)

Executes **human-configured command profiles** against a patched workspace in a disposable container and returns bounded, sanitized results.

Planned contract:

- Input: workspace snapshot (tarball or read-only mount of a copy), a validated `CommandProfile` from `@codepilot/agent-core`.
- Container: non-root user, read-only base image, `--network none` by default (dependency install uses a separate, allowlisted-registry step), CPU/memory/pids limits, disk quota, wall-clock timeout.
- Never mounted: the Docker socket, host credentials, `DATABASE_URL`, GitHub tokens, LLM keys.
- Output: exit code, duration, truncated and secret-scrubbed stdout/stderr summary, full log uploaded to object storage.

The directory layout is not a security boundary. For public multi-user deployment this runs on a hardened runtime (gVisor/Firecracker) or an isolated worker pool.
