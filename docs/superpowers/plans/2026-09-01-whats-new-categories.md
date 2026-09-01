# What's New Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual "What's New" reopen (Help menu) with a category index the user picks from, instead of dumping them into a 27-entry stepper starting at the oldest release.

**Architecture:** `WhatsNewEntry` gains a `category` field; a new pure `groupByCategory` helper groups the flat array; `WhatsNew.svelte` gains a `categoryView` state variable that switches its manual-reopen view between an index (category rows) and the existing stepper scoped to one category. The auto-open (missed-entries-on-load) flow is untouched.

**Tech Stack:** Svelte 5 (runes: `$state`/`$derived`), Vitest (`unit` project for pure logic, `components` project via `vitest-browser-svelte` for the Svelte component), Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-09-01-whats-new-categories-design.md`

## Global Constraints

- `WhatsNewEntry.category` is a closed union type (`WhatsNewCategory`), not a bare `string` — a typo'd or new category name is a compile error until the union is deliberately extended.
- The **auto-open** flow (popup on load for missed entries) is completely unchanged — no category index, same plain stepper, same "Got it" wording, same behavior as today. Only the **manual reopen** (Help menu, or any later transition of `whatsNewOpen` to `true`) changes.
- Category display order = order each category first appears in `WHATS_NEW_ENTRIES` (i.e. the order its oldest entry shipped). Entries **within** a category are newest-first (reverse of the array's own oldest-first order) — browsing a topic, you want its latest change first.
- The stepper's final button reads "Done" (not "Got it") whenever inside a category view, and returns to the index instead of closing the modal. The modal's own X button / Escape always fully closes it, from either the index or the stepper.
- Version bump: this is a user-facing UI change → **minor** bump to `1.40.0`, with its own What's New entry (category: "Editing & Formatting") per `CLAUDE.md`'s versioning convention.

---

### Task 1: `WhatsNewEntry.category` field + taxonomy assignment

**Files:**
- Modify: `client/src/whats-new-entries.ts`
- Create: `tests/client/src/whats-new-entries.test.ts`
- Modify: `tests/client/src/whats-new.test.ts:24-28` (existing `missedEntries` fixture array — needs a `category` field added to satisfy the now-required type)

**Interfaces:**
- Produces: `export type WhatsNewCategory = "Editing & Formatting" | "Collaboration" | "Version History" | "GitHub Integration" | "Organization & Navigation";` and `WhatsNewEntry.category: WhatsNewCategory` (required field), both exported from `client/src/whats-new-entries.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/client/src/whats-new-entries.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { WHATS_NEW_ENTRIES } from "../../../client/src/whats-new-entries";
import type { WhatsNewCategory } from "../../../client/src/whats-new-entries";

const KNOWN_CATEGORIES: WhatsNewCategory[] = ["Editing & Formatting", "Collaboration", "Version History", "GitHub Integration", "Organization & Navigation"];

