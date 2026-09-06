# Test Coverage Phase 1 — Editor core & formatting

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the `gap` / `partial` rows in `docs/TEST-COVERAGE.md` §1 (Editor core & formatting) that are testable without a live collab room.

**Architecture:** Almost all of §1 is CodeMirror-integration behavior — it only means anything through the real editor and DOM, so these are Playwright `local` e2e tests. New editor-behavior tests that don't fit the existing files go in a new `tests/e2e/local/editor-core.spec.ts`; a few extend `formatting.spec.ts` / `keybindings.spec.ts` in place. No application code changes.

**Tech Stack:** Playwright 5 (`local` project, `tests/e2e/local/**`, fixture `tests/e2e/local/support/fixtures.ts` seeds one doc + workspace and navigates to `/d/e2e-doc-1`), `window.MDE` bridge for editor access.

**Spec:** `docs/superpowers/specs/2026-09-06-test-coverage-catalog-design.md`

## Global Constraints

- **Versioning:** behind-the-scenes. Patch bump `package.json` `1.45.2` → `1.45.3` + both `version` fields in `package-lock.json` (lines ~3 and ~9), hand-edited. `CHANGELOG.md` `## [1.45.3] - <today>` with a `### Changed` entry ("Expanded automated test coverage for the editor core and formatting commands"). **No `client/src/whats-new-entries.ts` entry.**
- **No application code changes.** Only new/edited files under `tests/e2e/local/`, `docs/TEST-COVERAGE.md`, `package.json`, `package-lock.json`, `CHANGELOG.md`. If a test surfaces a real bug: trivial → fix in this PR with the failing-then-passing test + a `### Fixed` changelog line; non-trivial → `test.fixme` + a `## Deferred` catalog row + stop and flag the user.
- **Existing tests untouched** unless a specific row says "extend `<file>`". `npm test` and the full `npm run test:e2e:local` must stay green (modulo the 2 known pre-existing local-only failures: `images.spec` "Replace on a row", `mobile-input-zoom` "16px").
- **Every new e2e test** imports `{ test, expect }` from `./support/fixtures` (not `@playwright/test`) so the doc/workspace fixture runs. Read editor state with `page.evaluate(() => window.MDE.getEditor().state...)`.
- **Format before every commit:** `npm run format`.
- **Run the e2e file after each task:** `npx playwright test --project=local tests/e2e/local/<file>` (the config's `webServer` auto-starts `vite dev` on :5275).
- **Catalog updates:** flip each closed row to `covered` with the new test path; move anything deliberately not closed to `## Deferred` with a reason.

## Rows this phase closes

| Row | What | File |
| --- | ---- | ---- |
| EDIT-06 | Math snippet interior cursor position | extend `formatting.spec.ts` |
| EDIT-07 | Footnote auto-numbering past existing `[^N]`; single undo step | extend `formatting.spec.ts` |
| EDIT-09 | Link modal confirm inserts `[text](url)` with `link text` / `https://` fallbacks | new `editor-core.spec.ts` |
| EDIT-11 | Wrap on empty selection inserts + selects the placeholder | new `editor-core.spec.ts` |
| EDIT-12 | Line-prefix command toggles off when the prefix is already present | new `editor-core.spec.ts` |
| EDIT-16 | Toolbar overflow menu on a desktop-narrow viewport | new `editor-core.spec.ts` |
| EDIT-18 | Edit-menu Cut / Copy / Paste act on the selection | new `editor-core.spec.ts` |
| EDIT-19 | Tab / Shift-Tab indent / dedent selected lines | new `editor-core.spec.ts` |
| EDIT-20 | Debounced save persists typed content across a reload | new `editor-core.spec.ts` |
| EDIT-21 | Status bar word / char / cursor position update | new `editor-core.spec.ts` |

**Deferred to the §10 phase (already noted in the catalog):** EDIT-17 (`.view-selector` absent — needs a viewer role), EDIT-25 (`setReadOnly` depth). **Assessed during this phase:** EDIT-24 (vim sub-mode) — Task 9; if it proves flaky, move to `## Deferred` rather than landing a flaky test.

---

## Task 1: Create `editor-core.spec.ts` with EDIT-11 (empty-selection placeholder)

**Files:**
- Create: `tests/e2e/local/editor-core.spec.ts`

- [ ] **Step 1: Write the file with the EDIT-11 test**

```ts
import { test, expect } from "./support/fixtures";
import type { Page } from "@playwright/test";

async function setDoc(page: Page, content: string) {
  await page.evaluate((content) => {
    const view = window.MDE.getEditor();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, selection: { anchor: content.length } });
    view.focus();
  }, content);
}
const doc = (page: Page) => page.evaluate(() => window.MDE.getEditor().state.doc.toString());
const sel = (page: Page) =>
  page.evaluate(() => {
    const s = window.MDE.getEditor().state.selection.main;
    return { from: s.from, to: s.to, text: window.MDE.getEditor().state.sliceDoc(s.from, s.to) };
  });

test.describe("wrap commands with no selection", () => {
  test("bold on an empty selection inserts the placeholder and selects just the placeholder text", async ({ page }) => {
    await setDoc(page, "");
    await page.click('button[title^="Bold"]');
    await expect.poll(() => doc(page)).toBe("**bold text**");
    // The placeholder itself is selected, so typing replaces it.
    expect(await sel(page)).toEqual({ from: 2, to: 11, text: "bold text" });
    await page.keyboard.type("hi");
    await expect.poll(() => doc(page)).toBe("**hi**");
  });

  test("italic and inline code place-and-select their own placeholders", async ({ page }) => {
    await setDoc(page, "");
    await page.click('button[title^="Italic"]');
    await expect.poll(() => doc(page)).toBe("_italic text_");
    expect((await sel(page)).text).toBe("italic text");

    await setDoc(page, "");
    await page.click('button[title="Inline code"]');
    await expect.poll(() => doc(page)).toBe("`code`");
    expect((await sel(page)).text).toBe("code");
  });
});
```

- [ ] **Step 2: Run — expect PASS** (this is existing correct behavior in `formatting-commands.ts` `wrapSelection`, just never asserted)

Run: `npx playwright test --project=local tests/e2e/local/editor-core.spec.ts`
Expected: 2 passed.

- [ ] **Step 3: Commit**

```bash
npm run format
git add tests/e2e/local/editor-core.spec.ts
git commit -m "test(editor): EDIT-11 — wrap commands select their placeholder on an empty selection"
```

---

## Task 2: EDIT-12 (line-prefix toggle off)

**Files:**
- Modify: `tests/e2e/local/editor-core.spec.ts`

- [ ] **Step 1: Append the test**

```ts
test.describe("line-prefix commands toggle", () => {
  test("Heading 1 on a line that already starts with '# ' removes the prefix", async ({ page }) => {
    await setDoc(page, "# hello");
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ selection: { anchor: v.state.doc.length } }); // caret on the line
    });
    await page.click('button[title="Heading 1"]');
    await expect.poll(() => doc(page)).toBe("hello");
  });

  test("Bullet list toggles the '- ' prefix off and back on", async ({ page }) => {
    await setDoc(page, "item");
    await page.click('button[title="Bullet list"]');
    await expect.poll(() => doc(page)).toBe("- item");
    await page.click('button[title="Bullet list"]');
    await expect.poll(() => doc(page)).toBe("item");
  });

  test("Blockquote toggle off only strips the exact '> ' prefix, not other content", async ({ page }) => {
    await setDoc(page, "> quoted");
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ selection: { anchor: 3 } });
    });
    await page.click('button[title="Blockquote"]');
    await expect.poll(() => doc(page)).toBe("quoted");
  });
});
```

- [ ] **Step 2: Run — expect PASS** (`prefixLine`'s `line.text.startsWith(prefix)` branch)

Run: `npx playwright test --project=local tests/e2e/local/editor-core.spec.ts`
Expected: 5 passed.

- [ ] **Step 3: Commit**

```bash
npm run format
git add tests/e2e/local/editor-core.spec.ts
git commit -m "test(editor): EDIT-12 — line-prefix commands toggle their prefix off"
```

---

## Task 3: EDIT-19 (Tab / Shift-Tab indent)

**Files:**
- Modify: `tests/e2e/local/editor-core.spec.ts`

- [ ] **Step 1: Append the test**

```ts
test.describe("Tab indentation", () => {
  test("Tab indents the current line and does not move focus out of the editor", async ({ page }) => {
    await setDoc(page, "line one\nline two");
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } }); // select all
    });
    await page.keyboard.press("Tab");
    await expect.poll(() => doc(page)).toBe("  line one\n  line two");
    // Focus stayed in the editor (indentWithTab captures Tab).
    expect(await page.evaluate(() => document.activeElement?.closest(".cm-editor") != null)).toBe(true);
  });

  test("Shift-Tab dedents", async ({ page }) => {
    await setDoc(page, "  indented");
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
    });
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => doc(page)).toBe("indented");
  });
});
```

- [ ] **Step 2: Run — expect PASS**

Run: `npx playwright test --project=local tests/e2e/local/editor-core.spec.ts`
Expected: 7 passed.

**Note:** if CodeMirror's default indent unit is a tab character rather than two spaces, adjust the expected strings to `\t` — check `@codemirror/commands` `indentWithTab` behavior against the actual result the first run prints, and pin whatever it actually does.

- [ ] **Step 3: Commit**

```bash
npm run format
git add tests/e2e/local/editor-core.spec.ts
git commit -m "test(editor): EDIT-19 — Tab/Shift-Tab indent and keep editor focus"
```

---

## Task 4: EDIT-21 (status bar)

**Files:**
- Modify: `tests/e2e/local/editor-core.spec.ts`

**DOM:** `#wordCount` ("N words"), `#charCount` ("N characters"), `#cursorPos` ("Ln L, Col C") — all in `<footer id="statusbar">`.

- [ ] **Step 1: Append the test**

```ts
test.describe("status bar", () => {
  test("word and character counts update as the document changes", async ({ page }) => {
    await setDoc(page, "");
    await expect(page.locator("#charCount")).toHaveText("0 characters");
    await expect(page.locator("#wordCount")).toHaveText("0 words");

    await page.click("#editor-mount .cm-content");
    await page.keyboard.type("hello world");
    await expect(page.locator("#wordCount")).toHaveText("2 words");
    await expect(page.locator("#charCount")).toHaveText("11 characters");
    // Singular form for exactly one.
    await setDoc(page, "x");
    await expect(page.locator("#charCount")).toHaveText("1 character");
    await expect(page.locator("#wordCount")).toHaveText("1 word");
  });

  test("cursor position reflects the caret's line and column", async ({ page }) => {
    await setDoc(page, "abc\ndefgh");
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 0 } }));
    await expect(page.locator("#cursorPos")).toHaveText("Ln 1, Col 1");
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 6 } })); // 2 chars into line 2
    await expect(page.locator("#cursorPos")).toHaveText("Ln 2, Col 3");
  });
});
```

- [ ] **Step 2: Run — expect PASS.** If the counts don't update on a programmatic `dispatch` (the `updateListener` fires on `docChanged`, which a dispatch does trigger, but confirm), keep the `page.keyboard.type` path for the count test and only use `dispatch` for the cursor test.

Run: `npx playwright test --project=local tests/e2e/local/editor-core.spec.ts`
Expected: 9 passed.

- [ ] **Step 3: Commit**

```bash
npm run format
git add tests/e2e/local/editor-core.spec.ts
git commit -m "test(editor): EDIT-21 — status bar word/char/cursor updates"
```

---

## Task 5: EDIT-09 (link modal insert with fallbacks)

**Files:**
- Modify: `tests/e2e/local/editor-core.spec.ts`

**Flow:** toolbar Link button (`button[title^="Link"]`) or `#insertMenuBtn` → `#menuLink` opens `LinkModal.svelte`. Inputs: `input[placeholder="Link text"]`, `input[placeholder="https://example.com"]`. Confirm: `button.primary-btn` ("Insert"). `insertLinkIntoEditor(text, url)` → `replaceSelection(\`[${text || "link text"}](${url || "https://"})\`)`.

- [ ] **Step 1: Append the test**

```ts
test.describe("link modal insertion", () => {
  test("Insert writes [text](url) at the selection", async ({ page }) => {
    await setDoc(page, "");
    await page.click('button[title^="Link"]');
    await page.fill('input[placeholder="Link text"]', "Anthropic");
    await page.fill('input[placeholder="https://example.com"]', "https://anthropic.com");
    await page.click(".modal button.primary-btn");
    await expect.poll(() => doc(page)).toBe("[Anthropic](https://anthropic.com)");
  });

  test("empty fields fall back to 'link text' and 'https://'", async ({ page }) => {
    await setDoc(page, "");
    await page.click('button[title^="Link"]');
    await page.click(".modal button.primary-btn");
    await expect.poll(() => doc(page)).toBe("[link text](https://)");
  });

  test("a selected word prefills the Link text field", async ({ page }) => {
    await setDoc(page, "click here");
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 6, head: 10 } })); // "here"
    await page.click('button[title^="Link"]');
    await expect(page.locator('input[placeholder="Link text"]')).toHaveValue("here");
    await page.fill('input[placeholder="https://example.com"]', "https://x.com");
    await page.click(".modal button.primary-btn");
    await expect.poll(() => doc(page)).toBe("click [here](https://x.com)");
  });
});
```

- [ ] **Step 2: Run — expect PASS.** Confirm the modal's confirm button selector — if `.modal button.primary-btn` matches more than one, scope with `page.getByRole("button", { name: "Insert" })`.

Run: `npx playwright test --project=local tests/e2e/local/editor-core.spec.ts`
Expected: 12 passed.

- [ ] **Step 3: Commit**

```bash
npm run format
git add tests/e2e/local/editor-core.spec.ts
git commit -m "test(editor): EDIT-09 — link modal inserts [text](url) with empty-field fallbacks"
```

---

## Task 6: EDIT-18 (Edit-menu Cut / Copy / Paste)

**Files:**
- Modify: `tests/e2e/local/editor-core.spec.ts`

**DOM:** `#editMenuBtn` → `#menuCut` / `#menuCopy` / `#menuPaste`. `menuClipboard*` in `app.ts` use `navigator.clipboard` with a `document.execCommand` fallback; Paste's last-ditch fallback is an `alert()`. Needs clipboard permissions granted.

- [ ] **Step 1: Append the block, scoped with its own permissions**

```ts
test.describe("Edit menu clipboard commands", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("Copy puts the selection on the clipboard without changing the document", async ({ page }) => {
    await setDoc(page, "copy me please");
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 0, head: 7 } })); // "copy me"
    await page.click("#editMenuBtn");
    await page.click("#menuCopy");
    await expect.poll(() => doc(page)).toBe("copy me please");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("copy me");
  });

  test("Cut removes the selection and puts it on the clipboard", async ({ page }) => {
    await setDoc(page, "cut this out");
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 4, head: 9 } })); // "this "
    await page.click("#editMenuBtn");
    await page.click("#menuCut");
    await expect.poll(() => doc(page)).toBe("cut out");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("this ");
  });

  test("Paste inserts the clipboard text at the caret", async ({ page }) => {
    await setDoc(page, "before  after");
    await page.evaluate(() => navigator.clipboard.writeText("MIDDLE"));
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 7 } })); // between the two spaces
    await page.click("#editMenuBtn");
    await page.click("#menuPaste");
    await expect.poll(() => doc(page)).toBe("before MIDDLE after");
  });

  test("Cut / Copy with no selection is a no-op", async ({ page }) => {
    await setDoc(page, "untouched");
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 3 } }));
    await page.click("#editMenuBtn");
    await page.click("#menuCopy");
    await expect.poll(() => doc(page)).toBe("untouched");
  });
});
```

- [ ] **Step 2: Run.** Chromium honors `clipboard-read`/`clipboard-write` permissions headlessly. If `navigator.clipboard.readText()` still rejects in the test context, fall back to asserting only the document mutation for Cut/Paste and drop the Copy clipboard-content assertion (keep "document unchanged"). Note in the row's `Notes` whichever way it landed.

Run: `npx playwright test --project=local tests/e2e/local/editor-core.spec.ts`
Expected: 16 passed.

- [ ] **Step 3: Commit**

```bash
npm run format
git add tests/e2e/local/editor-core.spec.ts
git commit -m "test(editor): EDIT-18 — Edit-menu Cut/Copy/Paste act on the selection"
```

---

## Task 7: EDIT-20 (debounced save persists across reload)

**Files:**
- Modify: `tests/e2e/local/editor-core.spec.ts`

**Behavior:** `scheduleSave()` debounces `saveNow` by ~400ms; `saveNow` writes the doc into `localStorage` (`mde:docs`). A reload re-hydrates from `localStorage`.

- [ ] **Step 1: Append the test**

```ts
test.describe("autosave", () => {
  test("typed content is persisted and survives a reload", async ({ page }) => {
    await page.click("#editor-mount .cm-content");
    await page.keyboard.type("persist this across reload");
    // Wait past the debounce, then confirm it reached localStorage.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
          return docs.find((d: { id: string }) => d.id === "e2e-doc-1")?.content ?? "";
        }),
      )
      .toBe("persist this across reload");

    await page.reload();
    await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
    await expect.poll(() => doc(page)).toBe("persist this across reload");
  });
});
```

- [ ] **Step 2: Run — expect PASS**

Run: `npx playwright test --project=local tests/e2e/local/editor-core.spec.ts`
Expected: 17 passed.

- [ ] **Step 3: Commit**

```bash
npm run format
git add tests/e2e/local/editor-core.spec.ts
git commit -m "test(editor): EDIT-20 — typed content is debounce-saved and survives a reload"
```

---

## Task 8: EDIT-06 + EDIT-07 (math cursor, footnote numbering + undo) — extend `formatting.spec.ts`

**Files:**
- Modify: `tests/e2e/local/formatting.spec.ts` (the existing `test("math and footnote snippets", ...)` at ~line 92)

- [ ] **Step 1: Replace that single test with a `test.describe` covering the extra assertions**

Find:
```ts
  test("math and footnote snippets", async ({ page }) => {
    await clearContent(page);
    await page.click('button[title="Math"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("$$\n\n$$");

    await clearContent(page);
    await page.click('button[title="Footnote"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("[^1]\n\n[^1]: ");
  });
```

Replace with:
```ts
  test("math snippet inserts $$\\n\\n$$ with the caret on the interior blank line", async ({ page }) => {
    await clearContent(page);
    await page.click('button[title="Math"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("$$\n\n$$");
    // Caret sits after "$$\n" (offset 3), ready to type the LaTeX source.
    expect(await page.evaluate(() => window.MDE.getEditor().state.selection.main.head)).toBe(3);
    await page.keyboard.type("x^2");
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("$$\nx^2\n$$");
  });

  test("footnote snippet: first is [^1], the next numbers past it, a named [^note] is ignored", async ({ page }) => {
    await clearContent(page);
    await page.click('button[title="Footnote"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("[^1]\n\n[^1]: ");

    // Caret back to the start, insert another — it must become [^2].
    await page.evaluate(() => window.MDE.getEditor().dispatch({ selection: { anchor: 0 } }));
    await page.click('button[title="Footnote"]');
    await expect
      .poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString()))
      .toBe("[^2][^1]\n\n[^1]: \n\n[^2]: ");

    // A hand-written named footnote doesn't collide with the numbering.
    await clearContent(page);
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ changes: { from: 0, insert: "text[^note]\n\n[^note]: hi" }, selection: { anchor: 4 } });
    });
    await page.click('button[title="Footnote"]');
    await expect
      .poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString()))
      .toBe("text[^1][^note]\n\n[^note]: hi\n\n[^1]: ");
  });

  test("footnote snippet is a single undo step", async ({ page }) => {
    await clearContent(page);
    await page.click("#editor-mount .cm-content"); // ensure editor focus for the undo keybinding
    await page.click('button[title="Footnote"]');
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("[^1]\n\n[^1]: ");
    await page.evaluate(() => window.MDE.getEditor().focus());
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("");
  });
```

- [ ] **Step 2: Run — expect PASS.** The exact multi-footnote string depends on `insertFootnoteSnippet`'s ordering (ref at cursor, def appended at doc end). Run once, read the actual output, and pin the real strings if they differ from the guesses above — the *properties* to preserve are: (a) second insert is `[^2]` not `[^1]`, (b) a named `[^note]` is skipped by the numbering, (c) one `Ctrl+Z` undoes the whole thing.

Run: `npx playwright test --project=local tests/e2e/local/formatting.spec.ts`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
npm run format
git add tests/e2e/local/formatting.spec.ts
git commit -m "test(editor): EDIT-06/07 — math caret position, footnote numbering + single-undo"
```

---

## Task 9: EDIT-16 (toolbar overflow on a desktop-narrow viewport)

**Files:**
- Modify: `tests/e2e/local/editor-core.spec.ts`

**Behavior:** `Toolbar.svelte`'s `recalcOverflow()` (ResizeObserver-driven) moves buttons that don't fit into `.toolbar-overflow-menu` and un-`hidden`s the overflow toggle `.toolbar-overflow button[aria-label="More formatting options"]`. `isMobile()` is `max-width: 780px` — use a viewport wider than that but narrower than the full toolbar.

- [ ] **Step 1: Append the block with its own viewport**

```ts
test.describe("toolbar overflow (desktop, narrow)", () => {
  test.use({ viewport: { width: 900, height: 800 } });

  test("buttons that don't fit move into the overflow menu, reachable via the toggle", async ({ page }) => {
    const overflowToggle = page.locator('.toolbar-overflow button[aria-label="More formatting options"]');
    // At 900px the full formatting row doesn't fit — the toggle is shown.
    await expect(overflowToggle).toBeVisible();

    // A command that got pushed into the overflow menu still runs.
    await page.evaluate(() => {
      const v = window.MDE.getEditor();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "hi" }, selection: { anchor: 0, head: 2 } });
      v.focus();
    });
    await overflowToggle.click();
    const menu = page.locator(".toolbar-overflow-menu");
    await expect(menu).toBeVisible();
    // Footnote is near the end of the row, so it's a reliable overflow victim.
    await menu.locator('button[title="Footnote"]').click();
    await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toContain("[^1]");
  });

  test("widening the viewport past the toolbar width hides the overflow toggle again", async ({ page }) => {
    const overflowToggle = page.locator('.toolbar-overflow button[aria-label="More formatting options"]');
    await expect(overflowToggle).toBeVisible();
    await page.setViewportSize({ width: 1600, height: 800 });
    await expect(overflowToggle).toBeHidden();
  });
});
```

- [ ] **Step 2: Run.** If `Footnote` happens to still fit at 900px, pick whichever button the overflow menu actually contains (query `.toolbar-overflow-menu button` and use its `title`), or narrow the viewport to 820px. If the toggle doesn't appear even at 820px on the CI Chromium, the toolbar may genuinely fit — in that case reduce to 760px, drop `test.use` and instead assert this is the mobile path (cross-refs `mobile-menu-overflow.spec.ts`) and move EDIT-16 to `## Deferred` noting "toolbar fits at every tested desktop width; only the mobile overflow path is real".

