# End-to-End Testing Design

## Context

This app has real end-to-end coverage today, but it's informal:
`scripts/manual-testing/` holds a handful of standalone Node scripts
(`two-user-live-sync.mjs`, `simulate-collaborator-ws.mjs`,
`repo-sync-e2e.mjs`, plus a scroll-sync repro) that drive the app via the
raw `playwright` library, print `PASS`/`FAIL` to the console, and are run
by hand (`node scripts/manual-testing/two-user-live-sync.mjs`). There's
no test runner, no `expect()`-style assertions, no per-test reporting,
and `@playwright/test` (the actual Playwright test framework — distinct
from the `playwright` browser-automation library already a
devDependency) isn't installed. CI (`.github/workflows/test.yml`) runs
only the Vitest unit suite.

Every phase of the recently-completed editor-core migration
(`docs/superpowers/specs/2026-08-19-editor-core-migration-*.md`)
live-verified its own changes by hand through Chrome automation, then
flagged the same recurring gap in its own Post-plan note: collab-mode
read-only/editing-mode switching (`window.MDE.setReadOnly`/
`enterCollabMode`/`exitCollabMode`) has never actually been exercised
against a real shared room. That gap, plus the desire for durable,
re-runnable coverage of everything the migration touched, is what this
spec addresses.

## Goals

- Add `@playwright/test` as a devDependency, with a `playwright.config.ts`
  at the repo root defining two projects:
  - **`local`**: runs against `vite dev` (`client/vite.config.ts`), no
    backend, no auth. Playwright's own `webServer` option starts and
    stops it automatically.
  - **`collab`**: runs against a real `wrangler dev` (Durable Objects,
    real Worker routing), using the existing local-only dev-login
    bypass (`scripts/manual-testing/dev-login.patch`) for auth instead
    of real GitHub OAuth.
- New `e2e/` directory at the repo root (spans both `client/` and the
  Worker, same reasoning `scripts/manual-testing/` already lives at the
  root rather than under `client/`), organized as `e2e/local/*.spec.ts`
  and `e2e/collab/*.spec.ts`.
- **`local` project coverage** (one spec file per feature area, per the
  migration phase that last touched it):
  - `documents.spec.ts` — baseline: app loads, create/rename/delete a
    document, create a workspace, switch between documents.
  - `formatting.spec.ts` (Phase D) — every `runCmd` case via the
    toolbar, Mod-b/Mod-i/Mod-k.
  - `view-mode.spec.ts` (Phase D) — toggle via toolbar buttons, MenuBar,
    and Command Palette; `localStorage` persistence across reload.
  - `keybindings.spec.ts` (Phase A) — normal/vim/emacs switching, the
    status-bar mode indicator, a real vim motion.
  - `focus-mode.spec.ts` (Phase A) — all four triggers (MenuBar,
    Command Palette, mobile exit button, Escape), undo/redo.
  - `images.spec.ts` (Phase B) — paste/drop/toolbar-picker upload,
    oversized-file error path.
  - `comments.spec.ts` (Phase B) — marker highlight, panel entry,
    delete, comment-draft popup.
  - `slash-and-wikilinks.spec.ts` (Phase B trigger + Phase C
    navigation) — slash-command trigger/filter/run/Escape, wikilink
    autocomplete trigger/filter/Escape, click-navigation in the
    rendered preview (existing-doc and create-new-doc paths).
  - `preview-rendering.spec.ts` (Phase C) — live rendering (mermaid/
    math/wikilink/footnote), sync-scroll both directions plus the
    `mode-split` gate, cursor-follow, diagram edit-in-place refresh,
    theme-triggered mermaid re-render.
  - `export.spec.ts` (Phase C) — txt/html/pdf export with a rendered
    diagram (confirms no raw fence source leaks through).
