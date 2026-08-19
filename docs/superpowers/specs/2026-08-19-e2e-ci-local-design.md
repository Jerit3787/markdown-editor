# Local E2E Suite in CI — Design

## Context

`e2e/local/*.spec.ts` (10 files, 44 tests) and `e2e/collab/*.spec.ts` (2
files, 3 tests) exist today (`docs/superpowers/specs/2026-08-19-e2e-testing-design.md`)
but are manual/on-demand only — `npm run test:e2e:local` /
`test:e2e:collab` / `test:e2e`, never run by `.github/workflows/test.yml`.
That was a deliberate choice at the time (the collab suite's
infrastructure — a temporary `src/worker.ts` patch, a real `wrangler dev`
process, Durable Objects — looked like it needed real hosted
infrastructure to run anywhere but a developer's own machine).

Building the collab suite surfaced that assumption was wrong: `wrangler
dev`'s local Durable Objects emulation is fully self-contained (no real
Cloudflare account or API calls involved), so it's plausible to run in
GitHub Actions too. But the `local` suite is unambiguously simpler — just
`vite dev`, no backend, no patch — and CI behavior (headless runner
timing, flakiness under GitHub Actions' shared runners) is unknown for
either suite until something actually runs there. This spec covers only
`local`, going into CI as a required check; `collab` is a deliberately
separate, later spec once `local`'s real-world CI behavior is known.

## Goals

- `.github/workflows/test.yml` gains a second job, `e2e`, running
  `npm run test:e2e:local` on every push to `master` and every PR
  targeting `master` — the same triggers the existing `test` job already
  uses.
- `e2e` runs in parallel with `test` (no `needs:`) — both start
  immediately on push/PR.
- `playwright.config.ts` gains CI-aware retry and failure-artifact
  settings: `retries: process.env.CI ? 2 : 0`, `trace:
  "on-first-retry"`, `screenshot: "only-on-failure"`.
- On failure, the `e2e` job uploads `playwright-report/` as a workflow
  artifact (`actions/upload-artifact@v4`, `if: failure()`,
  `retention-days: 7`) so a CI-only failure can be debugged via
  Playwright's trace viewer without needing to reproduce it locally.
- Once this lands on `master` and has reported at least once (confirmed
  green on a subsequent PR), `e2e` is added to the repo's `Pass Tests`
  ruleset (`required_status_checks`) alongside the existing `test` and
  `GitGuardian Security Checks` contexts — a failing e2e run blocks
  merging, same as a failing unit-test run does today.

## Non-goals

- `collab` e2e in CI. Needs its own design: applying
  `scripts/manual-testing/dev-login.patch` in an ephemeral CI checkout
  (lower risk than on a developer machine, since there's nothing to
  accidentally commit), starting `wrangler dev`, and reasoning about
  Durable Objects behavior under GitHub Actions specifically. Deferred
  until `local`'s CI behavior is a known quantity.
- Browser-binary caching (`actions/cache` for `~/.cache/ms-playwright`).
  A single Chromium install is fast enough that the added complexity
  (cache-key management, stale-cache edge cases) isn't worth it yet.
- Cross-browser CI coverage (Firefox/WebKit) — the suite is Chromium-only
  today, matching every existing manual script; out of scope here too.
- Sharding/parallelizing across multiple runners. 44 tests finish in
  ~10s locally; not warranted at this scale.
- Any change to what triggers the *unit* `test` job, or to its own
  steps. This spec only adds a sibling job.

## Architecture

### `e2e` job (new, in `.github/workflows/test.yml`)

```yaml
jobs:
  test:
    # unchanged

  e2e:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v7

      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version: 'lts/*'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browser
        run: npx playwright install --with-deps chromium

      - name: Run local e2e suite
        run: npm run test:e2e:local

      - name: Upload Playwright report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7
```

The first four steps mirror the existing `test` job exactly (same
actions, same versions) — the only new setup is installing Chromium.
`--with-deps` also installs the OS-level shared libraries Chromium needs
on a bare `ubuntu-latest` runner (fonts, codecs, etc.), which aren't
present by default.

### `playwright.config.ts` changes

```typescript
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "vite dev --config client/vite.config.ts --port 5275",
    url: "http://localhost:5275",
    reuseExistingServer: !process.env.CI,
  },
  projects: [ /* unchanged */ ],
});
```

- `retries: process.env.CI ? 2 : 0` — zero retries locally (fast
  feedback on a real failure), up to 2 attempts in CI before a test
  counts as failed. A test that needs a retry to pass shows up in the
  Playwright report as flaky (visible in the uploaded artifact even on
  an overall-green run) without blocking the merge on a one-off timing
  hiccup.
- `trace: "on-first-retry"` — no tracing overhead on a first-attempt
  pass (the common case), but a trace is captured starting from the
  first retry of anything that failed once — exactly the run whose
  failure needs debugging.
- `screenshot: "only-on-failure"` — a screenshot at the moment of
  failure, cheap and always useful, independent of whether retries are
  enabled at all.
- `reuseExistingServer: !process.env.CI` already existed (written
  CI-aware from the start, even though nothing used it yet) — GitHub
  Actions sets `CI=true` automatically, so this evaluates to `false` in
  the new job: Playwright always starts its own fresh `vite dev` rather
  than assuming one is already running, which is the correct behavior
  for a clean runner.

### Ruleset update (separate step, after this PR merges)

The `Pass Tests` ruleset (`gh api repos/Jerit3787/markdown-editor/rulesets/20948581`)
currently requires exactly two contexts: `test` and `GitGuardian Security
Checks`. A required status check has to exist and have reported at least
once before GitHub will let a PR satisfy it — adding `e2e` to
`required_status_checks` in the *same* PR that introduces the `e2e` job
would mean that PR (and everything after it) could never merge, because
the check it's waiting on has no prior run to point to.

Sequence:
1. Merge this spec's implementation PR (workflow + config changes only,
   `e2e` **not** yet required).
