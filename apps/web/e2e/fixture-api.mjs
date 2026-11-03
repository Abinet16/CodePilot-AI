// A stand-in for the CodePilot API, for end-to-end tests of the web app.
// It serves fixed data in the shapes of @codepilot/contracts, keeps state in memory,
// and records every POST so tests can assert on what the UI sent.
// Not for production: it has no authentication and no persistence.
import { createServer } from "node:http";

const PORT = Number(process.env.FIXTURE_API_PORT ?? 4100);
const SHA = "3f9ce46" + "a".repeat(33);
const REPO_ID = "11111111-1111-4111-8111-111111111111";
const REPO = "acme/shop";
const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PLAN_TASK = id(1);
const REVIEW_TASK = id(2);
const PR_TASK = id(3);
const FAILED_TASK = id(4);

const plan = {
  summary: "Count the last partial page in totalPages.",
  assumptions: ["Page size is always positive"],
  affectedFiles: [
    { path: "src/pagination.ts", change: "modify", reason: "Holds the rounding bug" },
    { path: "src/pagination.test.ts", change: "create", reason: "Regression test" },
  ],
  implementationSteps: ["Use Math.ceil instead of Math.floor", "Add a test for 10 items in pages of 3"],
  testPlan: ["pnpm test"],
  risks: ["Callers that relied on the old count"],
};

const diffV1 = [
  `diff --git a/src/pagination.ts b/src/pagination.ts`,
  `index ${SHA}..${SHA}`,
  `--- a/src/pagination.ts`,
  `+++ b/src/pagination.ts`,
  `@@ -1,3 +1,3 @@`,
  ` export function totalPages(total: number, size: number): number {`,
  `-  return Math.floor(total / size);`,
  `+  return Math.round(total / size);`,
  ` }`,
  ``,
].join("\n");

const diffV2 = [
  `diff --git a/src/pagination.test.ts b/src/pagination.test.ts`,
  `new file mode 100644`,
  `index ${"0".repeat(40)}..${SHA}`,
  `--- /dev/null`,
  `+++ b/src/pagination.test.ts`,
  `@@ -0,0 +1,3 @@`,
  `+import { totalPages } from "./pagination";`,
  `+// <script>window.__xss = true</script> must render as text`,
  `+test("last page", () => expect(totalPages(10, 3)).toBe(4));`,
  `diff --git a/src/pagination.ts b/src/pagination.ts`,
  `index ${SHA}..${SHA}`,
  `--- a/src/pagination.ts`,
  `+++ b/src/pagination.ts`,
  `@@ -1,3 +1,3 @@`,
  ` export function totalPages(total: number, size: number): number {`,
  `-  return Math.floor(total / size);`,
  `+  return Math.ceil(total / size);`,
  ` }`,
  ``,
].join("\n");

function patch(version, status, diff, files) {
  return {
    version,
    status,
    planVersion: 1,
    baseSha: SHA,
    commitSha: `${version}`.repeat(40),
    treeSha: `e${version}`.repeat(20),
    branchName: "codepilot/fix-pagination-00000000",
    summary: version === 1 ? "Round the page count." : "Round the page count up and add a regression test.",
    commitMessage: "Count the last partial page",
    model: "qwen2.5-coder:7b",
    files,
    unchangedPlanFiles: version === 1 ? ["src/pagination.test.ts"] : [],
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    createdAt: ago(version === 1 ? 30 : 20),
    diff,
  };
}

const move = (n, from, to, minutes, payload = {}) => ({ id: `e${n}`, eventType: "status_changed", fromStatus: from, toStatus: to, payload, createdAt: ago(minutes) });
const note = (n, eventType, minutes, payload = {}) => ({ id: `e${n}`, eventType, fromStatus: null, toStatus: null, payload, createdAt: ago(minutes) });

function baseTask(taskId, title, status, extra = {}) {
  return {
    id: taskId,
    repositoryId: REPO_ID,
    repositoryFullName: REPO,
    issueId: null,
    title,
    status,
    baseSha: SHA,
    branchName: null,
    failureReason: null,
    createdAt: ago(60),
    startedAt: ago(59),
    completedAt: null,
    description: `${title}: 10 items in pages of 3 should be 4 pages.`,
    issue: null,
    requirePlanApproval: true,
    analysis: null,
    plans: [],
    patches: [],
    checks: [],
    pullRequest: null,
    runs: [],
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    events: [{ id: "e0", eventType: "task_created", fromStatus: null, toStatus: "QUEUED", payload: {}, createdAt: ago(60) }],
    ...extra,
  };
}