- **`collab` project coverage**:
  - `live-sync.spec.ts` — the formalized replacement for
    `two-user-live-sync.mjs`: two independent browser contexts, alice
    creates and shares a document, bob joins via the share link and
    receives the seeded content, then a live edit from alice appears in
    bob's browser with no reload. Same scenario, real `expect()`
    assertions and Playwright's own reporter instead of a hand-rolled
    `pass` boolean.
  - `readonly-and-editing-mode.spec.ts` — **new coverage**, the actual
    gap every migration phase flagged: join a room as a
    viewer/reviewer, confirm the editor is genuinely read-only
    (`EditorState.readOnly`); switch a room's access to editable,
    confirm typing now works; confirm `window.MDE.undo()`/`redo()`
    route through the Yjs `UndoManager` while in collab mode (not the
    local CM6 `history()` stack) and back to the local stack after
    leaving the room.
- `scripts/manual-testing/two-user-live-sync.mjs` is deleted — its
  scenario is now the formal `live-sync.spec.ts`. `dev-login.patch`/
  `enable-dev-login.sh`/`disable-dev-login.sh` move under the new e2e
  infrastructure's control (see Architecture) rather than being invoked
  by hand. `simulate-collaborator-ws.mjs` (protocol-level, no browser —
  tests something a page-driving Playwright spec structurally can't)
  and `repo-sync-e2e.mjs` (needs real GitHub OAuth and a disposable real
  repo — can't be automated) are untouched.
- `npm run test:e2e` — one new script, **not** added to
  `.github/workflows/test.yml`. Manual/on-demand only, matching the
  existing `scripts/manual-testing/` convention this replaces part of.
  Sub-scripts `test:e2e:local` and `test:e2e:collab` for running either
  project alone.

## Non-goals

- CI integration. `npm test` (the Vitest unit suite) stays the only
  thing `.github/workflows/test.yml` runs. Wiring e2e into CI — which
  would need a hosted Durable Objects-capable environment for the
  `collab` project, real infra work — is a separate, later decision.
- `repo-sync-e2e.mjs`'s scenario. It requires real GitHub OAuth and a
  disposable test repository; nothing about this spec makes that
  automatable, so it stays exactly as-is.
- Visual regression / screenshot-diff testing. Out of scope — this spec
  is about functional coverage, not pixel-level UI regression.
- Cross-browser coverage (Firefox/WebKit). Chromium only, matching every
  existing manual script's `chromium.launch()`.

## Architecture

### `playwright.config.ts` (repo root)

```typescript
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
  },
  projects: [
    {
      name: "local",
      testDir: "./e2e/local",
      use: { baseURL: "http://localhost:5275" },
      webServer: {
        command: "vite dev --config client/vite.config.ts --port 5275",
        url: "http://localhost:5275",
        reuseExistingServer: !process.env.CI,
      },
    },
    {
      name: "collab",
      testDir: "./e2e/collab",
      use: { baseURL: "http://localhost:8787" },
      // No webServer here — collab needs the dev-login patch applied
      // BEFORE wrangler dev starts (it patches src/worker.ts, which
      // wrangler then builds from), which Playwright's webServer
      // option has no hook for. scripts/e2e-collab.sh (see below)
      // handles the patch/build/wrangler-dev/teardown sequence and
      // invokes this project directly once the server is confirmed up.
    },
  ],
});
```

(Port `5275` for the local project's own `vite dev` instance — distinct
from `dev:client`'s default `5173`, so a developer's own manual dev
server running alongside the e2e suite is never accidentally reused or
conflicted with.)

### `package.json` changes

```json
"scripts": {
  "test:e2e:local": "playwright test --project=local",
  "test:e2e:collab": "bash scripts/e2e-collab.sh",
  "test:e2e": "npm run test:e2e:local && npm run test:e2e:collab"
}
```

### New: `scripts/e2e-collab.sh`

Owns the same enable → build → run → **always** disable sequence
`scripts/manual-testing/README.md` currently documents as a manual
dance, made safe for unattended/automated use via a `trap ... EXIT` —
the dev-login patch gets reverted whether the tests pass, fail, or the
script is interrupted:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

bash scripts/manual-testing/enable-dev-login.sh
trap 'bash scripts/manual-testing/disable-dev-login.sh' EXIT

npm run build
npx wrangler dev --local-upstream localhost:8787 &
WRANGLER_PID=$!
trap 'kill $WRANGLER_PID 2>/dev/null; bash scripts/manual-testing/disable-dev-login.sh' EXIT

# Poll for wrangler dev's own readiness instead of a fixed sleep — see
# systematic-debugging's condition-based-waiting technique.
for i in $(seq 1 60); do
  curl -sf http://localhost:8787 >/dev/null 2>&1 && break
  sleep 1
done

npx playwright test --project=collab
```

`enable-dev-login.sh`'s own existing safety check (refuses to run if
`src/worker.ts` already has uncommitted changes) is preserved exactly —
this script doesn't bypass it, just sequences around it.

### `e2e/collab/support/dev-login.ts` (shared helper)

```typescript
import type { Page } from "@playwright/test";

const BASE = "http://localhost:8787";

// Mirrors two-user-live-sync.mjs's stubGithubIdentity — /api/auth/github/me
// actively re-verifies the session token against GitHub's real API, which
// a fake dev-login token correctly fails, blocking any Share-gated flow.
// Intercepted at the network level (not a page.evaluate() stub) because
// some of those flows run at page-load time, before a stub could land.
export async function signInAsDevUser(page: Page, username: string): Promise<void> {
  await page.route("**/api/auth/github/me", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ connected: true, username }) })
  );
  await page.goto(`${BASE}/api/dev/login?username=${username}`);
}
```

### `e2e/local/support/fixtures.ts` (shared local-mode setup)

```typescript
import { test as base } from "@playwright/test";

