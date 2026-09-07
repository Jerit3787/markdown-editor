# Test Coverage — Bucket B finish (live-collab editor behaviours)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Close the four tractable remaining `e2e-collab` gap rows — COLLAB-43 (remote cursors), COLLAB-44 (WebSocket-drop reconnect), COLLAB-11 (reviewer withdraws own suggestion), CMT-14 (comment anchor follows live edits) — in one test-only PR. Patch bump, `CHANGELOG.md` `### Changed`, no What's New entry.

**Architecture:** All four are new Playwright specs in the `collab` project (real `wrangler dev` + DOs). Two use the `support/collab.ts` helpers; COLLAB-11 extends `suggestion-mode.spec.ts`'s own local-helper style. No production code — if a test surfaces a real bug, stop and raise it.

**Tech Stack:** Playwright `collab` project, `tests/e2e/collab/support/{collab,dev-login,share}.ts`.

**Spec:** `docs/superpowers/specs/2026-09-06-test-coverage-catalog-design.md` (the maintenance-phase spec; this is one more subsystem batch under it).

## Global Constraints

- **Never commit the dev-login patch** — `disable-dev-login.sh` + `git status` clean before every commit.
- Commit trailer `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`; PR body ends `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Test-only change → **patch** bump (`1.47.1`), `CHANGELOG.md` `### Changed`, **no** `whats-new-entries.ts`.
- e2e-collab sandbox browser mismatch: if "Executable doesn't exist", add `launchOptions:{executablePath:"/opt/pw-browsers/chromium"}` under `playwright.config.ts` `use`, run, revert before commit.
- Run the whole `collab` project serially (`--workers=1`) — the suite shares one backend.
- **Deferred, not in this PR:** COLLAB-39 (needs a constructed legacy `/api/collab` share link + migration harness) and IMG-06 (a `FileReader`-window concurrent-edit race — needs a second editor typing during the read). Both get a one-line "still deferred, needs <X>" note in the catalogue.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `tests/e2e/collab/awareness-and-reconnect.spec.ts` | new — COLLAB-43 + COLLAB-44 |
| `tests/e2e/collab/comments-collab.spec.ts` | extend — CMT-14 |
| `tests/e2e/collab/suggestion-mode.spec.ts` | extend — COLLAB-11 |
| `docs/TEST-COVERAGE.md` | 4 rows gap→covered; COLLAB-39/IMG-06 notes |
| `CHANGELOG.md`, `package.json`, `package-lock.json` | 1.47.1 patch bump |

---

## Task 1: COLLAB-43 + COLLAB-44 — awareness and reconnect

**Files:**
- Create: `tests/e2e/collab/awareness-and-reconnect.spec.ts`

**Interfaces:**
- Consumes: `ownerWithDoc`, `shareAnyoneLink`, `joinSharedWorkspace`, `expectEditorContains`, `editorText` from `./support/collab`.

- [ ] **Step 1: Write COLLAB-43 (remote cursor renders)**

```ts
import { test, expect } from "@playwright/test";
import { ownerWithDoc, shareAnyoneLink, joinSharedWorkspace, expectEditorContains, editorText } from "./support/collab";

test("COLLAB-43: a remote collaborator's selection renders in the other editor (yCollab awareness)", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "aware-a-e2e", "the quick brown fox jumps");
  const url = await shareAnyoneLink(a, "Editor");
  await joinSharedWorkspace(b, url);
  await expectEditorContains(b, "the quick brown fox");

  // A selects "quick" (chars 4..9).
  await a.evaluate(() => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ selection: { anchor: 4, head: 9 } });
    cm.focus();
  });

  // B's editor renders A's remote selection + caret (y-codemirror.next's
  // yRemoteSelectionsTheme — .cm-ySelection / .cm-ySelectionCaret).
  await expect(b.locator(".cm-ySelectionCaret")).toBeVisible({ timeout: 10000 });
  await expect(b.locator(".cm-ySelection").first()).toBeVisible();

  await aCtx.close();
  await bCtx.close();
});
```

- [ ] **Step 2: Write COLLAB-44 (WebSocket drop → reconnect, no dup)**

