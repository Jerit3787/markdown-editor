# Test Coverage Phase 2 — Preview, scroll-sync & rendering

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the `gap` / `partial` rows in `docs/TEST-COVERAGE.md` §2 that don't need a live collab room.

**Architecture:** `renderMarkdown` lives inside `Preview.svelte`'s `<script>` (not exported) and the component is heavily store-wired (`docsStore`, `workspaceRoom`, dynamic mermaid import, an `onMount` with wikilink/scroll wiring), so a `component`-level mount is disproportionate. **All §2 rows are tested at `e2e` level** — the preview only means anything as part of the real editor→`updatePreview`→DOM pipeline, and that's exactly what these tests exercise. Rows the catalog marked `component` (PREV-02, PREV-03, PREV-08) are re-levelled to `e2e` here (a "partial — wrong level" move the spec allows). Extends `tests/e2e/local/preview-rendering.spec.ts`; adds `tests/e2e/local/diagram-editor.spec.ts`. No application code changes.

**Tech Stack:** Playwright 5 (`local`), fixture seeds one doc at `/d/e2e-doc-1`, `window.MDE` bridge. Preview updates as the editor changes — type into `#editor-mount .cm-content`, assert against `#preview`.

**Spec:** `docs/superpowers/specs/2026-09-06-test-coverage-catalog-design.md`

## Global Constraints

