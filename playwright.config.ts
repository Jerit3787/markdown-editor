import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
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
