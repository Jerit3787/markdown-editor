# Collaboration mode chrome — Plan 3: focus mode & the 1.50.0 release

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give desktop a discoverable way out of focus mode (B1 — a top hover-hint), extend paragraph dimming to the preview pane (B2), and cut the `1.50.0` release that ships all three plans of this branch.

**Architecture:** Editor.svelte publishes the active-paragraph line range to a `focusActiveLines` store while focus mode is on. `#focusHint` is a fixed top pill that `app.ts` slides in on a top-edge `mousemove` (and once on entry) and hides after an idle timeout. Preview.svelte adds a `.focus-dim` class to every rendered block whose `[data-line]` span falls outside `focusActiveLines`.

**Tech Stack:** TypeScript, Svelte 5, CodeMirror 6, Vitest (`unit` + `components`), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-collaboration-mode-chrome-design.md` (§7 B1/B2)

## Global Constraints

- Continues on branch `feat/collab-mode-chrome` (Plans 1 + 2 already on it). **This plan does the release** — it bumps `package.json` + both `package-lock.json` `"version"` fields to `1.50.0`, fills in `CHANGELOG.md`'s existing `## [1.50.0] - UNRELEASED` heading (rename to `## [1.50.0] - <today>`), and adds one `client/src/whats-new-entries.ts` entry **with a real committed screenshot** in `client/public/whats-new/`.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` only. PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Never `git add src/worker.ts`.** This plan does not touch server code; keep the dev-login patch out of every commit (explicit `git add <paths>`; `git status` first). The screenshot-capture step (Task 5) applies + reverts the patch via `enable/disable-dev-login.sh` — verify `git diff --quiet src/worker.ts` after.
- `WhatsNew.svelte` warns in dev if the last `whats-new-entries.ts` entry's version ≠ `__APP_VERSION__` — so the new entry's `version` must be `"1.50.0"` and it must be last.
- `whats-new-entries.ts` entry shape (no `date` field): `{ version, title, description, screenshot: "/whats-new/<name>.png", category }`. `category` ∈ `WhatsNewCategory` (`"Editing & Formatting" | "Collaboration" | "Version History" | "GitHub Integration" | "Organization & Navigation"`).
- Focus mode is a session toggle (`stores/focusMode.ts`), never persisted — unchanged.
- Desktop-only for B1: the existing mobile `#focusModeExitBtn` (shown only `@media (max-width: 780px)`) stays as-is; the new `#focusHint` is a desktop affordance (pointer hover has no mobile equivalent).

---

## File Structure

- `client/src/stores/focusMode.ts` (modify) — add `focusActiveLines`.
- `client/src/components/Editor.svelte` (modify) — a focus-mode update listener that writes `focusActiveLines`; clear it on exit.
- `client/index.html` (modify) — `#focusHint` element next to `#focusModeExitBtn`.
- `client/src/app.ts` (modify) — `initFocusHint()`: show on entry + on top-edge `mousemove`, hide on idle, click → `focusMode.set(false)`.
- `client/src/components/Preview.svelte` (modify) — `applyFocusDim()` called from `updatePreview()` + a `$effect` on `focusMode` / `focusActiveLines`.
- `client/src/styles/_editor-preview.scss` (modify) — `#focusHint` + `#preview .focus-dim` styles.
- `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/public/whats-new/focus-mode-polish.png`, `package.json`, `package-lock.json`, `docs/TEST-COVERAGE.md`, `docs/ROADMAP.md`.
- Tests: `tests/client/src/components/Editor.test.ts` (or the nearest existing Editor component test), `tests/client/src/components/Preview.test.ts`, `tests/e2e/local/focus-mode.spec.ts` (extend).
- New capture script: `tests/scripts/manual-testing/capture-focus-mode-polish-screenshot.mjs`.

---

## Task 1: `focusActiveLines` store

**Files:**
- Modify: `client/src/stores/focusMode.ts`
- Test: covered by Task 2's Editor test (the store alone is a one-liner).

**Interfaces:**
- Produces: `focusActiveLines: Writable<{ from: number; to: number } | null>` — 1-based CodeMirror line numbers (inclusive) of the paragraph the cursor is in, while focus mode is on; `null` when focus mode is off.

- [ ] **Step 1: Implement**

`client/src/stores/focusMode.ts`, append:

