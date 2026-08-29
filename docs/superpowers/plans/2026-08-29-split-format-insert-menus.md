# Split Format and Insert Menus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the overloaded Edit menu's Format (Bold/Italic/Strikethrough) and Insert (Insert Link/Insert Image/Manage Images) concerns out into two new top-level menus.

**Architecture:** Pure `client/src/components/MenuBar.svelte` reorganization — two new dropdown ref pairs, two new entries in the existing `pairs` array (both `toggleDropdown` and `enableMenuBarHoverSwitch` are already generic over an arbitrary-length pairs list), and the six moved buttons relocated verbatim into two new `<div class="dropdown">` blocks. No other file changes.

**Tech Stack:** Svelte 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-29-split-format-insert-menus-design.md`

## Global Constraints

- Pure relocation: every button keeps its exact `id`, `onclick` handler, icon, `disabled` binding, and `<kbd>` shortcut hint — no command logic, keyboard shortcut, or `window.MDE` contract changes.
- Final menu bar order: File, Edit, Format, Insert, View, Help.
- No changes to `app.ts`, `types.ts`, any store, `Toolbar.svelte`, or `ShortcutsModal.svelte` — confirmed during brainstorming that none of them depend on these buttons' current menu location.
- This is a user-facing UI change: minor version bump, `CHANGELOG.md` entry, and a `whats-new-entries.ts` entry with a real screenshot.

---

### Task 1: Reorganize `MenuBar.svelte` into Edit/Format/Insert

**Files:**
- Modify: `client/src/components/MenuBar.svelte`
- Test: `tests/e2e/local/menu-format-insert.spec.ts` (new)

**Interfaces:** None — no exported functions or types change. This task is self-contained.

- [ ] **Step 1: Write the failing e2e tests**

```ts
// tests/e2e/local/menu-format-insert.spec.ts
import { test, expect } from "./support/fixtures";
import type { Page } from "@playwright/test";

async function setContentAndSelectAll(page: Page, content: string) {
  await page.evaluate((content) => {
    const view = window.MDE.getEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, selection: { anchor: 0, head: content.length } });
    view.focus();
  }, content);
}

test("Format menu applies Bold/Italic/Strikethrough to the selection", async ({ page }) => {
  await setContentAndSelectAll(page, "hello");
  await page.click("#formatMenuBtn");
  await page.click("#menuBold");
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("**hello**");

  await setContentAndSelectAll(page, "hello");
  await page.click("#formatMenuBtn");
  await page.click("#menuItalic");
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("_hello_");

  await setContentAndSelectAll(page, "hello");
  await page.click("#formatMenuBtn");
  await page.click("#menuStrike");
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("~~hello~~");
});

test("Insert menu opens the link modal with the selection prefilled", async ({ page }) => {
  await setContentAndSelectAll(page, "hello");
  await page.click("#insertMenuBtn");
  await page.click("#menuLink");
  const urlInput = page.locator('input[placeholder*="https://" i], input[type="url"]').first();
  await expect(urlInput).toBeVisible();
  await page.keyboard.press("Escape");
});