```ts
test("COLLAB-44: a dropped WebSocket reconnects and re-syncs without duplicating content", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "reconnect-a-e2e", "START");
  const url = await shareAnyoneLink(a, "Editor");
  await joinSharedWorkspace(b, url);
  await expectEditorContains(b, "START");

  // Drop B's connection (kills the WebSocket -> ws.onclose -> scheduleReconnect).
  await bCtx.setOffline(true);
  await b.waitForTimeout(1500);

  // A keeps editing while B is offline.
  await a.evaluate(() => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ changes: { from: cm.state.doc.length, insert: " / while-offline" } });
  });

  // B comes back — reconnect (1s base backoff) then re-sync.
  await bCtx.setOffline(false);
  await expectEditorContains(b, "while-offline", 20000);

  // No duplication on either side, and they converge.
  await expect.poll(async () => (await editorText(a)) === (await editorText(b))).toBe(true);
  const text = await editorText(b);
  expect(text.match(/START/g)?.length).toBe(1);
  expect(text.match(/while-offline/g)?.length).toBe(1);

  await aCtx.close();
  await bCtx.close();
});
```

- [ ] **Step 3: Run both — expect PASS (this is new coverage of existing behaviour)**

```bash
bash tests/scripts/manual-testing/enable-dev-login.sh
npm run build
npx wrangler dev --local-upstream localhost:8787 &   # wait for :8787
npx playwright test --project=collab tests/e2e/collab/awareness-and-reconnect.spec.ts --workers=1 --timeout=60000
```
If COLLAB-43's classes differ, inspect the actual DOM with a `read_page` / `page.locator(".cm-line").first()` dump and adjust to the real y-codemirror.next class names (they are `cm-ySelection*` in the pinned version — confirm). If COLLAB-44 flakes on the 20s window, raise the timeout to 30s; if it still fails, **stop** — a genuinely broken reconnect is a bug, not a test problem.

- [ ] **Step 4: Commit**

```bash
bash tests/scripts/manual-testing/disable-dev-login.sh   # confirm git status clean of src/worker.ts
npm run format
git add tests/e2e/collab/awareness-and-reconnect.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e-collab): COLLAB-43 remote cursor rendering + COLLAB-44 WebSocket-drop reconnect

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: COLLAB-11 — reviewer withdraws their own suggestion

**Files:**
- Modify: `tests/e2e/collab/suggestion-mode.spec.ts`

**Interfaces:**
- Consumes: that file's own local helpers (`createFirstWorkspaceAndDoc`, `joinSharedWorkspace`, `waitForExactlyOne`, `signInAsDevUser`, `readSharedState`). Suggestion action buttons come from `suggestion-editor.ts` — a reviewer's own pending suggestion shows a **"Withdraw"** button (`withdrawSuggestion(doc, id)` → reject-restricted-to-author).

- [ ] **Step 1: Read the existing test to mirror its setup**

Read `tests/e2e/collab/suggestion-mode.spec.ts` fully. The existing test already: signs in an owner (editor) + a reviewer, shares, the reviewer joins with `role=reviewer`, the reviewer types → a `.cm-suggestion`/suggestion-map entry appears, the editor accepts/rejects. Reuse that arc.

- [ ] **Step 2: Add the COLLAB-11 test**

After the existing test, add one that stops at the reviewer's own withdraw instead of the editor's accept/reject:

```ts
test("COLLAB-11: a reviewer can withdraw their own pending suggestion, and it disappears for both", async ({ browser }) => {
  // ... same setup as the existing test up to: reviewer has typed an
  // insertion that is now one pending suggestion on both sides ...

  // Reviewer hovers/opens their suggestion and clicks Withdraw.
  await reviewer.locator(".cm-suggestion").first().click();
  await reviewer.locator('button:has-text("Withdraw")').click();

  // Gone for the reviewer AND the editor — the inserted text is removed
  // (withdraw == reject) and the suggestion-map entry is cleared.
  await expect.poll(() => reviewer.locator(".cm-suggestion").count(), { timeout: 10000 }).toBe(0);
  await expect.poll(() => editor.locator(".cm-suggestion").count(), { timeout: 10000 }).toBe(0);
  await expect.poll(() => editorTextOf(editor)).not.toContain("<the reviewer's inserted string>");
});
```

Fill in the exact setup by copying the existing test's lines (the plan's "same setup" is a real copy, not a reference — paste the actual statements). Use the existing file's own `page.evaluate(() => window.MDE.getEditor()...)` text-read pattern for `editorTextOf`.

- [ ] **Step 3: Run it**

```bash
npx playwright test --project=collab tests/e2e/collab/suggestion-mode.spec.ts --workers=1 --timeout=60000
```
Expected: both tests pass. If the Withdraw button's selector/label differs, check `suggestion-editor.ts:46` — it is `this.actionButton("withdraw", "Withdraw", ...)`; find the rendered element (likely `.cm-suggestion-action` or a plain `<button>` inside the widget) and match on visible text "Withdraw".

- [ ] **Step 4: Commit**

```bash
npm run format
git add tests/e2e/collab/suggestion-mode.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e-collab): COLLAB-11 a reviewer withdrawing their own pending suggestion

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: CMT-14 — comment anchor follows live edits

