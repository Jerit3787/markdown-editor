import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { playwright } from "@vitest/browser-playwright";

// Some sandboxed dev environments pre-stage a Chromium build at a fixed
// path outside Playwright's own managed cache, which can trail whatever
// playwright-core version this repo currently has installed (a revision
// mismatch playwright-core treats as "not installed" and refuses to
// launch). Pointing executablePath at it directly bypasses that revision
// check — but only when the path actually exists; everywhere else
// (CI, a normal contributor machine) this stays undefined and Playwright
// resolves its own normally-installed browser exactly as it already does
// for this repo's Playwright e2e suite.
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium";
const launchOptions = existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : undefined;

// Two projects, one command (`npm test` / `vitest run` still runs both):
// "unit" is the original plain-Node/jsdom suite, unchanged. "components"
// is new — real Svelte components mounted in a real Chromium instance
// (via vitest-browser-svelte + the Playwright provider, reusing the same
// Chromium this repo's Playwright e2e suite already uses) rather than
// jsdom, since jsdom can't run Svelte 5's compiled output faithfully and
// the project has no existing component-test precedent to match instead.
// Component tests live under tests/client/src/components/ specifically
// (not mixed into the broader tests/client/src/**/*.test.ts glob the
// "unit" project already owns) so the two projects never both try to
// pick up the same file.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/client/src/components/**"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        plugins: [svelte()],
        test: {
          name: "components",
          include: ["tests/client/src/components/**/*.test.ts"],
          setupFiles: ["vitest-browser-svelte"],
          browser: {
            enabled: true,
            // Vitest only defaults to headless under CI — headed needs an
            // X server this repo's dev/CI containers don't have, so this
            // is explicit rather than left to that default.
            headless: true,
            provider: playwright({ launchOptions }),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
