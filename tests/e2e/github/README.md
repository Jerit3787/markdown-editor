# Real-GitHub e2e suite (`e2e-github`)

An **opt-in** Playwright project that drives the Gist / GitHub-repo **UI
flows** against the _real_ `api.github.com` proxy endpoints:

| Row         | Flow                                                                             |
| ----------- | -------------------------------------------------------------------------------- |
| **GIST-11** | Open a Gist (from your list / a pasted URL / a pasted id) → a new local document |
| **REPO-19** | Link a workspace to a repo through the menu → every `.md` pulled recursively     |
| **REPO-22** | "Open from GitHub Repo" from the no-workspace empty state                        |

Everything else in the test suite mocks `/api/gist*` and `/api/repo/*` at
the fetch boundary. This suite exists because those three flows can only
be exercised with a session whose token actually verifies against GitHub
(`handleMe` signs a fake token out on the next poll).

**It is never part of `npm test`, `npm run test:e2e:local`, or
`npm run test:e2e`.** Run it explicitly with `npm run test:e2e:github`,
which **skips silently (exit 0)** when no test account is configured. In
CI it is a separate `e2e-github` job that is **not a required check** —
real GitHub is rate-limited and its API drifts, so a red there is a
signal to investigate, never a merge gate.

`GIST-05` (an isomorphic-git _push_ into a gist's own git repo) stays
permanently deferred — a push creates a real gist every run and needs a
git smart-HTTP test double. This suite is read-only by design.

---

## One-time setup

### 1. A throwaway GitHub account

Use a dedicated account that holds nothing of value. The token below has
broad-ish scope; the account is the blast radius.

### 2. A fixture gist (public)

Create a public gist whose **first markdown file** is `handbook.md` with
this exact first line:

```markdown
# Fixture Handbook
```

(The Open-Gist flow opens only the first `.md` file, so a second file is
optional.) Note the gist id from its URL.

### 3. A fixture repo

A repo on the account, default branch **`main`**, containing exactly:

```
README.md               # first line: "# Fixture Repo"
docs/architecture.md
docs/deep/notes.md
assets/logo.txt         # NOT markdown — must NOT be pulled as a document
```

Note it as `owner/name`.

### 4. A **classic** Personal Access Token

`Settings → Developer settings → Personal access tokens → Tokens (classic)`,
scopes **`repo`** and **`gist`**.

> **Not a fine-grained token.** The app's `hasRepoScope()` reads the
> `X-OAuth-Scopes` response header from `GET /user`, which fine-grained
> tokens leave empty — `requireRepoScope()` would then block REPO-19/22 at
> the sign-in gate. A classic token reports `X-OAuth-Scopes: repo, gist`.

### 5. Local config — `.dev.vars` (git-ignored)

```
TEST_GITHUB_TOKEN=ghp_...
TEST_GITHUB_USERNAME=your-throwaway-login
TEST_GITHUB_GIST_ID=abc123...
TEST_GITHUB_REPO=your-throwaway-login/fixture-repo
```

### 6. CI config — repository Actions secrets

Add the same four as **secrets** (`Settings → Secrets and variables →
Actions`): `TEST_GITHUB_TOKEN`, `TEST_GITHUB_USERNAME`,
`TEST_GITHUB_GIST_ID`, `TEST_GITHUB_REPO`.

Secrets are not exposed to fork PRs — the `e2e-github` job's `if:` guard
makes it _skip_ (not fail) for those.

---

## Running

```bash
npm run test:e2e:github
```

The runner (`tests/scripts/e2e-github.sh`) applies the dev-login patch,
appends the token vars to `.dev.vars` for `wrangler dev`, builds, serves,
runs `playwright test --project=github --workers=1`, then reverts the
patch and strips the appended lines on exit.

## Rotating the token

Regenerate the classic PAT on GitHub, update `TEST_GITHUB_TOKEN` in
`.dev.vars` and in the CI secret. Nothing else changes.

## When a test breaks

First check the **fixtures still match the contract above** — someone may
have edited the gist or repo. The suite is deliberately brittle against
fixture drift so that a real regression isn't masked by a lenient
assertion.
