# Test Coverage Phases 10–14 (combined)

> Executed inline as one branch / one PR at the user's request ("do all the remaining in one single PR and then merge"). §9 has its own plan doc; this covers §10 Collab, §11 Auth/Gist, §12 Repo sync, §13 Mobile, §14 App shell.

**Goal:** Close every §10–§14 gap/partial row that does not require infrastructure this repo can't stand up locally (real GitHub OAuth in e2e; the flaky `e2e-collab` Worker suite).

**Spec:** `docs/TEST-COVERAGE.md` §10–§14.

## Global Constraints

- Test-only → one patch bump for the whole phases-9–14 branch, `CHANGELOG.md` `### Changed`, no `whats-new-entries.ts` entry.
- Match each subsystem's existing test patterns; pin real strings.
- Bug found while writing a test: trivial → fix + regression; non-trivial → note + leave the row `partial`/`gap` with the finding.
- Commit per subsystem.

## §11 — GitHub auth & Gist  (→ 19/3/1)

**Files:** `tests/src/github-auth.test.ts`, `tests/client/src/gist.test.ts`, `tests/src/memory-fs.test.ts` (new).

- [x] AUTH-04 — `handleLogin` state cookie (`Max-Age=600`, `HttpOnly`) value echoed in the authorize URL.
- [x] AUTH-05 — `handleCallback` happy path (token exchange → `/user` → session cookie → `"ok":true`) + mismatched-state short-circuit.
- [x] AUTH-07 — `handleMe`: 401 → signed out + cookie cleared; `fetch` throws → trust local session, no cookie touched.
- [x] AUTH-08 — `handleLogout`: POST → 200 + `Max-Age=0`; survives a failing grant-revoke; GET → 302 `/`.
- [x] GIST-01/02/03 — create/update/list/get proxy handlers: URL + method + body forwarding, 401 when signed out.
- [x] GIST-08/09/10 — `parseGistId` / `extractInlineImages` / `formatGistDate` unit.
- [x] GIST-14 — `MemoryFS` surface directly (write→read bytes/string, auto-mkdir, readdir sort, unlink, ENOENT/ENOSYS, `.`/`..`).
- Deferred: GIST-05 (happy git push needs an isomorphic-git smart-HTTP mock for the gist's own repo), GIST-11/GIST-13 (e2e, needs OAuth).

## §14 — App shell  (→ 16/2/3)

**Files:** `tests/client/src/escape-html.test.ts` (new), `tests/client/src/stores/toast.test.ts`, `tests/client/src/components/Modal.test.ts` (new), `tests/src/worker.test.ts` (new), `tests/e2e/local/menu-shell.spec.ts` (new), `tests/e2e/local/focus-mode.spec.ts`.

- [x] SHELL-04 — `Modal.svelte` shell: header + `aria-modal` dialog + body/tabs/footer regions, × + backdrop-click close, `elevated`. (Focus-trap/Esc/scroll-lock are each consumer's own onMount — noted in the catalog.)
- [x] SHELL-05 — regular toasts: type default, per-toast timers, stacking, `dismissToast`.
- [x] SHELL-13 — Focus Mode not restored after a reload.
- [x] SHELL-16 — `escapeHtml` (`<`/`>`/`&`; quotes intentionally not escaped by its `div.textContent` mechanism).
- [x] SHELL-18 — File/Edit/Help menus open + click-outside + hover-switch (Format/Insert/View already covered).
- [x] SHELL-20 — Help → Keyboard Shortcuts / About & Privacy modals open + close.
- [x] SHELL-21 — `worker.ts` routing: non-API + unknown `/api/*` both fall through to `env.ASSETS` (catalog corrected — **no hard 404**); workspace/collab → DO; non-WS `/api/workspace/:id` → 426; `/api/auth/github/me` → its handler.
- Deferred: SHELL-02 (full ~30-command sweep), SHELL-10 (whats-new seen side-effect), SHELL-11 (dev-only version-mismatch warn — needs mocking the entries module).

## §13 — Mobile  (→ 12/0/3)

**File:** `tests/e2e/local/mobile-layout.spec.ts` (new).

- [x] MOB-01 — below the breakpoint the split layout stacks (`#main` `flex-direction: column`, editor above preview).
- [x] MOB-07 — the sidebar sheet resets to the Documents tab on each open (switch to Headings → close → reopen).
- [x] MOB-08 — Headings tab: one `.outline-item` per heading, no row menu; tap → `jumpToLine` + sheet closes.
- [x] MOB-14 — resizing across the breakpoint re-lays-out row→column→row with no reload.
- Deferred: MOB-11/12/13 (mobile-Safari-width visual regressions — the "Preview" badge / "Anyone with the link" label / floating exit-Focus button; each needs a specific narrow-width pixel check).

## §10 — Workspace collab  (→ 37/4/5)

**File:** `tests/client/src/components/ShareChoiceModal.test.ts` (new).

- [x] COLLAB-24 — ShareChoiceModal: document / workspace / cancel resolution; prompt names the doc count + workspace.
- Deferred: COLLAB-11/13/23/25/39/43/44 (all `e2e-collab`), COLLAB-31/42 (partials — the redundant-rejoin exact case and the `workspacePresence` store/avatar UI).

## §12 — GitHub repo sync  (→ 19/1/4)

**File:** `tests/client/src/components/RepoConflictModal.test.ts` (new).

- [x] REPO-20 — per-file resolution select defaults to `mine`; Apply → `onResolve({docId: side})`; Cancel resolves nothing.
- Deferred: REPO-19/22/23 (e2e UI orchestration), REPO-21 (VH repo commits — cross-ref VER-16), REPO-24 (client repo-commits skip when signed out).

## §9 — Comments

See `docs/superpowers/plans/2026-09-07-test-coverage-phase-9-comments.md`.
