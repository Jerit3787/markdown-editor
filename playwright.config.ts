import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // Zero retries locally (a real failure should fail fast); up to 2
  // attempts in CI before a test counts as failed, absorbing one-off
  // timing flakiness on GitHub Actions' shared runners without masking
  // a genuinely broken test (it still fails the required check if all
  // 3 attempts fail).
  retries: process.env.CI ? 2 : 0,
  // "list" alone prints to stdout but never writes anything to disk —
  // the CI job's upload-artifact step needs an actual playwright-report/
  // directory to exist, which only the "html" reporter produces
  // (confirmed live: a first CI run's upload step found nothing to
  // upload with "list" alone, uploading zero files silently rather than
  // failing the job outright). open: "never" keeps CI from trying to
  // launch a browser to preview the report it just wrote.
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    // Captured starting from the first retry of anything that failed
    // once — exactly the run whose failure needs debugging. No tracing
    // overhead on a first-attempt pass, the common case.
    trace: "on-first-retry",
    // Cheap, always useful at the moment of failure, independent of
    // whether retries are enabled.
    screenshot: "only-on-failure",
  },
  // Top-level only — @playwright/test's TestProject type has no
  // per-project webServer field (confirmed against node_modules'
  // own type definitions; a project-nested webServer is silently
  // ignored, not a config error). A --project=collab run also spins
  // this up needlessly (collab tests don't hit it), but
  // reuseExistingServer plus the small size of this dev server makes
  // that overhead negligible for a manual/on-demand suite.
  webServer: {
    command: "vite dev --config client/vite.config.ts --port 5275",
    url: "http://localhost:5275",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "local",
      testDir: "./e2e/local",
      use: { baseURL: "http://localhost:5275" },
    },
    {
      name: "collab",
      testDir: "./e2e/collab",
      use: { baseURL: "http://localhost:8787" },
      // wrangler dev is started separately by scripts/e2e-collab.sh
      // (Task 11), after applying the dev-login patch — outside
      // Playwright's own webServer lifecycle entirely.
    },
  ],
});
