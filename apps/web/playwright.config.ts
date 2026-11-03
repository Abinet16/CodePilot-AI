import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests of the production build against a fixture API (e2e/fixture-api.mjs),
 * so they need neither GitHub nor a model nor a database. Ports avoid the dev servers
 * (3000 web, 4000 API). Rewrites to the API are fixed at build time, so the web app is
 * built with API_ORIGIN pointing at the fixture.
 */
const WEB_PORT = 3100;
const API_PORT = 4100;
const API_ORIGIN = `http://localhost:${API_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Tests share the fixture's in-memory state and reset it before each test.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node e2e/fixture-api.mjs",
      url: `${API_ORIGIN}/api/health`,
      env: { FIXTURE_API_PORT: String(API_PORT) },
      reuseExistingServer: false,
    },
    {
      command: `pnpm exec next build && pnpm exec next start --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      env: { API_ORIGIN },
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
