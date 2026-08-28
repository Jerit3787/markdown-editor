# Printing Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native browser print flow (File menu + Command Palette → `window.print()`) with a dedicated print stylesheet that hides all app chrome and shows only the rendered preview, headed by the document's title.

**Architecture:** A new `_print.scss` partial carries all the visual work as `@media print` rules keyed off existing element IDs — no JS-driven show/hide logic needed, since `@media print` applies identically whether printing was triggered by the app's own UI or the browser's native Ctrl/Cmd+P. A two-line `printDocument()` bridge method (mirroring the existing `exportAs()`) is the only new runtime logic, wired into the File menu and Command Palette as two thin call sites.

**Tech Stack:** Svelte 5, SCSS (`@media print`), Playwright (`page.emulateMedia`).

**Spec:** `docs/superpowers/specs/2026-08-28-print-support-design.md`

## Global Constraints

- Printing always renders the rendered **preview**, never the raw markdown source, regardless of the app's current view mode (editor-only, split, preview-only).
- No JS-driven media-query listening or keyboard interception of Ctrl/Cmd+P — the print stylesheet must work identically whether print is triggered by the app's own UI or the browser's native shortcut.
- No changes to the existing `exportAs("pdf")` / `html2pdf.js` flow.

---

### Task 1: Print stylesheet + document title heading

**Files:**
- Create: `client/src/styles/_print.scss`
- Modify: `client/src/style.scss` (append `@use` line)
- Modify: `client/src/components/Preview.svelte`
- Test: `tests/e2e/local/print.spec.ts` (new)

**Interfaces:**
- Consumes: nothing new — purely CSS plus one new piece of Svelte state inside an existing component.
- Produces: a `.print-only` CSS class (defined `display: none`, overridden to `display: block` under `@media print`) that later tasks don't need but that this task's own `#printDocTitle` heading relies on; the `#printDocTitle` element id itself, and the `activeDocTitle` reactive variable inside `Preview.svelte`, are both private to this task.

- [ ] **Step 1: Write the failing tests**

Create `tests/e2e/local/print.spec.ts`:

```ts
import { test, expect } from "./support/fixtures";

async function typeSomeContent(page: import("@playwright/test").Page) {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("# Hello\n\nSome content.");
  await expect(page.locator("#preview")).toContainText("Hello");
}

test("print media hides all app chrome and shows the preview, regardless of view mode", async ({ page }) => {
  await typeSomeContent(page);

  // Split view (default)
  await expect(page.locator("#body")).toHaveClass(/mode-split/);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#topbar")).not.toBeVisible();
  await expect(page.locator("#sidebar")).not.toBeVisible();
  await expect(page.locator("#editorPane")).not.toBeVisible();
  await expect(page.locator("#preview")).toBeVisible();
  await page.emulateMedia({ media: null });

  // Editor-only view
  await page.click('.view-selector button[title="Toggle preview pane"]');
  await expect(page.locator("#body")).toHaveClass(/mode-editor/);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#editorPane")).not.toBeVisible();
  await expect(page.locator("#preview")).toBeVisible();
  await page.emulateMedia({ media: null });
  await page.click('.view-selector button[title="Toggle preview pane"]');

  // Preview-only view
  await page.click('.view-selector button[title="Toggle editor pane"]');
  await expect(page.locator("#body")).toHaveClass(/mode-preview/);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#editorPane")).not.toBeVisible();
  await expect(page.locator("#preview")).toBeVisible();
});

test("the printed page shows the document title as a heading, hidden on screen", async ({ page }) => {
  await typeSomeContent(page);

  await expect(page.locator("#printDocTitle")).not.toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#printDocTitle")).toBeVisible();
  await expect(page.locator("#printDocTitle")).toHaveText("E2E Test Doc");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx playwright test --project=local tests/e2e/local/print.spec.ts`
Expected: FAIL — `#printDocTitle` doesn't exist yet, and `#topbar`/`#sidebar`/`#editorPane` are still visible under print media (no print stylesheet exists yet).

- [ ] **Step 3: Write the print stylesheet**

Create `client/src/styles/_print.scss`:

