# Test Coverage Phase 8 — Version History & Diff View

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the reachable `gap` rows in `docs/TEST-COVERAGE.md` §8 — the DiffView render (VER-12/13/14), the version-preview render (VER-18), and the restore-from-UI click-through (VER-07).

**Architecture:** One new component test file for `DiffView.svelte` (prop-only, no store wiring), one new jsdom unit file for `version-preview.ts`, and one restore test added to the existing `VersionHistory.test.ts` (which already mounts the real component with a mocked `window.MDE`). No production code changes expected.

**Tech Stack:** Vitest — `unit` project (Node/jsdom) and `components` project (`vitest-browser-svelte` in headless Chromium). No Playwright work this phase.

**Spec:** `docs/superpowers/specs/2026-09-06-test-coverage-catalog-design.md` (master spec for the whole effort); the per-scenario rows are `docs/TEST-COVERAGE.md` §8.

## Global Constraints

- Test-only phase → **patch bump** `package.json` `1.46.0` → `1.46.1` + both `package-lock.json` `"version"` fields (lines ~3, ~9, hand-edited) + a `CHANGELOG.md` `### Changed` entry. **No** `whats-new-entries.ts` entry (behind-the-scenes).
- Component test files live under `tests/client/src/components/*.test.ts` (that path routes them to the `components` Vitest project). jsdom unit files go elsewhere under `tests/client/src/`.
- Match each subsystem's existing test patterns — read the real source's output and pin the actual string; don't invent shapes.
- If a test surfaces a real bug: trivial → fix + regression test in this PR; non-trivial → `test.fixme` / skip + note it in the PR body and defer to its own branch.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. No `Claude-Session` trailer.
- Deferred rows stay deferred (add/keep them in `## Deferred`): **VER-08** (restore a *shared* version) → §10 collab; **VER-16** (`fetchAndMergeRepoHistory` timeline merge) → §12 repo sync; **VER-19** (normalized image-ref not a spurious diff) → §12 repo sync (its root cause is pull-ref determinism, a repo-sync serialization property).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `tests/client/src/components/DiffView.test.ts` | Component test — line-number gutters, intraline segments, Split/Unified toggle, image thumbnails, loading placeholder | Create |
| `tests/client/src/version-preview.test.ts` | jsdom unit — `renderVersionPreview` resolves `doc.images` refs, sanitizes, produces the same core HTML as the live path | Create |
| `tests/client/src/components/VersionHistory.test.ts` | Add one test: restoring an older local entry from the UI | Modify |
| `docs/TEST-COVERAGE.md` | §8 rows VER-07/12/13/14/18 → `covered`; tallies; `## Deferred` | Modify |
| `package.json`, `package-lock.json`, `CHANGELOG.md` | v1.46.1 | Modify |

---

## Task 1: DiffView component tests (VER-12, VER-13, VER-14)

**Files:**
- Create: `tests/client/src/components/DiffView.test.ts`

**Interfaces:**
- Consumes: `DiffView.svelte` props `{ before: string; after: string; beforeImages?: Record<string,string>; afterImages?: Record<string,string> }`.
- Row model (from `computeDiffRows`, verified in `tests/client/src/diff-lines.test.ts`): a changed line → `type: "changed"` with `leftSegments`/`rightSegments` arrays of `{ text, changed }`; gutters render `row.leftLine`/`row.rightLine` (1-based) into `.diff-view-gutter`.
- DOM contract from `DiffView.svelte`: mode toggle is two `<button>`s "Split" / "Unified" with `.active` on the current one; split layout is `.diff-view` (not `.diff-view-unified`), unified adds `.diff-view-unified`; an image-only changed line renders `img.diff-image-thumb` when the relevant images map is present, else `div.diff-image-loading`; intraline changed segments are `span.diff-segment-changed`.

- [ ] **Step 1: Write the file**