**Files:**
- Modify: `tests/e2e/collab/comments-collab.spec.ts`

**Interfaces:**
- Consumes: `ownerWithDoc`, `shareAnyoneLink`, `joinSharedWorkspace`, `expectEditorContains` from `./support/collab`. The comment marker is `.cm-comment-marker` (`editor-theme.ts:38`); `app.ts`'s `relocateAnchor` pass re-runs `setCommentMarkers` on every doc change; an anchor whose quoted text is gone is dropped (no marker rendered) — CMT-02 covers the pure `relocateAnchor` logic.

- [ ] **Step 1: Read `comments-collab.spec.ts` (CMT-15) for the comment-creation arc**

The CMT-15 test already: owner + peer on a shared doc, owner selects "quick", clicks "Add comment", fills the textarea, submits; the peer sees `.cm-comment-marker` live. Reuse that up to "marker visible on both".

- [ ] **Step 2: Add the CMT-14 test**

```ts
test("CMT-14: a comment's highlight follows edits made above it and drops when its quoted text is deleted", async ({ browser }) => {
  // ... same setup as CMT-15: owner comments on "quick" in "the quick brown fox",
  //     both sides show one .cm-comment-marker over "quick" ...

  // Capture where the marker sits now.
  const before = await owner.locator(".cm-comment-marker").first().textContent();
  expect(before?.trim()).toBe("quick");

  // Peer inserts text at the very start — the anchor must shift to stay on "quick".
  await peer.evaluate(() => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ changes: { from: 0, insert: "PREFIX " } });
  });
  await expectEditorContains(owner, "PREFIX the quick");
  await expect.poll(() => owner.locator(".cm-comment-marker").first().textContent().then((t) => t?.trim())).toBe("quick");

  // Peer deletes the word "quick" — the marker is dropped on both sides.
  await peer.evaluate(() => {
    const cm = window.MDE.getEditor();
    const i = cm.state.doc.toString().indexOf("quick");
    cm.dispatch({ changes: { from: i, to: i + "quick ".length, insert: "" } });
  });
  await expect.poll(() => owner.locator(".cm-comment-marker").count(), { timeout: 10000 }).toBe(0);
  await expect.poll(() => peer.locator(".cm-comment-marker").count(), { timeout: 10000 }).toBe(0);

  await ownerCtx.close();
  await peerCtx.close();
});
```

Paste the real CMT-15 setup lines (context creation, `ownerWithDoc`, `shareAnyoneLink`, `joinSharedWorkspace`, the select-"quick" keyboard sequence, "Add comment", `.comment-draft-box textarea` fill, `.comment-draft-box button.primary-btn` submit) rather than referencing them.

- [ ] **Step 3: Run it**

