# ADR 0010: The developer dashboard

- Status: Accepted
- Date: 2026-11-03

## Context

Week 8 turns the web app from a set of pages that each show one API response into a dashboard a developer uses every day. It needs to answer: what is waiting on me, what is the agent doing, what happened to this task and why, what does the change look like, and what is it costing. The task data already existed; the API needed list and summary endpoints, and the UI needed structure and tests.

## Decision

1. **Status groups are shared.**
   - `TASK_STATUS_GROUPS` in contracts maps every status to exactly one group: `review` (a person is needed: plan approval or PR review), `active`, `done` (PR opened), `failed`, or `cancelled`. A test ensures no status is missing.
   - The API filters and counts by group, and the UI labels them, so "waiting for review" means the same thing on every page.
2. **Lists use cursor pagination.**
   - `GET /tasks` returns `{ items, nextCursor }`, ordered by `(created_at desc, id desc)`. The cursor is opaque and URL-safe, and a malformed one is a `400`.
   - New tasks never shift a page the reader is on, which offset pagination would.
   - Each list item carries its last activity, PR, and cost, fetched with two grouped queries per page instead of one per task.
3. **One `TaskLister`, one visibility rule.**
   - The task list, the dashboard, and repository pages all list tasks through `TaskLister`. It starts every query from "repositories this user can access on GitHub, still installed", so a list can never show a task the detail endpoint would hide.
   - Usage is narrower: `GET /usage` reports only the user's own model calls.
4. **The task page is a history, not a snapshot.**
   - A progress stepper is derived from the persisted transitions. It shows done, current, failed, and skipped stages, the time in each, and how many times a stage repeated (checks and repairs).
   - An execution log turns every event into a readable line. Model calls show their errors.
   - Patch versions are tabs (`?patch=n`), so every attempt's diff stays reviewable.
   - The diff viewer parses the stored unified diff into files and hunks with old and new line numbers. Large files start collapsed, and rendering stops at 4,000 lines.
   - All model, issue, and check text is rendered as text, never HTML. An end-to-end test plants a `<script>` in a diff to check this.
5. **Client components do not import runtime code from contracts.** Contracts compile to CommonJS, which the bundler cannot tree-shake, so one import pulled zod into the browser. Server pages compute permissions and lists and pass plain props, which halved the repository pages' first-load JavaScript.
6. **Correct statuses over loading spinners.** A root `loading.tsx` makes Next.js stream the page with a `200` before `notFound()` can set `404`. The pages render in milliseconds, so there is no global loading state, and missing or forbidden pages return a real `404`.
7. **Two test layers for the web app.**
   - Jest covers the pure logic: the diff parser, progress, and formatters.
   - Playwright runs the production build against a dependency-free fixture API (`apps/web/e2e/fixture-api.mjs`). The fixture serves contract-shaped data and records every POST.
   - The end-to-end tests cover the review queue, filters and paging, plan approval, opening a PR, versioned diffs, the log, repository and usage pages, the 404, and HTML injection. They need no GitHub, model, or database, so they run in CI on every push.

## Consequences

- `GET /tasks` changed from an array to a page object; the web app was its only consumer.
- The fixture API must follow contract changes. Its data is typed only by convention, so a contract change that breaks the UI shows up as a failing end-to-end test rather than a type error.
- Rewrites to the API are fixed at build time, so the end-to-end run builds the web app pointed at the fixture (ports 3100 and 4100, clear of the dev servers).
- Live updates still poll (`AutoRefresh`, every 3 seconds while a task is active). Server-sent events would cut that load, but polling is enough at this scale.