test("Edit menu no longer contains the moved Format/Insert buttons", async ({ page }) => {
  expect(await page.locator("#editMenu #menuBold").count()).toBe(0);
  expect(await page.locator("#editMenu #menuLink").count()).toBe(0);
  expect(await page.locator("#formatMenu #menuBold").count()).toBe(1);
  expect(await page.locator("#insertMenu #menuLink").count()).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx playwright test --project=local tests/e2e/local/menu-format-insert.spec.ts`
Expected: FAIL — `#formatMenuBtn`/`#insertMenuBtn`/`#formatMenu`/`#insertMenu` don't exist yet, so the first two tests time out waiting for a click target and the third fails its count assertions (both moved-button counts under the new containers are 0, not 1).

- [ ] **Step 3: Add the new ref-pair declarations**

In `client/src/components/MenuBar.svelte`, change:

```ts
  let fileMenuBtn: HTMLButtonElement, fileMenu: HTMLDivElement;
  let editMenuBtn: HTMLButtonElement, editMenu: HTMLDivElement;
  let viewMenuBtn: HTMLButtonElement, viewMenu: HTMLDivElement;
  let helpMenuBtn: HTMLButtonElement, helpMenu: HTMLDivElement;
```

to:

```ts
  let fileMenuBtn: HTMLButtonElement, fileMenu: HTMLDivElement;
  let editMenuBtn: HTMLButtonElement, editMenu: HTMLDivElement;
  let formatMenuBtn: HTMLButtonElement, formatMenu: HTMLDivElement;
  let insertMenuBtn: HTMLButtonElement, insertMenu: HTMLDivElement;
  let viewMenuBtn: HTMLButtonElement, viewMenu: HTMLDivElement;
  let helpMenuBtn: HTMLButtonElement, helpMenu: HTMLDivElement;
```

- [ ] **Step 4: Register the new pairs in `onMount`**

Change:

```ts
    const pairs = [
      { btn: fileMenuBtn, menu: fileMenu },
      { btn: editMenuBtn, menu: editMenu },
      { btn: viewMenuBtn, menu: viewMenu },
      { btn: helpMenuBtn, menu: helpMenu },
    ];
```

to:

```ts
    const pairs = [
      { btn: fileMenuBtn, menu: fileMenu },
      { btn: editMenuBtn, menu: editMenu },
      { btn: formatMenuBtn, menu: formatMenu },
      { btn: insertMenuBtn, menu: insertMenu },
      { btn: viewMenuBtn, menu: viewMenu },
      { btn: helpMenuBtn, menu: helpMenu },
    ];
```

- [ ] **Step 5: Move the Format/Insert buttons out of Edit into two new dropdowns**

Change the entire Edit dropdown block plus the start of the View dropdown (this is one contiguous find/replace — the Format and Insert dropdowns are inserted between Edit's closing `</div>` and View's opening `<div class="dropdown">`):

```svelte
  <div class="dropdown">
    <button bind:this={editMenuBtn} id="editMenuBtn" class="menubar-btn" type="button">Edit</button>
    <div bind:this={editMenu} id="editMenu" class="dropdown-menu menubar-menu">
      <button id="menuUndo" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.undo())}><svg class="icon"><use href="#icon-undo-2"></use></svg> Undo <kbd>Ctrl+Z</kbd></button>
      <button id="menuRedo" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.redo())}><svg class="icon"><use href="#icon-redo-2"></use></svg> Redo <kbd>Ctrl+Shift+Z</kbd></button>
      <div class="menu-divider"></div>
      <button id="menuFind" type="button" disabled={!hasActiveDoc} onclick={() => act(() => openFindBar("find"))}><svg class="icon"><use href="#icon-search"></use></svg> Find... <kbd>Ctrl+F</kbd></button>
      <button id="menuFindReplace" type="button" disabled={!hasActiveDoc} onclick={() => act(() => openFindBar("replace"))}><svg class="icon"><use href="#icon-search"></use></svg> Find and Replace... <kbd>Ctrl+H</kbd></button>
      <div class="menu-divider"></div>
      <button id="menuCut" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.cutSelection())}><svg class="icon"><use href="#icon-scissors"></use></svg> Cut <kbd>Ctrl+X</kbd></button>
      <button id="menuCopy" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.copySelection())}><svg class="icon"><use href="#icon-copy"></use></svg> Copy <kbd>Ctrl+C</kbd></button>
      <button id="menuPaste" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.pasteClipboard())}><svg class="icon"><use href="#icon-clipboard"></use></svg> Paste <kbd>Ctrl+V</kbd></button>
      <div class="menu-divider"></div>
      <button id="menuBold" type="button" class="menu-glyph-btn" disabled={!hasActiveDoc} onclick={() => act(() => formatCmd("bold"))}><b>B</b> Bold <kbd>Ctrl+B</kbd></button>
      <button id="menuItalic" type="button" class="menu-glyph-btn" disabled={!hasActiveDoc} onclick={() => act(() => formatCmd("italic"))}><i>I</i> Italic <kbd>Ctrl+I</kbd></button>
      <button id="menuStrike" type="button" disabled={!hasActiveDoc} onclick={() => act(() => formatCmd("strike"))}><svg class="icon"><use href="#icon-strikethrough"></use></svg> Strikethrough</button>
      <div class="menu-divider"></div>
      <button id="menuLink" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.runCmd("link"))}><svg class="icon"><use href="#icon-link"></use></svg> Insert Link... <kbd>Ctrl+K</kbd></button>
      <button id="menuImage" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.runCmd("image"))}><svg class="icon"><use href="#icon-image"></use></svg> Insert Image...</button>
      <button id="menuManageImages" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.openImagesManager())}><svg class="icon"><use href="#icon-images"></use></svg> Manage Images...</button>
    </div>
  </div>

  <div class="dropdown">
    <button bind:this={viewMenuBtn} id="viewMenuBtn" class="menubar-btn" type="button">View</button>
```

to:

```svelte
  <div class="dropdown">
    <button bind:this={editMenuBtn} id="editMenuBtn" class="menubar-btn" type="button">Edit</button>
    <div bind:this={editMenu} id="editMenu" class="dropdown-menu menubar-menu">
      <button id="menuUndo" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.undo())}><svg class="icon"><use href="#icon-undo-2"></use></svg> Undo <kbd>Ctrl+Z</kbd></button>
      <button id="menuRedo" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.redo())}><svg class="icon"><use href="#icon-redo-2"></use></svg> Redo <kbd>Ctrl+Shift+Z</kbd></button>
      <div class="menu-divider"></div>
      <button id="menuFind" type="button" disabled={!hasActiveDoc} onclick={() => act(() => openFindBar("find"))}><svg class="icon"><use href="#icon-search"></use></svg> Find... <kbd>Ctrl+F</kbd></button>
      <button id="menuFindReplace" type="button" disabled={!hasActiveDoc} onclick={() => act(() => openFindBar("replace"))}><svg class="icon"><use href="#icon-search"></use></svg> Find and Replace... <kbd>Ctrl+H</kbd></button>
      <div class="menu-divider"></div>
      <button id="menuCut" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.cutSelection())}><svg class="icon"><use href="#icon-scissors"></use></svg> Cut <kbd>Ctrl+X</kbd></button>
      <button id="menuCopy" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.copySelection())}><svg class="icon"><use href="#icon-copy"></use></svg> Copy <kbd>Ctrl+C</kbd></button>
      <button id="menuPaste" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.pasteClipboard())}><svg class="icon"><use href="#icon-clipboard"></use></svg> Paste <kbd>Ctrl+V</kbd></button>
    </div>
  </div>

  <div class="dropdown">
    <button bind:this={formatMenuBtn} id="formatMenuBtn" class="menubar-btn" type="button">Format</button>
    <div bind:this={formatMenu} id="formatMenu" class="dropdown-menu menubar-menu">
      <button id="menuBold" type="button" class="menu-glyph-btn" disabled={!hasActiveDoc} onclick={() => act(() => formatCmd("bold"))}><b>B</b> Bold <kbd>Ctrl+B</kbd></button>
      <button id="menuItalic" type="button" class="menu-glyph-btn" disabled={!hasActiveDoc} onclick={() => act(() => formatCmd("italic"))}><i>I</i> Italic <kbd>Ctrl+I</kbd></button>
      <button id="menuStrike" type="button" disabled={!hasActiveDoc} onclick={() => act(() => formatCmd("strike"))}><svg class="icon"><use href="#icon-strikethrough"></use></svg> Strikethrough</button>
    </div>
  </div>

  <div class="dropdown">
    <button bind:this={insertMenuBtn} id="insertMenuBtn" class="menubar-btn" type="button">Insert</button>
    <div bind:this={insertMenu} id="insertMenu" class="dropdown-menu menubar-menu">
      <button id="menuLink" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.runCmd("link"))}><svg class="icon"><use href="#icon-link"></use></svg> Insert Link... <kbd>Ctrl+K</kbd></button>
      <button id="menuImage" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.runCmd("image"))}><svg class="icon"><use href="#icon-image"></use></svg> Insert Image...</button>
      <button id="menuManageImages" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.openImagesManager())}><svg class="icon"><use href="#icon-images"></use></svg> Manage Images...</button>
    </div>
  </div>

  <div class="dropdown">
    <button bind:this={viewMenuBtn} id="viewMenuBtn" class="menubar-btn" type="button">View</button>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx playwright test --project=local tests/e2e/local/menu-format-insert.spec.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 7: Run the full local Playwright suite to check for regressions**

Run: `npx playwright test --project=local`
Expected: PASS (all tests, no regressions — nothing else references `#editMenu`'s contents or these button ids' previous container)

- [ ] **Step 8: Typecheck, format, and commit**

```bash
npm run typecheck
npm run format
git add client/src/components/MenuBar.svelte tests/e2e/local/menu-format-insert.spec.ts
git commit -m "feat: split Format and Insert out of the Edit menu"
```

---

### Task 2: Version bump, CHANGELOG, What's New, IMPROVEMENTS.md

**Files:**
- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `IMPROVEMENTS.md`
- Create: `client/public/whats-new/split-format-insert-menus.png`

- [ ] **Step 1: Bump the version**

Hand-edit `package.json`'s `"version"` from `1.37.0` to `1.38.0`, and `package-lock.json`'s two `"version"` fields (top-level and `packages[""].version`) the same way — do not run `npm install --package-lock-only`.

- [ ] **Step 2: Add the CHANGELOG entry**

Add a new section at the top of `CHANGELOG.md`, immediately after the header comment block and before the current `## [1.37.0] - 2026-08-29` entry:

```markdown
## [1.38.0] - 2026-08-29

### Added

- **Split Format and Insert out of the Edit menu.** Bold/Italic/Strikethrough now live in a new Format menu, and Insert Link/Insert Image/Manage Images now live in a new Insert menu, instead of all being crowded into Edit alongside Undo/Redo/Find/Cut/Copy/Paste. No commands, shortcuts, or behavior changed — only where they live in the menu bar.
```

- [ ] **Step 3: Take a real screenshot for What's New**

Start the app locally, open the Format menu (or the Insert menu — whichever frames better) so it's visible in the menu bar, and capture a screenshot to `client/public/whats-new/split-format-insert-menus.png`, matching the framing of an existing file in that directory (e.g. `multimarkdown-syntax-support.png`).

- [ ] **Step 4: Add the What's New entry**

Append to the end of `WHATS_NEW_ENTRIES` in `client/src/whats-new-entries.ts`:

```ts
  {
    version: "1.38.0",
    title: "Format and Insert Menus",
    description:
      "Bold/Italic/Strikethrough and Insert Link/Insert Image/Manage Images now live in their own Format and Insert menus instead of being crowded into Edit. Nothing about how they work changed — just where to find them.",
    screenshot: "/whats-new/split-format-insert-menus.png",
  },
```

- [ ] **Step 5: Update IMPROVEMENTS.md**

Change:

```markdown
- [ ] Split the Format and Insert menu concerns apart (currently
      combined).
```

to:

```markdown
- [x] Split the Format and Insert menu concerns apart. (Shipped
      v1.38.0.) Bold/Italic/Strikethrough moved into a new Format menu;
      Insert Link/Insert Image/Manage Images moved into a new Insert
      menu — pure relocation out of the overloaded Edit menu, no
      command or shortcut changes.
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts client/public/whats-new/split-format-insert-menus.png IMPROVEMENTS.md
git commit -m "docs: version/changelog/what's-new for split Format/Insert menus"
```

---

### Task 3: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit/component test suite**

Run: `npm test`
Expected: PASS (all `unit` and `components` project tests — this feature touches no unit-tested code, so this is a pure regression check)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS, 0 errors

- [ ] **Step 3: Format check**

Run: `npm run format:check`
Expected: PASS

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS, no errors

- [ ] **Step 5: Full local Playwright e2e suite**

Run: `npm run test:e2e:local`
Expected: PASS (all tests, no regressions)

- [ ] **Step 6: Manual smoke test**

Using `npm run dev` (after `npm run build`): open the menu bar and confirm the order reads File, Edit, Format, Insert, View, Help; confirm Edit no longer shows Bold/Italic/Strikethrough/Insert Link/Insert Image/Manage Images; confirm Format's three buttons and Insert's three buttons work exactly as before (select text, apply Bold/Italic/Strikethrough; Insert Link opens the link modal; Insert Image opens the image flow; Manage Images opens the images manager).

- [ ] **Step 7: Hand off to finishing-a-development-branch**

Once all of the above are green, proceed to `superpowers:finishing-a-development-branch`.