```ts
// The 1-based line range of the paragraph the cursor is in, published by
// Editor.svelte while focus mode is on (null otherwise). Preview.svelte
// reads it to dim the corresponding preview blocks (B2).
export const focusActiveLines = writable<{ from: number; to: number } | null>(null);
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck` — clean.

```bash
git add client/src/stores/focusMode.ts
git commit -m "$(cat <<'EOF'
feat(focus): focusActiveLines store for preview-pane dimming

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Editor publishes the active-paragraph range

**Files:**
- Modify: `client/src/components/Editor.svelte` — `focusModeExtensions()` (~line 160) + the focus-mode `$effect` (~line 499).
- Test: `tests/client/src/components/Editor.test.ts` (create if absent — check for an existing Editor component test first; the `components` project mounts real `.svelte` in headless Chromium).

**Interfaces:**
- Consumes: `activeParagraphRange` (`../focus-mode`), `focusActiveLines` (`../stores/focusMode`).
- Produces: while focus mode is on, `focusActiveLines` tracks the cursor's paragraph on every selection / doc change; set to `null` when focus mode turns off.

- [ ] **Step 1: Write the failing test**

`tests/client/src/components/Editor.test.ts` — mount `Editor`, set some multi-paragraph content, turn on `focusMode`, move the cursor, assert `focusActiveLines`:

```ts
import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";
import Editor from "../../../../client/src/components/Editor.svelte";
import { focusMode, focusActiveLines } from "../../../../client/src/stores/focusMode";

beforeEach(() => {
  focusMode.set(false);
  focusActiveLines.set(null);
  window.MDE = new Proxy({ getEditorExtensions: () => [] }, { get: (t, p) => (p in t ? (t as any)[p] : vi.fn()) }) as unknown as typeof window.MDE;
});