```bash
npx playwright test --project=collab tests/e2e/collab/comments-collab.spec.ts --workers=1 --timeout=60000
```
Expected: both CMT tests pass. If the "follows edits above" assertion is flaky because `relocateAnchor` keys on surrounding context rather than raw offset, relax to "the marker is still present and still reads 'quick'" (don't assert an exact offset). If the marker does **not** drop on delete, check whether the app instead renders an orphaned-state marker class — adjust the assertion to that class, and note it in the catalogue.

- [ ] **Step 4: Commit**

```bash
npm run format
git add tests/e2e/collab/comments-collab.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e-collab): CMT-14 comment highlight follows live edits and drops on quote deletion

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Catalogue + patch bump + PR

**Files:**
- Modify: `docs/TEST-COVERAGE.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`

- [ ] **Step 1: Update the catalogue**

- COLLAB-43, COLLAB-44 rows → `covered`, ref `tests/e2e/collab/awareness-and-reconnect.spec.ts`.
- COLLAB-11 row → `covered`, ref `suggestion-mode.spec.ts`.
- CMT-14 row → `covered`, ref `comments-collab.spec.ts` (note the exact drop-behaviour the test asserts).
- COLLAB-39: keep `gap`, note "needs a constructed legacy `/api/collab` share link + migration harness; `handleMigrateRequest` tombstone covered at integration".
- IMG-06: keep `gap`, note "needs a second editor typing during the `FileReader` window; single-editor half covered by IMG-07".
- §9 tally: `covered` +1, `gap` −1. §10 tally: `covered` +3, `gap` −3. `**Total**` row: `covered` +4 → 302, `gap` −4 → 6. Re-verify the subsystem rows sum to the Total.

- [ ] **Step 2: CHANGELOG**

```markdown
## [1.47.1] - <today>

### Changed

- **Test coverage — live-collaboration editor behaviours.** Four new `e2e-collab` tests with a real second collaborator: a remote selection renders in the other editor (COLLAB-43); a dropped WebSocket reconnects and re-syncs with no duplicated content (COLLAB-44); a reviewer can withdraw their own pending suggestion and it clears for both sides (COLLAB-11); a comment highlight follows edits made above it and drops when its quoted text is deleted (CMT-14). No behaviour change.
```

- [ ] **Step 3: Patch bump** — `package.json` line 4 + `package-lock.json` lines 3 & ~9: `1.47.0` → `1.47.1`.

- [ ] **Step 4: Full local verification**

```bash
npm run typecheck && npm test && npm run format:check
# enable-dev-login, build, wrangler dev, then:
npx playwright test --project=collab --workers=1
# disable-dev-login, confirm git status clean
```
Expected: unit green (no new unit tests); full `collab` project green (23 tests).

- [ ] **Step 5: Commit + PR + merge**

```bash
git add docs/TEST-COVERAGE.md CHANGELOG.md package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore(release): live-collab editor-behaviour test coverage — v1.47.1

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push -u origin <branch>
```
PR against `master`, body summarising the four rows + the COLLAB-39/IMG-06 deferrals. Wait for CI green, merge with a merge commit, fast-forward local `master`.

---

## Self-Review

**Spec coverage:** COLLAB-43 → Task 1 Step 1. COLLAB-44 → Task 1 Step 2. COLLAB-11 → Task 2. CMT-14 → Task 3. Catalogue + bump → Task 4. COLLAB-39 + IMG-06 explicitly deferred with reasons (Task 4 Step 1).

**Placeholder scan:** Tasks 2 and 3 say "paste the real setup lines" rather than reproducing the full existing-test body — acceptable because the executor reads those files in the same task (Task 2 Step 1, Task 3 Step 1) and the delta (the new assertions) *is* given in full. The `<the reviewer's inserted string>` / `<branch>` / `<today>` are fill-ins the executor resolves from context, not hidden logic.

**Type consistency:** All four tests are standalone Playwright specs; no shared types introduced. Helper names (`ownerWithDoc`, `joinSharedWorkspace`, `expectEditorContains`, `editorText`) match `support/collab.ts`'s real exports.

**Ordering:** Tasks 1–3 are independent (different files, different specs) — any can be rejected without blocking the others. Task 4 depends on all three. A reviewer can accept the reconnect test but ask for changes to the comment-anchor assertions independently.