```ts
import { test, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import DiffView from "../../../../client/src/components/DiffView.svelte";

const IMG = "data:image/png;base64,AAAA";

test("VER-12: renders line-number gutters and word-level intraline highlighting", async () => {
  const screen = await render(DiffView, { before: "alpha\nold value\ngamma\n", after: "alpha\nnew value\ngamma\n" });

  const gutters = Array.from(screen.container.querySelectorAll(".diff-view-gutter")).map((g) => g.textContent?.trim());
  expect(gutters).toContain("1");
  expect(gutters).toContain("2");
  expect(gutters).toContain("3");

  // "value" is unchanged between "old value" and "new value" — only the
  // differing words carry .diff-segment-changed.
  const changed = Array.from(screen.container.querySelectorAll(".diff-segment-changed")).map((s) => s.textContent);
  expect(changed).toContain("old");
  expect(changed).toContain("new");
  expect(changed).not.toContain("value");
});

test("VER-12: the Split / Unified toggle switches layout", async () => {
  const screen = await render(DiffView, { before: "a\nb\n", after: "a\nc\n" });

  expect(screen.container.querySelector(".diff-view-unified")).toBeNull();
  await screen.getByRole("button", { name: "Unified" }).click();
  expect(screen.container.querySelector(".diff-view-unified")).not.toBeNull();
  await screen.getByRole("button", { name: "Split" }).click();
  expect(screen.container.querySelector(".diff-view-unified")).toBeNull();
});

test("VER-13: renders before/after image thumbnails for an image-only changed line, Split and Unified", async () => {
  const before = "intro\n![old pic](old.png)\nend\n";
  const after = "intro\n![new pic](new.png)\nend\n";
  const screen = await render(DiffView, {
    before,
    after,
    beforeImages: { "old.png": IMG },
    afterImages: { "new.png": IMG },
  });

  let thumbs = Array.from(screen.container.querySelectorAll("img.diff-image-thumb"));
  expect(thumbs.map((t) => t.getAttribute("src"))).toEqual([IMG, IMG]);
  expect(thumbs.map((t) => t.getAttribute("alt"))).toEqual(["old pic", "new pic"]);

  await screen.getByRole("button", { name: "Unified" }).click();
  thumbs = Array.from(screen.container.querySelectorAll("img.diff-image-thumb"));
  expect(thumbs.length).toBe(2);
  expect(thumbs.every((t) => t.getAttribute("src") === IMG)).toBe(true);
});

test("VER-13: an unknown ref falls back to the raw ref as src (browser shows its own broken-image icon)", async () => {
  const screen = await render(DiffView, {
    before: "![x](gone.png)\n",
    after: "![x](gone.png)\n",
    beforeImages: {},
    afterImages: {},
  });
  // before === after here means the line is "same" and never rendered as an
  // image row — swap to a real change:
  const s2 = await render(DiffView, {
    before: "![x](a.png)\n",
    after: "![x](b.png)\n",
    beforeImages: {},
    afterImages: {},
  });
  const thumbs = Array.from(s2.container.querySelectorAll("img.diff-image-thumb"));
  expect(thumbs.map((t) => t.getAttribute("src"))).toEqual(["a.png", "b.png"]);
});

test("VER-14: shows a loading placeholder while an image-line diff's images are still undefined", async () => {
  const screen = await render(DiffView, {
    before: "![p](a.png)\n",
    after: "![p](b.png)\n",
    // beforeImages / afterImages omitted -> still loading
  });
  expect(screen.container.querySelectorAll(".diff-image-loading").length).toBe(2);
  expect(screen.container.querySelector("img.diff-image-thumb")).toBeNull();

  await screen.getByRole("button", { name: "Unified" }).click();
  expect(screen.container.querySelectorAll(".diff-image-loading").length).toBe(2);
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run --project=components tests/client/src/components/DiffView.test.ts`
Expected: all PASS. If a selector is wrong, re-read `client/src/components/DiffView.svelte` and fix the test to match the real DOM (production code stays as-is unless a genuine bug appears).

- [ ] **Step 3: Commit**