// Seeds a single local (non-collab) document + workspace before each
// test that needs one, mirroring the localStorage-seeding technique
// used throughout the editor-core migration's own live-verification —
// same shape, now codified as a reusable fixture instead of copy-pasted
// javascript_exec calls.
export const test = base.extend<{ docId: string }>({
  docId: async ({ page }, use) => {
    const docId = "e2e-doc-1";
    const now = Date.now();
    await page.goto("/");
    await page.evaluate(({ docId, now }) => {
      localStorage.setItem("mde:docs", JSON.stringify([
        { id: docId, name: "E2E Test Doc", content: "", createdAt: now, updatedAt: now, workspaceId: "e2e-ws-1" },
      ]));
      localStorage.setItem("mde:workspaces", JSON.stringify([{ id: "e2e-ws-1", name: "Local", createdAt: now, updatedAt: now }]));
      localStorage.setItem("mde:active", docId);
      localStorage.setItem("mde:activeWorkspace", "e2e-ws-1");
      localStorage.setItem("mde:whatsNewSeen", "999.999.999");
    }, { docId, now });
    await page.goto(`/d/${docId}`);
    await use(docId);
  },
});
export { expect } from "@playwright/test";
```

Every `local` spec file imports `test`/`expect` from this fixture
instead of `@playwright/test` directly, the same way the migration's own
live-verification always started from an identically-seeded
`localStorage`.

### Example spec shape (`e2e/local/formatting.spec.ts`)

```typescript
import { test, expect } from "./support/fixtures";