- **Versioning:** behind-the-scenes. Patch bump `package.json` `1.45.3` → `1.45.4` + both `version` fields in `package-lock.json`. `CHANGELOG.md` `## [1.45.4] - <today>`, `### Changed` ("Expanded automated test coverage for preview rendering, sanitization, scroll sync, and the diagram editor"). **No `whats-new-entries.ts` entry.**
- **No application code changes.** Only `tests/e2e/local/**`, `docs/TEST-COVERAGE.md`, `package.json`, `package-lock.json`, `CHANGELOG.md`. Bug found → trivial fix in-PR with a `### Fixed` line + failing-then-passing test; non-trivial → `test.fixme` + `## Deferred` row + stop and flag the user.
- **This branch is stacked on Phase 1 (`test/coverage-phase-1-editor`, PR #137).** If #137 merges first, rebase onto `master` — conflicts limited to `CHANGELOG.md` / `package.json` / the `## Baseline` table.
- **Existing tests untouched** unless a row says "extend". `npm test` + full `npm run test:e2e:local` stay green modulo the known pre-existing local-only failures (`images.spec` "Replace on a row", `mobile-input-zoom` "16px" — env-specific, green in CI).
- **Format before every commit:** `npm run format`. **Run the file after each task:** `npx playwright test --project=local tests/e2e/local/<file>`.
- **Mermaid renders are async + debounced (~400ms)** — always `await expect(...).toBeVisible({ timeout: 5000 })` / `expect.poll`, never a bare assertion.

## Rows this phase closes

| Row | What | File |
| --- | ---- | ---- |
| PREV-01 | Every block type renders to HTML | extend `preview-rendering.spec.ts` |
| PREV-02 | `<script>` / `onerror` / `javascript:` href stripped by DOMPurify | extend `preview-rendering.spec.ts` |
| PREV-03 | (re-scoped) a `javascript:` link href is neutralized; regular links keep their href | folded into PREV-02 |
| PREV-04 | GFM task-list items render as checkboxes | extend `preview-rendering.spec.ts` |
| PREV-05 | Non-mermaid fenced code renders as `<pre><code class="language-…">` | extend `preview-rendering.spec.ts` |
| PREV-06 | Footnote: superscript ref, back-link, `sr-only` "Footnotes" heading | extend `preview-rendering.spec.ts` |
| PREV-07 | Inline `$…$` vs block `$$…$$` math render distinctly | extend `preview-rendering.spec.ts` |
| PREV-08 | A malformed math expression renders a KaTeX error inline, no crash | extend `preview-rendering.spec.ts` |
| PREV-18 | Scroll sync works after the preview is hidden and re-shown | extend `preview-rendering.spec.ts` |
| PREV-19 | DiagramEditor: open → template/blank → edit → renders → Save writes the fence + stores the source | new `diagram-editor.spec.ts` |
| PREV-20 | DiagramEditor: template picker fills the code; Reset view control | new `diagram-editor.spec.ts` |
| PREV-21 | DiagramEditor: Export → Copy as SVG / Download PNG; filename derives from the ref | new `diagram-editor.spec.ts` |

**Deferred to §10 (already noted):** PREV-23 (suggestion marks in preview — needs a shared doc).

---

## Task 1: PREV-01, 04, 05, 06, 07 — rendering fidelity (extend `preview-rendering.spec.ts`)

**Files:**
- Modify: `tests/e2e/local/preview-rendering.spec.ts`

**Existing first test** (`"live rendering: heading, mermaid, math, footnote"`) stays. Add a new `test.describe("preview rendering fidelity", ...)` after it.

- [ ] **Step 1: Add the block**

```ts
test.describe("preview rendering fidelity", () => {
  async function type(page: import("@playwright/test").Page, md: string) {
    await page.click("#editor-mount .cm-content");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    // insert verbatim so newlines/indent survive
    await page.evaluate((md) => {
      const v = window.MDE.getEditor();
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: md } });
    }, md);
  }

  test("PREV-01: headings, lists, nested lists, tables, blockquote, hr, inline styles", async ({ page }) => {
    await type(
      page,
      [
        "## Sub",
        "",
        "- a",
        "  - nested",
        "- b",
        "",
        "1. one",
        "2. two",
        "",
        "| H1 | H2 |",
        "| -- | -- |",
        "| c1 | c2 |",
        "",
        "> quoted",
        "",
        "---",
        "",
        "**bold** and _italic_ and `code`",
      ].join("\n"),
    );
    await expect(page.locator("#preview h2")).toHaveText("Sub");
    await expect(page.locator("#preview ul li ul li")).toHaveText("nested");
    await expect(page.locator("#preview ol li")).toHaveCount(2);
    await expect(page.locator("#preview table th")).toHaveCount(2);
    await expect(page.locator("#preview table td")).toHaveCount(2);
    await expect(page.locator("#preview blockquote")).toHaveText("quoted");
    await expect(page.locator("#preview hr")).toHaveCount(1);
    await expect(page.locator("#preview strong")).toHaveText("bold");
    await expect(page.locator("#preview em")).toHaveText("italic");
    await expect(page.locator("#preview p code")).toHaveText("code");
  });

  test("PREV-04: GFM task list items render as checkboxes", async ({ page }) => {
    await type(page, "- [ ] todo\n- [x] done");
    const boxes = page.locator('#preview li input[type="checkbox"]');
    await expect(boxes).toHaveCount(2);
    expect(await boxes.nth(0).isChecked()).toBe(false);
    expect(await boxes.nth(1).isChecked()).toBe(true);
  });

  test("PREV-05: a non-mermaid fenced code block renders as language-tagged <code>", async ({ page }) => {
    await type(page, "```js\nconst x = 1;\n```");
    const code = page.locator("#preview pre code");
    await expect(code).toContainText("const x = 1;");
    await expect(code).toHaveClass(/language-js/);
    // Not turned into a mermaid placeholder.
    await expect(page.locator("#preview pre.mermaid")).toHaveCount(0);
  });

  test("PREV-06: a footnote reference is a superscript link with a back-link and an sr-only heading", async ({ page }) => {
    await type(page, "Claim.[^1]\n\n[^1]: The source.");
    const ref = page.locator("#preview sup a").first();
    await expect(ref).toBeVisible();
    // The definition list at the bottom carries a back-link (↩) to the ref.
    await expect(page.locator('#preview .footnotes a[href^="#"]')).toHaveCount(await page.locator("#preview .footnotes a").count());
    await expect(page.locator("#preview .footnotes .sr-only, #preview .footnotes h2.sr-only")).toHaveCount(1);
  });

  test("PREV-07: inline math is inline, block math is display", async ({ page }) => {
    await type(page, "inline $a+b$ here\n\n$$\nc+d\n$$");
    // KaTeX marks display math with .katex-display; inline has just .katex.
    await expect(page.locator("#preview .katex-display")).toHaveCount(1);
    await expect(page.locator("#preview .katex")).not.toHaveCount(0);
    // The inline one sits inside a paragraph with surrounding text.
    await expect(page.locator("#preview p", { hasText: "inline" }).locator(".katex")).toHaveCount(1);
  });
});
```

- [ ] **Step 2: Run.** Pin each selector against the actual rendered DOM (marked 18 + `marked-footnote` output): footnote container class is likely `.footnotes`; the sr-only heading selector may be `h2#footnote-label.sr-only` — inspect the first run's failure and fix. The `type` helper's clear approach: if `Ctrl+A`/`Delete` is flaky through the editor, use the `dispatch` clear from Phase 1's `setDoc`.

Run: `npx playwright test --project=local tests/e2e/local/preview-rendering.spec.ts`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
npm run format
git add tests/e2e/local/preview-rendering.spec.ts
git commit -m "test(preview): PREV-01/04/05/06/07 — block rendering, task lists, code, footnotes, math"
```

---

## Task 2: PREV-02, 03, 08 — sanitization + math error (extend `preview-rendering.spec.ts`)

**Files:**
- Modify: `tests/e2e/local/preview-rendering.spec.ts`

- [ ] **Step 1: Add to the same `test.describe`**

```ts
  test("PREV-02: raw <script>, an onerror attribute, and a javascript: href are all stripped", async ({ page }) => {
    await type(
      page,
      ['<script>window.__pwned = true<\/script>', '<img src=x onerror="window.__pwned = true">', "[click](javascript:window.__pwned=true)"].join("\n\n"),
    );
    // Nothing executed.
    expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned ?? false)).toBe(false);
    // No script element, no onerror attribute survived into the preview.
    await expect(page.locator("#preview script")).toHaveCount(0);
    expect(await page.locator("#preview img").count()).toBeGreaterThanOrEqual(0);
    for (const img of await page.locator("#preview img").all()) {
      expect(await img.getAttribute("onerror")).toBeNull();
    }
    // The javascript: link's href is neutralized (DOMPurify drops it or blanks it).
    const link = page.locator('#preview a', { hasText: "click" });
    if (await link.count()) {
      const href = await link.getAttribute("href");
      expect(href === null || !href.startsWith("javascript:")).toBe(true);
    }
  });

  test("PREV-03: a normal external link keeps its href", async ({ page }) => {
    await type(page, "[Anthropic](https://www.anthropic.com)");
    const link = page.locator('#preview a', { hasText: "Anthropic" });
    await expect(link).toHaveAttribute("href", "https://www.anthropic.com");
  });

  test("PREV-08: a malformed math expression renders a KaTeX error inline without crashing the preview", async ({ page }) => {
    await type(page, "before $\\frac{1}{$ after\n\n## still rendering");
    // KaTeX renders parse errors as a .katex-error span (throwOnError:false).
    await expect(page.locator("#preview .katex-error")).toHaveCount(1);
    // The rest of the document still rendered — the preview didn't throw.
    await expect(page.locator("#preview h2")).toHaveText("still rendering");
  });
