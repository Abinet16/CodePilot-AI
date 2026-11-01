import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxRunRequest } from "../src/docker-sandbox";
import { DEFAULT_SANDBOX_LIMITS, DockerSandbox, SANDBOX_LABEL } from "../src/docker-sandbox";

const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? "codepilot/sandbox-node:22";

function imagePresent(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

// Needs a Docker daemon and the sandbox image (pnpm --filter @codepilot/sandbox-runner image:build).
const describeWithDocker = imagePresent() ? describe : describe.skip;

describeWithDocker(`DockerSandbox with ${IMAGE}`, () => {
  const sandbox = new DockerSandbox();
  const work = mkdtempSync(path.join(tmpdir(), "codepilot-sandbox-"));
  const workspaceDir = path.join(work, "repo");
  const cacheDir = path.join(work, "cache");
  execFileSync("mkdir", ["-p", workspaceDir, cacheDir]);

  const node = (script: string, extra: Partial<SandboxRunRequest> = {}) =>
    sandbox.run({
      image: IMAGE,
      workspaceDir,
      cacheDir,
      executable: "node",
      args: ["-e", script],
      timeoutMs: 30_000,
      network: "none",
      limits: DEFAULT_SANDBOX_LIMITS,
      maxOutputBytes: 16 * 1024,
      ...extra,
    });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  afterEach(() => {
    const left = execFileSync("docker", ["ps", "--all", "--quiet", "--filter", `label=${SANDBOX_LABEL}`]).toString().trim();
    expect(left).toBe("");
  });

  it("reports a passing command with its output", async () => {
    const result = await node("console.log('ok from the sandbox')");
    expect(result).toMatchObject({ status: "PASSED", exitCode: 0, limitExceeded: null, error: null });
    expect(result.output).toContain("ok from the sandbox");
  });

  it("reports a failing command with its exit code and stderr", async () => {
    const result = await node("console.error('expected 3, received 2'); process.exit(3)");
    expect(result).toMatchObject({ status: "FAILED", exitCode: 3 });
    expect(result.output).toContain("expected 3, received 2");
  });

  it("runs as a non-root user with a read-only root and a writable workspace", async () => {
    const result = await node(
      "const fs=require('fs');fs.writeFileSync('/workspace/out.txt','written');" +
        "let ro='writable';try{fs.writeFileSync('/usr/local/x','y')}catch(e){ro=e.code}" +
        "console.log(process.getuid(), ro)",
    );
    expect(result.status).toBe("PASSED");
    const [uid, rootFs] = result.output.trim().split(" ");
    expect(uid).not.toBe("0");
    expect(rootFs).toBe("EROFS");
    expect(readFileSync(path.join(workspaceDir, "out.txt"), "utf8")).toBe("written");
  });

  it("has no network", async () => {
    const result = await node(
      "require('https').get('https://registry.npmjs.org',()=>{console.log('reached');process.exit(0)}).on('error',e=>{console.log(e.code);process.exit(1)})",
    );
    expect(result.status).toBe("FAILED");
    expect(result.output).not.toContain("reached");
  });

  it("sees none of the worker's environment", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    const result = await node("console.log(JSON.stringify(process.env))");
    delete process.env.ANTHROPIC_API_KEY;
    expect(result.output).not.toMatch(/sk-ant|DATABASE_URL|GITHUB/);
    expect(JSON.parse(result.output).CI).toBe("true");
  });

  it("kills a command that runs past its timeout", async () => {
    const result = await node("setInterval(() => {}, 1000)", { timeoutMs: 2_000 });
    expect(result).toMatchObject({ status: "TIMED_OUT", exitCode: null, limitExceeded: "time" });
    expect(result.durationMs).toBeLessThan(20_000);
  });

  it("stops a command at the memory limit", async () => {
    const limits = { ...DEFAULT_SANDBOX_LIMITS, memoryMb: 128 };
    const result = await node("const a=[];for(;;){a.push(Buffer.alloc(8*1024*1024,1))}", { limits });
    expect(result).toMatchObject({ status: "ERRORED", limitExceeded: "memory" });
  });

  it("caps the number of processes", async () => {
    const limits = { ...DEFAULT_SANDBOX_LIMITS, pids: 32 };
    const result = await node(
      "const {spawn}=require('child_process');let n=0,failed=null;for(let i=0;i<100;i++){try{const c=spawn('sleep',['5']);c.on('error',e=>{failed=failed||e.code});n++}catch(e){failed=e.code;break}}setTimeout(()=>{console.log(failed);process.exit(0)},500)",
      { limits },
    );
    expect(result.output.trim()).toBe("EAGAIN");
  });

  it("keeps only a bounded amount of output", async () => {
    const result = await node("process.stdout.write('x'.repeat(1024*1024)+'THE END')");
    expect(result.outputTruncated).toBe(true);
    expect(result.output.length).toBeLessThan(17 * 1024);
    expect(result.output.endsWith("THE END")).toBe(true);
  });

  it("stops when the run is cancelled", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_000);
    const result = await node("setInterval(() => {}, 1000)", { signal: controller.signal });
    expect(result).toMatchObject({ status: "ERRORED", error: "Cancelled" });
  });

  it("reports a missing executable as an error, not a failing check", async () => {
    const result = await sandbox.run({
      image: IMAGE,
      workspaceDir,
      cacheDir,
      executable: "jest",
      args: [],
      timeoutMs: 30_000,
      network: "none",
      limits: DEFAULT_SANDBOX_LIMITS,
      maxOutputBytes: 4_096,
    });
    expect(result).toMatchObject({ status: "ERRORED", error: "jest could not be started in the sandbox" });
  });
});
