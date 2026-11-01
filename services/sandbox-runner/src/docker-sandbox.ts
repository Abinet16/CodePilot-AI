import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { BoundedOutput } from "./bounded-output";

export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
  /** Size of the writable /tmp (the root filesystem is read-only). */
  tmpfsMb: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = { memoryMb: 2_048, cpus: 2, pids: 512, tmpfsMb: 512 };

export interface SandboxRunRequest {
  image: string;
  /** Host directory mounted read-write at /workspace: the rebuilt checkout. */
  workspaceDir: string;
  /** Host directory mounted read-write at /cache: package manager caches shared by the steps of one verification. */
  cacheDir: string;
  /** An allowlisted executable name, resolved on the container PATH. */
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  /** "none" for checks. Only the install step may use "bridge". */
  network: "none" | "bridge";
  limits: SandboxLimits;
  /** Output kept per run: half from the start, half from the end. */
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export type SandboxStatus = "PASSED" | "FAILED" | "TIMED_OUT" | "ERRORED";

export interface SandboxResult {
  status: SandboxStatus;
  /** The command's exit code; null when it was killed or never started. */
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
  durationMs: number;
  /** Set when a resource limit stopped the command. */
  limitExceeded: "time" | "memory" | null;
  /** Why the command could not run at all, for ERRORED. */
  error: string | null;
}

/** Every sandbox container carries this label, so leftovers can be found and removed. */
export const SANDBOX_LABEL = "dev.codepilot.sandbox";

/** Exit codes from `docker run` itself rather than from the command. */
const DOCKER_ERROR = 125;
const NOT_EXECUTABLE = 126;
const NOT_FOUND = 127;

export interface DockerSandboxOptions {
  docker?: string;
  /** uid:gid inside the container. Defaults to the worker's own ids, or 1000:1000 when the worker runs as root. */
  user?: string;
}

/**
 * Runs one command in a fresh container:
 * - no network unless asked (only the install step asks);
 * - a read-only root filesystem, with writable /workspace, /cache, and a size-limited /tmp;
 * - a non-root user, all capabilities dropped, and no privilege escalation;
 * - memory (no swap), CPU, and process-count limits, and a wall-clock timeout;
 * - only the environment variables set here: nothing from the worker.
 *
 * A container is not a complete security boundary for hostile code; see the
 * threat model for the hardened runtime a public deployment needs.
 */
export class DockerSandbox {
  private readonly docker: string;
  private readonly user: string;

  constructor(options: DockerSandboxOptions = {}) {
    this.docker = options.docker ?? "docker";
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    this.user = options.user ?? (uid === 0 ? "1000:1000" : `${uid}:${gid}`);
  }

  /** True when the Docker daemon answers and `image` is present locally. */
  async ready(image: string): Promise<boolean> {
    try {
      await this.exec(["image", "inspect", "--format", "{{.Id}}", image], 15_000);
      return true;
    } catch {
      return false;
    }
  }

