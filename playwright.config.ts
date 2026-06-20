import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e config (Phase 7). Authored as the redesign's regression guard.
 *
 * The orchestrator (not Playwright) starts the Next.js server + Postgres, so there
 * is intentionally NO `webServer` block here. Point the run at a running instance
 * via E2E_BASE_URL, defaulting to http://127.0.0.1:3100.
 *
 * Run with: E2E_BASE_URL=<url> npm run test:e2e
 */
export default defineConfig({
  testDir: "tests/e2e",
  // A single retry smooths over first-paint timing on a freshly started server.
  retries: 1,
  // Per-test timeout — generous enough for cold DB-backed routes, bounded so a
  // hung run fails fast.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:3100",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
