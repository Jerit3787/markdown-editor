# Search & Replace — Design Spec

**IMPROVEMENTS.md Phase 2 item.** The editor has no in-document search today — finding or replacing text in a long document means scrolling by eye or falling back to the browser's own Ctrl/Cmd+F, which can't see into CodeMirror's virtualized content and can't replace anything.

## Goal

Ctrl/Cmd+F opens a find bar over the active document; Ctrl/Cmd+H (or expanding the same bar) adds a replace row. Full CM6-parity feature set: live match count, case-sensitive/whole-word/regex toggles, next/previous navigation, Replace and Replace All.

## Non-goals (deferred)

- **No cross-document search.** Operates on the currently-open document's content only — searching across a whole workspace is a much bigger feature (would need its own index/results-list UI) and isn't what this item asks for. Command Palette's existing document-name fuzzy search is a separate, already-shipped feature.
- **No persistence of the last search query** across closing/reopening the bar or switching documents — always starts blank, matching Command Palette's own "always opens fresh" precedent.
- **No "search history" dropdown.**

## Reusing `@codemirror/search`

`@codemirror/search` (`^6.7.1`) has been a direct `package.json` dependency since early in the project's history but has zero import sites anywhere in `client/src` — it was never actually wired up. It provides everything the matching/replacing itself needs:

- `search()` — installs the query state field (needed by everything below) plus its own built-in match highlighter and panel-CSS `baseTheme`. No keymap bindings — those are opt-in via `searchKeymap`, which this spec deliberately does not use.
- `SearchQuery` — constructed from `{ search, replace, caseSensitive, regexp, wholeWord }`; `setSearchQuery(view, query)` (a `StateEffect`) pushes a new query into the state field.
- `findNext(view)` / `findPrevious(view)` — move the selection to the next/previous match, dispatched against the current query.
- `replaceNext(view)` / `replaceAll(view)` — replace the current (or every) match with the query's `replace` string.
- `getSearchQuery(state)` — reads the currently-active query back out, used to keep the bar's own local state and the editor's own match-highlight field (see below) in sync.

The matching/replacing/query-management logic above needs no reimplementing. What *does* need a small amount of original code: `search()`'s own built-in highlighter turns out to only paint anything while its default panel is open (see "Highlighting matches is not automatic" below) — a `@codemirror/search` implementation detail, not something documented as configurable — so `client/src/search.ts` adds one small `StateField` of its own for that. Everything else is UI chrome: CM6's own default search panel is plain, unstyled-to-this-app markup, and reskinning it via CSS overrides would fight its DOM structure more than building a small custom Svelte component against the same underlying functions.

## Components

### `client/src/search.ts` (new)

Pure, DOM-free logic, importable by both `Editor.svelte` and tests:

```ts
export function buildSearchExtension(): Extension; // search() + our own match-highlight StateField
export function countMatches(state: EditorState, query: SearchQuery): { total: number; index: number };
```

`countMatches` iterates `query.getCursor(state.doc)` (a `SearchCursor`) to completion once, counting matches and noting which one is at or after the current selection head, wrapping to the first match otherwise (matching `findNext`'s own wrap-around) — this is what drives the bar's "3 of 12" indicator. `index` is `0` when `total` is `0`.

**Highlighting matches is not automatic.** `@codemirror/search`'s own built-in highlighter only ever paints decorations when its *default search panel* is open (its `highlight()` method literally checks `if (!panel || !query.spec.valid) return Decoration.none`) — since this design deliberately never calls `openSearchPanel`, that highlighter always no-ops. `buildSearchExtension()` therefore also installs a small `StateField<DecorationSet>` (same pattern `Editor.svelte`'s existing `imageMarkerField`/`commentMarkerField`/`focusDimField` already use) that recomputes highlight ranges itself off `getSearchQuery(state)` whenever the doc, the selection, or the query changes. It reuses `@codemirror/search`'s own `cm-searchMatch`/`cm-searchMatch-selected` class names — already styled (light and dark) by that package's bundled `baseTheme`, which `search()` includes regardless — so no new CSS is needed; a match under the live selection (the one `findNext`/`findPrevious` just moved to) gets `cm-searchMatch-selected`, every other match gets plain `cm-searchMatch`, identical to how CM6's own panel-driven highlighting would have told them apart. `findNext`/`findPrevious`/`replaceNext`/`replaceAll` themselves are unaffected by any of this — they read/write `searchState` directly and only fall back to `openSearchPanel` when no valid query exists yet at all, which never happens here since the bar always sets one first.

### `client/src/stores/findReplace.ts` (new)

```ts
export type FindBarMode = "find" | "replace";
export const findBarOpen = writable<boolean>(false);
export const findBarMode = writable<FindBarMode>("find");
export function openFindBar(mode: FindBarMode): void;
export function closeFindBar(): void;
```

