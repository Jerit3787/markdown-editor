# Real-GitHub e2e harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) or superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** An opt-in Playwright project (`tests/e2e/github`) that drives GIST-11 / REPO-19 / REPO-22 against a throwaway account's fixtures, via a real token injected through the extended dev-login patch. Non-blocking CI job. GIST-05 stays permanently deferred.

**Architecture:** One extra route branch in the (uncommitted) dev-login patch; a third Playwright project + a `bash` runner that mirrors `e2e-collab.sh`; three spec files; a CI job gated on a secret and excluded from required checks.

**Tech Stack:** Playwright, Cloudflare Worker (`wrangler dev`), bash, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-08-real-github-e2e-harness-design.md`

## Global Constraints

- **`src/worker.ts` must be clean (`git status`) before every commit.** The dev-login patch is uncommitted; `disable-dev-login.sh` and the scripts' `trap` revert it. Never `git add src/worker.ts`.
- **No secret ever enters the repo.** Tokens live in `.dev.vars` (git-ignored, `.gitignore:8`) and GitHub Actions secrets only.
- **This suite is never in `npm test`, `test:e2e:local`, or `test:e2e`.** Only `npm run test:e2e:github` / the `e2e-github` CI job.
- **No test calls a write endpoint** (`handleRepoPush`, `handleGistCreate`, `handleRepoCreate`) — all three flows are read-only against fixtures.
- Run the `github` project with `--workers=1` (one wrangler dev + real GitHub rate limits).
- Commit trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`; PR body ends `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Test-infra + tests, zero user-facing change → **patch bump**, `CHANGELOG.md` `### Changed`, no `whats-new-entries.ts`.
- **The executor may not have the test account.** Tasks 3–4 (the specs) are written, typechecked, and lint-clean; they are *run* only if `.dev.vars` carries a real token, otherwise the maintainer verifies via the `e2e-github` CI job once secrets are set. Every other task is fully verifiable locally.
- Branch already exists: `test/real-github-e2e-harness` (spec committed).

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `tests/scripts/manual-testing/dev-login.patch` | regenerate — add the `real=1` / `env.TEST_GITHUB_TOKEN` branch | 1 |
| `src/env.ts` | `TEST_GITHUB_TOKEN?` / `TEST_GITHUB_USERNAME?` optional fields | 1 |
| `tests/scripts/e2e-github.sh` | new — token-gated build + wrangler + `--project=github` | 2 |
| `playwright.config.ts` | new `github` project | 2 |
| `package.json` | `test:e2e:github` script | 2 |
| `tests/e2e/github/README.md` | new — fixture contract, token setup, rotation | 2 |
| `tests/e2e/github/support/github.ts` | new — `signInReal`, fixture constants, `dismissWhatsNew` | 3 |
| `tests/e2e/github/gist.spec.ts` | new — GIST-11 ×3 | 3 |
| `tests/e2e/github/repo.spec.ts` | new — REPO-19, REPO-22 | 4 |
| `.github/workflows/test.yml` | new `e2e-github` job | 5 |
| `CONTRIBUTING.md` | pointer to `tests/e2e/github/README.md` | 5 |
| `docs/TEST-COVERAGE.md` | 3 rows gap→covered; GIST-05 note; drop stale CMT-13 / VER-19 | 5 |
| `CHANGELOG.md`, `package.json`, `package-lock.json` | patch bump | 5 |

---

## Task 1: Extend the dev-login patch + `Env` fields

**Files:**
- Modify: `tests/scripts/manual-testing/dev-login.patch` (regenerate), `src/env.ts`

**Interfaces:**
- Produces: `/api/dev/login?real=1` returns a session with `env.TEST_GITHUB_TOKEN` / `env.TEST_GITHUB_USERNAME` when both are set; without `real=1` (or without the env vars) it returns the existing `"dev-fake-token"` session, byte-for-byte as today.
- `Env.TEST_GITHUB_TOKEN?: string`, `Env.TEST_GITHUB_USERNAME?: string`.

- [ ] **Step 1: Add the optional `Env` fields**

`src/env.ts`, inside `export interface Env`:

