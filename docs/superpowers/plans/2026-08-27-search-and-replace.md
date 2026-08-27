# Search & Replace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ctrl/Cmd+F opens a find bar over the active document; Ctrl/Cmd+H (or expanding the same bar) adds a replace row — full CM6-parity feature set (live match count, case/whole-word/regex toggles, next/previous navigation, Replace and Replace All).

**Architecture:** `@codemirror/search`'s core (`SearchQuery`, `setSearchQuery`, `findNext`/`findPrevious`/`replaceNext`/`replaceAll`) does all real matching/replacing — a new `client/src/search.ts` wraps it plus a from-scratch match-highlight `StateField` (the package's own highlighter only paints while its default panel is open, which this design never uses). A new `client/src/stores/findReplace.ts` holds the bar's open/closed state. A new `client/src/components/FindReplaceBar.svelte` is the actual UI, docked to the top of the editor pane — reads the live `EditorView` via the existing `window.MDE.getEditor()` bridge call, no new bridge method. `Editor.svelte` wires in the extension, a `Mod-f`/`Mod-h` keymap, and renders the bar; `MenuBar.svelte`/`ShortcutsModal.svelte` get matching entries.

**Tech Stack:** TypeScript, Svelte 5, CodeMirror 6 (`@codemirror/search`), Vitest (`unit` + `components` projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-27-search-and-replace-design.md`

## Global Constraints

- Operates on the currently-open document only — no cross-document search (a separate, much bigger feature).
- No search-query persistence across bar close/reopen or document switches — always starts blank.
- Replace/Replace All are disabled whenever the view is read-only (`view.state.readOnly`) — never attempted, never silently no-op.
- An invalid regex query (`SearchQuery.valid === false`) disables navigation and Replace/Replace All, and marks the Find input with an `.invalid` class — never thrown/crashed on.
- Reuses `@codemirror/search`'s own `cm-searchMatch`/`cm-searchMatch-selected` CSS classes for match highlighting — no new highlight CSS.
- This is a user-facing feature: ships with a minor version bump (`package.json` + `package-lock.json`), a `CHANGELOG.md` entry, and a `whats-new-entries.ts` entry with a real screenshot, per `CLAUDE.md`'s versioning convention.

---

### Task 1: `client/src/search.ts` — matching and highlighting logic

**Files:**
- Create: `client/src/search.ts`
- Test: `tests/client/src/search.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function countMatches(state: EditorState, query: SearchQuery): { total: number; index: number };
  export function buildSearchExtension(): Extension;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/client/src/search.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";
import { countMatches } from "../../../client/src/search";

function stateWith(doc: string, head: number): EditorState {
  return EditorState.create({ doc, selection: { anchor: head } });
}

describe("countMatches", () => {
  it("returns zero when there are no matches", () => {
    const state = stateWith("hello world", 0);
    const query = new SearchQuery({ search: "xyz" });
    expect(countMatches(state, query)).toEqual({ total: 0, index: 0 });
  });

  it("returns zero for an empty search string", () => {
    const state = stateWith("hello world", 0);
    const query = new SearchQuery({ search: "" });
    expect(countMatches(state, query)).toEqual({ total: 0, index: 0 });
  });

  it("counts every match and picks the one at or after the cursor", () => {
    const state = stateWith("cat cat cat", 5); // cursor inside the second "cat" (positions 4-7)
    const query = new SearchQuery({ search: "cat" });
    expect(countMatches(state, query)).toEqual({ total: 3, index: 2 });
  });

  it("wraps to the first match when the cursor is after every match", () => {
    const state = stateWith("cat dog", 7);
    const query = new SearchQuery({ search: "cat" });
    expect(countMatches(state, query)).toEqual({ total: 1, index: 1 });
  });

  it("is case-sensitive when the option is set", () => {
    const state = stateWith("Cat cat CAT", 0);
    const query = new SearchQuery({ search: "cat", caseSensitive: true });
    expect(countMatches(state, query)).toEqual({ total: 1, index: 1 });
  });

  it("treats the search string as a regular expression when regexp is set", () => {
    const state = stateWith("cat1 cat2 dog3", 0);
    const query = new SearchQuery({ search: "cat\\d", regexp: true });
    expect(countMatches(state, query)).toEqual({ total: 2, index: 1 });
  });

  it("returns zero for an invalid regular expression instead of throwing", () => {
    const state = stateWith("cat cat", 0);
    const query = new SearchQuery({ search: "cat(", regexp: true });
    expect(() => countMatches(state, query)).not.toThrow();
    expect(countMatches(state, query)).toEqual({ total: 0, index: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/src/search.test.ts`
Expected: FAIL — `client/src/search.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `client/src/search.ts`:

```ts
import { search, SearchQuery, getSearchQuery, setSearchQuery } from "@codemirror/search";
import { EditorState, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

interface MatchRange {
  from: number;
  to: number;
}

function collectMatchRanges(state: EditorState, query: SearchQuery): MatchRange[] {
  if (!query.valid) return [];
  const ranges: MatchRange[] = [];
  const cursor = query.getCursor(state.doc);
  for (let result = cursor.next(); !result.done; result = cursor.next()) {
    ranges.push({ from: result.value.from, to: result.value.to });
  }
  return ranges;
}

// Live match count for FindReplaceBar's "n of m" indicator: the match at
// or after the current selection head, wrapping to the first match if
// the selection is past every one of them — matches findNext's own
// wrap-around behavior. `index` is 0 when `total` is 0.
export function countMatches(state: EditorState, query: SearchQuery): { total: number; index: number } {
  const ranges = collectMatchRanges(state, query);
  if (ranges.length === 0) return { total: 0, index: 0 };
  const head = state.selection.main.head;
  const at = ranges.findIndex((r) => r.to >= head);
  return { total: ranges.length, index: at === -1 ? 1 : at + 1 };
}

// @codemirror/search's own built-in match highlighter only ever paints
// decorations while its default search panel is open (checked directly
// in its source: `if (!panel || !query.spec.valid) return Decoration.none`)
// — FindReplaceBar.svelte never opens that panel, so this needs its own
// highlight field instead. Reuses @codemirror/search's own
// "cm-searchMatch"/"cm-searchMatch-selected" class names, already styled
// (light and dark) by the baseTheme search() itself installs below, so
// no new CSS is needed here.
const matchMark = Decoration.mark({ class: "cm-searchMatch" });
const selectedMatchMark = Decoration.mark({ class: "cm-searchMatch-selected" });

function computeMatchHighlights(state: EditorState): DecorationSet {
  const ranges = collectMatchRanges(state, getSearchQuery(state));
  if (ranges.length === 0) return Decoration.none;
  return Decoration.set(
    ranges.map((r) => {
      const selected = state.selection.ranges.some((sel) => sel.from === r.from && sel.to === r.to);
      return (selected ? selectedMatchMark : matchMark).range(r.from, r.to);
    }),
  );
}

const searchHighlightField = StateField.define<DecorationSet>({
  create: (state) => computeMatchHighlights(state),
  update(deco, tr) {
    if (!tr.docChanged && !tr.selection && !tr.effects.some((e) => e.is(setSearchQuery))) return deco;
    return computeMatchHighlights(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function buildSearchExtension(): Extension {
  return [search(), searchHighlightField];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/client/src/search.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json` (this file is under `client/src`, checked via the client tsconfig, but the test file needs the root/unit typecheck too since it's not a `.svelte` file — run both to be safe):
```bash
npx tsc --noEmit -p tsconfig.json
npx svelte-check --tsconfig client/tsconfig.json
```
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/search.ts tests/client/src/search.test.ts
git commit -m "feat: add search/replace matching and highlighting logic"
```

---

### Task 2: `client/src/stores/findReplace.ts` — bar open/closed state

**Files:**
- Create: `client/src/stores/findReplace.ts`
- Test: `tests/client/src/stores/findReplace.test.ts`

**Interfaces:**
- Consumes: `viewMode`, `setView` (`client/src/stores/view.ts`, already exist).
- Produces:
  ```ts
  export type FindBarMode = "find" | "replace";
  export const findBarOpen: Writable<boolean>;
  export const findBarMode: Writable<FindBarMode>;
  export function openFindBar(mode: FindBarMode): void;
  export function closeFindBar(): void;
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/client/src/stores/findReplace.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

describe("findReplace store", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="body"></div>';
    vi.resetModules();
  });

  it("opens in find mode", async () => {
    const { findBarOpen, findBarMode, openFindBar } = await import("../../../../client/src/stores/findReplace");
    openFindBar("find");
    expect(get(findBarOpen)).toBe(true);
    expect(get(findBarMode)).toBe("find");
  });

  it("opens in replace mode", async () => {
    const { findBarMode, openFindBar } = await import("../../../../client/src/stores/findReplace");
    openFindBar("replace");
    expect(get(findBarMode)).toBe("replace");
  });

  it("switches out of preview-only view mode so the bar is visible", async () => {
    const { openFindBar } = await import("../../../../client/src/stores/findReplace");
    const { viewMode, setView } = await import("../../../../client/src/stores/view");
    setView("preview");
    openFindBar("find");
    expect(get(viewMode)).toBe("split");
  });

  it("leaves an already-visible view mode alone", async () => {
    const { openFindBar } = await import("../../../../client/src/stores/findReplace");
    const { viewMode, setView } = await import("../../../../client/src/stores/view");
    setView("editor");
    openFindBar("find");
    expect(get(viewMode)).toBe("editor");
  });

  it("closeFindBar hides the bar", async () => {
    const { findBarOpen, openFindBar, closeFindBar } = await import("../../../../client/src/stores/findReplace");
    openFindBar("find");
    closeFindBar();
    expect(get(findBarOpen)).toBe(false);
  });
});
```

(Dynamic `await import(...)` + `vi.resetModules()`, and the jsdom pragma + seeded `#body` element, match this codebase's existing convention for any test touching `stores/view.ts` — see `tests/client/src/stores/view.test.ts`, which needs the same setup since that module reads/writes `document.getElementById("body")` both at import time and inside `setView`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/src/stores/findReplace.test.ts`
Expected: FAIL — `client/src/stores/findReplace.ts` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `client/src/stores/findReplace.ts`:

```ts
import { writable, get } from "svelte/store";
import { viewMode, setView } from "./view";

export type FindBarMode = "find" | "replace";

export const findBarOpen = writable<boolean>(false);
export const findBarMode = writable<FindBarMode>("find");

// Switches out of Preview-only view mode first, if needed, so the bar
// (and its match highlights) are actually visible instead of opening
// behind a hidden editor pane.
export function openFindBar(mode: FindBarMode): void {
  if (get(viewMode) === "preview") setView("split");
  findBarMode.set(mode);
  findBarOpen.set(true);
}

export function closeFindBar(): void {
  findBarOpen.set(false);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/client/src/stores/findReplace.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Typecheck**

Run: `npx svelte-check --tsconfig client/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/stores/findReplace.ts tests/client/src/stores/findReplace.test.ts
git commit -m "feat: add findReplace store (bar open/closed state)"
```

---

### Task 3: `client/src/components/FindReplaceBar.svelte` — the UI

**Files:**
- Create: `client/src/components/FindReplaceBar.svelte`
- Test: `tests/client/src/components/FindReplaceBar.test.ts`

**Interfaces:**
- Consumes: `countMatches`, `buildSearchExtension` (Task 1); `findBarOpen`, `findBarMode`, `closeFindBar` (Task 2); `window.MDE.getEditor()` (existing bridge); `SearchQuery`/`setSearchQuery`/`findNext`/`findPrevious`/`replaceNext`/`replaceAll` (`@codemirror/search`, existing dependency).
- Produces: a `<FindReplaceBar />` component with no props — everything it needs comes from stores and the bridge.

- [ ] **Step 1: Write the failing tests**

Create `tests/client/src/components/FindReplaceBar.test.ts`:

```ts
import { render } from "vitest-browser-svelte";
import { expect, test, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";
import { userEvent } from "vitest/browser";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { buildSearchExtension } from "../../../../client/src/search";

// stores/findReplace.ts imports stores/view.ts, which reads/writes
// document.getElementById("body") at module load time (it mirrors the
// current view mode onto that element's className) — this app's own
// index.html always has that element, but the plain tester page Vitest's
// browser mode serves for component tests doesn't, so it has to be
// seeded before either module ever loads (including transitively, via
// FindReplaceBar.svelte's own static import of stores/findReplace).
if (!document.getElementById("body")) {
  const bodyMarker = document.createElement("div");
  bodyMarker.id = "body";
  document.body.appendChild(bodyMarker);
}

const { findBarOpen, findBarMode, closeFindBar } = await import("../../../../client/src/stores/findReplace");
const { default: FindReplaceBar } = await import("../../../../client/src/components/FindReplaceBar.svelte");

let view: EditorView;
let host: HTMLDivElement;

function mountEditor(doc: string, readOnly = false) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const extensions = readOnly ? [buildSearchExtension(), EditorState.readOnly.of(true)] : [buildSearchExtension()];
  view = new EditorView({ state: EditorState.create({ doc, extensions }), parent: host });
  window.MDE = { getEditor: () => view } as unknown as typeof window.MDE;
}

beforeEach(() => {
  findBarMode.set("find");
  findBarOpen.set(true);
});

afterEach(() => {
  closeFindBar();
  view?.destroy();
  host?.remove();
});

test("typing a query shows a live match count", async () => {
  mountEditor("cat cat CAT dog");
  const screen = await render(FindReplaceBar);
  await screen.getByLabelText("Find").fill("cat");
  // Case-insensitive by default: matches both "cat"s and "CAT".
  await expect.element(screen.getByText("1 of 3")).toBeVisible();
});

test("the match case toggle narrows the count", async () => {
  mountEditor("cat cat CAT dog");
  const screen = await render(FindReplaceBar);
  await screen.getByLabelText("Find").fill("cat");
  await screen.getByLabelText("Match case").click();
  // Case-sensitive: only the two lowercase "cat"s match, not "CAT".
  await expect.element(screen.getByText("1 of 2")).toBeVisible();
});

test("the replace row only appears in replace mode", async () => {
  mountEditor("cat cat");
  const screen = await render(FindReplaceBar);
  await expect.element(screen.getByLabelText("Replace", { exact: true })).not.toBeInTheDocument();
  await screen.getByLabelText("Toggle replace").click();
  await expect.element(screen.getByLabelText("Replace", { exact: true })).toBeVisible();
});

test("Replace and Replace All are disabled on a read-only view", async () => {
  mountEditor("cat cat", true);
  findBarMode.set("replace");
  const screen = await render(FindReplaceBar);
  await screen.getByLabelText("Find").fill("cat");
  // exact: true on "Replace" — without it, Testing Library's default
  // substring/case-insensitive name matching also matches "Toggle
  // replace" and "Replace All", raising a strict-mode violation.
  await expect.element(screen.getByRole("button", { name: "Replace", exact: true })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Replace All" })).toBeDisabled();
});

test("an invalid regex disables navigation and shows the invalid state", async () => {
  mountEditor("cat cat");
  const screen = await render(FindReplaceBar);
  await screen.getByLabelText("Use regular expression").click();
  await screen.getByLabelText("Find").fill("cat(");
  await expect.element(screen.getByLabelText("Find")).toHaveClass("invalid");
  await expect.element(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
});

test("Escape closes the bar", async () => {
  mountEditor("cat cat");
  const screen = await render(FindReplaceBar);
  await screen.getByLabelText("Find").fill("cat");
  await userEvent.keyboard("{Escape}");
  expect(get(findBarOpen)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project=components tests/client/src/components/FindReplaceBar.test.ts`
Expected: FAIL — `client/src/components/FindReplaceBar.svelte` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

Create `client/src/components/FindReplaceBar.svelte`:

```svelte
<script lang="ts">
  import { SearchQuery, setSearchQuery, findNext, findPrevious, replaceNext, replaceAll } from "@codemirror/search";
  import { countMatches } from "../search";
  import { findBarOpen, findBarMode, closeFindBar } from "../stores/findReplace";

  let findText = $state("");
  let replaceText = $state("");
  let caseSensitive = $state(false);
  let wholeWord = $state(false);
  let regexp = $state(false);
  let matchInfo = $state<{ total: number; index: number }>({ total: 0, index: 0 });
  let readOnly = $state(false);
  let findInputEl: HTMLInputElement | undefined = $state();

  const query = $derived(new SearchQuery({ search: findText, replace: replaceText, caseSensitive, wholeWord, regexp }));

  function view() {
    return window.MDE.getEditor();
  }

  function refresh() {
    const v = view();
    matchInfo = countMatches(v.state, query);
    readOnly = v.state.readOnly;
  }

  // Reactively pushes every query change (typing, or a toggle) into the
  // editor's search state and recomputes the match count. Doesn't cover
  // findNext/findPrevious/replaceNext/replaceAll below, which move the
  // selection or change the document without changing the query itself
  // — those call refresh() directly instead.
  $effect(() => {
    if (!$findBarOpen) return;
    view().dispatch({ effects: setSearchQuery.of(query) });
    refresh();
  });

  // Focuses (and selects the existing text of) the find input every time
  // the bar opens — Ctrl/Cmd+F while it's already open just refocuses,
  // matching VS Code.
  $effect(() => {
    if ($findBarOpen) {
      findInputEl?.focus();
      findInputEl?.select();
    }
  });

  function goNext() {
    findNext(view());
    refresh();
  }
  function goPrev() {
    findPrevious(view());
    refresh();
  }
  function doReplace() {
    replaceNext(view());
    refresh();
  }
  function doReplaceAll() {
    replaceAll(view());
    refresh();
  }
  function toggleReplaceRow() {
    findBarMode.set($findBarMode === "replace" ? "find" : "replace");
  }
  function close() {
    closeFindBar();
    view().focus();
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
    }
  }
</script>

{#if $findBarOpen}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="find-replace-bar" role="search" onkeydown={onKeydown}>
    <div class="find-row">
      <input
        type="text"
        placeholder="Find"
        bind:value={findText}
        bind:this={findInputEl}
        class:invalid={findText.length > 0 && !query.valid}
        aria-label="Find"
      />
      <span class="match-count">{matchInfo.total === 0 ? (findText ? "No results" : "") : `${matchInfo.index} of ${matchInfo.total}`}</span>
      <button type="button" onclick={goPrev} disabled={!query.valid || matchInfo.total === 0} aria-label="Previous match">
        <svg class="icon"><use href="#icon-chevron-left"></use></svg>
      </button>
      <button type="button" onclick={goNext} disabled={!query.valid || matchInfo.total === 0} aria-label="Next match">
        <svg class="icon"><use href="#icon-chevron-right"></use></svg>
      </button>
      <button type="button" class:active={caseSensitive} onclick={() => (caseSensitive = !caseSensitive)} aria-label="Match case" aria-pressed={caseSensitive}>
        Aa
      </button>
      <button type="button" class:active={wholeWord} onclick={() => (wholeWord = !wholeWord)} aria-label="Whole word" aria-pressed={wholeWord}>
        [ab]
      </button>
      <button type="button" class:active={regexp} onclick={() => (regexp = !regexp)} aria-label="Use regular expression" aria-pressed={regexp}>
        .*
      </button>
      <button type="button" onclick={toggleReplaceRow} aria-label="Toggle replace" aria-expanded={$findBarMode === "replace"}>
        <svg class="icon"><use href={$findBarMode === "replace" ? "#icon-chevron-down" : "#icon-chevron-right"}></use></svg>
      </button>
      <button type="button" onclick={close} aria-label="Close">
        <svg class="icon"><use href="#icon-x"></use></svg>
      </button>
    </div>
    {#if $findBarMode === "replace"}
      <div class="replace-row">
        <input type="text" placeholder="Replace" bind:value={replaceText} aria-label="Replace" />
        <button type="button" onclick={doReplace} disabled={readOnly || !query.valid || matchInfo.total === 0}>Replace</button>
        <button type="button" onclick={doReplaceAll} disabled={readOnly || !query.valid || matchInfo.total === 0}>Replace All</button>
      </div>
    {/if}
  </div>
{/if}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project=components tests/client/src/components/FindReplaceBar.test.ts`
Expected: PASS (all 6 tests). If a screenshot was auto-saved to `tests/client/src/components/__screenshots__/`, check it first to see what actually rendered before re-reading the component code.

- [ ] **Step 5: Typecheck**

Run: `npx svelte-check --tsconfig client/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/FindReplaceBar.svelte tests/client/src/components/FindReplaceBar.test.ts
git commit -m "feat: add FindReplaceBar.svelte"
```

---

### Task 4: Wire into `Editor.svelte` + styling

**Files:**
- Modify: `client/src/components/Editor.svelte`
- Modify: `client/src/styles/_editor-preview.scss`
- Create: `client/src/styles/_find-replace.scss`
- Modify: `client/src/style.scss`

**Interfaces:**
- Consumes: `buildSearchExtension` (Task 1), `openFindBar` (Task 2), `FindReplaceBar` (Task 3).

- [ ] **Step 1: Add the search extension and keymap**

In `client/src/components/Editor.svelte`, find the import block:

```ts
  import { commentDraft } from "../stores/commentDraft";
  import { slashMenu } from "../stores/slashMenu";
  import { wikilinkMenu } from "../stores/wikilinkMenu";
```

Change to:

```ts
  import { commentDraft } from "../stores/commentDraft";
  import { slashMenu } from "../stores/slashMenu";
  import { wikilinkMenu } from "../stores/wikilinkMenu";
  import { buildSearchExtension } from "../search";
  import { openFindBar } from "../stores/findReplace";
  import FindReplaceBar from "./FindReplaceBar.svelte";
```

Find the `menuEscapeKeymap` definition (so the new keymap sits next to the other single-purpose keymaps in this file):

```ts
  const menuEscapeKeymap = keymap.of([
    {
      key: "Escape",
      run: (v: EditorView) => {
        if (v.state.field(slashTriggerField)?.open) {
          v.dispatch({ effects: closeSlashMenuEffect.of(null) });
          return true;
        }
        if (v.state.field(wikilinkTriggerField)?.open) {
          v.dispatch({ effects: closeWikilinkMenuEffect.of(null) });
          return true;
        }
        return false;
      },
    },
  ]);
```

Change to:

```ts
  const menuEscapeKeymap = keymap.of([
    {
      key: "Escape",
      run: (v: EditorView) => {
        if (v.state.field(slashTriggerField)?.open) {
          v.dispatch({ effects: closeSlashMenuEffect.of(null) });
          return true;
        }
        if (v.state.field(wikilinkTriggerField)?.open) {
          v.dispatch({ effects: closeWikilinkMenuEffect.of(null) });
          return true;
        }
        return false;
      },
    },
  ]);

  const findReplaceKeymap = keymap.of([
    {
      key: "Mod-f",
      run: () => {
        openFindBar("find");
        return true;
      },
    },
    {
      key: "Mod-h",
      run: () => {
        openFindBar("replace");
        return true;
      },
    },
  ]);
```

- [ ] **Step 2: Add the extension/keymap to `buildExtensions()` and render the bar**

Find:

```ts
      commentMarkerField,
      commentDraftSyncListener,
      menuEscapeKeymap,
      slashTriggerField,
```

Change to:

```ts
      commentMarkerField,
      commentDraftSyncListener,
      menuEscapeKeymap,
      findReplaceKeymap,
      buildSearchExtension(),
      slashTriggerField,
```

Find the template at the bottom of the file:

```svelte
<div id="editorWrap">
  <div bind:this={hostEl} class="cm-host"></div>
</div>
```

Change to:

```svelte
<div id="editorWrap">
  <FindReplaceBar />
  <div bind:this={hostEl} class="cm-host"></div>
</div>
```

- [ ] **Step 3: Position `#editorWrap` so the bar can dock to its top**

In `client/src/styles/_editor-preview.scss`, find:

```scss
#editorWrap {
  flex: 1;
  min-height: 0;
  overflow: hidden;

  .cm-host {
    height: 100%;
  }
}
```

Change to:

```scss
#editorWrap {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;

  .cm-host {
    height: 100%;
  }
}
```

- [ ] **Step 4: Add the find/replace bar's own styling**

Create `client/src/styles/_find-replace.scss`:

```scss
/* Find & Replace bar (Ctrl/Cmd+F / Ctrl/Cmd+H) — docked to the top of
   the editor pane (#editorWrap is position: relative, see
   _editor-preview.scss), not a Modal-style centered dialog: a
   persistent tool you interact with while still seeing/editing the
   document, same layering idea as .slash-menu/.wikilink-menu. Match
   highlighting itself reuses @codemirror/search's own
   cm-searchMatch/cm-searchMatch-selected classes (see client/src/search.ts)
   — no new CSS needed for that part. */
.find-replace-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  box-shadow: var(--shadow);
  font-size: 13px;
}

.find-row,
.replace-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.find-replace-bar input[type="text"] {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: inherit;
}

.find-replace-bar input[type="text"]:focus {
  outline: none;
  border-color: var(--accent);
}

.find-replace-bar input[type="text"].invalid {
  border-color: var(--danger);
}

.find-replace-bar .match-count {
  min-width: 60px;
  text-align: center;
  white-space: nowrap;
  color: var(--text-dim);
}

.find-replace-bar button {
  border: none;
  background: none;
  border-radius: 6px;
  padding: 4px 6px;
  cursor: pointer;
  color: var(--text-dim);
  font-family: inherit;
  font-size: inherit;
}

.find-replace-bar button:hover:not(:disabled) {
  background: var(--bg-alt);
  color: var(--text);
}

.find-replace-bar button.active {
  background: var(--accent-dim);
  color: var(--accent);
}

.find-replace-bar button:disabled {
  opacity: 0.4;
  cursor: default;
}

.find-replace-bar .replace-row button {
  border: 1px solid var(--border);
  padding: 4px 10px;
}
```

In `client/src/style.scss`, find:

```scss
@use "./styles/slash-wikilink";
@use "./styles/utilities";
```

Change to:

```scss
@use "./styles/slash-wikilink";
@use "./styles/find-replace";
@use "./styles/utilities";
```

- [ ] **Step 5: Typecheck**

Run: `npx svelte-check --tsconfig client/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: succeeds (pre-existing chunk-size warnings are fine and unrelated).

- [ ] **Step 8: Commit**

```bash
git add client/src/components/Editor.svelte client/src/styles/_editor-preview.scss client/src/styles/_find-replace.scss client/src/style.scss
git commit -m "feat: wire the find/replace bar into the editor"
```

---

### Task 5: Edit menu and Shortcuts modal entries

**Files:**
- Modify: `client/src/components/MenuBar.svelte`
- Modify: `client/src/components/ShortcutsModal.svelte`

**Interfaces:**
- Consumes: `openFindBar` (Task 2).

- [ ] **Step 1: Add the import and menu entries**

In `client/src/components/MenuBar.svelte`, find:

```ts
  import { repoSyncBusyLabel } from "../stores/repoSync";
```

Change to:

```ts
  import { repoSyncBusyLabel } from "../stores/repoSync";
  import { openFindBar } from "../stores/findReplace";
```

Find:

```svelte
      <button id="menuRedo" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.redo())}><svg class="icon"><use href="#icon-redo-2"></use></svg> Redo <kbd>Ctrl+Shift+Z</kbd></button>
      <div class="menu-divider"></div>
      <button id="menuCut" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.cutSelection())}><svg class="icon"><use href="#icon-scissors"></use></svg> Cut <kbd>Ctrl+X</kbd></button>
```

Change to:

```svelte
      <button id="menuRedo" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.redo())}><svg class="icon"><use href="#icon-redo-2"></use></svg> Redo <kbd>Ctrl+Shift+Z</kbd></button>
      <div class="menu-divider"></div>
      <button id="menuFind" type="button" disabled={!hasActiveDoc} onclick={() => act(() => openFindBar("find"))}><svg class="icon"><use href="#icon-search"></use></svg> Find... <kbd>Ctrl+F</kbd></button>
      <button id="menuFindReplace" type="button" disabled={!hasActiveDoc} onclick={() => act(() => openFindBar("replace"))}><svg class="icon"><use href="#icon-search"></use></svg> Find and Replace... <kbd>Ctrl+H</kbd></button>
      <div class="menu-divider"></div>
      <button id="menuCut" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.cutSelection())}><svg class="icon"><use href="#icon-scissors"></use></svg> Cut <kbd>Ctrl+X</kbd></button>
```

- [ ] **Step 2: Add the shortcuts**

In `client/src/components/ShortcutsModal.svelte`, find:

```ts
  const SHORTCUTS: [string, string][] = [
    ["Bold", "Ctrl/Cmd+B"],
    ["Italic", "Ctrl/Cmd+I"],
    ["Insert link", "Ctrl/Cmd+K"],
    ["Undo", "Ctrl/Cmd+Z"],
    ["Redo", "Ctrl/Cmd+Shift+Z"],
    ["Continue list on new line", "Enter"],
  ];
```

Change to:

```ts
  const SHORTCUTS: [string, string][] = [
    ["Bold", "Ctrl/Cmd+B"],
    ["Italic", "Ctrl/Cmd+I"],
    ["Insert link", "Ctrl/Cmd+K"],
    ["Find", "Ctrl/Cmd+F"],
    ["Find and replace", "Ctrl/Cmd+H"],
    ["Undo", "Ctrl/Cmd+Z"],
    ["Redo", "Ctrl/Cmd+Shift+Z"],
    ["Continue list on new line", "Enter"],
  ];
```

- [ ] **Step 3: Typecheck**

Run: `npx svelte-check --tsconfig client/tsconfig.json`
Expected: clean.

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/MenuBar.svelte client/src/components/ShortcutsModal.svelte
git commit -m "feat: add Find/Find-and-Replace to the Edit menu and shortcuts list"
```

---

### Task 6: Playwright e2e coverage

**Files:**
- Create: `tests/e2e/local/search-and-replace.spec.ts`

**Interfaces:**
- Consumes: `./support/fixtures` (existing — seeds a local document and navigates to it before every test in this file).

- [ ] **Step 1: Write the test**

Create `tests/e2e/local/search-and-replace.spec.ts`:

```ts
import { test, expect } from "./support/fixtures";

test("Ctrl/Cmd+F opens the find bar and highlights matches with a live count", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("the cat sat on the cat mat");
  await page.keyboard.press("ControlOrMeta+F");

  await expect(page.locator(".find-replace-bar")).toBeVisible();
  await page.getByLabel("Find").fill("cat");
  await expect(page.getByText("1 of 2")).toBeVisible();
  await expect(page.locator(".cm-searchMatch")).toHaveCount(2);
});

test("Ctrl/Cmd+H opens with the replace row, and Replace All replaces every match", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.type("the cat sat on the cat mat");
  await page.keyboard.press("ControlOrMeta+H");

  await expect(page.getByLabel("Replace")).toBeVisible();
  await page.getByLabel("Find").fill("cat");
  await page.getByLabel("Replace").fill("dog");
  await page.getByRole("button", { name: "Replace All" }).click();

  await expect.poll(() => page.evaluate(() => window.MDE.getEditor().state.doc.toString())).toBe("the dog sat on the dog mat");
});

test("Escape closes the find bar", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.keyboard.press("ControlOrMeta+F");
  await expect(page.locator(".find-replace-bar")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".find-replace-bar")).not.toBeVisible();
});
```

- [ ] **Step 2: Run it**

Run: `npx playwright test --project=local tests/e2e/local/search-and-replace.spec.ts`
Expected: PASS (all 3 tests). This starts its own dev server per `playwright.config.ts`'s `webServer` config — no manual server setup needed.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/local/search-and-replace.spec.ts
git commit -m "test: add Playwright e2e coverage for search and replace"
```

---

### Task 7: Version bump, CHANGELOG, What's New, IMPROVEMENTS.md

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `client/src/whats-new-entries.ts`
- Modify: `IMPROVEMENTS.md`
- Create: `client/public/whats-new/search-and-replace.png`

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "1.28.0"` to `"version": "1.29.0"` (minor bump — user-facing feature).

In `package-lock.json`, update the same two `"version"` fields (the top-level one and the one under `packages[""]`) by hand, matching the exact value — not a full `npm install --package-lock-only` regeneration, which can introduce unrelated lockfile metadata churn (confirmed in this repo's own history: it did exactly that once already).

- [ ] **Step 2: Add the CHANGELOG entry**

In `CHANGELOG.md`, add a new section above the current top entry:

```md
## [1.29.0] - <today's date, YYYY-MM-DD>

### Added

- **Search and replace.** Ctrl/Cmd+F opens a find bar over the current document with a live match count and case-sensitive/whole-word/regex toggles; Ctrl/Cmd+H expands it with a Replace row (Replace and Replace All). Operates on the currently-open document only.
```

- [ ] **Step 3: Add the What's New entry**

First, capture a real screenshot: run `npm run build`, then `npx vite dev --config client/vite.config.ts --port 5275 &` in the background, then use Playwright (or a browser) to open the app, seed a document with a couple of repeated words, press Ctrl/Cmd+F, type a query, and screenshot the resulting `.find-replace-bar` area (crop to it plus a bit of surrounding editor content, similar framing to the other files already in `client/public/whats-new/`). Save it to `client/public/whats-new/search-and-replace.png`. Stop the dev server afterward.

In `client/src/whats-new-entries.ts`, find the closing of the array (the last entry followed by `];`) and add a new entry immediately before that closing bracket:

```ts
  {
    version: "1.29.0",
    title: "Search and Replace",
    description:
      "Ctrl/Cmd+F opens a find bar with a live match count and case/whole-word/regex toggles. Ctrl/Cmd+H expands it into Replace and Replace All.",
    screenshot: "/whats-new/search-and-replace.png",
  },
```

- [ ] **Step 4: Mark the IMPROVEMENTS.md backlog item done**

Find:

```md
- [ ] Search & replace.
```

Change to:

```md
- [x] Search & replace. (Shipped v1.29.0.)
```

- [ ] **Step 5: Typecheck and format check**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx svelte-check --tsconfig client/tsconfig.json
npx prettier --check .
```
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts IMPROVEMENTS.md client/public/whats-new/search-and-replace.png
git commit -m "docs: ship notes for search and replace"
```

---

### Task 8: Final verification

**Files:** None (verification only).

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all tests pass, including every new test from Tasks 1-3.

- [ ] **Step 2: Both typechecks**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx svelte-check --tsconfig client/tsconfig.json
```
Expected: both clean.

- [ ] **Step 3: Format check**

Run: `npx prettier --check .`
Expected: clean.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 5: Full local e2e suite**

Run: `npm run test:e2e:local`
Expected: all tests pass, including the 3 new ones from Task 6 — confirms nothing about the new keymap/bar broke any other client-only flow (formatting, export, focus mode, etc.).

- [ ] **Step 6: Manual verification**

Run the dev server (`npm run dev:client`) and check by hand:
1. Open a document with some repeated text, press Ctrl/Cmd+F — the bar appears docked to the top of the editor, matches highlight, the count updates live while typing.
2. Toggle Match case / Whole word / Use regular expression — the count and highlights update accordingly.
3. Type an invalid regex (e.g. `cat(` with the regex toggle on) — the Find input shows the invalid state, navigation/replace buttons disable.
4. Press Ctrl/Cmd+H — the Replace row appears; Replace and Replace All work as expected.
5. Open a shared document as a viewer/reviewer (read-only) and confirm Replace/Replace All are disabled while Find still works.
6. Switch to Preview-only view mode, then press Ctrl/Cmd+F — it switches to Split view so the bar is visible.
7. Escape closes the bar; File > Edit menu's "Find..."/"Find and Replace..." entries work; the Shortcuts modal lists both.