const run = (n, stage, status, error = null) => ({
  attemptNumber: n,
  stage,
  model: "qwen2.5-coder:7b",
  status,
  inputTokens: 9_000,
  outputTokens: 600,
  error,
  startedAt: ago(50 - n * 5),
  completedAt: ago(49 - n * 5),
});

function initialState() {
  const tasks = new Map();
  tasks.set(
    PLAN_TASK,
    baseTask(PLAN_TASK, "Fix totalPages rounding", "AWAITING_PLAN_APPROVAL", {
      plans: [{ version: 1, status: "PROPOSED", plan, model: "qwen2.5-coder:7b", feedback: null, reviewedBy: null, reviewedAt: null, createdAt: ago(40) }],
      runs: [run(1, "PLANNING", "SUCCEEDED")],
      usage: { inputTokens: 9_000, outputTokens: 600, estimatedCostUsd: 0 },
      events: [
        { id: "e0", eventType: "task_created", fromStatus: null, toStatus: "QUEUED", payload: {}, createdAt: ago(60) },
        move(1, "QUEUED", "ANALYZING", 58),
        note(2, "commit_pinned", 57, { branch: "main", commitSha: SHA }),
        move(3, "ANALYZING", "PLANNING", 50),
        note(4, "plan_proposed", 41, { version: 1, affectedFiles: 2 }),
        move(5, "PLANNING", "AWAITING_PLAN_APPROVAL", 40),
      ],
    }),
  );
  tasks.set(
    REVIEW_TASK,
    baseTask(REVIEW_TASK, "Repair pagination after a failing check", "READY_FOR_REVIEW", {
      branchName: "codepilot/fix-pagination-00000000",
      plans: [{ version: 1, status: "APPROVED", plan, model: "qwen2.5-coder:7b", feedback: null, reviewedBy: "alice", reviewedAt: ago(45), createdAt: ago(46) }],
      patches: [
        patch(1, "REJECTED", diffV1, [{ path: "src/pagination.ts", change: "modify", additions: 1, deletions: 1 }]),
        patch(2, "VERIFIED", diffV2, [
          { path: "src/pagination.test.ts", change: "create", additions: 3, deletions: 0 },
          { path: "src/pagination.ts", change: "modify", additions: 1, deletions: 1 },
        ]),
      ],
      checks: [
        {
          id: "run-1",
          patchVersion: 1,
          status: "FAILED",
          runnerImage: "codepilot/sandbox-node:22",
          error: null,
          results: [{ profileId: "test", kind: "test", command: "pnpm run test", status: "FAILED", exitCode: 1, durationMs: 4_200, output: "expected 4, received 3", outputTruncated: false }],
          startedAt: ago(29),
          completedAt: ago(28),
        },
        {
          id: "run-2",
          patchVersion: 2,
          status: "PASSED",
          runnerImage: "codepilot/sandbox-node:22",
          error: null,
          results: [{ profileId: "test", kind: "test", command: "pnpm run test", status: "PASSED", exitCode: 0, durationMs: 3_900, output: "1 passed", outputTruncated: false }],
          startedAt: ago(19),
          completedAt: ago(18),
        },
      ],
      runs: [run(1, "PLANNING", "SUCCEEDED"), run(2, "GENERATING_PATCH", "SUCCEEDED"), run(3, "REPAIRING", "FAILED", "Invalid patch: src/pagination.ts edit 1: the find text does not occur in the file"), run(4, "REPAIRING", "SUCCEEDED")],
      usage: { inputTokens: 36_000, outputTokens: 2_400, estimatedCostUsd: 0 },
      events: [
        { id: "e0", eventType: "task_created", fromStatus: null, toStatus: "QUEUED", payload: {}, createdAt: ago(60) },
        move(1, "QUEUED", "ANALYZING", 58),
        move(2, "ANALYZING", "PLANNING", 52),
        move(3, "PLANNING", "AWAITING_PLAN_APPROVAL", 46),
        move(4, "AWAITING_PLAN_APPROVAL", "GENERATING_PATCH", 45, { reason: "plan_approved", version: 1 }),
        note(5, "patch_created", 31, { version: 1, files: 1, additions: 1, deletions: 1 }),
        move(6, "GENERATING_PATCH", "RUNNING_CHECKS", 30),
        note(7, "checks_failed", 28, { patchVersion: 1, status: "FAILED" }),
        move(8, "RUNNING_CHECKS", "REPAIRING", 28),
        note(9, "patch_invalid", 25, { attempt: 1, problems: ["src/pagination.ts edit 1: the find text does not occur in the file"] }),
        note(10, "patch_created", 21, { version: 2, files: 2, additions: 4, deletions: 1 }),
        move(11, "REPAIRING", "RUNNING_CHECKS", 20),
        note(12, "checks_passed", 18, { patchVersion: 2 }),
        move(13, "RUNNING_CHECKS", "READY_FOR_REVIEW", 18),
      ],
    }),
  );
  tasks.set(
    PR_TASK,
    baseTask(PR_TASK, "Add a retry to the webhook client", "PR_OPENED", {
      completedAt: ago(5),
      pullRequest: {
        number: 42,
        url: "https://github.com/acme/shop/pull/42",
        status: "DRAFT",
        patchVersion: 1,
        branchName: "codepilot/add-retry-00000003",
        baseBranch: "main",
        headSha: SHA,
        createdAt: ago(5),
        mergedAt: null,
        closedAt: null,
        lastSyncedAt: ago(1),
      },
    }),
  );
  tasks.set(FAILED_TASK, baseTask(FAILED_TASK, "Rewrite the build system", "FAILED", { failureReason: "The model's plan failed validation 2 times", completedAt: ago(10) }));
  // Enough older tasks to need a second page.
  for (let n = 10; n < 40; n++) tasks.set(id(n), baseTask(id(n), `Older task ${n}`, "CANCELLED", { createdAt: ago(600 + n), completedAt: ago(599 + n) }));
  return { tasks, posts: [] };
}