```ts
  // Test-only: a throwaway account's classic PAT (Bearer for
  // api.github.com, `repo`+`gist` scopes) and its login. Set in a
  // git-ignored .dev.vars locally or a CI secret for the e2e-github job;
  // never present in production. Consumed only by the (uncommitted)
  // dev-login patch's `?real=1` branch.
  TEST_GITHUB_TOKEN?: string;
  TEST_GITHUB_USERNAME?: string;
```

- [ ] **Step 2: Apply the current patch, edit the route, regenerate**

```bash
git apply tests/scripts/manual-testing/dev-login.patch
```

In `src/worker.ts`, replace the applied `/api/dev/login` block:

```ts
    if (url.pathname === DEV_LOGIN_PATH) {
      const username = url.searchParams.get("username") || "dev-user";
      const cookie = await encryptSession(env, { token: "dev-fake-token", username });
      return new Response(`Signed in locally as ${username}`, {
        status: 200,
        headers: { "Set-Cookie": cookieHeader(SESSION_COOKIE, cookie), "Content-Type": "text/plain" },
      });
    }
```

with:

```ts
    if (url.pathname === DEV_LOGIN_PATH) {
      const wantReal = url.searchParams.get("real") === "1";
      const token = wantReal && env.TEST_GITHUB_TOKEN ? env.TEST_GITHUB_TOKEN : "dev-fake-token";
      const username = wantReal && env.TEST_GITHUB_USERNAME ? env.TEST_GITHUB_USERNAME : url.searchParams.get("username") || "dev-user";
      const cookie = await encryptSession(env, { token, username });
      return new Response(`Signed in locally as ${username}`, {
        status: 200,
        headers: { "Set-Cookie": cookieHeader(SESSION_COOKIE, cookie), "Content-Type": "text/plain" },
      });
    }
```

Regenerate the patch and revert the working tree:

```bash
git diff -- src/worker.ts > tests/scripts/manual-testing/dev-login.patch
git checkout -- src/worker.ts
```

Confirm `git status` shows only `src/env.ts` and the patch file modified.

- [ ] **Step 3: Verify the patch still round-trips**

```bash
bash tests/scripts/manual-testing/enable-dev-login.sh   # applies cleanly?
grep -n "wantReal" src/worker.ts                        # the new branch is there
bash tests/scripts/manual-testing/disable-dev-login.sh  # reverts cleanly?
git diff --quiet -- src/worker.ts && echo "worker.ts clean"
```

- [ ] **Step 4: Verify the fake path is unchanged — run the collab suite**

```bash
npm run typecheck
bash tests/scripts/e2e-collab.sh
```
Expected: `e2e-collab` all green (25 tests). This proves the regenerated patch's default (no `real=1`, no `TEST_GITHUB_*` env) behaves exactly as before. `disable-dev-login.sh` runs on exit; confirm `git status` clean of `src/worker.ts`.

- [ ] **Step 5: Commit**

```bash
npm run format
git add src/env.ts tests/scripts/manual-testing/dev-login.patch
git commit -m "$(cat <<'EOF'
test(infra): dev-login patch can mint a session with a real test-account token

`/api/dev/login?real=1` uses env.TEST_GITHUB_TOKEN / _USERNAME when set;
the default path is unchanged (the e2e-collab suite still passes). Two
optional Env fields document the test-only vars.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: The `github` Playwright project (no tests yet)

**Files:**
- Create: `tests/scripts/e2e-github.sh`, `tests/e2e/github/README.md`
- Modify: `playwright.config.ts`, `package.json`

- [ ] **Step 1: `playwright.config.ts` — add the project**

In the `projects` array, after `collab`:

```ts
    {
      name: "github",
      testDir: "./tests/e2e/github",
      use: { baseURL: "http://localhost:8787" },
      // one wrangler dev + real GitHub rate limits — no parallelism
      fullyParallel: false,
    },
```

- [ ] **Step 2: `package.json` — the script**

```json
    "test:e2e:github": "bash tests/scripts/e2e-github.sh",