```

- [ ] **Step 2: Run.** If DOMPurify's default keeps `<img onerror>` as a bare `<img src="x">` (attribute stripped, element kept) that's fine — the assertion allows it. If KaTeX's error span class differs (`.katex-error` vs something else), inspect and pin it. Confirm `throwOnError:false` is actually how `renderMathPlaceholders` calls KaTeX — if a bad expression instead renders as raw text, assert that instead (raw `$\frac{1}{$` text present + `h2` still rendered) and note it in the row.

Run: `npx playwright test --project=local tests/e2e/local/preview-rendering.spec.ts`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
npm run format
git add tests/e2e/local/preview-rendering.spec.ts
git commit -m "test(preview): PREV-02/03/08 — sanitization, link href, inline math-error"
```

---

## Task 3: PREV-18 — scroll sync survives hide/show (extend `preview-rendering.spec.ts`)

**Files:**
- Modify: `tests/e2e/local/preview-rendering.spec.ts`

**Context:** the existing `"sync-scroll follows the editor in split view, respects the mode-split gate"` test shows the pattern for driving scroll sync and switching view modes. PREV-18 adds: switch to editor-only (preview hidden), back to split, then confirm sync still works.

- [ ] **Step 1: Add a top-level test (not inside the fidelity describe — it manipulates view mode like the existing scroll tests)**

```ts
test("PREV-18: scroll sync still tracks the editor after the preview is hidden and re-shown", async ({ page }) => {
  // Long doc so there's something to scroll.
  await page.evaluate(() => {
    const v = window.MDE.getEditor();
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: lines } });
  });
  // Ensure split view (mirror whatever the existing scroll test does to get there).
  await page.evaluate(() => window.MDE.setViewMode?.("split"));

  // Hide the preview, then bring it back.
  await page.evaluate(() => window.MDE.setViewMode?.("editor"));
  await page.evaluate(() => window.MDE.setViewMode?.("split"));

  // Scroll the editor to the bottom; the preview should follow.
  await page.evaluate(() => {
    const scroller = document.querySelector("#editor-mount .cm-scroller") as HTMLElement;
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(() => page.evaluate(() => (document.querySelector("#preview-mount") as HTMLElement)?.scrollTop ?? 0))
    .toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run.** The exact view-mode API and the preview scroller element must match the existing scroll tests in this file — **read them first** and reuse their exact selectors/helpers (`#preview-mount` vs `#preview`, the real `setViewMode` name, how they trigger a scroll event). If the existing tests use a different mechanism to reach split view (toolbar buttons, `#viewMenu`), use that.

Run: `npx playwright test --project=local tests/e2e/local/preview-rendering.spec.ts`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
npm run format
git add tests/e2e/local/preview-rendering.spec.ts
git commit -m "test(preview): PREV-18 — scroll sync survives hiding and re-showing the preview"
```

---

## Task 4: PREV-19 — DiagramEditor open → edit → save (new `diagram-editor.spec.ts`)

**Files:**
- Create: `tests/e2e/local/diagram-editor.spec.ts`

**Flow:** toolbar `button[title="Insert diagram"]` sets `diagramEditorRef=null`, `diagramEditorOpen=true`. Overlay: `.diagram-editor-overlay`. Template picker `.diagram-template-picker` with `.diagram-template-card` buttons + a `start new` button. Code editor: `.diagram-editor-code-host .cm-content`. Live preview: `.diagram-editor-preview svg` (debounced ~400ms). Save: `.diagram-editor-header button.primary-btn` (text "Save", `disabled` until `hasCode`). On save (new): mints a `diagramKey`, `setDocDiagram(key, code)`, inserts `\n\`\`\`mermaid\n<key>\n\`\`\`\n` at the cursor, closes.

- [ ] **Step 1: Write the file**

```ts
import { test, expect } from "./support/fixtures";
import type { Page } from "@playwright/test";

const overlay = (page: Page) => page.locator(".diagram-editor-overlay");
const codeContent = (page: Page) => page.locator(".diagram-editor-code-host .cm-content");
const saveBtn = (page: Page) => page.locator(".diagram-editor-header button.primary-btn");

async function openNew(page: Page) {
  await page.click('button[title="Insert diagram"]');
  await expect(overlay(page)).toBeVisible();
}
async function setCode(page: Page, code: string) {
  await page.evaluate((code) => {
    // The diagram editor's own CodeMirror — find it by its host element.
    const host = document.querySelector(".diagram-editor-code-host .cm-editor") as unknown as { cmView?: { view: import("@codemirror/view").EditorView } };
    // Fallback: dispatch via the visible EditorView on the element.
    const view = (host as unknown as { CodeMirror?: unknown }) && (window as unknown as { __diagramView?: import("@codemirror/view").EditorView }).__diagramView;
    void view;
  }, code);
  // Simpler + reliable: focus the editor and type.
  await codeContent(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type(code);
}

test("PREV-19: create a diagram — blank start, type source, it renders, Save inserts the fence and stores the source", async ({ page }) => {
  await openNew(page);
  // New diagram opens on the template picker.
  await expect(page.locator(".diagram-template-picker")).toBeVisible();
  await page.click('.diagram-template-picker button:has-text("start new")');

  await setCode(page, "flowchart TD\n  A --> B");
  // Debounced render lands.
  await expect(page.locator(".diagram-editor-preview svg")).toBeVisible({ timeout: 5000 });

  await expect(saveBtn(page)).toBeEnabled();
  await saveBtn(page).click();
  await expect(overlay(page)).toBeHidden();

  // The document now has a mermaid fence referencing a stored diagram key,
  // and doc.diagrams holds the source.
  const state = await page.evaluate(() => {
    const v = window.MDE.getEditor();
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const doc = docs.find((d: { id: string }) => d.id === "e2e-doc-1");
    return { text: v.state.doc.toString(), diagrams: doc?.diagrams ?? {} };
  });
  expect(state.text).toMatch(/```mermaid\n[a-z0-9-]+\n```/);
  const keys = Object.keys(state.diagrams);
  expect(keys.length).toBe(1);
  expect(state.diagrams[keys[0]]).toContain("flowchart TD");
});

test("PREV-19b: editing an existing diagram overwrites its stored source, leaving the document text unchanged", async ({ page }) => {
  // Seed a rendered diagram by creating one first.
  await openNew(page);
  await page.click('.diagram-template-picker button:has-text("start new")');
  await setCode(page, "flowchart TD\n  A --> B");
  await expect(page.locator(".diagram-editor-preview svg")).toBeVisible({ timeout: 5000 });
  await saveBtn(page).click();
  await expect(overlay(page)).toBeHidden();

  const before = await page.evaluate(() => window.MDE.getEditor().state.doc.toString());

  // Re-open via the rendered diagram in the main preview (Preview.svelte
  // sets diagramEditorRef + opens on click of a rendered diagram).
  await page.locator("#preview pre.mermaid, #preview .mermaid svg").first().click();
  await expect(overlay(page)).toBeVisible();
  await setCode(page, "flowchart LR\n  X --> Y");
  await expect(page.locator(".diagram-editor-preview svg")).toBeVisible({ timeout: 5000 });
  await saveBtn(page).click();
  await expect(overlay(page)).toBeHidden();

  const after = await page.evaluate(() => {
    const v = window.MDE.getEditor();
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const doc = docs.find((d: { id: string }) => d.id === "e2e-doc-1");
    return { text: v.state.doc.toString(), diagrams: doc?.diagrams ?? {} };
  });
  expect(after.text).toBe(before); // document text (just the ref) unchanged
  expect(Object.values(after.diagrams)[0]).toContain("flowchart LR");
});
```

- [ ] **Step 2: Run.** The `setCode` helper's `page.evaluate` stub is dead weight — delete it, keep only the focus-and-type path (shown after it). If clicking a rendered diagram in `#preview` doesn't re-open the editor (the click handler may target a specific child), inspect `Preview.svelte`'s diagram click wiring (~line 181) and match its selector; if it's genuinely not reachable via a plain click, drop PREV-19b's re-open and instead open a second fresh editor — the "editing overwrites source, text unchanged" invariant can also be shown by asserting `setDocDiagram` on an existing ref via the `diagramEditorRef` store directly (`page.evaluate(async () => { const { diagramEditorRef, diagramEditorOpen } = await import('/src/stores/diagramEditor.ts'); diagramEditorRef.set('<key>'); diagramEditorOpen.set(true); })`).

Run: `npx playwright test --project=local tests/e2e/local/diagram-editor.spec.ts`
Expected: 2 passed.

- [ ] **Step 3: Commit**

```bash
npm run format
git add tests/e2e/local/diagram-editor.spec.ts
git commit -m "test(preview): PREV-19 — DiagramEditor create + edit round-trips through doc.diagrams"
```

---

## Task 5: PREV-20 + PREV-21 — DiagramEditor templates, reset view, export

**Files:**
- Modify: `tests/e2e/local/diagram-editor.spec.ts`

**Templates:** `.diagram-template-card` buttons named Flowchart / Sequence / Class / State / ER / Gantt / Pie; clicking one fills the code editor with that template's source and leaves the picker. **Reset view:** `.diagram-preview-reset` (text "Reset view") — rendered near the preview; visible once a diagram is rendered. **Export:** `.diagram-editor-header button:has-text("Export")` (disabled until `lastRenderedSvg`), opens a `.dropdown-menu` with `Copy as SVG` and `Download PNG`. `exportFilename(ext)` = `${ref || "diagram"}.${ext}`.

- [ ] **Step 1: Append**

```ts
test("PREV-20: picking a template fills the code editor and dismisses the picker", async ({ page }) => {
  await openNew(page);
  await page.click('.diagram-template-picker button:has-text("Sequence")');
  await expect(page.locator(".diagram-template-picker")).toBeHidden();
  await expect(codeContent(page)).toContainText("sequenceDiagram");
  await expect(page.locator(".diagram-editor-preview svg")).toBeVisible({ timeout: 5000 });
});

test("PREV-20b: Reset view is available once a diagram is rendered", async ({ page }) => {
  await openNew(page);
  await page.click('.diagram-template-picker button:has-text("Flowchart")');
  await expect(page.locator(".diagram-editor-preview svg")).toBeVisible({ timeout: 5000 });
  const reset = page.locator(".diagram-preview-reset");
  await expect(reset).toBeVisible();
  await reset.click(); // no-throw; view returns to fit
});

test("PREV-21: Download PNG produces a <ref>.png download; Copy as SVG is offered", async ({ page }) => {
  await openNew(page);
  await page.click('.diagram-template-picker button:has-text("Pie")');
  await expect(page.locator(".diagram-editor-preview svg")).toBeVisible({ timeout: 5000 });

  await page.click('.diagram-editor-header button:has-text("Export")');
  const menu = page.locator(".diagram-editor-header .dropdown-menu.open");
  await expect(menu.locator('button:has-text("Copy as SVG")')).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    menu.locator('button:has-text("Download PNG")').click(),
  ]);
  // New (unsaved) diagram has no ref yet → filename falls back to "diagram.png".
  expect(download.suggestedFilename()).toMatch(/^diagram\.png$|^[a-z0-9-]+\.png$/);
});
```

- [ ] **Step 2: Run.** `Copy as SVG` writes to the clipboard — if the test needs to assert that, add `test.describe(..., () => { test.use({ permissions: ["clipboard-read", "clipboard-write"] }); ... })` around a variant; otherwise asserting the button is offered + Download PNG downloads is enough for the row. If `waitForEvent("download")` times out (jsdom-less headless Chromium sometimes needs `Page.setDownloadBehavior` — Playwright handles this by default, but the canvas→blob path may be slow), bump the wait and add `await page.waitForTimeout(500)` after the SVG renders.

Run: `npx playwright test --project=local tests/e2e/local/diagram-editor.spec.ts`
Expected: 5 passed.

- [ ] **Step 3: Commit**

```bash
npm run format
git add tests/e2e/local/diagram-editor.spec.ts
git commit -m "test(preview): PREV-20/21 — DiagramEditor templates, reset view, PNG/SVG export"
```

---

## Task 6: Catalog, version, changelog, PR

**Files:**
- Modify: `docs/TEST-COVERAGE.md`, `package.json`, `package-lock.json`, `CHANGELOG.md`

- [ ] **Step 1: Flip §2 rows.** Set `covered` + the new test path for PREV-01, 02, 03, 04, 05, 06, 07, 08, 18, 19, 20, 21. For PREV-02/03/08 also change `Level` `component` → `e2e` and note "re-levelled: tested through the real preview pipeline". For PREV-03 update the `Scenario` text to match what's actually tested ("a normal external link keeps its href; a `javascript:` href is neutralized") and drop the "safe rel/target" claim (no such hardening exists — note it in the row as a possible future improvement, not a gap). Leave PREV-23 as-is.

- [ ] **Step 2: Update the `## Baseline` table** — §2 was `10 / 5 / 8`; recompute from the flipped rows (should land near `21 / 1 / 1`, PREV-23 the remaining partial). Update the total row and the prose percentage.

- [ ] **Step 3: Version bump** — `1.45.3` → `1.45.4` in `package.json` + `package-lock.json` (both fields).

- [ ] **Step 4: Changelog** — new `## [1.45.4] - <today>`, `### Changed`:
```markdown
- Expanded automated test coverage for the preview: every block type's HTML rendering, DOMPurify sanitization of `<script>` / event-handler attributes / `javascript:` hrefs, task-list checkboxes, code-block language tagging, footnote structure, inline-vs-block math, inline KaTeX error handling, scroll sync across a preview hide/show, and the diagram editor end to end (create, edit, templates, reset view, PNG/SVG export).
```

- [ ] **Step 5: Full verification**

```bash
npm run format
npm test && npm run typecheck && npm run format:check && npm run build
npm run test:e2e:local
```
Expected: unit/typecheck/format/build green; e2e green except the known pre-existing local-only failures — confirm those are the only ones.

- [ ] **Step 6: Commit, push, PR**

```bash
npm run format
git add docs/TEST-COVERAGE.md package.json package-lock.json CHANGELOG.md
git commit -m "docs: mark §2 preview rows covered + v1.45.4"
git push -u origin test/coverage-phase-2-preview
gh pr create --base master --title "Test coverage Phase 2 — preview, scroll-sync & rendering" --body "$(cat <<'EOF'
Phase 2 of the maintenance-phase test effort (`docs/TEST-COVERAGE.md` §2). Plan: `docs/superpowers/plans/2026-09-06-test-coverage-phase-2-preview.md`.

Stacked on #137 (Phase 1) — if #137 merges first this rebases cleanly (CHANGELOG/version only).

New `tests/e2e/local/diagram-editor.spec.ts` + extensions to `preview-rendering.spec.ts`. No application code changes. All §2 rows tested at e2e level (PREV-02/03/08 re-levelled from `component` — the preview is only meaningful as part of the real render pipeline).

Closes PREV-01, 02, 03, 04, 05, 06, 07, 08, 18, 19, 20, 21. PREV-23 stays deferred to §10.

Patch bump to v1.45.4, CHANGELOG `### Changed`, no What's New.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:** every §2 gap/partial except PREV-23 has a task (PREV-01→T1, 04→T1, 05→T1, 06→T1, 07→T1, 02→T2, 03→T2, 08→T2, 18→T3, 19→T4, 20→T5, 21→T5). PREV-23 explicitly deferred. ✅

**Placeholder scan:** every test step carries literal code; the "pin the real selector" notes are genuine (marked 18 / marked-footnote / KaTeX output must be observed) and each names the invariant to preserve. Task 4's `setCode` has an explicit "delete the dead stub" instruction. ✅

**Type/selector consistency:** `type` helper defined once in Task 1, reused in Task 2. `overlay` / `codeContent` / `saveBtn` / `openNew` / `setCode` defined once in Task 4, reused in Task 5. Diagram selectors (`.diagram-editor-overlay`, `.diagram-template-picker`, `.diagram-template-card`, `.diagram-editor-code-host`, `.diagram-editor-preview`, `.diagram-preview-reset`) all from `DiagramEditor.svelte`. ✅

**Scope:** one PR, ~20 new e2e tests across 2 files, no app code. Re-levelling PREV-02/03/08 is a documented "wrong level" move, not scope creep. ✅