let state = initialState();

const GROUPS = {
  review: ["AWAITING_PLAN_APPROVAL", "READY_FOR_REVIEW"],
  active: ["QUEUED", "ANALYZING", "PLANNING", "GENERATING_PATCH", "RUNNING_CHECKS", "REPAIRING", "OPENING_PR"],
  done: ["PR_OPENED"],
  failed: ["FAILED"],
  cancelled: ["CANCELLED"],
};
const groupOf = (status) => Object.keys(GROUPS).find((g) => GROUPS[g].includes(status));

function listItem(task) {
  const { description, issue, requirePlanApproval, analysis, plans, patches, checks, runs, usage, events, pullRequest, ...summary } = task;
  void description, issue, requirePlanApproval, analysis, plans, patches, checks, runs, events;
  return {
    ...summary,
    group: groupOf(task.status),
    updatedAt: task.events.at(-1)?.createdAt ?? task.createdAt,
    pullRequest: pullRequest ? { number: pullRequest.number, url: pullRequest.url, status: pullRequest.status } : null,
    estimatedCostUsd: usage.estimatedCostUsd,
  };
}

const sorted = () => [...state.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const counts = (tasks) => Object.fromEntries(Object.keys(GROUPS).map((g) => [g, tasks.filter((t) => groupOf(t.status) === g).length]));

const repository = {
  id: REPO_ID,
  owner: "acme",
  name: "shop",
  fullName: REPO,
  defaultBranch: "main",
  isPrivate: true,
  enabled: true,
  permission: "ADMIN",
  installationStatus: "ACTIVE",
};

function usage(days) {
  const daily = Array.from({ length: days }, (_, i) => {
    const day = new Date(now - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    const calls = i % 3 === 0 ? 4 : 0;
    return { key: day, inputTokens: calls * 9_000, outputTokens: calls * 600, estimatedCostUsd: 0, calls };
  });
  const totals = daily.reduce((t, d) => ({ inputTokens: t.inputTokens + d.inputTokens, outputTokens: t.outputTokens + d.outputTokens, estimatedCostUsd: 0, calls: t.calls + d.calls }), {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    calls: 0,
  });
  return {
    days,
    since: daily[0].key + "T00:00:00.000Z",
    totals,
    daily,
    byModel: [{ key: "qwen2.5-coder:7b", ...totals }],
    byProvider: [{ key: "ollama", ...totals }],
    byRepository: [{ key: REPO, ...totals }],
  };
}

function route(method, path, query, body) {
  const tasks = sorted();
  if (method === "GET" && path === "/api/auth/me") return [200, { id: "user-1", githubLogin: "alice", name: "Alice", avatarUrl: null }];
  if (method === "GET" && path === "/api/health") return [200, { status: "ok", checks: { database: "ok", redis: "ok" } }];
  if (method === "GET" && path === "/api/dashboard") {
    return [
      200,
      {
        counts: counts(tasks),
        needsReview: tasks.filter((t) => groupOf(t.status) === "review").reverse().map(listItem),
        recent: tasks.slice(0, 10).map(listItem),
        pullRequests: { DRAFT: 1, OPEN: 0, CLOSED: 0, MERGED: 0 },
        repositories: { visible: 1, enabled: 1 },
        usage: { days: 30, inputTokens: 45_000, outputTokens: 3_000, estimatedCostUsd: 0 },
      },
    ];
  }
  if (method === "GET" && path === "/api/tasks") {
    const filtered = tasks.filter((t) => (!query.get("group") || groupOf(t.status) === query.get("group")) && (!query.get("repositoryId") || t.repositoryId === query.get("repositoryId")));
    const limit = Number(query.get("limit") ?? 25);
    const start = query.get("cursor") ? Number(query.get("cursor").replace("page", "")) : 0;
    const items = filtered.slice(start, start + limit).map(listItem);
    return [200, { items, nextCursor: start + limit < filtered.length ? `page${start + limit}` : null }];
  }
  const taskMatch = /^\/api\/tasks\/([0-9a-f-]{36})(\/.*)?$/.exec(path);
  if (taskMatch) {
    const task = state.tasks.get(taskMatch[1]);
    if (!task) return [404, { message: "Task not found" }];
    const rest = taskMatch[2] ?? "";
    if (method === "GET" && rest === "") return [200, { ...task, patches: task.patches.map(({ diff, ...p }) => (void diff, p)) }];
    const patchMatch = /^\/patches\/(\d+)$/.exec(rest);
    if (method === "GET" && patchMatch) {
      const found = task.patches.find((p) => p.version === Number(patchMatch[1]));
      return found ? [200, found] : [404, { message: "Patch not found" }];
    }
    if (method === "POST") {
      state.posts.push({ path, body });
      if (rest === "/plan/approve" && task.status === "AWAITING_PLAN_APPROVAL" && body?.version === task.plans.at(-1)?.version) {
        task.plans.at(-1).status = "APPROVED";
        task.plans.at(-1).reviewedBy = "alice";
        task.events.push(move(100, "AWAITING_PLAN_APPROVAL", "GENERATING_PATCH", 0, { reason: "plan_approved", version: body.version }));
        task.status = "GENERATING_PATCH";
        return [200, task];
      }
      if (rest === "/pull-request" && task.status === "READY_FOR_REVIEW" && body?.patchVersion === task.patches.at(-1)?.version) {
        task.events.push(move(101, "READY_FOR_REVIEW", "OPENING_PR", 0, { reason: "pull_request_requested", patchVersion: body.patchVersion }));
        task.status = "OPENING_PR";
        return [200, task];
      }
      return [409, { message: "Conflict" }];
    }
  }
  if (method === "GET" && path === "/api/repositories") return [200, [repository]];
  if (method === "GET" && path === `/api/repositories/${REPO_ID}`) {
    const mine = tasks.filter((t) => t.repositoryId === REPO_ID);
    return [
      200,
      {
        ...repository,
        latestSnapshot: { commitSha: SHA, indexedAt: ago(58), primaryLanguage: "typescript", packageManager: "pnpm", testFrameworks: ["Vitest"], indexedFiles: 128 },
        checksConfigured: true,
        openIssues: 3,
        taskCounts: counts(mine),
        recentTasks: mine.slice(0, 5).map(listItem),
      },
    ];
  }
  if (method === "GET" && path === `/api/repositories/${REPO_ID}/issues`) return [200, []];
  if (method === "GET" && path === "/api/usage") return [200, usage(Number(query.get("days") ?? 30))];
  return [404, { message: "Not found" }];
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    if (url.pathname === "/__reset" && req.method === "POST") {
      state = initialState();
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/__posts") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state.posts));
      return;
    }
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    const [status, payload] = route(req.method ?? "GET", url.pathname, url.searchParams, body);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
  });
}).listen(PORT, () => console.log(`fixture API on http://localhost:${PORT}`));