`findBarOpen`/`findBarMode` are the same shape as `stores/diagramEditor.ts`/`stores/commentsPanel.ts` — a plain boolean-gated overlay. `openFindBar`/`closeFindBar` centralize the one piece of real logic (switching out of Preview-only view mode, see below) so both the editor keymap and the Edit-menu entries call the same function instead of duplicating it.

### `client/src/components/FindReplaceBar.svelte` (new)

Renders when `$findBarOpen`. Reads the live `EditorView` via the existing `window.MDE.getEditor()` bridge call (already used elsewhere, e.g. `app.ts`'s `getResolvedContent()`) — no new bridge method needed since this component only ever needs the view at the moment a button is clicked, not a live-updating reference.

Layout: a bar docked to the top of the editor pane (absolute-positioned overlay, same layering approach as `SlashMenu.svelte`/`WikilinkMenu.svelte`, not a `Modal`-style centered dialog — this is a persistent tool bar you interact with while still seeing/editing the document, not a one-off dialog).

- **Find row** (always visible when open): text input, prev/next chevron buttons, live "n of m" count (from `countMatches`), case-sensitivity toggle (`Aa`), whole-word toggle, regex toggle (`.*`), a chevron to expand/collapse the replace row, close (`×`) button.
- **Replace row** (visible when `$findBarMode === "replace"` or the user expands it manually): text input, "Replace" button, "Replace All" button.
- Every input keystroke rebuilds the `SearchQuery` and dispatches `setSearchQuery(view, query)`, then recomputes the match count — this is what keeps the in-editor highlight and the bar's own count synchronized, both driven off the same `SearchQuery`.
- Replace/Replace All are `disabled` when `view.state.readOnly` — matches how the rest of the editor already goes fully read-only for a viewer/reviewer role in a shared document (see `collab.ts`'s `setReadOnly`) rather than letting an edit attempt silently no-op.
- An invalid regex (when the regex toggle is on) is caught via `SearchQuery`'s own `.valid` flag — `countMatches` returns `{ total: 0, index: 0 }` for an invalid query without attempting to run it, and the find input gets a new `.invalid` class (a red outline — no existing precedent for this in the codebase, so this is new, self-contained styling scoped to just this input). Prev/next/Replace/Replace All are all disabled while the query is invalid.
- Escape closes the bar (calls `closeFindBar()`) and returns focus to the editor.

## Wiring into existing files

- **`Editor.svelte`**: `buildSearchExtension()` added to the base extension list (same list `history()`/`syntaxHighlighting()` already live in — not a compartment, since search state doesn't need to be swapped out like read-only/editing-mode do). A new keymap entry: `Mod-f` → `openFindBar("find")`, `Mod-h` → `openFindBar("replace")`, both `preventDefault` (so they don't fall through to the browser's own find-in-page). Renders `<FindReplaceBar />` inside the editor pane's container.
- **`stores/findReplace.ts`**: `openFindBar(mode)` sets `findBarMode`, sets `findBarOpen` to `true`, and — if `get(viewMode) === "preview"` — calls `setView("split")` first, so the bar and its highlights are actually visible instead of opening behind a hidden editor pane. `closeFindBar()` just sets `findBarOpen` to `false`.
- **`MenuBar.svelte`**: two new Edit-menu entries, "Find..." (`Ctrl/Cmd+F`) and "Find and Replace..." (`Ctrl/Cmd+H`), calling `openFindBar("find")`/`openFindBar("replace")` (same `act(() => ...)` wrapper pattern the rest of the Edit menu already uses) — no `window.MDE` involvement needed here either.
- **`ShortcutsModal.svelte`**: two new rows appended to `SHORTCUTS`.

## Testing

- `tests/client/src/search.test.ts` (new): `countMatches` against a plain `EditorState` (no `EditorView`/DOM needed) — zero matches, several matches with the selection head inside/before/after various ones, case-sensitivity and regex queries.
- `tests/client/src/components/FindReplaceBar.test.ts` (new): real component tests via `vitest-browser-svelte` (a real headless Chromium, see `vitest.config.ts`'s `components` project — set up as its own preparatory piece of work, not specific to this feature) — toggling case/whole-word/regex updates the query and match count, the replace row only appears in replace mode, Replace/Replace All are disabled on a read-only view, an invalid regex disables navigation and shows the `.invalid` state, Escape closes the bar.
- A new Playwright test in `tests/e2e/local` (this suite already covers exactly this class of client-only interaction — formatting, export, focus mode): open the bar via keyboard shortcut, type a query, assert the match count and at least one visible highlight, replace one occurrence, Replace All the rest, assert final document content. This is real end-to-end coverage (a full page, real document, real keyboard shortcut) — narrower than the component tests above, which exercise `FindReplaceBar.svelte`'s own logic in isolation.
