import { DEFAULT_SANDBOX_LIMITS, DockerSandbox, sandboxEnvironment } from "./docker-sandbox";

const request = {
  image: "codepilot/sandbox-node:22",
  workspaceDir: "/work/task/repo",
  cacheDir: "/work/task/cache",
  executable: "pnpm",
  args: ["run", "test", "--", "--ci"],
  timeoutMs: 60_000,
  network: "none" as const,
  limits: DEFAULT_SANDBOX_LIMITS,
  maxOutputBytes: 64 * 1024,
};

describe("DockerSandbox.runArgs", () => {
  const args = new DockerSandbox({ user: "501:20" }).runArgs("codepilot-sbx-test", request);
  const valueOf = (flag: string) => args[args.indexOf(flag) + 1];

  it("isolates the container: no network, read-only root, non-root, no capabilities", () => {
    expect(valueOf("--network")).toBe("none");
    expect(args).toContain("--read-only");
    expect(valueOf("--user")).toBe("501:20");
    expect(valueOf("--cap-drop")).toBe("ALL");
    expect(valueOf("--security-opt")).toBe("no-new-privileges");
    expect(args).not.toContain("--privileged");
  });

  it("limits memory without swap, CPU, processes, and /tmp", () => {
    expect(valueOf("--memory")).toBe("2048m");
    expect(valueOf("--memory-swap")).toBe("2048m");
    expect(valueOf("--cpus")).toBe("2");
    expect(valueOf("--pids-limit")).toBe("512");
    expect(valueOf("--tmpfs")).toBe("/tmp:rw,nosuid,nodev,size=512m");
  });

  it("mounts only the workspace and the cache, never the Docker socket", () => {
    const mounts = args.filter((_, i) => args[i - 1] === "--mount");
    expect(mounts).toEqual(["type=bind,source=/work/task/repo,target=/workspace", "type=bind,source=/work/task/cache,target=/cache"]);
    expect(args.join(" ")).not.toMatch(/docker\.sock|--volume|-v /);
  });

  it("runs the executable directly with its arguments after the image", () => {
    expect(valueOf("--entrypoint")).toBe("pnpm");
    expect(args.slice(args.indexOf(request.image))).toEqual([request.image, "run", "test", "--", "--ci"]);
  });

  it("passes only its own environment, nothing from the worker", () => {
    process.env.DATABASE_URL = "postgresql://secret";
    const env = new DockerSandbox({ user: "1:1" }).runArgs("x", request).filter((_, i, all) => all[i - 1] === "--env");
    expect(env).toEqual(sandboxEnvironment());
    expect(env.join(" ")).not.toMatch(/DATABASE_URL|ANTHROPIC|GITHUB/);
    delete process.env.DATABASE_URL;
  });
});