```
(after `"test:e2e:collab"`. Do **not** touch `"test:e2e"`.)

- [ ] **Step 3: `tests/scripts/e2e-github.sh`**

```bash
#!/usr/bin/env bash
# Opt-in real-GitHub e2e suite (GIST-11 / REPO-19 / REPO-22). Needs a
# throwaway account's classic PAT + fixture ids — see
# tests/e2e/github/README.md. Skips cleanly (exit 0) when unconfigured.
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ -z "${TEST_GITHUB_TOKEN:-}" ] && [ -f .dev.vars ]; then
  # allow running locally straight from .dev.vars
  set -a; . ./.dev.vars; set +a
fi
if [ -z "${TEST_GITHUB_TOKEN:-}" ]; then
  echo "e2e-github: TEST_GITHUB_TOKEN not set (see tests/e2e/github/README.md) — skipping." >&2
  exit 0
fi
: "${TEST_GITHUB_USERNAME:?set TEST_GITHUB_USERNAME}"
: "${TEST_GITHUB_GIST_ID:?set TEST_GITHUB_GIST_ID}"
: "${TEST_GITHUB_REPO:?set TEST_GITHUB_REPO (owner/name)}"

bash tests/scripts/manual-testing/enable-dev-login.sh

# wrangler dev reads .dev.vars — append the token vars so the Worker sees
# env.TEST_GITHUB_TOKEN / _USERNAME, then strip them on exit.
APPENDED=0
if ! grep -q '^TEST_GITHUB_TOKEN=' .dev.vars 2>/dev/null; then
  { echo "TEST_GITHUB_TOKEN=$TEST_GITHUB_TOKEN"; echo "TEST_GITHUB_USERNAME=$TEST_GITHUB_USERNAME"; } >> .dev.vars
  APPENDED=1
fi

npm run build
npx wrangler dev --local-upstream localhost:8787 &
WRANGLER_PID=$!
cleanup() {
  kill "$WRANGLER_PID" 2>/dev/null || true
  lsof -ti:8787 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  if [ "$APPENDED" = "1" ]; then
    grep -v '^TEST_GITHUB_' .dev.vars > .dev.vars.tmp && mv .dev.vars.tmp .dev.vars || true
  fi
  bash tests/scripts/manual-testing/disable-dev-login.sh
}
trap cleanup EXIT

ready=""
for _ in $(seq 1 60); do
  if curl -sf http://localhost:8787 >/dev/null 2>&1; then ready="yes"; break; fi
  sleep 1
done
[ -n "$ready" ] || { echo "wrangler dev never became ready on :8787" >&2; exit 1; }

TEST_GITHUB_GIST_ID="$TEST_GITHUB_GIST_ID" TEST_GITHUB_REPO="$TEST_GITHUB_REPO" \
  npx playwright test --project=github --workers=1
```

`chmod +x tests/scripts/e2e-github.sh`.

- [ ] **Step 4: `tests/e2e/github/README.md`**

Write it with these sections (real prose, not placeholders):

- **What this suite is** — opt-in, real GitHub, GIST-11/REPO-19/REPO-22, non-blocking.
- **One-time setup:**
  1. Create a throwaway GitHub account.
  2. **Fixture gist** (public): first `.md` file `handbook.md`, first line `# Fixture Handbook`. Copy its id.
  3. **Fixture repo** (`main` branch): `README.md` (`# Fixture Repo`), `docs/architecture.md`, `docs/deep/notes.md`, `assets/logo.txt` (must NOT be a `.md`). Note `owner/name`.
  4. **Classic PAT** (`Settings → Developer settings → Tokens (classic)`), scopes **`repo`** + **`gist`**. *Not* fine-grained — the app's `hasRepoScope()` reads `X-OAuth-Scopes`, which fine-grained tokens leave empty.
  5. Local: add to `.dev.vars` — `TEST_GITHUB_TOKEN`, `TEST_GITHUB_USERNAME`, `TEST_GITHUB_GIST_ID`, `TEST_GITHUB_REPO`.
  6. CI: add the same four as repo **Actions secrets**.
- **Running:** `npm run test:e2e:github` (skips silently if `.dev.vars` lacks the token).
- **Rotation:** regenerate the PAT on GitHub, update `.dev.vars` + the CI secret. Nothing else.
- **If a test breaks:** first check the fixtures still match this contract (someone may have edited the gist/repo).