Run: `npx playwright test --project=local tests/e2e/local/editor-core.spec.ts`
Expected: all green (or EDIT-16 deferred per the note).

- [ ] **Step 3: Commit**

```bash
npm run format
git add tests/e2e/local/editor-core.spec.ts
git commit -m "test(editor): EDIT-16 — desktop-narrow toolbar overflow menu"
```

---

## Task 10: EDIT-24 (vim sub-mode indicator) — assess, then extend `keybindings.spec.ts` or defer

**Files:**
- Modify: `tests/e2e/local/keybindings.spec.ts` (only if reliable)

**Behavior:** `Editor.svelte` listens for `vim-mode-change` and writes `#keybindingMode`'s text to the uppercased sub-mode (`NORMAL` / `INSERT` / `VISUAL`). The vim package loads dynamically on first switch into vim mode.

- [ ] **Step 1: Prototype the test locally**

```ts
test("the vim status indicator tracks NORMAL / INSERT / VISUAL", async ({ page }) => {
  // Switch to Vim via Settings, same path as the existing test in this file.
  await page.click("#settingsBtn");
  await page.selectOption('select[aria-label="Keybinding mode"]', "vim"); // confirm the real selector against the existing test
  await page.click("#editor-mount .cm-content");
  await expect(page.locator("#keybindingMode")).toHaveText("NORMAL");
  await page.keyboard.press("i");
  await expect(page.locator("#keybindingMode")).toHaveText("INSERT");
  await page.keyboard.press("Escape");
  await expect(page.locator("#keybindingMode")).toHaveText("NORMAL");
  await page.keyboard.press("v");
  await expect(page.locator("#keybindingMode")).toHaveText("VISUAL");
});
```