```scss
.print-only {
  display: none;
}

@media print {
  // Chrome: hidden everywhere, regardless of current view mode or
  // screen size (mobile bottom-sheet variants of these same elements
  // are covered by the same selectors — they're the same DOM nodes,
  // just repositioned by mobile media queries on screen). #editorPane
  // (not the deeper #editorWrap Editor.svelte renders inside it) is
  // the actual flex child sized by #main's layout — hiding it here
  // rather than its descendant lets #previewPane below claim the
  // freed space cleanly. #divider is the drag handle between the two
  // panes, meaningless once one side is gone.
  #topbar,
  #topbar-row,
  #sidebar,
  #sidebarBackdrop,
  #editorPane,
  #divider,
  #comments-panel-mount,
  #statusbar,
  #diagram-editor-mount,
  .mobile-sheet-backdrop {
    display: none !important;
  }

  // The app's on-screen layout clips everything to one viewport's
  // height (#app: height:100dvh + overflow:hidden; #body/#content-row/
  // #main: flex/grid sizing meant for a fixed-height single screen) —
  // every ancestor in this chain needs overflow:visible + height:auto
  // so the browser's print pagination can actually see content past
  // the first screen's worth instead of clipping it there.
  html,
  body,
  #app,
  #body,
  #content-row,
  #main {
    height: auto !important;
    overflow: visible !important;
    display: block !important;
  }

  .print-only {
    display: block;
  }

  #printDocTitle {
    margin: 0 0 16px 0;
    font-size: 1.9em;
    line-height: 1.3;
  }

  // #previewPane is the actual .pane element with its own
  // flex:1/overflow:hidden/border-left — #preview-mount (display:
  // contents) and #preview itself (flex:1/overflow-y:auto/padding:40px)
  // both need the same reset one level deeper.
  #previewPane,
  #preview-mount,
  #preview {
    display: block !important;
    flex: none !important;
    width: 100% !important;
    height: auto !important;
    max-height: none !important;
    overflow: visible !important;
    border-left: none !important;
    padding: 0 !important;
    font-size: 12pt;
    line-height: 1.5;
  }

  // Standard page-break hygiene: never split an image, code block, or
  // table across two pages, and never leave a heading stranded alone
  // at the bottom of a page with its content pushed to the next one.
  #preview {
    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      break-after: avoid;
    }

    img,
    pre,
    table {
      break-inside: avoid;
    }
  }
}
```

Add to `client/src/style.scss`'s `@use` list, as the last line:

```scss
@use "./styles/print";
```

- [ ] **Step 4: Add the document title heading to Preview.svelte**

In `client/src/components/Preview.svelte`, add a new state variable next to the existing `let hostEl: HTMLDivElement | undefined = $state();` (around line 29):

```ts
let activeDocTitle = $state("");
```

Inside `updatePreview()`, immediately after the existing `const doc = getActiveDoc();` line (around line 36), add:

```ts
activeDocTitle = doc?.name ?? "";
```

In the template, immediately before the existing `<div id="preview-mount">` line, add:

```svelte
<h1 id="printDocTitle" class="print-only">{activeDocTitle}</h1>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx playwright test --project=local tests/e2e/local/print.spec.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add client/src/styles/_print.scss client/src/style.scss client/src/components/Preview.svelte tests/e2e/local/print.spec.ts
git commit -m "feat: add a print stylesheet that hides app chrome and titles the preview"
```

---

### Task 2: `printDocument()` bridge method, File menu, and Command Palette entry

**Files:**
- Modify: `client/src/types.ts`
- Modify: `client/src/app.ts`
- Modify: `client/src/components/MenuBar.svelte`
- Modify: `client/src/components/CommandPalette.svelte`
- Test: `tests/e2e/local/print.spec.ts` (extend)

