# sandbox-runner

Runs **maintainer-configured command profiles** against a rebuilt patch workspace in a disposable container and returns bounded results. The worker calls it in-process (`DockerSandbox`). The model never chooses a command; it only reads the results.

Build the image once:

```bash
pnpm sandbox:build      # docker build -t codepilot/sandbox-node:22 services/sandbox-runner
```

Every command runs in a fresh container with:

- `--network none`, except the install step, which runs with network access but with lifecycle scripts disabled (`--ignore-scripts` / `--mode=skip-build`, enforced by `agent-core`'s install policy);
- a read-only root filesystem; only `/workspace` (the checkout), `/cache` (package manager caches for this verification), and a size-limited `/tmp` are writable;
- a non-root user, `--cap-drop ALL`, `no-new-privileges`, and `--init`;
- memory without swap, CPU, process-count, and open-file limits, plus a wall-clock timeout (`docker kill` on expiry or cancellation);
- an environment built from scratch: nothing from the worker (no `DATABASE_URL`, GitHub tokens, or model keys) reaches the container;
- labeled containers, removed after every run and swept at worker startup.

Output is kept in bounded memory (head and tail), then stripped of terminal escapes and secret-shaped strings by `agent-core` before it is stored or shown to the model.

## Limits of this isolation

A standard container shares the host kernel and is **not a complete security boundary** for hostile code. The worker needs access to the Docker daemon, which is root-equivalent on that host, so the worker and its Docker host must not hold anything else. For a public multi-user deployment, run checks on a hardened runtime (gVisor `runsc`, Kata, or Firecracker) or on a dedicated, isolated worker pool. Disk use inside `/workspace` is not quota-limited by Docker's default storage driver; the workspace is deleted after each verification.

## Tests

`pnpm test` covers the container arguments. `pnpm test:integration` runs real containers and is skipped when the image is not present.
