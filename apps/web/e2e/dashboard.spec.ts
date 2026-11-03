import { expect, test } from "@playwright/test";

const API = "http://localhost:4100";
const PLAN_TASK = "00000000-0000-4000-8000-000000000001";
const REVIEW_TASK = "00000000-0000-4000-8000-000000000002";
const REPO_ID = "11111111-1111-4111-8111-111111111111";

test.beforeEach(async ({ request }) => {
  await request.post(`${API}/__reset`);
});

test("the dashboard shows the review queue, counts, and navigation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");

  const review = page.getByRole("link", { name: /waiting for review/ });
  await expect(review).toContainText("2");
  const queue = page.locator("section", { has: page.getByRole("heading", { name: "Waiting for you" }) });
  await expect(queue.getByRole("link", { name: "Fix totalPages rounding" })).toBeVisible();
  await expect(queue.getByRole("link", { name: "Repair pagination after a failing check" })).toBeVisible();

  await review.click();
  await expect(page).toHaveURL(/\/tasks\?group=review$/);
  await expect(page.getByRole("link", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
});

test("the task list filters by status and pages through older tasks", async ({ page }) => {
  await page.goto("/tasks");
  await expect(page.getByRole("row")).toHaveCount(26); // header + 25
  await page.getByRole("link", { name: "Older tasks →" }).click();
  await expect(page).toHaveURL(/cursor=page25/);
  await expect(page.getByRole("link", { name: /^Older task / }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Older tasks →" })).toHaveCount(0);

  await page.getByRole("link", { name: "Failed" }).click();
  await expect(page).toHaveURL(/group=failed/);
  await expect(page.getByRole("link", { name: "Rewrite the build system" })).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(2);
});

test("a reviewer approves the plan and the task moves on", async ({ page, request }) => {
  await page.goto(`/tasks/${PLAN_TASK}`);
  await expect(page.locator(".stepper li[data-state='current']")).toContainText("Plan review");
  await expect(page.getByText("Use Math.ceil instead of Math.floor")).toBeVisible();

  await page.getByRole("button", { name: "Approve plan v1" }).click();
  await expect(page.locator(".stepper li[data-state='current']")).toContainText("Patch");
  await expect(page.getByText("awaiting plan approval → generating patch")).toBeVisible();

  const posts = await (await request.get(`${API}/__posts`)).json();
  expect(posts).toEqual([{ path: `/api/tasks/${PLAN_TASK}/plan/approve`, body: { version: 1 } }]);
});

test("the task page shows the repair history, versioned diffs, checks, and log", async ({ page }) => {
  await page.goto(`/tasks/${REVIEW_TASK}`);

  // Progress: checks ran twice, the repair happened, the plan review was not skipped.
  await expect(page.locator(".stepper li[data-state='current']")).toContainText("Review");
  await expect(page.locator(".stepper li", { hasText: "Checks" })).toContainText("2×");
  await expect(page.locator(".stepper li", { hasText: "Repair" })).toHaveAttribute("data-state", "done");

  // The latest patch's diff, per file, with line numbers; model text renders as text, never as HTML.
  const patch = page.locator("#patch");
  await expect(patch.getByRole("link", { name: /v2/ })).toHaveAttribute("aria-current", "page");
  await expect(patch.locator(".diff-file-box")).toHaveCount(2);
  await expect(patch.locator("tr.add", { hasText: "Math.ceil" })).toBeVisible();
  await expect(patch.getByText("<script>window.__xss = true</script> must render as text")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __xss?: boolean }).__xss)).toBeUndefined();

  // The first version is one click away.
  await patch.getByRole("link", { name: /v1/ }).click();
  await expect(page).toHaveURL(/patch=1/);
  await expect(page.locator("#patch tr.add", { hasText: "Math.round" })).toBeVisible();

  await expect(page.locator("#checks")).toContainText("expected 4, received 3");
  await expect(page.locator("#log")).toContainText("Patch attempt 1 rejected by validation");
  await expect(page.locator("#model-calls")).toContainText("the find text does not occur in the file");
});

test("opening a draft PR names the verified patch version", async ({ page, request }) => {
  await page.goto(`/tasks/${REVIEW_TASK}`);
  await page.getByRole("button", { name: "Open draft PR for patch v2" }).click();
  await expect(page.getByText("Pushing the branch and opening the draft pull request…")).toBeVisible();
  const posts = await (await request.get(`${API}/__posts`)).json();
  expect(posts).toEqual([{ path: `/api/tasks/${REVIEW_TASK}/pull-request`, body: { patchVersion: 2 } }]);
});

test("the repository page links to its tasks and checks", async ({ page }) => {
  await page.goto(`/repositories/${REPO_ID}`);
  await expect(page.getByRole("heading", { level: 1, name: "acme/shop" })).toBeVisible();
  await expect(page.getByText("128 indexed")).toBeVisible();
  await expect(page.getByRole("link", { name: "View checks →" })).toHaveAttribute("href", `/repositories/${REPO_ID}/checks`);
  await page.getByRole("link", { name: /waiting for review/ }).click();
  await expect(page).toHaveURL(new RegExp(`repositoryId=${REPO_ID}&group=review`));
});

test("the usage page charts tokens for a free provider and switches windows", async ({ page }) => {
  await page.goto("/usage");
  await expect(page.getByRole("heading", { name: "Tokens per day" })).toBeVisible();
  await expect(page.locator(".bars > div")).toHaveCount(30);
  await expect(page.getByRole("cell", { name: "ollama" })).toBeVisible();
  await page.getByRole("link", { name: "Last 7 days" }).click();
  await expect(page.locator(".bars > div")).toHaveCount(7);
});

test("unknown tasks show the not-found page", async ({ page }) => {
  const response = await page.goto("/tasks/00000000-0000-4000-8000-999999999999");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
});
