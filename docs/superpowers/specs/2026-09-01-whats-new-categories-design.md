# What's New Categories — Design Spec

## Goal

Fix the manual "What's New" reopen (Help menu, or any device that's already
caught up) so it stops dropping the user into a 26-entry stepper starting at
the oldest release. Replace it with a category index the user picks from,
each category opening the existing stepper scoped to just that topic's
entries.

## Non-goals / deferred scope

- The **auto-open** flow (the popup that appears on load when the app has
  entries newer than the device's last-seen version) is unchanged — it
  still jumps straight into the plain stepper over just the missed entries,
  no category index. That flow is normally 1-2 entries; categorizing it
  adds nothing and would make a routine update notice heavier.
- No search/filter within the category index — 5 categories is small enough
  to scan directly.
- No persistence of "last category viewed" — every manual reopen starts at
  the index.
- No change to entry content itself (title/description/screenshot) or to
  the `missedEntries`/version-comparison logic in `whats-new.ts`.

## Data model

`WhatsNewEntry` (in `client/src/whats-new-entries.ts`) gains one required
field:

```ts
export interface WhatsNewEntry {
  version: string;
  title: string;
  description: string;
  screenshot: string;
  category: WhatsNewCategory;
}

export type WhatsNewCategory = "Editing & Formatting" | "Collaboration" | "Version History" | "GitHub Integration" | "Organization & Navigation";
```

Every existing entry gets a `category` value assigned per this taxonomy
(counts as of the 27 entries that exist today):

| Category | Entries |
|---|---|
| Editing & Formatting (10) | Command Palette, Slash Commands, Search and Replace, Toolbar Undo/Redo & Command Palette, Format and Insert Menus, Insert Existing Image & Replace, Printing Support, MultiMarkdown Syntax Support, Markdown Compatibility Checker, Citations & Bibliography |
| Collaboration (5) | Threaded Comments, Unresolved-Comment Badge, Workspace-Level Sharing, Suggestion-Mode Collaboration, Shared Document Names Sync |
| Version History (5) | Version History, Version History Meets Repo Commits, GitHub-Style Diffs, Portable Local History, Smart Version History Grouping |
| GitHub Integration (3) | GitHub Repo Sync, Open GitHub Repo as Workspace, Choose Gist Visibility |
| Organization & Navigation (4) | Wikilinks, Workspaces, A URL for Every Document, Document Info Edit Modal |

The category list itself is never hardcoded anywhere else — it's always
derived from whatever categories actually appear in `WHATS_NEW_ENTRIES`, so
a new entry just declares its `category` and either joins an existing group
or introduces a new one with no other code change.

`WhatsNewCategory` is a closed union (not a bare `string`) so a future
entry with a typo'd or new category name is a compile error until the union
is deliberately extended — matches this file's existing "every field
required, no optional laxity" style.

## New pure logic (`whats-new.ts`)

```ts
export interface WhatsNewCategoryGroup {
  category: WhatsNewCategory;
  entries: WhatsNewEntry[]; // newest-first within the category
}

// Groups by category in the order each category first appears in `all`
// (i.e. the order its oldest entry shipped), entries within each group
// newest-first (reverse chronological — browsing a topic, you want its
// latest change first, unlike the auto-open catch-up flow which is
// oldest-first by nature of "here's what you missed, in order").
export function groupByCategory(all: WhatsNewEntry[]): WhatsNewCategoryGroup[]
```

Pure function, unit-testable in isolation exactly like the existing
`compareVersions`/`missedEntries` in the same file — no component,
Svelte, or DOM involved.

## Component behavior (`WhatsNew.svelte`)

Today's component already distinguishes two triggers via `showAll`:
auto-open (`showAll = false`, shows `missed` directly) and manual reopen
(`showAll = true`, shows all entries — this is the path being redesigned).

New local state, meaningful only when `showAll` is true:

```ts
let categoryView = $state<WhatsNewCategory | null>(null); // null = showing the index
```

- Manual reopen sets `showAll = true` (as today) and additionally resets
  `categoryView = null` — landing on the index, not the stepper.
- The index renders one row per `groupByCategory(WHATS_NEW_ENTRIES)` group:
  category name + entry count (e.g. "Editing & Formatting (10)"). Clicking
  a row sets `categoryView` to that category and `slideIndex = 0`.
- While `categoryView` is set, `slides` (today's `$derived`) becomes that
  category's `entries` array instead of the full flat list — the existing
  stepper markup, `next()`/`prev()`, and slide counter are otherwise
  unchanged, just fed a smaller, scoped array.
- The stepper's final button reads "Done" (not "Got it") whenever
  `categoryView !== null`, and clicking it sets `categoryView = null`
  (back to the index) instead of calling `dismiss()`. A dedicated
  "← Categories" link/button in the stepper's header does the same at any
  point, not just on the last slide.
- The modal's own close (X icon) and Escape still call `dismiss()`
  unconditionally, from either the index or the stepper, closing the whole
  modal regardless of `categoryView`.
- The auto-open path (`showAll === false`) never touches `categoryView` and
  its rendering branch is untouched — same plain stepper, same "Got it"
  wording, same behavior as today.

## Testing

- `tests/client/src/whats-new.test.ts`: unit tests for `groupByCategory` —
  grouping, per-category ordering (newest-first), and group ordering
  (first-appearance/oldest-shipped-first).
- `tests/client/src/components/whats-new.test.ts` (new, routes to the
  `components` Vitest project per this repo's naming convention): mounts
  the real `WhatsNew.svelte`, opens it via the manual-reopen trigger,
  asserts the index renders, clicking a category enters its stepper,
  "Done" returns to the index, and closing via Escape works from both
  screens. A separate case confirms the auto-open trigger (`missed`
  entries) never shows the index at all.
- `tests/e2e/local/`: extend or add a spec exercising the Help menu → What's
  New → pick a category → step through → Done → back at index → close,
  against the real built app (matches this repo's e2e convention of
  covering user-facing flows end-to-end).

## Versioning

User-facing UI change → minor version bump, with its own What's New entry
(category: Editing & Formatting, since it's an editor-chrome change) —
per this repo's own versioning convention in `CLAUDE.md`.