2. Confirm `e2e` reports (ideally green) on the next real PR against
   `master`.
3. Update the ruleset (via `gh api` PATCH or the GitHub UI) to add
   `{"context": "e2e", "integration_id": 15368}` (same
   `integration_id` as the existing `test` context — both are GitHub
   Actions checks from this same repo) to `required_status_checks`.

Step 3 is *not* part of the implementation plan below — it's a manual
follow-up once step 2 is confirmed, since it can't be verified any other
way than watching a real PR.

## Error handling

- **Flaky test surfaces in CI but not locally**: the uploaded
  `playwright-report/` artifact contains a trace for anything that
  needed a retry, viewable via `npx playwright show-trace
  <trace.zip>` after downloading it from the failed run's Summary page.
  If a test is flaky specifically under GitHub Actions' timing (not
  reproducible locally even under load), the fix is almost always a
  wait/assertion that's too tight for a slower shared runner — the same
  category of fix already made repeatedly while building the collab
  suite (`waitForResponse` instead of a race, explicit settle
  `waitForTimeout`s).
- **`npx playwright install --with-deps chromium` fails** (e.g. a
  transient package-mirror issue on the runner): the job fails outright
  before any tests run — visible immediately as an install-step failure,
  distinct from a test failure, in the job log.
- **A required check with no way to pass ever** (the bootstrapping
  hazard above) — avoided entirely by doing the ruleset update as an
  explicit, separate, manually-verified step rather than folding it into
  the implementation plan.

## Testing

- Verify the new `e2e` job's YAML is valid and steps run in the intended
  order by pushing the implementation branch and watching the Actions
  run directly (no local GitHub-Actions emulator needed — the existing
  `test` job already proves this repo's CI works normally).
- Confirm the job actually fails the way it's supposed to: temporarily
  break one assertion in an `e2e/local/*.spec.ts` file on a scratch
  branch, push, confirm the `e2e` check goes red and the
  `playwright-report` artifact appears on the run's Summary page with a
  usable trace — then revert the temporary breakage before merging
  anything real.
- Confirm retry behavior specifically: a test forced to fail once (e.g.
  a `test.info().retry === 0` guard that throws only on the first
  attempt) should show as passed-with-retry in the report, not as a
  failed check — proving `retries: process.env.CI ? 2 : 0` is wired
  correctly rather than silently `0` everywhere.

## Self-review

- **Placeholder scan**: no TBD/TODO — every step above has concrete
  YAML/config, not a description of what to write.
- **Internal consistency**: the ruleset update is explicitly called out
  as post-merge and out of the implementation plan's scope, avoiding a
  contradiction between "required from day one" (the approved design
  decision) and "can't actually be required until the check has run
  once" (a hard GitHub constraint) — day one here means as soon as
  step 2 above is confirmed, not literally the moment this PR merges.
- **Scope check**: single new CI job + three config fields. Fits one
  implementation plan; no further decomposition needed.