- [ ] **Step 5: Verify it skips cleanly with no token**

With no `TEST_GITHUB_*` in `.dev.vars`:

```bash
npm run test:e2e:github
```
Expected: prints `e2e-github: TEST_GITHUB_TOKEN not set … — skipping.` and exits 0. `git status` clean.

- [ ] **Step 6: `npm run format` + `format:check`, commit**

```bash
npm run format
git add tests/scripts/e2e-github.sh tests/e2e/github/README.md playwright.config.ts package.json
git commit -m "$(cat <<'EOF'
test(infra): opt-in `github` Playwright project + e2e-github.sh runner

Skips cleanly (exit 0) without a configured test account. Not wired into
npm test / test:e2e. README documents the fixture contract.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `support/github.ts` + `gist.spec.ts` (GIST-11)

**Files:**
- Create: `tests/e2e/github/support/github.ts`, `tests/e2e/github/gist.spec.ts`

**Interfaces:**
- `BASE`, `GIST_ID` (`process.env.TEST_GITHUB_GIST_ID`), `REPO` (`process.env.TEST_GITHUB_REPO`), `USERNAME` (`process.env.TEST_GITHUB_USERNAME`).
- `signInReal(page): Promise<void>` — injects the real session, lands on the app, waits for `window.MDE.githubUsername`.
- `dismissWhatsNew(page)`, `readDocs(page)` (parse `localStorage["mde:docs"]`).

- [ ] **Step 1: `support/github.ts`**

```ts
import { expect, type Page } from "@playwright/test";

export const BASE = "http://localhost:8787";
export const GIST_ID = process.env.TEST_GITHUB_GIST_ID ?? "";
export const REPO = process.env.TEST_GITHUB_REPO ?? ""; // "owner/name"
export const USERNAME = process.env.TEST_GITHUB_USERNAME ?? "";

export async function dismissWhatsNew(page: Page): Promise<void> {
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) await gotIt.click();
}

// Injects a session carrying the real test-account token, then lands on
// the app. No /api/auth/github/me route stub — the real endpoint verifies
// the real token and reports its scopes (classic PAT -> "repo, gist").
export async function signInReal(page: Page): Promise<void> {
  await page.goto(`${BASE}/api/dev/login?real=1`);
  await page.goto(BASE);
  await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await page.waitForFunction(() => Boolean((window as unknown as { MDE?: { githubUsername?: string } }).MDE?.githubUsername), { timeout: 15000 });
  await dismissWhatsNew(page);
}

export async function readDocs(page: Page): Promise<Array<{ name: string; content: string; repoPath?: string; gistId?: string }>> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]"));
}
```

- [ ] **Step 2: `gist.spec.ts`**

```ts
import { test, expect } from "@playwright/test";
import { BASE, GIST_ID, USERNAME, signInReal, readDocs } from "./support/github";

async function expectHandbookOpened(page: import("@playwright/test").Page) {
  await expect(page.locator("#editor-mount .cm-content")).toContainText("# Fixture Handbook", { timeout: 15000 });
  await expect.poll(async () => (await readDocs(page)).some((d) => d.name === "handbook" && d.gistId === GIST_ID)).toBe(true);
}

test("GIST-11: open a gist from the account's list creates a local document", async ({ page }) => {
  await signInReal(page);
  await page.click("#menuOpenGist");
  await expect(page.locator('text="Open from GitHub Gist"')).toBeVisible();
  const row = page.locator(".gist-item", { hasText: "Fixture Handbook" }).or(page.locator(".gist-item").first());
  await row.getByRole("button", { name: /Open/ }).click();
  await expectHandbookOpened(page);
});

test("GIST-11: open a gist by pasted URL creates a local document", async ({ page }) => {
  await signInReal(page);
  await page.click("#menuOpenGist");
  await page.fill('input[aria-label="Gist URL or ID"]', `https://gist.github.com/${USERNAME}/${GIST_ID}`);
  await page.locator('.share-row button.secondary-btn', { hasText: "Open" }).click();
  await expectHandbookOpened(page);
});