test("bold wraps the selection", async ({ page }) => {
  await page.evaluate(() => {
    const view = window.MDE.getEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "hello" }, selection: { anchor: 0, head: 5 } });
  });
  await page.click('button[title^="Bold"]');
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("**hello**");
});
```

(`expect.poll(...)` rather than a bare assertion — dispatch-then-read
across a `page.evaluate()` boundary is exactly the kind of thing that
benefits from Playwright's built-in retry/timeout handling instead of a
fixed `waitForTimeout`, the technique the manual scripts already lean on
in a few places.)

## Data flow

```
npm run test:e2e
  │
  ├─ npm run test:e2e:local
  │    │
  │    ▼
  │  playwright test --project=local
  │    │
  │    ▼
  │  Playwright's webServer starts `vite dev --port 5275` (client only,
  │  no backend) and waits for it to respond
  │    │
  │    ▼
  │  Each e2e/local/*.spec.ts test: fixtures.ts seeds localStorage,
  │  navigates to /d/<docId>, drives the UI, asserts
  │    │
  │    ▼
  │  Playwright tears down the webServer when the run finishes
  │
  └─ npm run test:e2e:collab (scripts/e2e-collab.sh)
       │
       ▼
     enable-dev-login.sh patches src/worker.ts (refuses if dirty)
       │
       ▼
     npm run build (wrangler serves client/dist as static assets)
       │
       ▼
     wrangler dev --local-upstream localhost:8787, backgrounded;
     script polls until it responds
       │
       ▼
     playwright test --project=collab — e2e/collab/*.spec.ts:
     signInAsDevUser() per browser context, drive real Durable Object
     rooms, assert
       │
       ▼
     trap fires (success, failure, or interrupt): kill wrangler dev,
     disable-dev-login.sh reverts src/worker.ts
```

## Error handling

- `enable-dev-login.sh`'s existing guard (refuses to touch a dirty
  `src/worker.ts`) is the primary safety net against the patch ever
  landing in a real commit — unchanged by this spec, just now also the
  first thing `scripts/e2e-collab.sh` does.
- The `trap ... EXIT` in `scripts/e2e-collab.sh` guarantees
  `disable-dev-login.sh` runs and `wrangler dev` is killed even if
  `npm run build` fails, the readiness poll times out, or the Playwright
  run itself crashes — not just on a clean pass/fail exit. This is the
  one meaningfully new risk this spec introduces (automating something
  the current README explicitly warns must be done by hand), so it gets
  the most defensive treatment.
- If `wrangler dev` never becomes ready within the poll's timeout, the
  script exits non-zero (via `set -e` once the loop's own explicit
  failure check is added in the implementation plan) rather than running
  Playwright against a server that isn't there — cheaper to diagnose
  than a wall of connection-refused test failures.
- `local` project tests have no comparable teardown risk — Playwright's
  own `webServer` lifecycle handles start/stop, and there's no patched
  file to ever forget to revert.

## Testing

This spec's own deliverable *is* the test suite — there's no
meta-testing layer beyond running it. Verification is: install
`@playwright/test`, run `npm run test:e2e:local` and confirm every local
spec passes against a real browser, then run `npm run test:e2e:collab`
and confirm the collab specs pass AND `git status` shows `src/worker.ts`
clean afterward (proving the trap-based cleanup actually works, not just
in the happy path — the implementation plan's own verification should
include deliberately killing the script mid-run once, to confirm the
trap still fires).

## Self-review

- **Placeholder scan**: none — every new file (`playwright.config.ts`,
  `scripts/e2e-collab.sh`, the fixture/support files, the example spec)
  is concrete, not a description of intent.
- **Internal consistency**: the Goals section's spec-file list matches
  exactly what's described in Architecture's project breakdown; nothing
  claimed as `local`-project coverage touches the backend, nothing
  claimed as `collab`-project coverage is achievable without it.
- **Scope check**: comprehensive per the user's explicit choice — 10
  local spec files plus 2 collab spec files, organized by the migration
  phase that owns each feature area, not by test-writing convenience.
  Large but not open-ended: every file maps to a real, already-built
  feature, not a hypothetical one.
- **Ambiguity check**: the two judgment calls this spec had to resolve —
  whether to retire `two-user-live-sync.mjs` (resolved: yes, retire, per
  explicit user decision) and how to safely automate the dev-login
  patch's apply/revert cycle (resolved: a `trap`-based wrapper script,
  reusing the existing scripts' own idempotency checks rather than
  replacing them) — are both stated explicitly.
