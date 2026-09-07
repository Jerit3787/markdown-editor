import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
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
    // No wrangler dev running behind this server (the collab project
    // talks to its own, started separately by e2e-collab.sh) — tells
    // client/vite.config.ts's /api proxy to skip straight to a quiet 404
    // instead of attempting, and logging, a doomed connection to :8787.
    env: { VITE_DISABLE_API_PROXY: "1" },
  },
  projects: [
    {
      name: "local",
      testDir: "./tests/e2e/local",
      use: { baseURL: "http://localhost:5275" },
    },
    {
      // Mobile-Safari-width visual checks that the Chromium `local`
      // project can't do — native form-control chrome differs by engine
      // (and, for a real iPhone, by OS). WebKit-the-engine is not
      // iOS-Safari-the-platform: `<select>` renders with the host OS's
      // appearance, not iOS's wheel picker. It still catches the
      // regression classes that matter (CSS/layout under WebKit, the
      // width-computation logic, the ellipsis fallback). Off the same
      // client-only vite dev server as `local`.
      name: "webkit",
      testDir: "./tests/e2e/webkit",
      use: { ...devices["iPhone 13"], baseURL: "http://localhost:5275" },
    },
    {
      name: "collab",
      testDir: "./tests/e2e/collab",
      use: { baseURL: "http://localhost:8787" },
      // Every assertion in this suite is a cross-process round trip
      // (browser A → WebSocket → wrangler dev → Durable Object → Yjs →
      // WebSocket → browser B → Svelte → CodeMirror). The 5s default is
      // the budget for a single-page DOM assertion, not this — and
      // GitHub Actions' shared runners run it a few times slower than a
      // dev machine. 15s gives the working-but-slow path room without
      // hiding a genuinely broken sync (which still fails).
      expect: { timeout: 15000 },
      // wrangler dev is started separately by tests/scripts/e2e-collab.sh
      // (Task 11), after applying the dev-login patch — outside
      // Playwright's own webServer lifecycle entirely.
      //
      // Runs serially: e2e-collab.sh passes `--workers=1`. Every test here
      // shares that one wrangler dev + its Durable Object storage, so
      // parallelism buys no isolation, only contention — which starved the
      // sync-heavy specs on CI's shared runners. See that script's comment.
      fullyParallel: false,
    },
    {
      // Opt-in real-GitHub suite (GIST-11 / REPO-19 / REPO-22). wrangler
      // dev + the `?real=1` dev-login session are set up by
      // tests/scripts/e2e-github.sh, which skips entirely without a
      // configured throwaway account (see tests/e2e/github/README.md).
      // Serial: one wrangler dev, and real GitHub is rate-limited.
      name: "github",
      testDir: "./tests/e2e/github",
      use: { baseURL: "http://localhost:8787" },
      fullyParallel: false,
    },
  ],
});