```bash
git add tests/client/src/components/DiffView.test.ts
git commit -m "test(version-history): cover DiffView render — gutters, intraline, toggle, image rows, loading (VER-12/13/14)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: version-preview render test (VER-18)

**Files:**
- Create: `tests/client/src/version-preview.test.ts`

**Interfaces:**
- Consumes: `renderVersionPreview(content: string, doc: Doc | undefined, container: HTMLElement): Promise<void>` from `client/src/version-preview.ts` — writes sanitized HTML into `container`, resolves `![alt](href)` where `href` is a key in `doc.images` to that data URI, strips scripts via DOMPurify.
- With no ```mermaid fence and no `$…$` math, `renderMermaidDiagrams` / `renderMathPlaceholders` are no-ops (they querySelector for elements that aren't there and return without importing anything) — so a plain-markdown + image test runs cleanly in jsdom.

- [ ] **Step 1: Write the file**

```ts
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderVersionPreview } from "../../../client/src/version-preview";
import type { Doc } from "../../../client/src/types";

function fakeDoc(images: Record<string, string>): Doc {
  return { id: "d1", name: "d", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", images };
}

describe("renderVersionPreview", () => {
  it("renders markdown to sanitized HTML in the container", async () => {
    const el = document.createElement("div");
    await renderVersionPreview("# Title\n\nSome **bold** text.\n", undefined, el);
    expect(el.querySelector("h1")?.textContent).toBe("Title");
    expect(el.querySelector("strong")?.textContent).toBe("bold");
  });

  it("resolves an image reference against the version's own image map (same as the live preview)", async () => {
    const el = document.createElement("div");
    const dataUri = "data:image/png;base64,AAAA";
    await renderVersionPreview("![a pic](img-1)\n", fakeDoc({ "img-1": dataUri }), el);
    const img = el.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(dataUri);
    expect(img.getAttribute("alt")).toBe("a pic");
  });

  it("leaves an unknown image reference as its raw href", async () => {
    const el = document.createElement("div");
    await renderVersionPreview("![x](not-in-map.png)\n", fakeDoc({}), el);
    expect(el.querySelector("img")?.getAttribute("src")).toBe("not-in-map.png");
  });

  it("strips a <script> tag from the rendered version (DOMPurify)", async () => {
    const el = document.createElement("div");
    await renderVersionPreview("ok\n\n<script>window.__x = 1<\/script>\n", undefined, el);
    expect(el.querySelector("script")).toBeNull();
    expect((window as unknown as { __x?: number }).__x).toBeUndefined();
  });

  it("replaces the container's previous content on each call", async () => {
    const el = document.createElement("div");
    await renderVersionPreview("first\n", undefined, el);
    await renderVersionPreview("second\n", undefined, el);
    expect(el.textContent).toContain("second");
    expect(el.textContent).not.toContain("first");
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run tests/client/src/version-preview.test.ts`
Expected: PASS. If jsdom chokes on a `marked`/`DOMPurify` import, check how `tests/client/src/math-preview.test.ts` (also `@vitest-environment jsdom`, also imports DOMPurify transitively) sets up — mirror it. Do **not** add mermaid/math cases here (covered by `mermaid-preview.test.ts` / `math-preview.test.ts` and the §2 Preview phase).

- [ ] **Step 3: Commit**

```bash
git add tests/client/src/version-preview.test.ts
git commit -m "test(version-history): cover renderVersionPreview — image resolution + sanitization (VER-18)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: restore-from-UI test (VER-07)

**Files:**
- Modify: `tests/client/src/components/VersionHistory.test.ts`

**Interfaces:**
- The existing `beforeEach` mocks `window.MDE = { getEditor: () => ({ state: { readOnly: false } }), formatRelativeTime: () => "just now" }` and seeds `docsStore`/`activeIdStore`/`workspacesStore` + `deleteHistory(DOC_ID)`. `fake-indexeddb/auto` is imported, so `maybeSnapshotVersion` / `restoreLocalVersion` round-trip real IndexedDB.
- `restore()` for a local `entry.kind === "local"` calls `restoreLocalVersion(doc.id, entry.id)`, then `window.MDE.getEditor().dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: restored.content } })`, then `replaceDocImages(doc.id, restored.images)`, then `showToast("Version restored", "success")`, then `close()`.
- The Restore button: `<button ... name="Restore this version" disabled={!selectedId || restoring || !restoreAllowed || selectedId === currentEntryId}>`. Selecting an **older** nested entry (not `nestedRows[0]`) makes it enabled — see the existing "restore is disabled only for the newest nested entry" test for the exact row-selection pattern.

- [ ] **Step 1: Add the test**

Add to `tests/client/src/components/VersionHistory.test.ts` (needs `get` from `svelte/store`, `toasts` from the toast store, and `replaceDocImages` is exercised transitively — assert via `docsStore`). Extend the imports at the top of the file:

```ts
import { get } from "svelte/store";
import { toasts } from "../../../../client/src/stores/toast";
```

Then the test:

```ts
test("VER-07: restoring an older local entry replaces the editor content and toasts", async () => {
  // Two snapshots, 35s apart -> one session, two nested entries.
  await maybeSnapshotVersion(DOC_ID, "the older revision", 1_000);
  await maybeSnapshotVersion(DOC_ID, "the newer revision", 1_000 + 35 * 1000);

  let dispatched: { from: number; to: number; insert: string } | null = null;
  window.MDE = {
    getEditor: () => ({
      state: { readOnly: false, doc: { length: 18 } },
      dispatch: (tr: { changes: { from: number; to: number; insert: string } }) => {
        dispatched = tr.changes;
      },
    }),
    formatRelativeTime: () => "just now",
  } as unknown as typeof window.MDE;

  toasts.set([]);
  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);
  await expect.element(screen.getByText(/2 edits/)).toBeVisible();
  await screen.getByText(/2 edits/).click();

  const nestedRows = await screen.getByText(/1970/).all();
  expect(nestedRows.length).toBe(2);
  // nestedRows[0] is the newest (current) entry; [1] is the older one.
  await nestedRows[1]!.click();

  const restoreBtn = screen.getByRole("button", { name: "Restore this version" });
  await expect.element(restoreBtn).not.toBeDisabled();
  await restoreBtn.click();

  await expect.poll(() => dispatched?.insert).toBe("the older revision");
  expect(dispatched!.from).toBe(0);
  expect(get(toasts).some((t) => t.message === "Version restored" && t.type === "success")).toBe(true);
  // restore() calls close() on success
  await expect.poll(() => get(versionHistoryOpen)).toBe(false);
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run --project=components tests/client/src/components/VersionHistory.test.ts`
Expected: all PASS (the 6 existing + the new one). If `restoreLocalVersion` returns `undefined` (selected the wrong entry / content not loaded yet), add an `await expect.element(screen.getByText("the older revision")` visibility wait on the preview pane before clicking Restore, mirroring how the existing tests wait for `loadVersions()`.

- [ ] **Step 3: Commit**

```bash
git add tests/client/src/components/VersionHistory.test.ts
git commit -m "test(version-history): cover restore-from-UI replacing editor content + toast (VER-07)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: catalog, version bump, changelog, PR

**Files:**
- Modify: `docs/TEST-COVERAGE.md`, `package.json`, `package-lock.json`, `CHANGELOG.md`

- [ ] **Step 1: Update the catalog §8 rows**

In `docs/TEST-COVERAGE.md` §8, flip these rows to `covered` with the new test paths:
- **VER-07** → `component` | covered | `tests/client/src/components/VersionHistory.test.ts` | note: re-levelled e2e→component — the component test is a full click-through (real IndexedDB round-trip via fake-indexeddb; only the live CodeMirror instance is stubbed)
- **VER-12** → `component` | covered | `tests/client/src/components/DiffView.test.ts`
- **VER-13** → `component` | covered | `tests/client/src/components/DiffView.test.ts`
- **VER-14** → `component` | covered | `tests/client/src/components/DiffView.test.ts`
- **VER-18** → `unit` | covered | `tests/client/src/version-preview.test.ts` | note: mermaid/math render paths covered by `mermaid-preview.test.ts` / `math-preview.test.ts`

Leave **VER-08**, **VER-16**, **VER-19** as `gap`, and make sure each has a `## Deferred` entry (VER-08 → §10, VER-16 → §12, VER-19 → §12).

- [ ] **Step 2: Update the tallies**

In the `## Baseline` table: `8. Version history & diff view` row `11 | 0 | 8 | 19` → `16 | 0 | 3 | 19`. `**Total**` row `243 | 17 | 51 | 311` → `248 | 17 | 46 | 311`. Update the "~78%..." prose line if the rounded percentage moves (248/311 ≈ 80%).

- [ ] **Step 3: Version bump**

`package.json` line 4: `"version": "1.46.0"` → `"1.46.1"`. `package-lock.json` lines ~3 and ~9: same. Confirm with `grep -n '"version"' package.json package-lock.json | head -3`.

- [ ] **Step 4: CHANGELOG**

Add at the top of `CHANGELOG.md`:

```markdown
## [1.46.1] - 2026-09-07

### Changed

- **Test coverage — version history & diff view (maintenance phase 8).** Added component tests for `DiffView` (line-number gutters, word-level intraline highlighting, the Split/Unified toggle, image-row thumbnails, the still-loading placeholder), a unit test for `renderVersionPreview` (image-reference resolution + HTML sanitization), and a restore-from-UI test for `VersionHistory`. No behavior change.
```

- [ ] **Step 5: Full verification**

Run: `npm test && npm run typecheck && npm run format:check`
Expected: all green. Then `npm run format` if `format:check` complains, and re-stage.

- [ ] **Step 6: Commit + PR**

```bash
git add docs/TEST-COVERAGE.md package.json package-lock.json CHANGELOG.md
git commit -m "chore(release): test coverage phase 8 (version history) — v1.46.1

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push -u origin test/coverage-phase-8-version-history
```

Open a PR against `master`, title `test: coverage phase 8 — version history & diff view (v1.46.1)`, body summarizing the 3 new/extended files, the 5 closed rows (VER-07/12/13/14/18), the 3 still deferred (VER-08→§10, VER-16→§12, VER-19→§12), and the §8 tally move 11/0/8 → 16/0/3. End with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Wait for CI green, then merge with a merge commit.

---

## Self-Review

**Spec coverage (§8 gap rows):**
- VER-07 restore click-through → Task 3 ✓
- VER-08 shared restore → deferred to §10 (Task 4 Step 1) ✓
- VER-12 DiffView gutters/intraline/toggle → Task 1 ✓
- VER-13 DiffView image thumbnails (split + unified) → Task 1 ✓
- VER-14 DiffView loading placeholder → Task 1 ✓
- VER-16 repo-history timeline merge → deferred to §12 ✓
- VER-18 version-preview render → Task 2 ✓
- VER-19 normalized image-ref not a spurious diff → deferred to §12 ✓

**Placeholder scan:** every test step has literal code; no "add assertions"/"etc."

**Type/name consistency:** `renderVersionPreview(content, doc, container)` signature matches `client/src/version-preview.ts`. `toasts` (not `toastStore`) is the real export name in `client/src/stores/toast.ts`. `.diff-view-unified`, `.diff-image-thumb`, `.diff-image-loading`, `.diff-segment-changed`, `.diff-view-gutter` all taken verbatim from `DiffView.svelte`. Restore button accessible name `"Restore this version"` matches the existing VersionHistory test. `maybeSnapshotVersion` / `deleteHistory` / `restoreLocalVersion` names match `client/src/history.ts`.

**Scope:** one subsystem, three test files, no production changes — a single reviewable PR.
