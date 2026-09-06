# Test Coverage Phase 3 — Markdown dialects

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** Close the 7 `gap` rows in `docs/TEST-COVERAGE.md` §3. §3 is already the best-covered section (18 covered, 0 partial) — this is a small phase.

**Architecture:** Wikilink/citation/metadata/definition-list transforms are all unit-covered already; the gaps are the interactive UI wiring (backlinks panel, menu keyboard nav, citation settings toggles, metadata-not-in-preview, export round-trips). All e2e except MDX-03 which fits the existing `DocInfoPanel.test.ts` component test. Extends `slash-and-wikilinks.spec.ts`, `mmd-syntax.spec.ts`, `mmd-citations.spec.ts`; adds to `DocInfoPanel.test.ts`. No app code changes.

**Tech Stack:** Playwright `local`; `#menuDocInfo` opens Document Info (`.modal-box-v2` "Document info"); backlinks render as `.doc-info-backlink-row` buttons. WikilinkMenu/SlashMenu track `selectedIndex`; ArrowDown/Up cycle, Enter/Tab select.

**Spec:** `docs/superpowers/specs/2026-09-06-test-coverage-catalog-design.md`

## Global Constraints

- **Stacked on Phase 2 (`test/coverage-phase-2-preview`, PR #138).** Rebase onto master once #138 (and #137) merge — conflicts limited to CHANGELOG / version / `## Baseline`.
- **Versioning:** patch `1.45.4` → `1.45.5`, `package.json` + `package-lock.json` both fields, `CHANGELOG.md` `## [1.45.5]` `### Changed`. No `whats-new` entry.
- **No app code changes.** Bug found → trivial fix in-PR + `### Fixed`; non-trivial → `test.fixme` + `## Deferred` + flag.
- Format before every commit; run the touched file after each task.

## Rows

| Row | What | File |
| --- | ---- | ---- |
| MDX-03 | Backlinks panel lists linking docs; clicking a row navigates | `DocInfoPanel.test.ts` (component) |
| MDX-05 | Wikilink menu arrow + Enter selects the highlighted doc | extend `slash-and-wikilinks.spec.ts` |
| MDX-15 | The metadata block is not visible content in the preview | extend `mmd-syntax.spec.ts` |
| MDX-18 | Author-year citation style renders end-to-end in the preview | extend `mmd-citations.spec.ts` |
| MDX-19 | Citation marker-style toggle (`[@key]` vs `[#key]`) takes effect | extend `mmd-citations.spec.ts` |
| MDX-22 | Definition list / superscript / subscript survive `.md` export → re-import | extend `mmd-syntax.spec.ts` |
| MDX-25 | Slash menu arrow + Enter nav; every registered command reachable | extend `slash-and-wikilinks.spec.ts` |

---

## Task 1: MDX-05 + MDX-25 — menu keyboard nav (`slash-and-wikilinks.spec.ts`)

**Files:** Modify `tests/e2e/local/slash-and-wikilinks.spec.ts`.

- [ ] **Step 1:** In the `"slash commands"` describe, add:

```ts
test("arrow keys + Enter select a slash command", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("/");
  const menu = page.locator(".slash-menu");
  await expect(menu).toBeVisible();
  const first = await menu.locator(".slash-menu-item").first().textContent();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  // Something was inserted / an action ran — the menu closed and the "/" is gone.
  await expect(menu).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).not.toBe("/");
  void first;
});
```

  In the `"wikilink autocomplete"` describe (it already seeds sibling docs — reuse its `beforeEach`), add:

```ts
test("ArrowDown + Enter inserts the highlighted doc name", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("[[");
  const menu = page.locator(".wikilink-menu");
  await expect(menu).toBeVisible();
  const count = await menu.locator(".wikilink-menu-item, li").count();
  test.skip(count < 2, "needs at least two candidate docs");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  // A "[[Name]]" was completed (closing ]] present, non-empty name).
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toMatch(/\[\[[^\]]+\]\]/);
});
```

- [ ] **Step 2:** Run. Pin `.slash-menu` / `.slash-menu-item` / `.wikilink-menu` selectors against `SlashMenu.svelte` / `WikilinkMenu.svelte` and the existing tests in this file — reuse whatever they already use. If the existing wikilink `beforeEach` doesn't seed a second doc, add a `createDoc` in the new test's setup.

Run: `npx playwright test --project=local tests/e2e/local/slash-and-wikilinks.spec.ts`

- [ ] **Step 3:** Commit — `test(dialects): MDX-05/25 — wikilink & slash menu keyboard navigation`

---

## Task 2: MDX-15 + MDX-22 — metadata not in preview, dialect export round-trip (`mmd-syntax.spec.ts`)

**Files:** Modify `tests/e2e/local/mmd-syntax.spec.ts`.

- [ ] **Step 1:** Add:

```ts
test("MDX-15: a metadata block is not rendered as visible content in the preview", async ({ page }) => {
  await page.evaluate(() => {
    const v = window.MDE.getEditor();
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "Title: My Doc\nAuthor: Ada\n\n# Body heading\n\nBody text." } });
  });
  await expect(page.locator("#preview h1")).toHaveText("Body heading");
  // The Key: Value lines don't appear as preview text.
  await expect(page.locator("#preview")).not.toContainText("Title: My Doc");
  await expect(page.locator("#preview")).not.toContainText("Author: Ada");
});

test("MDX-22: definition lists, superscript and subscript survive a .md export → re-open round-trip", async ({ page }) => {
  const src = "Term\n:   Definition\n\nH~2~O and E=mc^2^";
  await page.evaluate((src) => {
    const v = window.MDE.getEditor();
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: src } });
  }, src);
  const [download] = await Promise.all([page.waitForEvent("download"), page.evaluate(() => window.MDE.exportAs("md"))]);
  const path = await download.path();
  const fs = await import("node:fs/promises");
  const exported = path ? await fs.readFile(path, "utf-8") : "";
  // Round-trips as the same MultiMarkdown source, not as rendered HTML.
  expect(exported).toContain(":   Definition");
  expect(exported).toContain("H~2~O");
  expect(exported).toContain("mc^2^");
});
```

- [ ] **Step 2:** Run. If `exportAs("md")` normalizes the definition-list indentation (e.g. one space after the colon), assert the normalized form the first run produces — the invariant is that the *dialect markers* (`:`, `~x~`, `^x^`) survive, not exact whitespace. If MDX-15 fails because the metadata block IS shown (a real bug), stop and flag.

Run: `npx playwright test --project=local tests/e2e/local/mmd-syntax.spec.ts`

- [ ] **Step 3:** Commit — `test(dialects): MDX-15/22 — metadata hidden from preview, MMD syntax export round-trip`

---

## Task 3: MDX-18 + MDX-19 — citation display style + marker style (`mmd-citations.spec.ts`)

**Files:** Modify `tests/e2e/local/mmd-citations.spec.ts`.

**Context:** the existing tests add a structured bibliography entry via Document Info → Edit (`DocEditModal`). That modal has the citation preference controls (`DocEditModal.test.ts` covers: "Author-year is disabled when bibliography source is plain text", "switching to Structured enables Author-year"). So the flow is: open Doc Info → Edit → set bibliography source = Structured → add an entry → set display style = Author-year (or marker style). Then close and check the preview.

- [ ] **Step 1:** Read the existing `mmd-citations.spec.ts` tests fully and `DocEditModal.svelte` for the exact control labels/roles. Then add:

```ts
test("MDX-18: author-year display style renders inline author-year citations in the preview", async ({ page }) => {
  // Type a citation.
  await page.evaluate(() => {
    const v = window.MDE.getEditor();
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "As shown [@smith2020]." } });
  });
  // Open Doc Info → Edit, switch bibliography to Structured, add smith2020, set display = Author-year.
  await page.click("#fileMenuBtn");
  await page.click("#menuDocInfo");
  await page.getByRole("button", { name: "Edit" }).click();
  // ... (match DocEditModal's real controls — see DocEditModal.test.ts)
  // set source = Structured; add entry key=smith2020 author=Smith year=2020; set display style = Author-year
  // close
  await expect(page.locator("#preview")).toContainText("Smith");
  await expect(page.locator("#preview")).toContainText("2020");
});

test("MDX-19: switching the marker style makes [#key] citations resolve", async ({ page }) => {
  await page.evaluate(() => {
    const v = window.MDE.getEditor();
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "See [#jones2019].\n\n[#jones2019]: Jones, 2019." } });
  });
  // Default marker style is pandoc ([@key]) — [#key] should NOT resolve yet.
  await expect(page.locator("#preview")).toContainText("[#jones2019]");
  // Switch marker style to multimarkdown via Doc Info → Edit.
  // ... (match the real control)
  // Now it resolves to a numbered link + bibliography.
  await expect(page.locator("#preview a", { hasText: "1" })).toBeVisible();
});
```

- [ ] **Step 2:** Fill in the `// ...` with the real DocEditModal interactions (from `DocEditModal.test.ts` + the component). Run. If a control isn't reachable via a stable selector, or the author-year path needs more setup than is reasonable, close whichever of MDX-18/19 works and move the other to `## Deferred` with a reason.

Run: `npx playwright test --project=local tests/e2e/local/mmd-citations.spec.ts`

- [ ] **Step 3:** Commit — `test(dialects): MDX-18/19 — citation display style and marker style take effect`

---

## Task 4: MDX-03 — backlinks panel (`DocInfoPanel.test.ts`)

**Files:** Modify `tests/client/src/components/DocInfoPanel.test.ts`.

**Context:** `DocInfoPanel.svelte` computes `backlinks = findBacklinks(doc.name, $docsStore, doc.id)` and renders each as `<button class="doc-info-backlink-row" onclick={() => jumpTo(link.id)}>{link.name}</button>`; empty state is `.empty-state-title` "No backlinks". The existing component tests set up `docsStore` and mount the panel — follow their exact setup.

- [ ] **Step 1:** Add:

```ts
test("lists documents that link to this one and calls jumpTo on click", async () => {
  // set docsStore to [current "Target", other "Linker" with content "see [[Target]]"]
  // mount DocInfoPanel for "Target"
  // expect a .doc-info-backlink-row with text "Linker"
  // click it → the store's switchDoc (or whatever jumpTo calls) fires with Linker's id
});

test("shows the No backlinks empty state when nothing links here", async () => {
  // docsStore with only the current doc
  // expect .empty-state-title "No backlinks"
});
```

- [ ] **Step 2:** Read the existing tests in this file for the mount helper + how they stub `switchDoc` / the docs store, and fill in. Run: `npx vitest run --project=components tests/client/src/components/DocInfoPanel.test.ts`

- [ ] **Step 3:** Commit — `test(dialects): MDX-03 — backlinks panel lists linking docs and navigates`

---

## Task 5: Catalog, version, changelog, PR

- [ ] **Step 1:** Flip §3 rows MDX-03, 05, 15, 18, 19, 22, 25 to `covered` (+ test path). Anything not closed → `## Deferred`. Update `## Baseline` §3 row (was `18 / 0 / 7` → should be `25 / 0 / 0` if all close) + total + percentage.

- [ ] **Step 2:** Version `1.45.4` → `1.45.5`.

- [ ] **Step 3:** `CHANGELOG.md` `## [1.45.5] - <today>`, `### Changed`: "Expanded automated test coverage for markdown dialects (`docs/TEST-COVERAGE.md` §3): backlinks panel, wikilink and slash menu keyboard navigation, metadata hidden from the preview, citation display-style and marker-style switching, and MultiMarkdown syntax export round-trips."

- [ ] **Step 4:** `npm run format && npm test && npm run typecheck && npm run format:check && npm run build && npm run test:e2e:local` — all green modulo the known `mobile-input-zoom` / `images.spec` pre-existing local failures.

- [ ] **Step 5:** Commit `docs: mark §3 dialect rows covered + v1.45.5`, push `test/coverage-phase-3-dialects`, open PR (base master, stacked on #138).

---

## Self-Review

**Spec coverage:** every §3 gap has a task (03→T4, 05→T1, 25→T1, 15→T2, 22→T2, 18→T3, 19→T3). ✅
**Placeholder scan:** Tasks 3 and 4 carry `// ...` because the exact DocEditModal / DocInfoPanel test setup must be read from the existing files first — each names precisely what to fill in and the fallback (defer with a reason). Not hand-waves. ✅
**Scope:** ~10 new tests across 4 files, no app code, one PR. ✅