**Interfaces:**
- Consumes: `window.MDE.flushPreviewRenders?(): Promise<void>` (existing bridge method, already used by `exportAs()`), the `.print-only`/`#printDocTitle`/print-media chrome-hiding rules from Task 1 (this task doesn't touch them, just needs them present so the manual/visual result is complete).
- Produces: `window.MDE.printDocument(): Promise<void>` — the only new symbol later tasks or other code could call; no other task in this plan needs it beyond this task's own two call sites.

- [ ] **Step 1: Write the failing tests**

Append to `tests/e2e/local/print.spec.ts`:

```ts
async function stubWindowPrint(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    (window as unknown as { __printCalls: number }).__printCalls = 0;
    window.print = () => {
      (window as unknown as { __printCalls: number }).__printCalls++;
    };
  });
}

async function printCallCount(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls);
}

test("File menu Print action calls window.print()", async ({ page }) => {
  await stubWindowPrint(page);
  await page.click("#fileMenuBtn");
  await page.click('button:has-text("Print")');
  await expect.poll(() => printCallCount(page)).toBe(1);
});

test("Command Palette Print entry calls window.print()", async ({ page }) => {
  await stubWindowPrint(page);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await page.fill('input[placeholder*="Search" i]', "Print");
  await page.click('text="Print"');
  await expect.poll(() => printCallCount(page)).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx playwright test --project=local tests/e2e/local/print.spec.ts -g "Print action|Print entry"`
Expected: FAIL — no "Print" button exists in the File menu or Command Palette yet, and `window.MDE.printDocument` doesn't exist.

- [ ] **Step 3: Add the bridge method**

In `client/src/types.ts`, add a new line directly after the existing `exportAs(format: string): Promise<void>;` (around line 230):

```ts
printDocument(): Promise<void>;
```

In `client/src/app.ts`, add a new function directly after the existing `async function exportAs(format: string) { ... }` function (its closing brace is around line 981):

```ts
async function printDocument() {
  // Same reasoning as exportAs()'s txt/html/pdf branches — an in-flight
  // mermaid/math render triggered by a very recent edit shouldn't still
  // be showing its placeholder when the print dialog opens.
  await window.MDE.flushPreviewRenders?.();
  window.print();
}
```

Register it on the bridge object literal, directly after the existing `exportAs,` line (around line 1174):

```ts
exportAs,
printDocument,
```

- [ ] **Step 4: Add the File menu button**

In `client/src/components/MenuBar.svelte`, add a new button directly after the closing `</div>` of the existing Export `menu-submenu` block (around line 170, right after the `<div class="menu-submenu-panel">...</div></div>` for Export, before the next `<div class="menu-divider"></div>`):

```svelte
<div class="menu-divider"></div>
<button type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.printDocument())}>
  <svg class="icon"><use href="#icon-printer"></use></svg> Print
</button>
```

(`#icon-printer` already exists in `client/index.html`'s sprite sheet — added ahead of this plan while drafting the design spec.)

- [ ] **Step 5: Add the Command Palette entry**

In `client/src/components/CommandPalette.svelte`, add a new entry directly after the existing `export-txt` line (around line 98):

```ts
{ id: "print", label: "Print", category: "Export", run: () => window.MDE.printDocument(), requires: "doc" },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx playwright test --project=local tests/e2e/local/print.spec.ts`
Expected: PASS (all four tests in the file).

- [ ] **Step 7: Commit**

```bash
git add client/src/types.ts client/src/app.ts client/src/components/MenuBar.svelte client/src/components/CommandPalette.svelte tests/e2e/local/print.spec.ts
git commit -m "feat: add a Print action to the File menu and Command Palette"
```

---

### Task 3: Version, CHANGELOG, What's New, IMPROVEMENTS, and final verification

**Files:**
- Modify: `package.json`, `package-lock.json` (two `"version"` fields)
- Modify: `CHANGELOG.md`
- Modify: `client/src/whats-new-entries.ts`
- Modify: `IMPROVEMENTS.md`
- Create: `client/public/whats-new/print-support.png`

**Interfaces:**
- Consumes: the finished File menu Print button and printed layout from Tasks 1–2, to screenshot.
- Produces: nothing new for other code — this task is docs/version/release-artifact only.

- [ ] **Step 1: Bump the version**

In `package.json`, change:

```json
  "version": "1.32.0",
```

to:

```json
  "version": "1.33.0",
```

In `package-lock.json`, change **both** occurrences (the top-level `"version"` field and the nested `""` package's `"version"` field) from `"1.32.0"` to `"1.33.0"`.

- [ ] **Step 2: Add the CHANGELOG entry**

In `CHANGELOG.md`, add a new section directly above the current top entry:

```markdown
## [1.33.0] - 2026-08-28

### Added

- **Printing support.** A new Print action (File menu, next to Export, and the Command Palette) opens the browser's native print dialog. A dedicated print stylesheet hides all app chrome — sidebar, toolbar, editor pane, comments panel, status bar — so only the rendered document prints, titled with the document's name, with sensible page-break behavior around headings, images, code blocks, and tables. Works identically via the browser's own Ctrl/Cmd+P shortcut, since the print stylesheet applies regardless of how printing was triggered.
```

- [ ] **Step 3: Capture the What's New screenshot**

Start a local Vite dev server (`npx vite dev --config client/vite.config.ts --port 5275`), then use a throwaway Playwright script (same technique used for the `insert-existing-and-replace-image.png` screenshot: navigate to `/d/<seeded-doc-id>` with `localStorage` seeded exactly like `tests/e2e/local/support/fixtures.ts` does, type some markdown content into the editor, call `page.emulateMedia({ media: "print" })`, then screenshot the page at roughly 1200×630 (tall enough to show the document title heading plus a couple of rendered lines, with the chrome-free print layout visible) — save to `client/public/whats-new/print-support.png`. Stop the dev server afterward.

- [ ] **Step 4: Add the What's New entry**

In `client/src/whats-new-entries.ts`, append to the end of the `WHATS_NEW_ENTRIES` array (after the `insert-existing-and-replace-image` entry added by the previous feature):

```ts
  {
    version: "1.33.0",
    title: "Printing Support",
    description:
      "A new Print action in the File menu and Command Palette opens the browser's native print dialog with a dedicated print layout — chrome-free, titled with the document name, and paginated cleanly across pages.",
    screenshot: "/whats-new/print-support.png",
  },
```

- [ ] **Step 5: Check off the IMPROVEMENTS.md item**

In `IMPROVEMENTS.md`, change:

```markdown
- [ ] Printing support.
```

to:

```markdown
- [x] Printing support. (Shipped v1.33.0.)
```

- [ ] **Step 6: Run the full verification suite**

Run in order:

```bash
npm run typecheck
npm run format:check
npm test
npm run build
npx playwright test --project=local tests/e2e/local/print.spec.ts
npx playwright test --project=local
```

Expected: all green. If `format:check` fails, run `npm run format` and re-check. If the full local Playwright suite shows a failure unrelated to this feature's files, re-run just that one test in isolation to confirm it's a pre-existing flake (matching how the previous feature's `keybindings.spec.ts` flake was handled) before treating the suite as passing.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts IMPROVEMENTS.md client/public/whats-new/print-support.png
git commit -m "docs: version/changelog/whats-new for printing support"
```
