# Test Coverage Phase 4 — Documents, workspaces & multi-tab

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.

**Goal:** Close the `gap` / `partial` rows in `docs/TEST-COVERAGE.md` §4. The stores (`docs.ts`, `workspaces.ts`, `merge-records.ts`, `router.ts`, `doc-naming.ts`) are exhaustively unit-covered; the gaps are the UI wiring and the genuinely-integration scenarios (multi-tab, first-run migration, deep-link, browser nav).

**Architecture:** All e2e except DOC-21 (DocList sort/outline — fits a component test). Extends `documents.spec.ts`; adds `tests/e2e/local/doc-routing.spec.ts` (deep-link, back/forward, new-tab links) and `tests/e2e/local/multi-tab.spec.ts` (two `page` contexts on one origin). DOC-09 (WorkspaceSwitcher) as a new component test. No app code changes.

**Tech Stack:** Playwright `local`; fixture seeds `e2e-doc-1` in `e2e-ws-1` at `/d/e2e-doc-1`. Sidebar rows are `<a class="doc-row-link" href="/d/<id>">` (`DocList.svelte`), gated by `onRowLinkClick` which bails on `meta/ctrl/shift/button!=0`. `initRouter` listens on `popstate`. Two tabs = two Playwright pages from the same `context` (shared `localStorage`).

**Spec:** `docs/superpowers/specs/2026-09-06-test-coverage-catalog-design.md`

## Global Constraints