- [ ] **Step 2: Run it 5×.** `for i in 1 2 3 4 5; do npx playwright test --project=local tests/e2e/local/keybindings.spec.ts -g "vim status indicator"; done`
  - **All 5 green:** keep it. Match the existing file's exact Settings selectors (read `keybindings.spec.ts` first — it already switches to Vim mode, reuse that helper).
  - **Any flake** (the dynamic `@replit/codemirror-vim` import + `vim-mode-change` timing): delete it, add EDIT-24 to `docs/TEST-COVERAGE.md` `## Deferred` — reason: *"vim sub-mode transitions depend on the dynamically-imported vim package initializing and firing `vim-mode-change`; not reliable enough to assert in Playwright without arbitrary waits. The indicator-appears case is covered by `keybindings.spec.ts`."*

- [ ] **Step 3: Commit** (either the test, or the catalog Deferred entry)

```bash
npm run format
git add tests/e2e/local/keybindings.spec.ts docs/TEST-COVERAGE.md
git commit -m "test(editor): EDIT-24 — vim sub-mode indicator (or defer, per flake check)"
```

---

## Task 11: Update the catalog, version bump, changelog, PR

**Files:**
- Modify: `docs/TEST-COVERAGE.md`, `package.json`, `package-lock.json`, `CHANGELOG.md`