test("GIST-11: open a gist by pasted bare id creates a local document", async ({ page }) => {
  await signInReal(page);
  await page.click("#menuOpenGist");
  await page.fill('input[aria-label="Gist URL or ID"]', GIST_ID);
  await page.locator('.share-row button.secondary-btn', { hasText: "Open" }).click();
  await expectHandbookOpened(page);
});
```

The list-row selector uses `.or(...first())` because the fixture gist's
description is the maintainer's choice — if it contains "Fixture Handbook"
the specific match wins, otherwise the first (and, for a fresh account,
only) markdown gist is it. If the account accumulates gists, tighten the
`README.md` to require the description `Fixture Handbook`.

- [ ] **Step 3: Typecheck + lint**

```bash
npm run typecheck
npx prettier --check tests/e2e/github/
```
(Both must pass with no token needed — these are static.)

- [ ] **Step 4: Run *if* a token is available**

```bash
# only if .dev.vars has TEST_GITHUB_* :
npm run test:e2e:github
```
Expected (with a token): 3 gist tests pass. Without: skipped — that's fine, the CI job verifies once secrets land. If run and a selector is wrong, fix against the real modal DOM (`page.pause()` / a screenshot).

- [ ] **Step 5: Commit**

```bash
npm run format
git add tests/e2e/github/support/github.ts tests/e2e/github/gist.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e-github): GIST-11 — open a gist (list / URL / id) creates a doc

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `repo.spec.ts` (REPO-19, REPO-22)

**Files:**
- Create: `tests/e2e/github/repo.spec.ts`

**Interfaces:**
- Consumes `signInReal`, `readDocs`, `REPO` from `support/github.ts`.
- The repo flow: `#emptyOpenRepoBtn` / `#menuOpenRepo` → `window.MDE.openRepoModal()` → `requireRepoScope()` (passes for a classic `repo` PAT) → RepoPicker → `input[aria-label="owner/repo"]` + Enter → `pickRepo(owner, repo, branch)` → modal closes → `createWorkspaceFromRepo` → progress/success toast → docs + `repoLink`.

- [ ] **Step 1: `repo.spec.ts`**

```ts
import { test, expect } from "@playwright/test";
import { REPO, signInReal, readDocs } from "./support/github";

const [OWNER, NAME] = REPO.split("/");

async function expectFixtureRepoPulled(page: import("@playwright/test").Page) {
  // success toast (createWorkspaceFromRepo's own progress toast, resolved)
  await expect(page.locator(".toast", { hasText: /repo|synced|pulled/i }).first()).toBeVisible({ timeout: 20000 });
  await expect
    .poll(async () => {
      const docs = await readDocs(page);
      return docs.map((d) => d.repoPath).filter(Boolean).sort();
    }, { timeout: 20000 })
    .toEqual(["README.md", "docs/architecture.md", "docs/deep/notes.md"]);
  const ws = await page.evaluate(() => {
    const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const active = localStorage.getItem("mde:activeWorkspace");
    return wss.find((w: { id: string }) => w.id === active) ?? null;
  });
  expect(ws?.repoLink).toMatchObject({ owner: OWNER, repo: NAME, branch: "main" });
}

test("REPO-19: linking a workspace to a repo pulls every .md recursively", async ({ page }) => {
  await signInReal(page);
  await page.click("#emptyNewWorkspaceBtn"); // gives us a workspace
  await page.click("#menuOpenRepo");
  await expect(page.locator('text="Open GitHub Repo as Workspace"')).toBeVisible();
  await page.fill('input[aria-label="owner/repo"]', REPO);
  await page.press('input[aria-label="owner/repo"]', "Enter");
  await expect(page.locator('text="Open GitHub Repo as Workspace"')).toHaveCount(0, { timeout: 15000 });
  await expectFixtureRepoPulled(page);
});

test("REPO-22: the no-workspace empty state loads a workspace from a repo", async ({ page }) => {
  await signInReal(page);
  // fresh context -> no workspace -> the no-workspace empty state
  await page.click("#emptyOpenRepoBtn");
  await expect(page.locator('text="Open GitHub Repo as Workspace"')).toBeVisible({ timeout: 10000 });
  await page.fill('input[aria-label="owner/repo"]', REPO);
  await page.press('input[aria-label="owner/repo"]', "Enter");
  await expect(page.locator('text="Open GitHub Repo as Workspace"')).toHaveCount(0, { timeout: 15000 });
  await expectFixtureRepoPulled(page);
  const wsCount = await page.evaluate(() => JSON.parse(localStorage.getItem("mde:workspaces") || "[]").length);
  expect(wsCount).toBe(1);
});
```