- **Stacked on Phase 3 (`test/coverage-phase-3-dialects`, PR #139).** Rebase onto master once #137→#139 merge.
- **Versioning:** patch `1.45.5` → `1.45.6`; `package.json` + `package-lock.json` both fields; `CHANGELOG.md` `## [1.45.6]` `### Changed`. No `whats-new`.
- **No app code changes.** Bug found → trivial fix in-PR + `### Fixed`; non-trivial → `test.fixme` + `## Deferred` + flag.
- Format before every commit; run the touched file after each task. Known pre-existing local-only failures to ignore: `images.spec` "Replace on a row", `mobile-input-zoom` "16px".

## Rows

| Row | What | File |
| --- | ---- | ---- |
| DOC-04 | Delete a doc via the UI (confirm) → removed, falls back to a sibling | extend `documents.spec.ts` |
| DOC-07 | Move a doc between workspaces via MoveToWorkspaceModal | extend `documents.spec.ts` |
| DOC-09 | WorkspaceSwitcher: create / rename / delete / switch | new `WorkspaceSwitcher.test.ts` (component) |
| DOC-12 | First-run: a pre-workspace `localStorage` shape loads into a default workspace, editor works | new `doc-routing.spec.ts` |
| DOC-15 | Two tabs: a save in one never destroys the other's untouched docs; a delete sticks | new `multi-tab.spec.ts` |
| DOC-18 | Deep-linking `/d/<id>` resolves the right document | new `doc-routing.spec.ts` |
| DOC-19 | switchDoc updates the URL; back/forward navigates; deleting the active doc → `/` | new `doc-routing.spec.ts` |
| DOC-20 | Sidebar rows are real `<a href="/d/…">`; Ctrl/Cmd-click opens a new tab | new `doc-routing.spec.ts` |
| DOC-21 | DocList sorts alphabetically; shows the active doc's live heading outline | new `DocList.test.ts` (component) |

---

## Task 1: DOC-04 + DOC-07 — delete + move via the UI (`documents.spec.ts`)

**Files:** Modify `tests/e2e/local/documents.spec.ts`.

**Context:** the sidebar may be collapsed by default — check how the existing "creating a new document adds it to the sidebar" test reveals rows (it may use `#sidebarToggleOut` or a menu). Delete is likely a row context action or a File-menu "Delete document" (`window.MDE.deleteActiveDoc`?) with a `ConfirmDialog`. Move-to-workspace opens via a row action or File menu → `MoveToWorkspaceModal` (`.modal` titled `Move "<name>" to Workspace`, each target workspace has a `button:has-text("Move")`).

- [ ] **Step 1:** Read `documents.spec.ts` + `MenuBar.svelte` (File menu) + `DocList.svelte` (row actions) + `ConfirmDialog.svelte` for the real selectors. Then add:

```ts
test("DOC-04: deleting the active document removes it and falls back to a sibling in the same workspace", async ({ page }) => {
  // seed a second doc in the same workspace
  await page.evaluate(async () => {
    const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "e2e-doc-b", name: "Doc B" });
    switchDoc("e2e-doc-1");
  });
  // trigger delete of the active doc (match the real UI: File menu item, or row action)
  // confirm in ConfirmDialog
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").map((d: { id: string }) => d.id)))
    .not.toContain("e2e-doc-1");
  // active doc fell back to the remaining sibling, editor still mounted
  await expect(page.locator("#editor-mount .cm-content")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("mde:active"))).toBe("e2e-doc-b");
});

test("DOC-07: moving a document to another workspace via the modal reassigns it", async ({ page }) => {
  await page.evaluate(async () => {
    const { createWorkspace } = await import("/src/stores/workspaces.ts");
    createWorkspace("Second WS");
  });
  // open MoveToWorkspaceModal for the active doc (match the real UI)
  // click "Move" next to "Second WS"
  await expect
    .poll(() =>
      page.evaluate(() => {
        const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
        const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
        const doc = docs.find((d: { id: string }) => d.id === "e2e-doc-1");
        const target = wss.find((w: { name: string }) => w.name === "Second WS");
        return doc?.workspaceId === target?.id;
      }),
    )
    .toBe(true);
});
```

- [ ] **Step 2:** Fill in the delete-trigger and move-trigger with real selectors. If the app has no UI path to delete a doc (only `removeDocById` programmatically), assert via `window.MDE`-exposed action if one exists; otherwise move DOC-04 to `## Deferred` noting "no user-facing delete path" (unlikely — check the File menu and row hover actions carefully first). Run: `npx playwright test --project=local tests/e2e/local/documents.spec.ts`

- [ ] **Step 3:** Commit — `test(docs): DOC-04/07 — delete and move-to-workspace via the UI`

---

## Task 2: DOC-18 + DOC-19 + DOC-20 + DOC-12 — routing & migration (`doc-routing.spec.ts`)

**Files:** Create `tests/e2e/local/doc-routing.spec.ts`.

- [ ] **Step 1:** Write:

```ts
import { test, expect } from "./support/fixtures";

test("DOC-18: deep-linking to /d/<id> resolves that exact document", async ({ page }) => {
  await page.evaluate(async () => {
    const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "deep-target", name: "Deep Target" });
    createDoc({ id: "deep-other", name: "Deep Other" });
    switchDoc("e2e-doc-1");
  });
  await page.evaluate(() => {
    const v = window.MDE.getEditor();
    window.MDE.switchDoc("deep-target");
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "TARGET CONTENT" } });
  });
  await page.goto("/d/deep-other");
  await page.waitForSelector("#editor-mount .cm-content");
  await page.goto("/d/deep-target");
  await page.waitForSelector("#editor-mount .cm-content");
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("TARGET CONTENT");
  expect(await page.evaluate(() => localStorage.getItem("mde:active"))).toBe("deep-target");
});

test("DOC-19: switching documents updates the URL; browser back/forward navigates between them", async ({ page }) => {
  await page.evaluate(async () => {
    const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "nav-b", name: "Nav B" });
    switchDoc("e2e-doc-1");
  });
  await page.evaluate(() => window.MDE.switchDoc("nav-b"));
  await expect(page).toHaveURL(/\/d\/nav-b$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/d\/e2e-doc-1$/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("mde:active"))).toBe("e2e-doc-1");
  await page.goForward();
  await expect(page).toHaveURL(/\/d\/nav-b$/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("mde:active"))).toBe("nav-b");
});

test("DOC-19b: deleting the active document replaces the URL with /", async ({ page }) => {
  // With only one doc, deleting it should land on / (no doc to route to).
  await page.evaluate(() => window.MDE.deleteActiveDoc?.() ?? import("/src/stores/docs.ts").then((m) => m.removeDocById("e2e-doc-1")));
  await expect(page).toHaveURL(/\/$/);
});

test("DOC-20: a sidebar row is a real link; Ctrl/Cmd-click opens the document in a new tab", async ({ page, context }) => {
  await page.evaluate(async () => {
    const { createDoc, switchDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "row-target", name: "Row Target" });
    switchDoc("e2e-doc-1");
  });
  // reveal the sidebar if collapsed (match documents.spec's approach)
  const row = page.locator('.doc-row-link[href="/d/row-target"]');
  await expect(row).toHaveAttribute("href", "/d/row-target");
  const [newPage] = await Promise.all([context.waitForEvent("page"), row.click({ modifiers: ["ControlOrMeta"] })]);
  await newPage.waitForLoadState();
  expect(new URL(newPage.url()).pathname).toBe("/d/row-target");
});

test("DOC-12: a pre-workspace localStorage shape migrates into a default workspace with a working editor", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    // Legacy shape: docs with no workspaceId, no mde:workspaces at all.
    localStorage.setItem("mde:docs", JSON.stringify([{ id: "legacy-1", name: "Legacy Doc", content: "legacy body", createdAt: 1, updatedAt: 1 }]));
    localStorage.setItem("mde:active", "legacy-1");
    localStorage.setItem("mde:whatsNewSeen", "999.999.999");
  });
  await page.goto("/d/legacy-1");
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("legacy body");
  // A workspace now exists and the doc belongs to it.
  const state = await page.evaluate(() => ({
    wss: JSON.parse(localStorage.getItem("mde:workspaces") || "[]"),
    doc: JSON.parse(localStorage.getItem("mde:docs") || "[]").find((d: { id: string }) => d.id === "legacy-1"),
  }));
  expect(state.wss.length).toBeGreaterThanOrEqual(1);
  expect(state.doc.workspaceId).toBeTruthy();
});
```

- [ ] **Step 2:** Run. Pin: whether the URL is `/d/<id>` exactly (no trailing slash), the real name of the delete-active-doc bridge method (`window.MDE.deleteActiveDoc` may not exist — check `types.ts` `MDEBridge`; fall back to the store import), and how `documents.spec.ts` reveals the sidebar (DOC-20 needs the row visible). If `context.waitForEvent("page")` doesn't fire for a modified click on the CI Chromium, assert instead that the row is an `<a>` with the right `href` and that `onRowLinkClick` does NOT preventDefault when `ctrlKey` is set (a `page.evaluate` dispatching a synthetic `MouseEvent({ctrlKey:true})` and checking `defaultPrevented`).

Run: `npx playwright test --project=local tests/e2e/local/doc-routing.spec.ts`

- [ ] **Step 3:** Commit — `test(docs): DOC-12/18/19/20 — deep-link, browser nav, real-link rows, first-run migration`

---

## Task 3: DOC-15 — multi-tab save safety (`multi-tab.spec.ts`)

**Files:** Create `tests/e2e/local/multi-tab.spec.ts`.

**Context:** `persistDocs` / `persistWorkspaces` merge-by-record on save (the `TODO.md` fix). Two tabs = two pages from the same `context`, sharing `localStorage`. Tab A edits doc 1; Tab B (with doc 2 loaded, never touched) then saves — doc 1's Tab-A edit must survive, and doc 2 must survive in Tab A.

- [ ] **Step 1:** Write:

```ts
import { test, expect } from "./support/fixtures";

test("DOC-15: a save in one tab never clobbers another tab's untouched documents", async ({ page, context }) => {
  // page (tab A) is on e2e-doc-1. Seed a second doc + open tab B on it.
  await page.evaluate(async () => {
    const { createDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "tab-doc-2", name: "Tab Doc 2" });
  });
  const tabB = await context.newPage();
  await tabB.goto("/d/tab-doc-2");
  await tabB.waitForSelector("#editor-mount .cm-content", { state: "visible" });

  // Tab A edits doc 1 and lets it autosave.
  await page.bringToFront();
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("edit from tab A");
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").find((d: { id: string }) => d.id === "e2e-doc-1")?.content))
    .toBe("edit from tab A");

  // Tab B edits doc 2 and saves — must not resurrect a stale doc 1 or drop it.
  await tabB.bringToFront();
  await tabB.click("#editor-mount .cm-content");
  await tabB.keyboard.type("edit from tab B");
  await expect
    .poll(() => tabB.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").find((d: { id: string }) => d.id === "tab-doc-2")?.content))
    .toBe("edit from tab B");

  // Both edits coexist in localStorage.
  const docs = await tabB.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]"));
  expect(docs.find((d: { id: string }) => d.id === "e2e-doc-1")?.content).toBe("edit from tab A");
  expect(docs.find((d: { id: string }) => d.id === "tab-doc-2")?.content).toBe("edit from tab B");
});

test("DOC-15b: a document deleted in one tab stays deleted after another tab's next save", async ({ page, context }) => {
  await page.evaluate(async () => {
    const { createDoc } = await import("/src/stores/docs.ts");
    createDoc({ id: "del-doc-2", name: "Del Doc 2" });
    createDoc({ id: "del-doc-3", name: "Del Doc 3" });
  });
  const tabB = await context.newPage();
  await tabB.goto("/d/del-doc-3");
  await tabB.waitForSelector("#editor-mount .cm-content", { state: "visible" });

  // Tab A deletes del-doc-2.
  await page.bringToFront();
  await page.evaluate(() => import("/src/stores/docs.ts").then((m) => m.removeDocById("del-doc-2")));
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").map((d: { id: string }) => d.id)))
    .not.toContain("del-doc-2");

  // Tab B saves (edit del-doc-3) — del-doc-2 must not come back.
  await tabB.bringToFront();
  await tabB.click("#editor-mount .cm-content");
  await tabB.keyboard.type("x");
  await expect
    .poll(() => tabB.evaluate(() => JSON.parse(localStorage.getItem("mde:docs") || "[]").map((d: { id: string }) => d.id)))
    .not.toContain("del-doc-2");
});
```

- [ ] **Step 2:** Run. If tabs don't actually share `localStorage` in the Playwright context (they should — same `context` = same storage partition), or a `storage` event is needed to sync in-memory state, adjust: the invariant is about what's *in localStorage* after both saves, which merge-by-record guarantees regardless of live cross-tab sync. If a test is flaky on save timing, wait on the localStorage poll rather than a fixed timeout.

Run: `npx playwright test --project=local tests/e2e/local/multi-tab.spec.ts`

- [ ] **Step 3:** Commit — `test(docs): DOC-15 — multi-tab saves merge by record, deletes stick`

---

## Task 4: DOC-09 — WorkspaceSwitcher UI (`WorkspaceSwitcher.test.ts`)

**Files:** Create `tests/client/src/components/WorkspaceSwitcher.test.ts`.

**Context:** Follow `JoinWorkspaceModal.test.ts` / `DocInfoPanel.test.ts` for the component mount + store setup pattern (`vitest-browser-svelte`, `render`, set `workspacesStore` / `activeWorkspaceIdStore`). Read `WorkspaceSwitcher.svelte` for its real controls — a dropdown listing workspaces, a "New workspace" action, per-row rename (inline input) and delete.

- [ ] **Step 1:** Write tests for: switching to another workspace updates `activeWorkspaceIdStore`; the "new workspace" action calls `createWorkspace` (a new entry appears + becomes active); inline rename updates the name; delete removes it and falls back. Match the actual DOM — if some of these are only reachable through nested menus that are painful to drive in a component test, cover what's clean and put the rest in `## Deferred` (the store logic is fully covered by DOC-08, so partial UI coverage here is acceptable).

- [ ] **Step 2:** Run: `npx vitest run --project=components tests/client/src/components/WorkspaceSwitcher.test.ts`

- [ ] **Step 3:** Commit — `test(docs): DOC-09 — WorkspaceSwitcher create/rename/delete/switch`

---

## Task 5: DOC-21 — DocList sort + outline (`DocList.test.ts`)

**Files:** Create `tests/client/src/components/DocList.test.ts`.

**Context:** `DocList.svelte` — `sorted = [...$docsStore].filter(workspace).sort((a,b) => a.name.localeCompare(b.name))`; per-row `headings = extractHeadings(doc.id === activeId ? $activeDocContent : doc.content)`; rows render as `.doc-row-link` with `.doc-name`. The `headings` tab (`.doclist-tabs`) shows the active doc's outline.

- [ ] **Step 1:** Write:

```ts
// mount DocList with docsStore = [{name:"Zebra"},{name:"apple"},{name:"Mango"}] in one workspace
// expect the rendered .doc-name order to be ["apple","Mango","Zebra"] (localeCompare)
// set activeDocContent to "# One\n## Two"; expect the active row's outline to show "One" and "Two"
// (nested — "Two" indented under "One")
```

Match the store-setup pattern from the other component tests (also set `workspacesStore` + `activeWorkspaceIdStore` + `activeIdStore` + `activeDocContent`).

- [ ] **Step 2:** Run: `npx vitest run --project=components tests/client/src/components/DocList.test.ts`

- [ ] **Step 3:** Commit — `test(docs): DOC-21 — DocList alphabetical sort + live heading outline`

---

## Task 6: Catalog, version, changelog, PR

- [ ] **Step 1:** Flip §4 rows DOC-04, 07, 09, 12, 15, 18, 19, 20, 21 to `covered` (+ paths). Anything not closed → `## Deferred`. Update `## Baseline` §4 row (`15 / 2 / 7` → depends on how many close) + total + percentage.
- [ ] **Step 2:** Version `1.45.5` → `1.45.6`.
- [ ] **Step 3:** `CHANGELOG.md` `## [1.45.6] - <today>` `### Changed`: "Expanded automated test coverage for documents and workspaces (`docs/TEST-COVERAGE.md` §4): deleting and moving documents through the UI, the workspace switcher, tab-per-document routing (deep links, browser back/forward, real-link sidebar rows), first-run migration of pre-workspace data, multi-tab save safety, and the document-list sort and outline."
- [ ] **Step 4:** `npm run format && npm test && npm run typecheck && npm run format:check && npm run build && npm run test:e2e:local`.
- [ ] **Step 5:** Commit `docs: mark §4 doc/workspace rows covered + v1.45.6`, push, open PR (base master, stacked on #139).

---

## Self-Review

**Spec coverage:** every §4 gap/partial has a task (04→T1, 07→T1, 09→T4, 12→T2, 15→T3, 18→T2, 19→T2, 20→T2, 21→T5). ✅
**Placeholder scan:** Tasks 1 and 4 carry `// match the real UI` notes because the exact delete/move/switcher DOM must be read from the components first — each names what to fill and the defer-with-reason fallback. Tasks 2, 3, 5 have literal test bodies. ✅
**Scope:** ~14 new tests across 5 files (2 new e2e specs, 2 new component specs, 1 extension), no app code, one PR. ✅
