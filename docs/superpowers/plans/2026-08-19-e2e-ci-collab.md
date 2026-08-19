# Collab E2E Suite in CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `scripts/e2e-collab.sh` (the existing `wrangler dev` + Durable Objects + dev-login-patch collab e2e flow) as a required GitHub Actions check on every push/PR to `master`, alongside `test` and `e2e`.

**Architecture:** A new `e2e-collab` job in `.github/workflows/test.yml`, parallel to `test` and `e2e`, delegates entirely to the existing `npm run test:e2e:collab` script — no changes to the script itself. `e2e` and the new job both get `timeout-minutes: 10`, prompted by a real install hang observed while shipping Phase 1.

**Tech Stack:** GitHub Actions, the existing `scripts/e2e-collab.sh` / `e2e/collab/*.spec.ts` (unmodified).

**Spec:** `docs/superpowers/specs/2026-08-19-e2e-ci-collab-design.md`

## Global Constraints

- `e2e-collab` job triggers: same as `test`/`e2e` — inherited from the workflow-level `on:` block, no new trigger config. (Spec Goals.)
- `e2e-collab` runs in parallel with `test` and `e2e` — no `needs:`. (Spec Goals, Architecture.)
- `timeout-minutes: 10` on both `e2e-collab` (new) and `e2e` (retrofit). (Spec Goals, Architecture.)
- Failure artifact for `e2e-collab` uses the name `playwright-report-collab`, not `playwright-report` (which `e2e` already uses) — required so the two jobs' artifacts don't collide within the same workflow run. (Spec Architecture.)
- No changes to `scripts/e2e-collab.sh`, `scripts/manual-testing/enable-dev-login.sh`/`disable-dev-login.sh`, or `scripts/manual-testing/dev-login.patch`. (Spec Non-goals.)
- The `Pass Tests` ruleset is **not** touched by this plan — adding `e2e-collab` as required is a manual follow-up after this merges and reports green at least once. (Spec Architecture: "Ruleset update".)

---

### Task 1: Add the `e2e-collab` CI job and retrofit `e2e`'s timeout

**Files:**
- Modify: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: `npm run test:e2e:collab` (existing `package.json` script → `bash scripts/e2e-collab.sh`, unmodified), `e2e/collab/*.spec.ts` (existing, unmodified).
- Produces: nothing consumed by a later task — this plan is one task.

- [ ] **Step 1: Add `timeout-minutes: 10` to the existing `e2e` job**

Open `.github/workflows/test.yml`. It currently looks like this (after
Phase 1):

```yaml
name: Test

on:
  push:
    branches:
      - master
  pull_request:
    branches:
      - master

jobs:
  test:
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

      - name: Run tests
        run: npm test

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

Add `timeout-minutes: 10` right under `e2e`'s `runs-on: ubuntu-latest`:

```yaml
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      # unchanged
```

- [ ] **Step 2: Add the `e2e-collab` job**

Add a third job, after `e2e`:

```yaml
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

`e2e-collab` has no `needs:` — same parallel behavior as `e2e`. Note the
artifact `name:` is `playwright-report-collab`, not `playwright-report`
— required so this doesn't collide with `e2e`'s own upload within the
same workflow run.

The complete file should now have three jobs: `test`, `e2e` (with the
new `timeout-minutes: 10`), and `e2e-collab` (new).

- [ ] **Step 3: Validate the workflow YAML parses correctly**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/test.yml')); print('valid')"`

Expected: prints `valid` with no errors.

- [ ] **Step 4: Verify `scripts/e2e-collab.sh` still runs correctly locally**

This step doesn't test anything new (the script itself isn't modified
by this plan) — it's a baseline check that nothing about the current
repo state broke the collab flow before pushing to CI.

Run: `npm run test:e2e:collab`

Expected: `3 passed`, and the script's own trap output at the end:
`Removed dev-login route from src/worker.ts.` /
`src/worker.ts is clean (matches HEAD).`

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "$(cat <<'EOF'
ci: run the collab e2e suite as a new required check

New e2e-collab job in the Test workflow, parallel to test and e2e:
delegates entirely to the existing npm run test:e2e:collab (wrangler
dev + Durable Objects + the local-only dev-login patch), unmodified.
Uses a distinct playwright-report-collab artifact name so its
on-failure upload doesn't collide with e2e's own playwright-report
within the same workflow run.