- [ ] **Step 1: Flip the §1 rows**

In `docs/TEST-COVERAGE.md` §1, set `Status` → `covered` and `Test` → the new path for: EDIT-06, EDIT-07, EDIT-09, EDIT-11, EDIT-12, EDIT-18, EDIT-19, EDIT-20, EDIT-21, and EDIT-16 & EDIT-24 unless deferred. Leave EDIT-17 and EDIT-25 as-is (their `Notes` already say "cross-ref §10"). Update the `## Baseline` table's row 1 counts and the total.

- [ ] **Step 2: Version bump** — `package.json` `1.45.2` → `1.45.3`; `package-lock.json` both `version` fields.

- [ ] **Step 3: Changelog** — under the title block, above `## [1.45.2]`:
```markdown
## [1.45.3] - <today>

### Changed

- Expanded automated test coverage for the editor core and formatting commands: empty-selection placeholder behavior, line-prefix toggle-off, Tab/Shift-Tab indentation, the status bar, link-modal insertion, Edit-menu clipboard commands, footnote numbering + single-undo, math caret placement, debounced autosave persistence, and desktop toolbar overflow.
```
(Add a `### Fixed` line too if a trivial bug was fixed along the way.)

- [ ] **Step 4: Full verification**

Run:
```bash
npm run format
npm test && npm run typecheck && npm run format:check && npm run build
npm run test:e2e:local
```
Expected: unit/typecheck/format/build green; e2e green except the 2 known pre-existing local-only failures (`images.spec` "Replace on a row", `mobile-input-zoom` "16px") — confirm those are the *only* two.