  async run(request: SandboxRunRequest): Promise<SandboxResult> {
    const name = `codepilot-sbx-${randomBytes(6).toString("hex")}`;
    const started = Date.now();
    const output = new BoundedOutput(Math.floor(request.maxOutputBytes / 2), Math.ceil(request.maxOutputBytes / 2));
    // Set from the timer callback, so it lives in an object TypeScript does not narrow.
    const stop: { reason: "time" | null } = { reason: null };

    const child = spawn(this.docker, this.runArgs(name, request), { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } });
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));

    const kill = () => void this.exec(["kill", name], 15_000).catch(() => undefined);
    const timer = setTimeout(() => {
      stop.reason = "time";
      kill();
    }, request.timeoutMs);
    const onAbort = () => kill();
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code));
      });
      const state = await this.inspect(name);
      const limitExceeded: SandboxResult["limitExceeded"] = stop.reason ?? (state?.oomKilled ? "memory" : null);
      const durationMs = Date.now() - started;
      const base = { output: output.toString(), outputTruncated: output.truncated, durationMs, limitExceeded };

      if (limitExceeded === "time") return { ...base, status: "TIMED_OUT", exitCode: null, error: `Exceeded the ${Math.round(request.timeoutMs / 1000)}s limit` };
      if (limitExceeded === "memory") return { ...base, status: "ERRORED", exitCode: null, error: `Exceeded the ${request.limits.memoryMb} MB memory limit` };
      if (request.signal?.aborted) return { ...base, status: "ERRORED", exitCode: null, error: "Cancelled" };
      if (!state?.started) {
        return { ...base, status: "ERRORED", exitCode: null, error: exitCode === DOCKER_ERROR ? "The sandbox container could not be created" : "The sandbox container did not start" };
      }
      // The runtime reports a missing or non-executable entrypoint in State.Error; a command exiting 127 itself does not.
      if ((exitCode === NOT_EXECUTABLE || exitCode === NOT_FOUND) && state.error) {
        return { ...base, status: "ERRORED", exitCode, error: `${request.executable} could not be started in the sandbox` };
      }
      return { ...base, status: exitCode === 0 ? "PASSED" : "FAILED", exitCode, error: null };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      await this.exec(["rm", "--force", "--volumes", name], 30_000).catch(() => undefined);
    }
  }

  /** Removes sandbox containers older than `maxAgeMs`, left behind by a crashed worker. */
  async sweep(maxAgeMs: number, now = Date.now()): Promise<number> {
    let listing: string;
    try {
      listing = await this.exec(["ps", "--all", "--filter", `label=${SANDBOX_LABEL}`, "--format", "{{.ID}} {{.Label \"" + SANDBOX_LABEL + "\"}}"], 15_000);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const line of listing.split("\n").filter(Boolean)) {
      const [id, createdMs] = line.split(" ");
      if (id && now - Number(createdMs) > maxAgeMs) {
        await this.exec(["rm", "--force", "--volumes", id], 30_000).catch(() => undefined);
        removed++;
      }
    }
    return removed;
  }

  /** The `docker run` arguments. Exposed for tests; nothing here goes through a shell. */
  runArgs(name: string, request: SandboxRunRequest): string[] {
    const { limits } = request;
    return [
      "run",
      "--name",
      name,
      "--label",
      `${SANDBOX_LABEL}=${Date.now()}`,
      "--init",
      "--network",
      request.network,
      "--user",
      this.user,
      "--read-only",
      "--tmpfs",
      `/tmp:rw,nosuid,nodev,size=${limits.tmpfsMb}m`,
      "--memory",
      `${limits.memoryMb}m`,
      "--memory-swap",
      `${limits.memoryMb}m`,
      "--cpus",
      String(limits.cpus),
      "--pids-limit",
      String(limits.pids),
      "--ulimit",
      "nofile=4096:4096",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=bind,source=${path.resolve(request.workspaceDir)},target=/workspace`,
      "--mount",
      `type=bind,source=${path.resolve(request.cacheDir)},target=/cache`,
      "--workdir",
      "/workspace",
      ...sandboxEnvironment().flatMap((e) => ["--env", e]),
      "--entrypoint",
      request.executable,
      request.image,
      ...request.args,
    ];
  }

  private async inspect(name: string): Promise<{ started: boolean; oomKilled: boolean; error: string } | null> {
    try {
      const out = await this.exec(["inspect", "--format", "{{.State.StartedAt}}|{{.State.OOMKilled}}|{{.State.Error}}", name], 15_000);
      const [startedAt, oom, error] = out.trim().split("|");
      return { started: !!startedAt && !startedAt.startsWith("0001-"), oomKilled: oom === "true", error: error ?? "" };
    } catch {
      return null;
    }
  }

  private exec(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.docker, args, { timeout: timeoutMs, env: { PATH: process.env.PATH }, maxBuffer: 1024 * 1024 }, (err, stdout) =>
        err ? reject(err) : resolve(String(stdout)),
      );
    });
  }
}

/** The complete environment inside the sandbox. Nothing is inherited from the worker. */
export function sandboxEnvironment(): string[] {
  return [
    "CI=true",
    "HOME=/tmp",
    "PATH=/workspace/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    "COREPACK_HOME=/cache/corepack",
    "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
    "npm_config_cache=/cache/npm",
    "npm_config_store_dir=/cache/pnpm-store",
    "npm_config_update_notifier=false",
    "YARN_CACHE_FOLDER=/cache/yarn",
    "NO_COLOR=1",
    "FORCE_COLOR=0",
  ];
}