Also adds timeout-minutes: 10 to both e2e-collab and (retroactively)
e2e, prompted by a real ~5-minute install-step hang observed while
shipping Phase 1 — a genuine hang now fails within 10 minutes instead
of running toward GitHub's 6-hour default job limit until someone
notices and cancels it by hand.

Does NOT yet add e2e-collab to the Pass Tests ruleset's required
status checks — same reasoning as e2e's own rollout: GitHub won't let
a PR satisfy a required check that has never reported, so that update
happens as a manual follow-up once this job has run and gone green on
a real PR, not in this commit.
EOF
)"
```

- [ ] **Step 6: Push, open a PR, and verify the job actually runs in CI**

```bash
git push -u origin <branch-name>
gh pr create --base master --title "ci: run collab e2e suite as a required check" --body "Adds an e2e-collab job to the Test workflow — see docs/superpowers/specs/2026-08-19-e2e-ci-collab-design.md for the full design."
gh pr checks <pr-number> --watch
```

Expected: `test`, `e2e`, and `e2e-collab` all report, and `e2e-collab`
passes with `3 passed` in its log — the same result Step 4 already
confirmed locally, this time on a GitHub Actions `ubuntu-latest`
runner. If any check shows `pending` for much longer than its normal
duration (`e2e-collab` should finish in roughly 1-2 minutes, matching
local timing), check `gh run view <run-id>` for a stuck step before
assuming something is broken — Phase 1 hit exactly this once, and it
was a transient runner issue that a cancel + `gh run rerun` resolved
immediately, not a real bug.

- [ ] **Step 7: Verify the failure path once, deliberately**

On the same branch, temporarily break one assertion in
`e2e/collab/live-sync.spec.ts` so the suite fails on purpose. Find this
line:

```typescript
  expect(shareState.ws?.shared).toBe(true);
```

and change it to:

```typescript
  expect(shareState.ws?.shared).toBe(false);
```

Commit this as a throwaway commit, push, and let CI run:

```bash
git add e2e/collab/live-sync.spec.ts
git commit -m "test: deliberately break an assertion to verify the e2e-collab CI failure path"
git push
gh pr checks <pr-number> --watch
```

Expected: the `e2e-collab` check goes red. Open the failed run's
Summary page (`gh run view <run-id> --web` or the Actions tab) and
confirm a `playwright-report-collab` artifact is attached and
downloadable.

Then revert the deliberate breakage:

```bash
git revert HEAD --no-edit
git push
gh pr checks <pr-number> --watch
```

Expected: `e2e-collab` goes green again, confirming both the revert
restored the original passing assertion and the CI failure path
(red check + correctly-named artifact) worked end-to-end before
merging anything real.

- [ ] **Step 8: Complete the branch**

**REQUIRED SUB-SKILL:** Use superpowers:finishing-a-development-branch
to merge this PR once all three checks (`test`, `e2e`, `e2e-collab`)
are green. The ruleset update (adding `e2e-collab` to
`required_status_checks`) is a separate, manual step — do it only
after this merges and `e2e-collab` has reported green on a subsequent
PR (per the spec's Architecture section), not as part of finishing
this branch.

---

## Self-review

- **Spec coverage**: every Goals-section item has a step — the
  `e2e-collab` job itself (Step 2), parallelism via the absence of
  `needs:` (Step 2), `timeout-minutes: 10` on both jobs (Steps 1-2),
  the distinctly-named failure artifact (Step 2), and the ruleset
  update explicitly deferred out of this plan per the spec's own
  "Ruleset update" subsection (Step 8's note). The spec's Testing
  section's checks (real CI run observed live, failure path produces a
  usable correctly-named artifact) are covered by Steps 6 and 7. The
  spec explicitly decided *not* to test the timeout value itself with
  a deliberate hang — no step here does that either, consistent with
  the spec.
- **Placeholder scan**: no TBD/TODO; every step has literal file
  content or literal commands, matching Phase 1's plan's own
  discipline.
- **Type consistency**: n/a — no functions/types are introduced or
  consumed across steps; this plan only edits one YAML file.
