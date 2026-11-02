import { buildPullRequest } from "./pr-body";
import type { PullRequestInput } from "./pr-body";

const input: PullRequestInput = {
  taskId: "1a2b3c4d-0000-4000-8000-000000000000",
  issue: { number: 42, title: "Last page is missing @octocat" },
  description: null,
  plan: {
    summary: "Count the last partial page",
    assumptions: ["Page size is never 0"],
    affectedFiles: [
      { path: "src/pagination.ts", change: "modify", reason: "Holds the bug" },
      { path: "src/pagination.test.ts", change: "create", reason: "Regression test" },
    ],
    implementationSteps: ["Use Math.ceil"],
    testPlan: [],
    risks: ["Callers may rely on the old count <script>"],
  },
  planVersion: 2,
  planApprovedBy: "alice",
  patch: {
    version: 3,
    summary: "Use Math.ceil. ![x](https://evil.example/p.gif)",
    commitMessage: "Count the last partial page",
    model: "claude-opus-5-5",
    baseSha: "a".repeat(40),
    files: [{ path: "src/pagination.ts", change: "modify", additions: 1, deletions: 1 }],
    unchangedPlanFiles: ["src/pagination.test.ts"],
  },
  repairs: 2,
  baseBranch: "main",
  checks: {
    runnerImage: "codepilot/sandbox-node:22",
    results: [
      { profileId: "typecheck", kind: "typecheck", command: "pnpm run typecheck", status: "PASSED", durationMs: 4_200 },
      { profileId: "test", kind: "test", command: "pnpm run test", status: "PASSED", durationMs: 9_100 },
    ],
  },
};

describe("buildPullRequest", () => {
  const { title, body } = buildPullRequest(input);

  it("uses the commit subject as the title", () => {
    expect(title).toBe("Count the last partial page");
  });

  it("discloses AI authorship and who approved the plan", () => {
    expect(body).toMatch(/^> \[!NOTE\]\n> Opened by CodePilot AI as a draft\. The change was written by an AI model \(`claude-opus-5-5`\) from a plan approved by alice/);
  });

  it("links the issue and lists files with the plan's reasons", () => {
    expect(body).toContain("Resolves #42: Last page is missing @‍octocat");
    expect(body).toContain("| `src/pagination.ts` | modify | +1 −1 | Holds the bug |");
  });

  it("reports exactly the checks that ran, with their results", () => {
    expect(body).toContain("| typecheck (typecheck) | `pnpm run typecheck` | ✅ passed | 4.2s |");
    expect(body).toContain("| test (test) | `pnpm run test` | ✅ passed | 9.1s |");
    expect(body).toContain("These are the only checks that ran.");
  });

  it("makes uncertainty visible", () => {
    expect(body).toContain("- Assumption: Page size is never 0");
    expect(body).toContain("- Risk: Callers may rely on the old count &lt;script&gt;");
    expect(body).toContain("- Planned but left unchanged: `src/pagination.test.ts`");
    expect(body).toContain("- 2 earlier version(s) of this patch failed checks and were repaired.");
  });

  it("neutralizes model-written Markdown", () => {
    expect(body).toContain("Use Math.ceil. !\\[x]\\(https://evil.example/p.gif)");
    expect(body).not.toMatch(/<script>|!\[x\]\(/);
  });

  it("quotes a free-form description when there is no issue", () => {
    const { body: noIssue } = buildPullRequest({ ...input, issue: null, description: "Fix paging\n<b>now</b>" });
    expect(noIssue).toContain("## Problem\n\n> Fix paging\n> &lt;b&gt;now&lt;/b&gt;");
  });

  it("says when the plan was auto-approved", () => {
    expect(buildPullRequest({ ...input, planApprovedBy: null }).body).toContain("from a plan that was auto-approved");
  });
});
