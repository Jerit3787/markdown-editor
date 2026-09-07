# Real-GitHub e2e harness — Design Spec

## Goal

Close the three catalogue rows that need a **real** GitHub session — the
UI-orchestration flows whose server endpoints proxy `api.github.com` with
the signed-in user's token:

- **GIST-11** — opening a Gist (own list / pasted URL / pasted id) creates
  a new local document.
- **REPO-19** — linking a workspace to a repo through the UI pulls every
  `.md` recursively and dismisses the modal for a progress toast.
- **REPO-22** — the no-workspace empty state offers "load a workspace from
  a repo" and it works end-to-end.

These are un-mockable at the level that matters: `handleMe` "fails open"
except on an explicit `401` from `GET /user`, so a fake token is signed
out on the next `/api/auth/github/me` poll. The rest of the suite mocks
`/api/gist*` and `/api/repo/*` at the fetch boundary (VER-16, REPO-20/21,
`gist-images.test.ts`); this spec adds a small, opt-in suite that drives
the real endpoints against a throwaway account's fixtures.

## Non-goals / deferred scope

- **GIST-05 (the isomorphic-git push into a gist's own git repo) stays
  permanently deferred.** A push *creates* a real gist every run and would
  need teardown; the smart-HTTP path up to the push is already covered by
  `gist-images.test.ts` (validation + `MemoryFS` write). Not worth one row.
- **No test mutates GitHub state.** All three flows are read-only against
  fixtures. No repo/gist creation, no `handleRepoPush`, no `handleGistCreate`.
- **This suite never runs in `npm test`, `test:e2e:local`, or `test:e2e`**,
  and never on a fork PR (no secret access). It is a supplementary,
  **non-blocking** CI job plus an on-demand local script.
- **No OAuth-popup automation.** The harness injects a session directly,
  the same shape the dev-login patch already uses.
- **No change to any production code path.** The only `src/` change is one
  uncommitted patch (extended from the existing dev-login patch) and two
  optional fields on the `Env` interface.
- **The stale `## Deferred` rows (CMT-13, VER-19) are cleaned up in this
  PR** as a no-risk housekeeping fold-in — both are `covered` in the main
  tables now.

## Current mechanics this builds on

- `tests/scripts/manual-testing/dev-login.patch` adds `/api/dev/login` to
  `src/worker.ts` (uncommitted; applied/reverted by
  `enable`/`disable-dev-login.sh`). It mints
  `encryptSession(env, { token: "dev-fake-token", username })` and sets
  the `SESSION_COOKIE`.
- `tests/scripts/e2e-collab.sh` is the model for a script-driven Playwright
  project: apply the patch → `npm run build` → `wrangler dev` on `:8787`
  (serves built `client/dist` + the Worker) → wait for readiness →
  `playwright test --project=collab --workers=1` → `trap` cleanup that
  kills wrangler *and* whatever is bound to `:8787` *and* reverts the patch.
- `playwright.config.ts` has `local` (vite dev `:5275`) and `collab`
  (`:8787`, `fullyParallel: false`) projects.
- Session token flow: `getSession` → `decryptSession` → `{ token, username }`;
  every `/api/gist*` and `/api/repo/*` handler sends
  `Authorization: Bearer ${session.token}` to `api.github.com`.
- `.dev.vars` is git-ignored (`.gitignore:8`).

## Design

### A. Session injection — extend the existing patch

Rename `dev-login.patch` behaviour, keeping one route:

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

- `enable-dev-login.sh` / `e2e-collab.sh` are unchanged in behaviour — no
  `real=1`, no `TEST_GITHUB_TOKEN` in the environment ⇒ the fake path,
  exactly as today. Only the patch file is regenerated.
- `e2e-github.sh` calls `/api/dev/login?real=1`; the token comes from
  `.dev.vars` (local) or the CI secret.
- Same "never commit" discipline: `disable-dev-login.sh` reverts it, the
  scripts' `trap` reverts it, `git status` must show `src/worker.ts` clean
  before any commit.

### B. `Env` gains two optional fields

`src/env.ts`:

```ts
export interface Env {
  // ...existing...
  // Test-only: a throwaway account's PAT (Bearer token for api.github.com)
  // and its login. Set in a git-ignored .dev.vars locally, or a CI secret
  // for the e2e-github job. Never present in production. Consumed only by
  // the (uncommitted) dev-login patch.
  TEST_GITHUB_TOKEN?: string;
  TEST_GITHUB_USERNAME?: string;
}
```

Committed — they are optional config, not secrets, and typing them keeps
the patch clean.

### C. The fixture contract (you provide)

Documented in a new `tests/e2e/github/README.md`. On a **throwaway
GitHub account**:

1. **A classic PAT** with scopes **`repo` + `gist`**. *Not* a fine-grained
   token: the app's own `hasRepoScope()` reads the `X-OAuth-Scopes`
   response header from `GET /user` (via `/api/auth/github/me`), which
   fine-grained PATs leave **empty** — so `requireRepoScope()` would block
   REPO-19/22 at the sign-in gate. A classic token reports
   `X-OAuth-Scopes: repo, gist` and passes. The account is a throwaway
   holding nothing, so classic `repo` (full control of that account's
   repos) is an acceptable blast radius; the token is read-only *in
   practice* because no test calls a write endpoint.
   (Alternative for the security-averse: fine-grained `Gists: read` +
   `Contents: read` on the fixture repo, plus a Playwright `page.route`
   that passes the real `/api/auth/github/me` response through but injects
   `scopes: ["repo","gist"]` — keeps the endpoints real, patches only the
   scope-reporting quirk. The plan implements the classic-PAT path;
   swapping in the route is a one-liner.)
2. **A fixture gist** — public. The Open-Gist flow opens only the *first*
   markdown file in a gist, so the contract is just: the first `.md` file
   is `handbook.md`, first line `# Fixture Handbook`. Its id →
   `TEST_GITHUB_GIST_ID` (the pasted-URL test derives the URL as
   `https://gist.github.com/<TEST_GITHUB_USERNAME>/<id>`).
3. **A fixture repo** — `TEST_GITHUB_REPO` = `owner/name`, default branch
   `main`, containing:
   - `README.md` (`# Fixture Repo`)
   - `docs/architecture.md`
   - `docs/deep/notes.md`
   - one non-markdown file (`assets/logo.txt`) that must **not** be pulled
   So REPO-19/22 can assert "3 `.md` files, recursive, non-`.md` skipped".
4. Values recorded in `.dev.vars` (local) and CI secrets:
   `TEST_GITHUB_TOKEN`, `TEST_GITHUB_USERNAME`, `TEST_GITHUB_GIST_ID`,
   `TEST_GITHUB_REPO`.

The fixtures are a stable contract — if they change on the account, the
suite breaks loudly (that's acceptable for an opt-in job).

### D. `tests/scripts/e2e-github.sh`

Mirrors `e2e-collab.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Skip cleanly when the account isn't configured — a contributor without
# the fixtures just doesn't run this suite.
: "${TEST_GITHUB_TOKEN:?e2e-github needs TEST_GITHUB_TOKEN (see tests/e2e/github/README.md) — skipping}" || exit 0

bash tests/scripts/manual-testing/enable-dev-login.sh
trap 'bash tests/scripts/manual-testing/disable-dev-login.sh' EXIT

# Pass the test account through to wrangler dev via .dev.vars (git-ignored).
{
  echo "TEST_GITHUB_TOKEN=$TEST_GITHUB_TOKEN"
  echo "TEST_GITHUB_USERNAME=$TEST_GITHUB_USERNAME"
} >> .dev.vars

npm run build
npx wrangler dev --local-upstream localhost:8787 &
WRANGLER_PID=$!
cleanup() {
  kill "$WRANGLER_PID" 2>/dev/null || true
  lsof -ti:8787 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  # strip the two lines we appended
  grep -v '^TEST_GITHUB_' .dev.vars > .dev.vars.tmp && mv .dev.vars.tmp .dev.vars || true
  bash tests/scripts/manual-testing/disable-dev-login.sh
}
trap cleanup EXIT

# wait for :8787 (same 60×1s loop as e2e-collab.sh)
# ...

TEST_GITHUB_GIST_ID="$TEST_GITHUB_GIST_ID" TEST_GITHUB_REPO="$TEST_GITHUB_REPO" \
  npx playwright test --project=github --workers=1
```

Note the `.dev.vars` append/strip: `enable-dev-login.sh` writes a
`SESSION_SECRET` line to `.dev.vars` if absent; this script adds the two
`TEST_GITHUB_*` lines for `wrangler dev` to pick up, and removes them on
exit so a subsequent `git status` / `e2e-collab` run sees a minimal file.
(`.dev.vars` is git-ignored, so worst case is a stale local line, never a
committed secret — but the strip keeps it tidy.)

### E. `playwright.config.ts` — a third project

```ts
{
  name: "github",
  testDir: "./tests/e2e/github",
  use: { baseURL: "http://localhost:8787" },
  fullyParallel: false, // one wrangler dev + real GitHub rate limits
},
```

`npm run test:e2e:github` → `bash tests/scripts/e2e-github.sh`. **Not**
added to `test:e2e` (which stays local + collab).

### F. `tests/e2e/github/support/github.ts`

```ts
export const BASE = "http://localhost:8787";
export const GIST_ID = process.env.TEST_GITHUB_GIST_ID!;
export const REPO = process.env.TEST_GITHUB_REPO!; // "owner/name"

// Injects a session carrying the real test-account token.
export async function signInReal(page: Page): Promise<void> {
  await page.goto(`${BASE}/api/dev/login?real=1`);
  await page.goto(BASE);
  await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  // real /api/auth/github/me now returns { connected: true } — no route stub
  await page.waitForFunction(() => (window as any).MDE?.githubUsername, { timeout: 15000 });
  // dismiss What's New if shown
}
```

No `page.route` stub of `/api/auth/github/me` — the whole point is that
the real endpoint verifies the real token and succeeds.

### G. The tests (`tests/e2e/github/`)

**`gist.spec.ts` — GIST-11** (three entry points, each its own test):

1. *Own list* — `signInReal` → File menu "From GitHub Gist…"
   (`#menuOpenGist`) → the modal ("Open from GitHub Gist") lists the
   account's markdown gists (`.gist-item`) → click the fixture row's
   "Open" → the modal closes, an `Opened "handbook" from Gist` toast, and
   a new local doc named `handbook` whose content starts `# Fixture
   Handbook`.
2. *Pasted URL* — open the modal, fill `input[aria-label="Gist URL or ID"]`
   with `https://gist.github.com/<TEST_GITHUB_USERNAME>/<id>`, click the
   adjacent "Open" → same result.
3. *Pasted bare id* — fill the same field with `TEST_GITHUB_GIST_ID` →
   same result.

Assert: the editor shows `# Fixture Handbook`, and
`localStorage["mde:docs"]` has a doc named `handbook` with `gistId ===
TEST_GITHUB_GIST_ID`.

**`repo.spec.ts` — REPO-19** — `signInReal` → `#emptyNewWorkspaceBtn` to
make a workspace → File menu "Open GitHub Repo…" (`#menuOpenRepo`) → in the
RepoPicker, fill `input[aria-label="owner/repo"]` with `TEST_GITHUB_REPO`,
press Enter → assert:
- the modal ("Open GitHub Repo as Workspace") dismisses,
- a progress → success toast,
- `localStorage["mde:docs"]` has exactly 3 docs — names
  `README` / `architecture` / `notes`, `repoPath` values
  `README.md` / `docs/architecture.md` / `docs/deep/notes.md`;
  no doc for `assets/logo.txt`,
- the active workspace's `repoLink` is
  `{ owner, repo, branch: "main" }`.

**`repo.spec.ts` — REPO-22** — a fresh context (**zero** workspaces) →
`signInReal` → the no-workspace empty state's `#emptyOpenRepoBtn` ("Open
from GitHub Repo") → same RepoPicker manual-input flow → the same
3-doc / `repoLink` assertions, plus: a workspace now exists and is
active. (`#emptyOpenRepoBtn` routes through `#menuOpenRepo` →
`requireRepoScope` → the RepoPicker, same as REPO-19 — the distinct
coverage is *reaching* it from the empty state with no prior workspace.)

### H. CI — a new `e2e-github` job

`.github/workflows/test.yml`:

```yaml
  e2e-github:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    # Runs only where secrets are available: pushes to master and
    # same-repo PRs, never a fork PR (which sees this job skipped, not
    # failed). NOT added to branch protection's required checks — real
    # GitHub is rate-limited and its API drifts, so a red here is a
    # visible signal to investigate, never a merge gate. (Preferred over
    # `continue-on-error: true`, which would hide a real break behind a
    # green check + a warning annotation nobody reads.)
    if: ${{ github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository }}
    steps:
      # ...checkout, setup-node, npm ci, playwright install...
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
        with: { name: playwright-report-github, path: playwright-report/, retention-days: 7 }
```

- Not in branch protection's required-checks list ⇒ a failure is visible
  (red X on the PR) but never blocks merge.
- `e2e-github.sh`'s `${TEST_GITHUB_TOKEN:?…} || exit 0` means: if the
  secret is somehow empty, the script exits 0 (skip), not fail.

### I. Security

- **The token never enters the repo.** `.dev.vars` is git-ignored; CI uses
  encrypted secrets; the value only ever appears in `wrangler dev`'s
  process env and the `Authorization` header to `api.github.com`.
- **Fine-grained PAT, read-only, throwaway account** — worst case on leak
  is read access to public fixtures. `README.md` documents rotation.
- **Fork PRs get no secret** (`pull_request` from a fork can't read
  `secrets.*`), and the `if:` guard skips the job for them explicitly so
  it shows as skipped, not failed.
- Playwright's `screenshot: only-on-failure` — a failing sign-in screen
  shows the app UI, not the token (it's in an httpOnly cookie / server
  env, never rendered).

## Testing this harness

- `e2e-github.sh` run locally with `.dev.vars` populated → all 5 tests
  green.
- Run `e2e-collab.sh` afterward → still green (regenerated patch, stripped
  `.dev.vars` lines).
- `git status` clean of `src/worker.ts` and `.dev.vars` after every run.
- CI: the job runs on a `push` to master, is `continue-on-error`, uploads
  a report on failure.
- Unit: no new unit tests (this is an integration harness). The patch
  change is exercised by both `e2e-collab` (fake path) and `e2e-github`
  (real path).

## Catalogue

`docs/TEST-COVERAGE.md`:
- GIST-11, REPO-19, REPO-22 → `covered`, level `e2e-github`, ref
  `tests/e2e/github/*.spec.ts`.
- GIST-05 → keep in `## Deferred`, note refined: "permanently deferred —
  push creates a real gist per run (teardown burden) and needs a git
  smart-HTTP double; the `e2e-github` harness is read-only by design."
- Delete the stale `CMT-13` and `VER-19` rows from `## Deferred` (both
  `covered` in the main tables).
- §11 tally: GIST-11 gap→covered. §12 tally: REPO-19, REPO-22 gap→covered.
  Total covered +3, gap −3.

## Versioning

Test infrastructure + tests, zero user-facing change → **patch bump**,
`CHANGELOG.md` `### Changed`, no `whats-new-entries.ts`.

## Files touched

| File | Change |
| --- | --- |
| `tests/scripts/manual-testing/dev-login.patch` | regenerate — `real=1` + `env.TEST_GITHUB_TOKEN` branch |
| `src/env.ts` | `TEST_GITHUB_TOKEN?` / `TEST_GITHUB_USERNAME?` optional fields |
| `tests/scripts/e2e-github.sh` | new — build + wrangler + `--project=github`, skips without the token |
| `playwright.config.ts` | new `github` project |
| `package.json` | `test:e2e:github` script |
| `tests/e2e/github/support/github.ts` | new — `signInReal`, fixture constants |
| `tests/e2e/github/gist.spec.ts` | new — GIST-11 ×3 |
| `tests/e2e/github/repo.spec.ts` | new — REPO-19, REPO-22 |
| `tests/e2e/github/README.md` | new — the fixture contract + token setup + rotation |
| `.github/workflows/test.yml` | new `e2e-github` job (non-blocking, secret-gated) |
| `CONTRIBUTING.md` | a paragraph pointing at `tests/e2e/github/README.md` |
| `docs/TEST-COVERAGE.md` | 3 rows gap→covered; GIST-05 note; drop stale CMT-13/VER-19 |
| `CHANGELOG.md`, `package.json`, `package-lock.json` | patch bump |

## What you (the maintainer) do, once

1. Create a throwaway GitHub account.
2. Create the fixture gist and fixture repo per `tests/e2e/github/README.md`.
3. Create a fine-grained PAT (read-only, as scoped above).
4. Put `TEST_GITHUB_TOKEN` / `_USERNAME` / `_GIST_ID` / `_REPO` in local
   `.dev.vars` and in the repo's Actions secrets.

Everything else is in this spec.
