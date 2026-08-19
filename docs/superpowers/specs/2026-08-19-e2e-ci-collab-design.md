# Collab E2E Suite in CI — Design

## Context

`docs/superpowers/specs/2026-08-19-e2e-ci-local-design.md` (Phase 1) put
the `local` Playwright suite into CI as a required check
(`.github/workflows/test.yml`'s `e2e` job), deliberately deferring the
`collab` suite (`e2e/collab/*.spec.ts` — `wrangler dev`, Durable
Objects, a temporary `src/worker.ts` dev-login patch) until `local`'s
real-world CI behavior was known. It's now known: `e2e` has run
repeatedly on real PRs, passed consistently (~1m15-20s per run), is a
required status check, and the one anomaly observed (a ~5-minute hang
during `npx playwright install --with-deps chromium`) was a transient
GitHub Actions runner issue unrelated to this repo's config — cancelling
and re-running resolved it immediately, with no code change needed.

`scripts/e2e-collab.sh` already runs the full collab flow locally,
non-interactively, with its own reliability hardening already baked in
from building it in Phase 0 (the original e2e-testing spec): a
trap-based cleanup that reverts the dev-login patch and kills `wrangler
dev` (including its underlying `workerd` child, found by port rather
than PID) on any exit — clean, failed, or interrupted. Every command it
uses (`git apply`, `curl`, `lsof`, `bash`) is plain POSIX tooling, not
macOS-specific. This spec puts that exact script into CI as a second new
required job.

## Goals

- `.github/workflows/test.yml` gains a third job, `e2e-collab`, running
  `npm run test:e2e:collab` (i.e. `bash scripts/e2e-collab.sh`,
  unmodified) on the same triggers as `test`/`e2e` — push to `master`,
  PRs targeting `master`.
- `e2e-collab` runs in parallel with `test` and `e2e` — no `needs:`.
- `e2e-collab` gets `timeout-minutes: 10`. `e2e` retroactively gets the
  same, prompted directly by the install hang observed in this session
  — a genuine hang should fail loudly well before GitHub's 6-hour
  default job limit, not require a human noticing and cancelling it by
  hand.
- Job steps: checkout, setup-node (same as `test`/`e2e`), `npm ci`,
  `npx playwright install --with-deps chromium`, `npm run
  test:e2e:collab`, then an on-failure upload of `playwright-report/`
  — same shape as `e2e`, but the artifact is named
  `playwright-report-collab` (not `playwright-report`) since both jobs
  run in the same workflow run and `actions/upload-artifact@v4`
  requires unique names within a run.
- No new CI secrets. `scripts/manual-testing/enable-dev-login.sh`
  already creates its own `.dev.vars` (`SESSION_SECRET=local-test-
  secret-do-not-use-in-prod`) if one doesn't exist — the dev-login
  bypass never touches real GitHub OAuth, so nothing beyond what's
  already in the repo is needed.
- Once this lands on `master` and `e2e-collab` has reported green on a
  real PR, it's added to the `Pass Tests` ruleset's
  `required_status_checks` alongside `test`, `e2e`, and `GitGuardian
  Security Checks` — same bootstrapping sequence Phase 1 used (a
  required check can't be required before it's ever run once).

## Non-goals

- Any change to `scripts/e2e-collab.sh`,
  `scripts/manual-testing/enable-dev-login.sh`/`disable-dev-login.sh`,
  or `scripts/manual-testing/dev-login.patch`. All three are reused
  exactly as they already exist and have already been exercised
  (including their crash-path cleanup, verified via a deliberate
  mid-run `SIGTERM` during Phase 0's own implementation).
- Hardening the trap-based cleanup further for CI's sake. It's moot in
  CI: every job runs on a fresh, disposable VM that's discarded
  afterward regardless of how the job ends, so there's no persistent
  developer machine for a leftover patch or orphaned `wrangler`
  process to actually threaten. The trap's real audience is still a
  human running this locally.
- Any change to `e2e`'s own steps beyond adding `timeout-minutes: 10`.
- Deduplicating the near-identical checkout/setup-node/npm-ci/playwright
  -install preamble shared by `e2e` and `e2e-collab` (e.g. via a
  reusable workflow or composite action). Two small, readable jobs is
  simpler than the indirection a shared action would add, at this
  scale (3 jobs total).

## Architecture

### `e2e-collab` job (new, in `.github/workflows/test.yml`)

```yaml
jobs:
  test:
    # unchanged

  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    # steps unchanged from Phase 1

  e2e-collab:
    runs-on: ubuntu-latest
    timeout-minutes: 10

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

      - name: Run collab e2e suite
        run: npm run test:e2e:collab

      - name: Upload Playwright report
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report-collab
          path: playwright-report/
          retention-days: 7
```

`npm run test:e2e:collab` is already `bash scripts/e2e-collab.sh`
(`package.json`, unchanged by this spec) — the CI job's only
responsibility is providing the environment that script already expects
(Node, npm deps, a Chromium binary) and reacting to its exit code. The
script itself owns the entire patch → build → `wrangler dev` → test →
cleanup sequence, identically to a local run.

### Timeout rationale

`timeout-minutes: 10` on both `e2e` and `e2e-collab`: real runs finish
in ~1-2 minutes each (collab's `npm run build` adds real time over
`e2e`'s plain `vite dev` — the wrangler bundle is larger — but still
well under a minute in local timing observed this session). 10 minutes
gives generous headroom for a slow (not hung) runner while still
failing within a bounded time instead of GitHub's 6-hour default if
something genuinely wedges — exactly the scenario just observed on
`e2e`'s own browser-install step, which required a manual cancel this
session because nothing was there to time it out automatically.

### Ruleset update (separate step, after this PR merges)

Identical sequence to Phase 1's:
1. Merge this spec's implementation PR (`e2e-collab` job **not** yet
   required).
2. Confirm `e2e-collab` reports (ideally green) on the next real PR.
3. Update the `Pass Tests` ruleset to add `{"context": "e2e-collab",
   "integration_id": 15368}` to `required_status_checks` (same
   `integration_id` as `test` and `e2e` — all three are GitHub Actions
   checks from this same repo's own workflow).

Not part of the implementation plan below, for the same reason as
Phase 1: GitHub won't let a PR satisfy a required check that has never
reported, so making it required in the same commit that introduces the
job would deadlock every subsequent PR, including the one introducing
it.

## Error handling

- **`wrangler dev` never becomes ready within `scripts/e2e-collab.sh`'s
  own 60s polling loop**: the script already `exit 1`s with `"wrangler
  dev never became ready on :8787 after 60s"` — this surfaces as a
  normal job failure with that exact message in the log, well inside
  the new 10-minute job timeout, so the timeout is a backstop for a
  *different* kind of hang (like the browser-install one already seen),
  not this one.
- **`enable-dev-login.sh` refuses to apply the patch** (its own guard:
  `git diff --quiet -- src/worker.ts` failing, or `DEV_LOGIN_PATH`
  already present) — cannot happen in CI's fresh checkout, since
  there's no prior state for `src/worker.ts` to have been left dirty
  in; included here only because the script's own `set -euo pipefail`
  means this guard failing would `exit 1` immediately with a clear
  message, not hang or silently proceed.
- **Artifact name collision between `e2e` and `e2e-collab`**: avoided
  by construction (`playwright-report` vs. `playwright-report-collab`)
  — not something to detect at runtime, just a naming rule to follow
  when writing the job.
- **A required check with no way to pass ever** (the same bootstrapping
  hazard Phase 1 called out): avoided the same way — the ruleset update
  is an explicit, separate, manually-verified step, never folded into
  the implementation plan's own commit.

## Testing

- Same three-part verification Phase 1 used, applied to `e2e-collab`:
  push the branch, open a real PR, and watch `gh pr checks --watch`
  until `e2e-collab` reports; confirm its duration and outcome look
  like a normal local run (`3 passed`, not a hang).
- Deliberately break one collab spec assertion (e.g. in
  `e2e/collab/live-sync.spec.ts`), push, confirm `e2e-collab` goes red
  and a `playwright-report-collab` artifact appears and is downloadable
  with a usable trace — then revert before merging anything real. Same
  pattern Phase 1 already validated the mechanics of (and, in Phase
  1's case, caught a real bug this way — the `list`-reporter-only
  config never actually producing `playwright-report/` on disk).
- Confirm `timeout-minutes: 10` doesn't fire on a normal passing run
  (it shouldn't, at ~1-2 minutes actual runtime) — no separate
  deliberate-hang test is planned for this; inducing a real 10-minute
  hang on purpose isn't worth the CI minutes it would cost to verify a
  single scalar config value.

## Self-review

- **Placeholder scan**: no TBD/TODO; every step has concrete YAML or a
  direct reference to an existing, already-tested script.
- **Internal consistency**: the ruleset update is explicitly deferred
  post-merge here too, consistent with Phase 1 and with "required from
  day one" meaning "as soon as it's actually possible to require it,"
  not literally the moment the PR merges.
- **Scope check**: one new CI job (mostly delegating to an existing,
  already-hardened script) plus a two-line timeout addition to an
  existing job. Fits one implementation plan.