test("B2: focusActiveLines tracks the cursor's paragraph while focus mode is on, and clears on exit", async () => {
  const screen = await render(Editor);
  const view = window.MDE.getEditor();
  view.dispatch({ changes: { from: 0, insert: "para one line a\npara one line b\n\npara two\n" } });

  focusMode.set(true);
  view.dispatch({ selection: { anchor: 2 } }); // inside paragraph one (lines 1-2)
  await expect.poll(() => get(focusActiveLines)).toEqual({ from: 1, to: 2 });

  view.dispatch({ selection: { anchor: view.state.doc.line(4).from } }); // paragraph two (line 4)
  await expect.poll(() => get(focusActiveLines)).toEqual({ from: 4, to: 4 });

  focusMode.set(false);
  await expect.poll(() => get(focusActiveLines)).toBeNull();
});
```

If `Editor` needs more `window.MDE` / DOM scaffolding to mount, copy it from whichever component test already mounts it (search `render(Editor` under `tests/`). If none does and it proves too heavy to mount, fall back to a unit test that exercises the listener's logic directly — but prefer the component test.

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run --project=components tests/client/src/components/Editor.test.ts -t "B2"`
Expected: FAIL — `focusActiveLines` stays `null`.

- [ ] **Step 3: Implement**

`client/src/components/Editor.svelte` script — import:

```ts
  import { focusMode, focusActiveLines } from "../stores/focusMode";
```

(replace the existing `import { focusMode } from "../stores/focusMode";`)

Add a listener and include it in `focusModeExtensions()`:

```ts
  const focusRangeListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged && !update.selectionSet) return;
    const { from, to } = activeParagraphRange(update.state.doc, update.state.selection.main.head);
    focusActiveLines.set({ from: update.state.doc.lineAt(from).number, to: update.state.doc.lineAt(to).number });
  });

  function focusModeExtensions(): Extension[] {
    return [focusDimField, typewriterListener, focusRangeListener];
  }
```

In the focus-mode `$effect`, publish the initial range on entry and clear on exit:

```ts
  $effect(() => {
    if (!view) return;
    document.body.classList.toggle("focus-mode", $focusMode);
    view.dispatch({ effects: focusModeCompartment.reconfigure($focusMode ? focusModeExtensions() : []) });
    if ($focusMode) {
      centerCursorLine(view);
      const { from, to } = activeParagraphRange(view.state.doc, view.state.selection.main.head);
      focusActiveLines.set({ from: view.state.doc.lineAt(from).number, to: view.state.doc.lineAt(to).number });
    } else {
      focusActiveLines.set(null);
    }
  });
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run --project=components tests/client/src/components/Editor.test.ts` — PASS.
Run: `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Editor.svelte tests/client/src/components/Editor.test.ts
git commit -m "$(cat <<'EOF'
feat(focus): publish the active-paragraph line range while focus mode is on

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: B1 — desktop focus-mode exit hint

**Files:**
- Modify: `client/index.html` (`#focusHint`), `client/src/app.ts` (`initFocusHint()`), `client/src/styles/_editor-preview.scss` (styles).
- Test: `tests/e2e/local/focus-mode.spec.ts` (extend).

**Interfaces:**
- Consumes: `focusMode` store, `document` `mousemove`.
- Behaviour: while `body.focus-mode`, `#focusHint` shows for ~2.2s on entry, and shows whenever the pointer is within 48px of the top edge (re-arming a ~2.5s hide timer on each such move); a click on it runs `focusMode.set(false)`. Off `body.focus-mode`, it's hidden and its listeners idle.

- [ ] **Step 1: Add the markup**

`client/index.html`, right after `#focusModeExitBtn`:

```html
    <!-- Desktop focus-mode exit hint — slides down from the top edge on a
     top-of-viewport mouse move, and once briefly on entry. Mobile keeps
     the always-visible #focusModeExitBtn above instead. See app.ts's
     initFocusHint() + _editor-preview.scss. -->
    <button id="focusHint" class="focus-hint" type="button">
      <svg class="icon"><use href="#icon-x"></use></svg>
      <span>Focus mode — press Esc or click here to exit</span>
    </button>
```

- [ ] **Step 2: Style it**

`client/src/styles/_editor-preview.scss`:

```scss
.focus-hint {
  position: fixed;
  top: 0;
  left: 50%;
  transform: translate(-50%, calc(-100% - 8px));
  z-index: 60;
  display: none;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border: 1px solid var(--border);
  border-top: none;
  border-radius: 0 0 10px 10px;
  background: var(--bg);
  color: var(--text-dim);
  box-shadow: var(--shadow);
  font-size: 13px;
  cursor: pointer;
  transition: transform 0.18s ease;
}
.focus-hint .icon {
  width: 14px;
  height: 14px;
}
body.focus-mode .focus-hint {
  display: flex;
}
body.focus-mode .focus-hint.is-visible {
  transform: translate(-50%, 0);
}
@media (max-width: 780px) {
  /* Mobile uses the always-visible #focusModeExitBtn; no hover to trigger this. */
  .focus-hint {
    display: none !important;
  }
}
```

- [ ] **Step 3: Wire it in `app.ts`**

Add `initFocusHint()` and call it from `init()` near the `#focusModeExitBtn` wiring (~line 103):

```ts
  function initFocusHint() {
    const hint = document.getElementById("focusHint");
    if (!hint) return;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const show = (ms: number) => {
      hint.classList.add("is-visible");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => hint.classList.remove("is-visible"), ms);
    };
    hint.addEventListener("click", () => focusMode.set(false));
    document.addEventListener("mousemove", (e) => {
      if (!document.body.classList.contains("focus-mode")) return;
      if (e.clientY <= 48) show(2500);
    });
    focusMode.subscribe((on) => {
      if (on) show(2200);
      else {
        clearTimeout(hideTimer);
        hint.classList.remove("is-visible");
      }
    });
  }
```

Call `initFocusHint();` alongside the other `init()` setup calls.

- [ ] **Step 4: Extend the E2E**

`tests/e2e/local/focus-mode.spec.ts`:

```ts
test("desktop: the focus-mode hint appears on entry and on a top-of-screen mouse move, and exits on click", async ({ page }) => {
  await page.goto("/");
  await page.click('text="Focus Mode"');
  await expect(page.locator("body")).toHaveClass(/focus-mode/);

  // Shown briefly on entry.
  await expect(page.locator("#focusHint")).toHaveClass(/is-visible/);

  // After it auto-hides, a move to the top brings it back.
  await expect(page.locator("#focusHint")).not.toHaveClass(/is-visible/, { timeout: 4000 });
  await page.mouse.move(400, 5);
  await expect(page.locator("#focusHint")).toHaveClass(/is-visible/);

  // Clicking it exits.
  await page.click("#focusHint");
  await expect(page.locator("body")).not.toHaveClass(/focus-mode/);
});
```

- [ ] **Step 5: Run e2e + build**

Run: `npm run build` — succeeds.
Run: `npm run test:e2e:local` — green (sandbox browser caveat from `CLAUDE.md` applies).

- [ ] **Step 6: Commit**

```bash
git add client/index.html client/src/app.ts client/src/styles/_editor-preview.scss tests/e2e/local/focus-mode.spec.ts
git commit -m "$(cat <<'EOF'
feat(focus): desktop hover-hint for exiting focus mode (B1)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: B2 — dim the preview pane

**Files:**
- Modify: `client/src/components/Preview.svelte` — `updatePreview()` tail (~line 143) + a new `$effect`.
- Modify: `client/src/styles/_editor-preview.scss` — `#preview .focus-dim`.
- Test: `tests/client/src/components/Preview.test.ts` (extend / create).

**Interfaces:**
- Consumes: `focusMode`, `focusActiveLines` (`../stores/focusMode`).
- Behaviour: while `$focusMode` and `$focusActiveLines` is set, every top-level `#preview` child whose `[data-line]` span (`[data-line]` .. next tagged block's `data-line`) does not overlap `[from-1, to-1]` (0-based, since `data-line` is 0-based — see `computeBlockLineStarts`) gets `.focus-dim`; all `.focus-dim` classes are cleared when focus mode is off. Blocks with no `[data-line]` are left undimmed.

- [ ] **Step 1: Write the failing test**

`tests/client/src/components/Preview.test.ts` — render `Preview`, feed multi-block content through `updatePreview` (via `window.MDE.getEditor()` + `window.MDE.updatePreview()` or however the file already drives it), set `focusMode` + `focusActiveLines`, assert `.focus-dim`:

```ts
import { focusMode, focusActiveLines } from "../../../../client/src/stores/focusMode";

test("B2: preview blocks outside the active paragraph get .focus-dim, cleared on exit", async () => {
  // ...render Preview, set editor content to "# Head\n\npara one\n\npara two\n", updatePreview()...
  const host = /* the #preview host element from the render */;
  focusMode.set(true);
  focusActiveLines.set({ from: 3, to: 3 }); // "para one" is on line 3 (1-based)

  await expect.poll(() => host.querySelector('[data-line="0"]')?.classList.contains("focus-dim")).toBe(true); // the heading
  await expect.poll(() => host.querySelector('[data-line="2"]')?.classList.contains("focus-dim")).toBe(false); // para one (line 3 → data-line 2)

  focusMode.set(false);
  await expect.poll(() => host.querySelectorAll(".focus-dim").length).toBe(0);
});
```

Match the file's existing pattern for mounting `Preview` + driving `updatePreview`. If `Preview.test.ts` doesn't exist yet, model the harness on `tests/client/src/components/DiffView.test.ts` or another component test that needs `window.MDE.getEditor()`.

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run --project=components tests/client/src/components/Preview.test.ts -t "B2"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`client/src/components/Preview.svelte` script — import:

```ts
  import { focusMode, focusActiveLines } from "../stores/focusMode";
```

Add `applyFocusDim()`:

```ts
  // B2 — while focus mode is on, dim every preview block outside the
  // paragraph the cursor is in (focusActiveLines, 1-based). Blocks are
  // already [data-line]-tagged (0-based) by updatePreview() for
  // sync-scroll; reuse those.
  function applyFocusDim() {
    if (!hostEl) return;
    const range = get(focusMode) ? get(focusActiveLines) : null;
    const children = Array.from(hostEl.children) as HTMLElement[];
    if (!range) {
      for (const el of children) el.classList.remove("focus-dim");
      return;
    }
    const from0 = range.from - 1;
    const to0 = range.to - 1;
    // Each tagged block spans [its data-line, the next tagged block's data-line).
    const tagged = children.map((el, i) => ({ el, line: el.hasAttribute("data-line") ? Number(el.getAttribute("data-line")) : null, i }));
    for (let k = 0; k < tagged.length; k++) {
      const { el, line } = tagged[k]!;
      if (line === null) {
        el.classList.remove("focus-dim");
        continue;
      }
      let end = Infinity;
      for (let m = k + 1; m < tagged.length; m++) {
        if (tagged[m]!.line !== null) {
          end = tagged[m]!.line as number;
          break;
        }
      }
      const overlaps = line <= to0 && end > from0;
      el.classList.toggle("focus-dim", !overlaps);
    }
  }
```

(Add `import { get } from "svelte/store";` if not already imported.)

Call it at the end of `updatePreview()`, right after the `[data-line]` tagging loops (before `mermaidRenderScheduler.trigger();` is fine):

```ts
    applyFocusDim();
```

And a reactive `$effect` so a cursor move (no re-render) still updates the dimming:

```ts
  $effect(() => {
    // re-read both stores so this tracks them
    void $focusMode;
    void $focusActiveLines;
    applyFocusDim();
  });
```

- [ ] **Step 4: Style it**

`client/src/styles/_editor-preview.scss`, near the `#preview` rules:

```scss
#preview > .focus-dim {
  opacity: 0.35;
  transition: opacity 0.15s ease;
}
```

- [ ] **Step 5: Run tests + build + e2e**

Run: `npx vitest run --project=components tests/client/src/components/Preview.test.ts` — PASS.
Run: `npm test` — all green.
Run: `npm run build` — succeeds.

Add an e2e assertion to `tests/e2e/local/focus-mode.spec.ts` (split view, focus on → a block away from the cursor has `.focus-dim`):

```ts
test("focus mode dims preview blocks outside the active paragraph", async ({ page }) => {
  await page.goto("/");
  // ...ensure split view, type a heading + two paragraphs, put the cursor in paragraph two...
  await page.click('text="Focus Mode"');
  await expect(page.locator('#preview [data-line="0"]')).toHaveClass(/focus-dim/); // the heading, dimmed
});
```

- [ ] **Step 6: Commit**

```bash
git add client/src/components/Preview.svelte client/src/styles/_editor-preview.scss tests/client/src/components/Preview.test.ts tests/e2e/local/focus-mode.spec.ts
git commit -m "$(cat <<'EOF'
feat(focus): extend paragraph dimming to the preview pane (B2)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: The 1.50.0 release

**Files:**
- Create: `tests/scripts/manual-testing/capture-focus-mode-polish-screenshot.mjs`, `client/public/whats-new/focus-mode-polish.png`
- Modify: `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `package.json`, `package-lock.json`, `docs/TEST-COVERAGE.md`, `docs/ROADMAP.md`

- [ ] **Step 1: Full local verification**

```bash
npm test
npm run typecheck
npm run format:check      # `npm run format` then re-add if it flags anything
npm run build
npm run test:e2e:local
npm run test:e2e:collab
```

All green. Fix anything red in the owning task before proceeding.

- [ ] **Step 2: `CHANGELOG.md` — rename the heading + add `### Fixed`**

Change `## [1.50.0] - UNRELEASED` to `## [1.50.0] - <YYYY-MM-DD>`. Under it, add:

```markdown
### Fixed

- **Focus mode is easier to leave, and it now quiets the preview too.** On desktop a hint slides down from the top of the screen when you enter focus mode or move your pointer to the top edge — click it (or press Esc) to exit. And the paragraph dimming now applies to the preview pane as well, not just the editor.
```

(Keep the `### Added` / `### Changed` entries from Plans 1 & 2.)

- [ ] **Step 3: Capture the What's New screenshot**

Create `tests/scripts/manual-testing/capture-focus-mode-polish-screenshot.mjs` (model on `capture-shared-workspace-delete-revoke-screenshot.mjs` — plain `chromium.launch()`, no `executablePath`):

- sign in / land on the app, create a doc, type a heading + two short paragraphs, split view
- put the cursor in the second paragraph
- toggle Focus Mode on (via the View menu or `window.MDE`)
- move the mouse to `(640, 5)` so `#focusHint` shows
- wait ~300ms, `page.screenshot({ path: "client/public/whats-new/focus-mode-polish.png" })`

Run it against a locally-built + served client:

```bash
bash tests/scripts/manual-testing/enable-dev-login.sh
npm run build && (npm run dev &)   # wait for :8787
node tests/scripts/manual-testing/capture-focus-mode-polish-screenshot.mjs
# stop dev, then:
bash tests/scripts/manual-testing/disable-dev-login.sh
git diff --quiet src/worker.ts && echo "worker clean" || (echo "REVERT worker.ts"; exit 1)
```

Confirm the PNG shows the hint pill at top + the dimmed heading. **A real screenshot — never a placeholder.**

- [ ] **Step 4: `whats-new-entries.ts`**

Append (must be the last entry):

```ts
  {
    version: "1.50.0",
    title: "Work Below Your Role, and a Calmer Focus Mode",
    description:
      "A shared workspace now has an Editing / Suggesting / Viewing switcher — work below the access you were granted, and Viewing mode strips the app down to just the document. Publishing and repo sync are the workspace owner's controls only, collaborators can see when a workspace syncs to a repo, and on desktop a hint now tells you how to leave focus mode (which also dims the preview pane now).",
    screenshot: "/whats-new/focus-mode-polish.png",
    category: "Collaboration",
  },
```

- [ ] **Step 5: Version bump**

`package.json`: `"version": "1.50.0"`. `package-lock.json`: both top-level `"version"` fields (lines ~3 and ~9) → `"1.50.0"`. Hand-edit; do not regenerate.

- [ ] **Step 6: `docs/ROADMAP.md`**

Under **Active → "Collaboration roles, focus mode & suggesting mode"** — mark **A1–A5, B1, B2, C1, D6** shipped (v1.50.0), leaving **D1–D5** (the suggesting-mode rendering redesign) as the remaining open item. Copy the spec's Non-goals into a deferred note (syncing chosen mode; per-document mode; focus-mode separate toggles / persistence / sentence-level dimming).

- [ ] **Step 7: `docs/TEST-COVERAGE.md`**

Add rows: `focusActiveLines` publish (Editor component), B1 hover-hint (e2e), B2 preview dimming (Preview component + e2e). Follow the table format; cite the spec.

- [ ] **Step 8: Format + final full run**

```bash
npm run format
npm test && npm run typecheck && npm run build
```

- [ ] **Step 9: Commit + push**

```bash
git status   # src/worker.ts must NOT appear
git add CHANGELOG.md client/src/whats-new-entries.ts client/public/whats-new/focus-mode-polish.png package.json package-lock.json docs/ROADMAP.md docs/TEST-COVERAGE.md tests/scripts/manual-testing/capture-focus-mode-polish-screenshot.mjs
git commit -m "$(cat <<'EOF'
chore: release 1.50.0 — collaboration mode chrome (switcher, gating, focus mode)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push origin feat/collab-mode-chrome
```

- [ ] **Step 10: Finalise PR #180**

Update PR #180's title/description to cover all three plans (the mode switcher + Viewing chrome, the owner-only publish gate + repo-linked signal, and the focus-mode polish), and that it ships as `1.50.0`. Wait for CI green. This is the last plan — once CI is green, the PR is ready to merge (confirm with the user first, per the accumulate-then-release pattern).

---

## Self-review notes (addressed)

- **Spec coverage:** B1 → Task 3; B2 → Tasks 1, 2, 4. A1–A5 / C1 / D6 were Plans 1 & 2. D1–D5 stay out (separate brainstorm).
- **`data-line` is 0-based** (`computeBlockLineStarts` returns `raw.slice(0, cursor).split("\n").length - 1`), but `focusActiveLines` is 1-based CM line numbers — Task 4's `applyFocusDim` converts (`range.from - 1`). The test uses matching values.
- **Cursor-move-only updates** (no re-render, so `updatePreview` doesn't run): Task 4's `$effect` on `$focusMode` / `$focusActiveLines` covers that; `applyFocusDim` is also called from `updatePreview` so a re-render re-applies it against fresh `data-line` tags.
- **Placeholder scan:** no "TBD" / "handle edge cases". Task 2 Step 1 and Task 4 Step 1 leave the test-harness scaffolding to "match the existing file" where a concrete pattern already exists in-repo — pointing at the specific sibling test to copy.
- **Type consistency:** `focusActiveLines: { from: number; to: number } | null` — same shape in the store (Task 1), the Editor writes (Task 2), and the Preview reads (Task 4).
- **Release safety:** Task 5 Steps 3 & 9 both check `git diff --quiet src/worker.ts`; the screenshot step is the only dev-login use and reverts it.