- [ ] **Step 5: Commit + push + PR**

```bash
npm run format
git add docs/TEST-COVERAGE.md package.json package-lock.json CHANGELOG.md
git commit -m "docs: mark §1 editor rows covered + v1.45.3"
git push -u origin test/coverage-phase-1-editor
gh pr create --base master --title "Test coverage Phase 1 — editor core & formatting" --body "$(cat <<'EOF'
Phase 1 of the maintenance-phase test effort (`docs/TEST-COVERAGE.md` §1).

Closes the editor-core gap/partial rows testable without a live collab room: EDIT-06, 07, 09, 11, 12, 16, 18, 19, 20, 21 (and EDIT-24 if it proved reliable). EDIT-17 and EDIT-25 stay deferred to the §10 phase (they need a viewer role).

New file `tests/e2e/local/editor-core.spec.ts`; extensions to `formatting.spec.ts` and possibly `keybindings.spec.ts`. No application code changes. Patch bump to v1.45.3.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:** every §1 row that isn't cross-referenced to §10 has a task (EDIT-06→T8, 07→T8, 09→T5, 11→T1, 12→T2, 16→T9, 18→T6, 19→T3, 20→T7, 21→T4, 24→T10). EDIT-17/25 explicitly deferred per the catalog. ✅

**Placeholder scan:** every test step has literal test code; the "if the string differs, pin the real one" notes are genuine (Playwright e2e against a real editor — the exact output must be observed, not guessed) and each names the invariant that matters. No "add assertions" hand-waves. ✅

**Type/selector consistency:** `setDoc` / `doc` / `sel` helpers defined once in Task 1, reused by name in every later task in the same file. `window.MDE.getEditor()` used consistently. Menu ids (`#editMenuBtn`, `#menuCut`, `#insertMenuBtn`, `#menuLink`) taken from `MenuBar.svelte`. Status bar ids (`#wordCount`, `#charCount`, `#cursorPos`) from `index.html`. ✅

**Scope:** one PR, ~20 new test cases across 3 files, no app code. Matches the spec's "one subsystem per phase". If Task 6 (clipboard) or Task 10 (vim) fight the environment, both have explicit fallback-to-Deferred instructions rather than a flaky landing. ✅