- [ ] **Step 2: Typecheck + lint**

```bash
npm run typecheck
npx prettier --check tests/e2e/github/
```

- [ ] **Step 3: Run *if* a token is available** — same conditional as Task 3 Step 4. With a classic `repo`+`gist` PAT, `requireRepoScope()` passes and both tests run. If the toast/selector assertions miss, adjust against the real DOM (the toast text and the `repoLink` shape are the load-bearing asserts; relax the toast regex before the doc-list assertion).

- [ ] **Step 4: Commit**

```bash
npm run format
git add tests/e2e/github/repo.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e-github): REPO-19 / REPO-22 — link a workspace to a repo, from the menu and the empty state

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: CI job, docs, catalogue, bump, PR

**Files:**
- Modify: `.github/workflows/test.yml`, `CONTRIBUTING.md`, `docs/TEST-COVERAGE.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`

- [ ] **Step 1: `.github/workflows/test.yml` — the `e2e-github` job**

After the `e2e-collab:` job:

```yaml
  e2e-github:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    # Secrets are unavailable to fork PRs — this `if` makes the job SKIP
    # (not fail) for them. NOT a required check: real GitHub is
    # rate-limited and its API drifts, so a red here is a signal to look,
    # never a merge gate.
    if: ${{ github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository }}
    steps:
      - name: Checkout repository
        uses: actions/checkout@v7
      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version: "lts/*"
          cache: "npm"
      - name: Install dependencies
        run: npm ci
      - name: Install Playwright browser
        run: npx playwright install --with-deps chromium
      - name: Run GitHub e2e suite
        run: npm run test:e2e:github
        env:
          TEST_GITHUB_TOKEN: ${{ secrets.TEST_GITHUB_TOKEN }}
          TEST_GITHUB_USERNAME: ${{ secrets.TEST_GITHUB_USERNAME }}
          TEST_GITHUB_GIST_ID: ${{ secrets.TEST_GITHUB_GIST_ID }}
          TEST_GITHUB_REPO: ${{ secrets.TEST_GITHUB_REPO }}
      - name: Upload Playwright report
        if: failure()
        uses: actions/upload-artifact@v7
        with:
          name: playwright-report-github
          path: playwright-report/
          retention-days: 7
```

(If `secrets.TEST_GITHUB_TOKEN` is unset in the repo, `e2e-github.sh` exits 0 with a skip message — the job goes green having done nothing, until the maintainer adds the secrets.)

- [ ] **Step 2: `CONTRIBUTING.md`**

After the OAuth-App section, add a short paragraph: there is an opt-in real-GitHub e2e suite for the Gist/Repo *UI* flows (the rest of the suite mocks those endpoints); to run it, set up a throwaway account per `tests/e2e/github/README.md`. It is never part of `npm test`.

- [ ] **Step 3: `docs/TEST-COVERAGE.md`**

- **GIST-11** row (§11) → `covered`, level `e2e-github`, ref `tests/e2e/github/gist.spec.ts`, note "own-list / pasted-URL / pasted-id, against a fixture gist".
- **REPO-19**, **REPO-22** rows (§12) → `covered`, level `e2e-github`, ref `tests/e2e/github/repo.spec.ts`.
- **GIST-05** in `## Deferred` — refine the note: "Permanently deferred — a push creates a real gist per run (teardown burden) and needs a git smart-HTTP double; the `e2e-github` harness is read-only by design. Everything up to the push is covered by `gist-images.test.ts`."
- **Delete** the `CMT-13` and `VER-19` rows from `## Deferred` — both are `covered` in the main tables (CMT-13 integration, VER-19 `repo-sync.test.ts`).
- Add a line under `## How to read this` or the level table: `e2e-github` = "full client + Worker + **real GitHub** (opt-in, `tests/e2e/github`, secret-gated CI)".
- §11 tally: covered +1, gap −1. §12 tally: covered +2, gap −2. `**Total**` row: covered +3 → 308, gap −3 → 3. Re-sum the subsystem rows against the Total.