describe("WHATS_NEW_ENTRIES categories", () => {
  it("every entry has a category from the known set", () => {
    for (const entry of WHATS_NEW_ENTRIES) {
      expect(KNOWN_CATEGORIES).toContain(entry.category);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project=unit tests/client/src/whats-new-entries.test.ts`
Expected: FAIL — every entry's `category` is `undefined`, not in `KNOWN_CATEGORIES`.

- [ ] **Step 3: Add the type and field, and tag every entry**

In `client/src/whats-new-entries.ts`, change the interface:

```ts
export type WhatsNewCategory = "Editing & Formatting" | "Collaboration" | "Version History" | "GitHub Integration" | "Organization & Navigation";

export interface WhatsNewEntry {
  version: string;
  title: string;
  description: string;
  screenshot: string; // client/public/ path, e.g. "/whats-new/threaded-comments.png"
  category: WhatsNewCategory;
}
```

Add `category: "..."` to every one of the 27 existing entries, per this exact assignment (by `title`):

| Category | Titles |
|---|---|
| `"Editing & Formatting"` | Command Palette, Slash Commands, Search and Replace, Toolbar Undo, Redo & Command Palette, Insert Existing Image & Replace, Printing Support, Markdown Compatibility Checker, MultiMarkdown Syntax Support, Citations & Bibliography, Format and Insert Menus |
| `"Collaboration"` | Threaded Comments, Workspace-Level Sharing, Shared Document Names Sync, Unresolved-Comment Badge, Suggestion-Mode Collaboration |
| `"Version History"` | Version History, Version History Meets Repo Commits, GitHub-Style Diffs, Portable Local History, Smart Version History Grouping |
| `"GitHub Integration"` | GitHub Repo Sync, Open GitHub Repo as Workspace, Choose Gist Visibility |
| `"Organization & Navigation"` | Wikilinks, Workspaces, A URL for Every Document, Document Info Edit Modal |

For example, the first entry becomes:

```ts
  {
    version: "1.10.0",
    title: "Command Palette",
    description: "Press Ctrl/Cmd+Shift+P (or use Help > Command Palette) to search and run any command, or jump straight to any open document by name.",
    screenshot: "/whats-new/command-palette.png",
    category: "Editing & Formatting",
  },
```

Apply the same pattern (add `category: "..."` as the last field) to all 27 entries using the table above — every title in the file must get exactly one category from the table.

- [ ] **Step 4: Fix the existing `missedEntries` test fixtures**

In `tests/client/src/whats-new.test.ts`, the `missedEntries` describe block (around line 24) builds its own fixture array — add a `category` to each of its 3 objects since the type now requires it:

```ts
  const entries: WhatsNewEntry[] = [
    { version: "1.10.0", title: "A", description: "a", screenshot: "/a.png", category: "Editing & Formatting" },
    { version: "1.11.0", title: "B", description: "b", screenshot: "/b.png", category: "Editing & Formatting" },
    { version: "1.12.0", title: "C", description: "c", screenshot: "/c.png", category: "Editing & Formatting" },
  ];
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `npx vitest run --project=unit tests/client/src/whats-new-entries.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no errors about a missing `category` property anywhere.

- [ ] **Step 7: Commit**

```bash
git add client/src/whats-new-entries.ts tests/client/src/whats-new-entries.test.ts tests/client/src/whats-new.test.ts
git commit -m "feat: add category field to What's New entries"
```

---

### Task 2: `groupByCategory` pure function

**Files:**
- Modify: `client/src/whats-new.ts`
- Modify: `tests/client/src/whats-new.test.ts`

**Interfaces:**
- Consumes: `WhatsNewEntry`, `WhatsNewCategory` (from Task 1, `client/src/whats-new-entries.ts`).
- Produces: `export interface WhatsNewCategoryGroup { category: WhatsNewCategory; entries: WhatsNewEntry[] }` and `export function groupByCategory(all: WhatsNewEntry[]): WhatsNewCategoryGroup[]`, both from `client/src/whats-new.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/client/src/whats-new.test.ts` (add `groupByCategory` to the existing `import { compareVersions, missedEntries } from "../../../client/src/whats-new";` line):

```ts
describe("groupByCategory", () => {
  const entries: WhatsNewEntry[] = [
    { version: "1.0.0", title: "A", description: "a", screenshot: "/a.png", category: "Editing & Formatting" },
    { version: "1.1.0", title: "B", description: "b", screenshot: "/b.png", category: "Collaboration" },
    { version: "1.2.0", title: "C", description: "c", screenshot: "/c.png", category: "Editing & Formatting" },
    { version: "1.3.0", title: "D", description: "d", screenshot: "/d.png", category: "Collaboration" },
  ];

  it("groups entries by category, ordered by each category's first appearance", () => {
    const groups = groupByCategory(entries);
    expect(groups.map((g) => g.category)).toEqual(["Editing & Formatting", "Collaboration"]);
  });

  it("orders entries within each category newest-first", () => {
    const groups = groupByCategory(entries);
    expect(groups[0]!.entries.map((e) => e.title)).toEqual(["C", "A"]);
    expect(groups[1]!.entries.map((e) => e.title)).toEqual(["D", "B"]);
  });

  it("returns an empty array for no entries", () => {
    expect(groupByCategory([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project=unit tests/client/src/whats-new.test.ts`
Expected: FAIL with "groupByCategory is not a function" (or a TS error to that effect).

- [ ] **Step 3: Implement `groupByCategory`**

In `client/src/whats-new.ts`, add (alongside the existing `compareVersions`/`missedEntries`, update the top import to include `WhatsNewCategory`):

```ts
import type { WhatsNewEntry, WhatsNewCategory } from "./whats-new-entries";

export interface WhatsNewCategoryGroup {
  category: WhatsNewCategory;
  entries: WhatsNewEntry[]; // newest-first within the category
}

// Groups by category in the order each category first appears in `all`
// (i.e. the order its oldest entry shipped) — `all` itself is oldest-
// first, so a plain forward pass naturally builds each category's own
// list oldest-first too; reversed at the end for newest-first browsing
// (a topic's latest change first, unlike the auto-open catch-up flow
// which stays oldest-first by nature of "here's what you missed, in
// order").
export function groupByCategory(all: WhatsNewEntry[]): WhatsNewCategoryGroup[] {
  const order: WhatsNewCategory[] = [];
  const byCategory = new Map<WhatsNewCategory, WhatsNewEntry[]>();
  for (const entry of all) {
    if (!byCategory.has(entry.category)) {
      byCategory.set(entry.category, []);
      order.push(entry.category);
    }
    byCategory.get(entry.category)!.push(entry);
  }
  return order.map((category) => ({
    category,
    entries: [...byCategory.get(category)!].reverse(),
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project=unit tests/client/src/whats-new.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/whats-new.ts tests/client/src/whats-new.test.ts
git commit -m "feat: add groupByCategory helper for What's New"
```

---

### Task 3: `WhatsNew.svelte` — category index, scoped stepper, navigation, styling

**Files:**
- Modify: `client/src/components/WhatsNew.svelte`
- Modify: `client/src/styles/_modals.scss` (new rules near the existing `.whats-new-*` block, around line 158)
- Create: `tests/client/src/components/WhatsNew.test.ts`

**Interfaces:**
- Consumes: `groupByCategory`, `WhatsNewCategoryGroup` (Task 2, `../whats-new`), `WhatsNewCategory` (Task 1, `../whats-new-entries`), existing `whatsNewOpen` store.
- Produces: no new exports — this is the final integration point of the feature.

- [ ] **Step 1: Write the failing component tests**

Create `tests/client/src/components/WhatsNew.test.ts`. This mounts the real component in a browser (per this repo's `components` Vitest project) and drives it exactly like a user would — set `localStorage` before render to control the auto-open/missed-entries computation (done at module-script-eval time, before `onMount`), then flip `whatsNewOpen` to simulate the Help menu's manual reopen (its *second* transition to `true`, since the first — synchronous, on `subscribe()` — is the initial/auto-open case per the component's own `sawInitialValue` guard).

```ts
import { test, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import WhatsNew from "../../../../client/src/components/WhatsNew.svelte";
import { whatsNewOpen } from "../../../../client/src/stores/whatsNew";

const STORAGE_KEY = "mde:whatsNewSeen";

beforeEach(() => {
  // Already caught up — the auto-open flow never fires, isolating these
  // tests to the manual-reopen path this task is actually changing.
  localStorage.setItem(STORAGE_KEY, __APP_VERSION__);
  whatsNewOpen.set(false);
});

function openManually() {
  whatsNewOpen.set(true);
}

test("manual reopen shows the category index, not a slide", async () => {
  const screen = await render(WhatsNew);
  openManually();
  await expect.element(screen.getByText("Editing & Formatting")).toBeVisible();
  await expect.element(screen.getByText("Collaboration")).toBeVisible();
  await expect.element(screen.getByText("Version History")).toBeVisible();
  await expect.element(screen.getByText("GitHub Integration")).toBeVisible();
  await expect.element(screen.getByText("Organization & Navigation")).toBeVisible();
});

test("clicking a category enters its stepper at the newest entry, newest-first", async () => {
  const screen = await render(WhatsNew);
  openManually();
  await screen.getByText("GitHub Integration").click();
  // Newest of the 3 GitHub Integration entries by version (1.34.0).
  await expect.element(screen.getByText("Choose Gist Visibility")).toBeVisible();
  await expect.element(screen.getByText("1 of 3")).toBeVisible();
});

test("the last slide's button reads Done, and it returns to the index", async () => {
  const screen = await render(WhatsNew);
  openManually();
  await screen.getByText("GitHub Integration").click();
  await screen.getByRole("button", { name: "Next →" }).click();
  await screen.getByRole("button", { name: "Next →" }).click();
  await expect.element(screen.getByText("3 of 3")).toBeVisible();
  await screen.getByRole("button", { name: "Done" }).click();
  await expect.element(screen.getByText("GitHub Integration")).toBeVisible();
  await expect.element(screen.getByText("Choose Gist Visibility")).not.toBeInTheDocument();
});

test("the Categories back-link returns to the index without finishing the stepper", async () => {
  const screen = await render(WhatsNew);
  openManually();
  await screen.getByText("GitHub Integration").click();
  await screen.getByText("Categories").click();
  await expect.element(screen.getByText("Editing & Formatting")).toBeVisible();
});

test("the auto-open (missed entries) flow never shows the category index", async () => {
  localStorage.setItem(STORAGE_KEY, "1.10.0"); // far behind — several entries missed
  const screen = await render(WhatsNew);
  // Auto-opens on its own; no manual whatsNewOpen.set(true) needed.
  await expect.element(screen.getByRole("button", { name: "Next →" })).toBeVisible();
  await expect.element(screen.getByText("Editing & Formatting")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project=components tests/client/src/components/WhatsNew.test.ts`
Expected: FAIL — the category index doesn't exist yet; the component still jumps straight into the flat 27-entry stepper on manual reopen.

- [ ] **Step 3: Implement the component changes**

Replace the `<script>` block of `client/src/components/WhatsNew.svelte` with:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { whatsNewOpen } from "../stores/whatsNew";
  import { WHATS_NEW_ENTRIES } from "../whats-new-entries";
  import type { WhatsNewCategory } from "../whats-new-entries";
  import { missedEntries, groupByCategory } from "../whats-new";

  const STORAGE_KEY = "mde:whatsNewSeen";
  const CURRENT_VERSION = __APP_VERSION__;

  if (import.meta.env.DEV && WHATS_NEW_ENTRIES.at(-1)?.version !== CURRENT_VERSION) {
    console.warn(
      `WhatsNew: no announcement entry for the current version (${CURRENT_VERSION}) — add one to whats-new-entries.ts.`,
    );
  }

  const missed = missedEntries(WHATS_NEW_ENTRIES, localStorage.getItem(STORAGE_KEY));
  // Only meaningful once `showAll` is true (the manual-reopen path) —
  // null means "show the category index"; a category means "show that
  // category's own stepper." The auto-open path never sets or reads this.
  let showAll = $state(false);
  let categoryView = $state<WhatsNewCategory | null>(null);
  const categoryGroups = $derived(groupByCategory(WHATS_NEW_ENTRIES));
  const slides = $derived(
    !showAll ? missed : categoryView !== null ? (categoryGroups.find((g) => g.category === categoryView)?.entries ?? []) : [],
  );
  let slideIndex = $state(0);
  const isLast = $derived(slideIndex >= slides.length - 1);
  const inCategoryStepper = $derived(showAll && categoryView !== null);
  const doneLabel = $derived(inCategoryStepper ? "Done" : "Got it");

  function dismiss() {
    whatsNewOpen.set(false);
    localStorage.setItem(STORAGE_KEY, CURRENT_VERSION);
  }
  function backToCategories() {
    categoryView = null;
  }
  function next() {
    if (isLast) {
      if (inCategoryStepper) {
        backToCategories();
      } else {
        dismiss();
      }
      return;
    }
    slideIndex += 1;
  }
  function prev() {
    if (slideIndex > 0) slideIndex -= 1;
  }
  function openCategory(category: WhatsNewCategory) {
    categoryView = category;
    slideIndex = 0;
  }

  onMount(() => {
    if (missed.length > 0) whatsNewOpen.set(true);
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $whatsNewOpen) dismiss();
    };
    document.addEventListener("keydown", onKeydown);
    // MenuBar.svelte's Help > What's New button has no dedicated
    // element/id to listen for a click on (unlike the topbar icon
    // buttons other panels wire up) — it just flips whatsNewOpen true
    // directly. Subscribing here lets this component tell that apart
    // from its own auto-open above: subscribe() always replays the
    // current value synchronously as its first callback, so that first
    // call is the auto-open case (or the initial `false`) and is
    // ignored; every later transition to true is a real, later trigger
    // — i.e. the Help menu — and should show the category index.
    let sawInitialValue = false;
    const unsubscribe = whatsNewOpen.subscribe((open) => {
      if (!sawInitialValue) {
        sawInitialValue = true;
        return;
      }
      if (open) {
        showAll = true;
        categoryView = null;
        slideIndex = 0;
      }
    });
    return () => {
      document.removeEventListener("keydown", onKeydown);
      unsubscribe();
    };
  });
</script>
```

Replace the template (everything from `{#if $whatsNewOpen && slides[slideIndex]}` onward) with:

```svelte
{#if $whatsNewOpen}
  <Modal title="What's new" icon="icon-rocket" maxWidth="680px" labelledBy="whatsNewTitle" onClose={dismiss}>
    {#snippet quickAction()}
      {#if inCategoryStepper}
        <button type="button" class="whats-new-back-link" onclick={backToCategories}>
          <svg class="icon"><use href="#icon-chevron-left"></use></svg> Categories
        </button>
      {/if}
    {/snippet}
    {#if showAll && categoryView === null}
      <div class="whats-new-category-list">
        {#each categoryGroups as group (group.category)}
          <button type="button" class="whats-new-category-row" onclick={() => openCategory(group.category)}>
            <span>{group.category}</span>
            <span class="whats-new-category-count">{group.entries.length}</span>
            <svg class="icon"><use href="#icon-chevron-right"></use></svg>
          </button>
        {/each}
      </div>
    {:else if slides[slideIndex]}
      <div class="whats-new-slide">
        <img class="whats-new-screenshot" src={slides[slideIndex].screenshot} alt={slides[slideIndex].title} />
        <div class="whats-new-text">
          <div class="menu-section-label">{slides[slideIndex].title}</div>
          <p class="hint-text">{slides[slideIndex].description}</p>
        </div>
      </div>
    {/if}
    {#snippet footer()}
      {#if showAll && categoryView === null}
        <!-- Index has no footer controls — Modal's own X (or Escape) closes it. -->
      {:else if slides.length > 1}
        <div class="whats-new-nav">
          <button type="button" class="secondary-btn" disabled={slideIndex === 0} onclick={prev}>← Back</button>
          <span class="whats-new-counter">{slideIndex + 1} of {slides.length}</span>
          <button type="button" class="primary-btn" onclick={next}>{isLast ? doneLabel : "Next →"}</button>
        </div>
      {:else}
        <button class="primary-btn" type="button" onclick={next}>{doneLabel}</button>
      {/if}
    {/snippet}
  </Modal>
{/if}
```

(Note the last `else` branch's button now calls `next()`, not `dismiss()` directly — for a single-entry category this correctly routes through `next()`'s own `isLast` handling, which calls `backToCategories()` for a category stepper or `dismiss()` for the auto-open case with exactly one missed entry, same as before.)

Add to `client/src/styles/_modals.scss`, right after the existing `.whats-new-counter` rule (around line 161):

```scss
.whats-new-category-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.whats-new-category-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;

  span:first-child {
    flex: 1;
  }

  &:hover {
    background: var(--bg-alt);
  }

  .icon {
    flex-shrink: 0;
    color: var(--text-dim);
  }
}
.whats-new-category-count {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
  flex-shrink: 0;
}
.whats-new-back-link {
  display: flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;

  &:hover {
    color: var(--text);
  }

  .icon {
    width: 14px;
    height: 14px;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project=components tests/client/src/components/WhatsNew.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full unit + component suite**

Run: `npx vitest run`
Expected: PASS (all files, including Tasks 1-2's tests and every pre-existing test)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add client/src/components/WhatsNew.svelte client/src/styles/_modals.scss tests/client/src/components/WhatsNew.test.ts
git commit -m "feat: categorized index for the manual What's New reopen"
```

---

### Task 4: Playwright e2e coverage

**Files:**
- Create: `tests/e2e/local/whats-new.spec.ts`

**Interfaces:**
- Consumes: `test`/`expect` from `./support/fixtures` (existing helper — pre-seeds `mde:whatsNewSeen` to `999.999.999`, so the auto-open flow never fires and every test here starts clean on the manual-reopen path).

- [ ] **Step 1: Write the e2e test**

```ts
// tests/e2e/local/whats-new.spec.ts
import { test, expect } from "./support/fixtures";

test("Help menu > What's New shows a category index; picking one steps through it, Done returns to the index", async ({ page }) => {
  await page.click("#helpMenuBtn");
  await page.click('button:has-text("What\'s New")');

  await expect(page.locator("text=Editing & Formatting")).toBeVisible();
  await expect(page.locator("text=GitHub Integration")).toBeVisible();

  await page.click("text=GitHub Integration");
  await expect(page.locator("text=Choose Gist Visibility")).toBeVisible();
  await expect(page.locator("text=1 of 3")).toBeVisible();

  await page.click('button:has-text("Next →")');
  await page.click('button:has-text("Next →")');
  await expect(page.locator("text=3 of 3")).toBeVisible();
  await page.click('button:has-text("Done")');

  await expect(page.locator("text=GitHub Integration")).toBeVisible();
  await expect(page.locator("text=Choose Gist Visibility")).not.toBeVisible();

  await page.click("text=Version History");
  await page.click('button:has-text("Categories")');
  await expect(page.locator("text=Editing & Formatting")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("text=Editing & Formatting")).not.toBeVisible();
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:e2e:local -- whats-new`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/local/whats-new.spec.ts
git commit -m "test: e2e coverage for the What's New category index"
```

---

### Task 5: Version bump, CHANGELOG, and this feature's own What's New entry

**Files:**
- Modify: `package.json`, `package-lock.json` (both `"version"` fields, per `CLAUDE.md` — hand-edit rather than a full `npm install --package-lock-only` regeneration)
- Modify: `CHANGELOG.md`
- Modify: `client/src/whats-new-entries.ts` (append the 28th entry)
- Create: `client/public/whats-new/categorized-whats-new.png` (screenshot, via a new one-off script mirroring `tests/scripts/manual-testing/capture-suggestion-mode-screenshot.mjs`'s pattern)
- Create: `tests/scripts/manual-testing/capture-whats-new-categories-screenshot.mjs`

**Interfaces:**
- None — this task only touches data/metadata files, no new functions or types.

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "1.39.1"` to `"version": "1.40.0"`.
In `package-lock.json`, change both `"version": "1.39.1"` occurrences (the top-level one and the one inside `"packages": { "": { ... } }`) to `"1.40.0"`.

- [ ] **Step 2: Add the CHANGELOG entry**

At the top of `CHANGELOG.md`, above the existing `## [1.39.1] - 2026-08-31` section, add:

```markdown
## [1.40.0] - 2026-09-01

### Added

- **Categorized What's New.** Reopening What's New from the Help menu now starts at a category index instead of a 27-entry stepper beginning at the very first release. Pick a category to step through just its updates; "Done" returns to the index instead of closing the whole modal. The automatic popup for missed updates on load is unchanged.

```

- [ ] **Step 3: Write the screenshot-capture script**

Create `tests/scripts/manual-testing/capture-whats-new-categories-screenshot.mjs` — this feature is purely local-client (no Worker/collab dependency), so it drives the plain Vite dev server directly instead of `wrangler dev`:

```js
// One-off script to capture the What's New screenshot for this very
// feature (client/public/whats-new/categorized-whats-new.png). Not part
// of the test suite — run manually against `npm run dev:client` (plain
// Vite dev server; this feature has no Worker/collab dependency).
import { chromium } from "playwright";

const BASE = "http://localhost:5275";
const OUT = "client/public/whats-new/categorized-whats-new.png";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 900, height: 620 } });

await page.goto(BASE);
await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
// Already caught-up, so no auto-open fires before we manually trigger it.
await page.evaluate(() => localStorage.setItem("mde:whatsNewSeen", __APP_VERSION__));
await page.click("#helpMenuBtn");
await page.click('button:has-text("What\'s New")');
await page.waitForSelector("text=Editing & Formatting");

await page.screenshot({ path: OUT });
console.log(`Saved ${OUT}`);
await browser.close();
```

Run it (with `npm run dev:client` already running in another terminal, or backgrounded):

```bash
(npm run dev:client > /tmp/vite-dev.log 2>&1 &)
sleep 3
node tests/scripts/manual-testing/capture-whats-new-categories-screenshot.mjs
```

- [ ] **Step 4: Verify the screenshot**

Read the saved PNG (`client/public/whats-new/categorized-whats-new.png`) and confirm it shows the category index (five rows: Editing & Formatting, Version History, Collaboration, Organization & Navigation, GitHub Integration, each with a count) rather than an error page or a blank modal. Stop the dev server afterward.

- [ ] **Step 5: Add this feature's own What's New entry**

Append to `WHATS_NEW_ENTRIES` in `client/src/whats-new-entries.ts` (after the "Suggestion-Mode Collaboration" entry):

```ts
  {
    version: "1.40.0",
    title: "Categorized What's New",
    description:
      "Reopening What's New from the Help menu now starts at a category index instead of a 27-entry stepper from the very first release — pick a topic to step through just its updates, with a Done button that returns you to the index instead of closing the whole thing.",
    screenshot: "/whats-new/categorized-whats-new.png",
    category: "Editing & Formatting",
  },
```

- [ ] **Step 6: Run the full unit + component suite**

Run: `npx vitest run`
Expected: PASS (the new entry doesn't break `WHATS_NEW_ENTRIES categories` from Task 1, since "Editing & Formatting" is already a known category)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts client/public/whats-new/categorized-whats-new.png tests/scripts/manual-testing/capture-whats-new-categories-screenshot.mjs
git commit -m "chore: version bump and changelog for What's New categories"
```

---

### Task 6: Final verification

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS, every project (`unit` and `components`)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Format check**

Run: `npm run format:check`
Expected: PASS. If it fails, run `npm run format` and re-check.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS, no errors

- [ ] **Step 5: Local e2e suite**

Run: `npm run test:e2e:local`
Expected: PASS, including Task 4's new spec

- [ ] **Step 6: Manual smoke test**

With the app running, confirm live in a real browser:
- A device with no `mde:whatsNewSeen` at all still sees the plain single-entry auto-open popup on load (no category index).
- Help > What's New opens the category index; each category's count matches the number of entries actually in `WHATS_NEW_ENTRIES` for that category.
- Picking a category enters its stepper at the newest entry; "Done" on the last one returns to the index; the "← Categories" link returns immediately from any slide; Escape and the X button both fully close the modal from either screen.