- [ ] **Step 4: Bump + CHANGELOG**

`CHANGELOG.md`, new top section:

```markdown
## [1.48.2] - <today>

### Changed

- **Test coverage — the Gist / GitHub-repo UI flows now have real end-to-end tests.** A new opt-in `e2e-github` suite drives "open a Gist" and "load a workspace from a repo" against a throwaway account's fixtures through the real API proxy endpoints (the rest of the suite mocks them). It is never part of `npm test` and its CI job is non-blocking. GIST-11 / REPO-19 / REPO-22 move to covered (308/314); GIST-05 (a real push) stays permanently deferred.
```

`package.json` line 4 + `package-lock.json` lines 3 & ~9: `1.48.1` → `1.48.2`.

- [ ] **Step 5: Full local verification**

```bash
npm run typecheck && npm test && npm run format:check
npx prettier --check tests/e2e/github/ .github/workflows/test.yml
bash tests/scripts/e2e-collab.sh          # still 25 green — regenerated patch is safe
npm run test:e2e:github                   # skips (no local token) OR runs 5 green
```

- [ ] **Step 6: Commit + PR**

```bash
npm run format
git add .github/workflows/test.yml CONTRIBUTING.md docs/TEST-COVERAGE.md CHANGELOG.md package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore(release): real-GitHub e2e harness — v1.48.2

GIST-11 / REPO-19 / REPO-22 -> covered via the opt-in e2e-github suite
(308/314). GIST-05 permanently deferred. Stale CMT-13 / VER-19 Deferred
rows dropped.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push -u origin test/real-github-e2e-harness
```

PR against `master`. Body: the 3 rows, the opt-in design, the **maintainer action required** (create account + fixtures + PAT, add 4 Actions secrets — link the spec's last section and `tests/e2e/github/README.md`), and that the `e2e-github` CI job is non-blocking and will stay green-skipping until the secrets are added.

- [ ] **Step 7: Merge once the required checks are green**

`test`, `e2e`, `e2e-collab`, `typecheck`, `format:check`, CodeQL must pass. `e2e-github` is **not required** — it skips (green) with no secrets. Merge with a merge commit; fast-forward local `master`.

---

## Self-Review

**Spec coverage:**
- Session injection (`?real=1` branch) → Task 1.
- `Env` fields → Task 1 Step 1.
- `github` project + `e2e-github.sh` + `test:e2e:github` + README → Task 2.
- `signInReal` (no `me` stub) → Task 3 Step 1.
- GIST-11 ×3 → Task 3. REPO-19 / REPO-22 → Task 4.
- CI job (secret-gated, not required, fork-safe `if`) → Task 5 Step 1.
- Catalogue (3 covered, GIST-05 note, drop CMT-13/VER-19, new level row) → Task 5 Step 3.
- Security (token never in repo, `.dev.vars` git-ignored, classic-PAT rationale) → README (Task 2 Step 4) + the patch consuming env only.
- Non-goals (no writes, not in `npm test`, GIST-05 deferred) → Global Constraints + Task 5.

**Placeholder scan:** `<today>` and the README prose are the only fill-ins; both are explicit ("Write it with these sections"). Every code/YAML/bash block is literal. The "run if a token is available" conditional is a real, stated branch of the plan, not a hand-wave — the alternative (CI verifies) is spelled out.

**Type consistency:** `TEST_GITHUB_TOKEN?` / `TEST_GITHUB_USERNAME?` — one shape, added once (Task 1), read once (in the patch). `signInReal` / `readDocs` / `dismissWhatsNew` signatures defined once in `support/github.ts`, imported by both spec files. `REPO` = `"owner/name"` string, split to `[OWNER, NAME]` in `repo.spec.ts` only.

**Ordering:** Task 1 (patch) is verified against the *existing* collab suite before anything depends on it. Task 2 (infra) skips cleanly with no token, so it's fully testable locally. Tasks 3–4 (specs) are static-checked locally and verified by CI. Task 5 depends on all. A reviewer can reject the CI wiring (Task 5) without touching the patch or the specs.
