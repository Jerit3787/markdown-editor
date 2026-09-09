# Annotation rail + shared card (SP-A) — design

**Status:** approved approach (brainstorm 2026-09-09), design under review
**Part of:** the suggesting-mode redesign (ROADMAP → Active → "Group D"). Group D
decomposes into SP-A (this spec — D1 + the visual half of D5), SP-B (unified
annotation model in the Y.Doc — D3 + the data-path half of D5), SP-C (granularity
— D4). D2 shipped standalone in v1.60.4.
**Predecessor:** `docs/superpowers/specs/2026-08-31-suggestion-mode-collaboration-design.md`
(the original suggesting-mode model, shipped v1.50.0).
**Ships as:** a minor release (`1.61.0`) — visible change: `CHANGELOG.md`
`### Changed`, a `whats-new-entries.ts` entry, a real screenshot.

## Goal

Move suggestion cards out of the editor's text flow and into a right-margin rail,
vertically aligned to the line they annotate, rendered by the same card component
that renders comment cards. One `AnnotationRail` replaces the flat
`CommentsPanel` list; it shows both comments and suggestions as position-anchored
cards when the editor is visible, and as a plain chronological list otherwise.

This is a **rendering** change. It does not alter how suggestions or comments are
stored, synced, or resolved.

## Why

Suggestion cards today are an inline CodeMirror `WidgetType` (`side: 1`, at the
end of each suggested range). Rendered in the text flow they wrap awkwardly, push
the surrounding text around, and collide with each other on a busy line — the D1
complaint ("cramped/broken"). Comments, meanwhile, live in a separate 320px panel
as an unordered list with no spatial connection to the text. Google Docs puts
both in one margin rail, aligned to their anchor, as one card type — that is the
target. Getting the rail and the shared card in place first (with storage
untouched) de-risks the harder SP-B model unification.

## Non-goals / deferred

- **Storage unification.** Suggestions stay in the document `Y.Map<SuggestionEntry>`;
  shared-doc comments stay in `WorkspaceRoom` DO storage; local-doc comments stay
  as `stores/docs.ts` notes. SP-B does this. _Done in SP-B (v1.62.0): shared-doc
  comments moved to a `comments` Y.Map on the doc; local-doc notes unchanged —
  see `docs/superpowers/specs/2026-09-10-annotation-model-unification-design.md`._
- **Reply threads on suggestions (D3).** A suggestion card in SP-A has no reply
  input — only accept / reject / withdraw. SP-B adds threads. _Done in SP-B
  (v1.62.0)._
- **Split accept/reject of a replace (D4).** A replace (adjacent delete-suggestion
  + insert-suggestion, same author) renders as one "Replace X → Y" card whose one
  Accept resolves both entries and whose one Reject rejects both. Independent
  accept/reject of the two halves is SP-C.
- **Anchoring cards to the preview pane.** In preview-only and Viewing modes the
  rail falls back to the chronological list. Preview-block anchoring (via the
  existing `data-line` tags) is a possible SP-B/SP-C follow-up.
- **Changing Viewing-mode chrome.** CV2-1b still greys the comments button and
  forces the rail shut in Viewing mode — untouched.
- **The "Add comment" draft flow.** The floating "Add comment" button on a text
  selection, and its textarea box, are kept as-is (moved into `AnnotationRail`
  verbatim).
- **Preview `<ins>` / `<del>` rendering** (`suggestion-preview.ts`) — unchanged.
- **Suggestion resolution semantics** (`resolveSuggestion` / `withdrawSuggestion`
  and the four-case table) — unchanged; the card's buttons call the same
  functions the inline widget's buttons called.

## Global constraints

- Two `tsconfig.json`s. `client/src/**` + `tests/client/src/**` have
  `strictNullChecks` / `noImplicitAny` off. `annotation-rail-layout.ts` and
  `annotations.ts` are client files.
- Svelte 5 (runes). Component tests go under `tests/client/src/components/*.test.ts`
  (routed to the `components` Vitest project — real Chromium, not jsdom).
- `npm run format` (Prettier) + `npm run typecheck` (`tsc` + `svelte-check`) pass.
- The `local` Playwright project runs against `vite dev`; the `collab` project
  against `wrangler dev` with the real `WorkspaceRoom`.
- `feedback_topbar_sizing_locked` — do not touch topbar/logo/icon sizing or the
  accent tokens. The rail is not the topbar; this is a reminder not to drift into
  it.
- The `#comments-panel-mount` grid column, `#content-row`'s
  `grid-template-columns: auto 1fr auto` / `grid-template-areas`, and the
  `.comments-panel` slide-out (`transform: translateX(100%)` + `margin-right:
  -320px`) are reused, not rebuilt. `#comments-panel-mount` keeps
  `display: contents`.
- Mobile (`max-width: 780px`): the rail is the existing bottom-sheet, list mode
  only, no anchoring.

---

## Part 1 — The adapter: `client/src/annotations.ts` (new)

A single normalised shape both the rail and the card consume, so neither has to
know whether an entry came from the Y.Doc, an HTTP thread, or a local note:

```ts
export interface RailAnnotation {
  id: string;
  kind: "comment" | "suggestion";
  author: string;
  createdAt: number;
  anchorFrom: number; // char offset into the editor's current text
  anchorTo: number;
  // comment-only
  quote?: string;
  resolved?: boolean;
  orphaned?: boolean;
  replies?: { id: string; author: string; body: string; createdAt: number }[];
  // suggestion-only
  changeKind?: "insert" | "delete";
  changeText?: string; // the affected text, sliced from the editor
  // display grouping (a replace = one card over two suggestion entries)
  groupedIds?: string[]; // when set, id is synthetic; groupedIds are the real entry ids
}
```

Two builders:

```ts
// Shared documents: suggestions from the Y.Doc + comment threads already
// fetched by the caller. `content` is the editor's current text (for changeText
// slices + relocating thread anchors, same string CommentsPanel already passes
// to relocateAnchor today).
export function railAnnotationsForShared(
  suggestions: ResolvedSuggestion[],
  threads: CommentThread[],
  content: string,
): RailAnnotation[];

// Local (never-shared) documents: plain notes only, no suggestions.
export function railAnnotationsForLocal(notes: Note[], content: string): RailAnnotation[];
```

Rules:

- **Suggestion → card.** `anchorFrom`/`anchorTo` are the resolved absolute
  offsets already on `ResolvedSuggestion`. `changeText = content.slice(from, to)`.
- **Replace grouping.** After sorting suggestions by `from`, an `insert` entry
  whose `from` equals a same-author `delete` entry's `to` (or vice versa —
  contiguous, either order) collapses into one `RailAnnotation` with
  `groupedIds: [deleteId, insertId]`, `id` = `` `${deleteId}+${insertId}` ``,
  `changeKind` omitted, and `changeText` carrying both slices (the card renders
  "Replace «del» → «ins»"). Only pairs exactly adjacent and same-author group;
  anything else stays a standalone card.
- **Comment → card.** `anchorFrom`/`anchorTo` come from `relocateAnchor(content,
  thread)` (the same call `CommentsPanel.loadEntries` makes now); a thread that
  no longer relocates gets `orphaned: true` and `anchorFrom = anchorTo = 0` (the
  rail renders it clamped at the top in list order). `replies` maps
  `thread.comments`. `quote` from `thread.quote`.
- **Note → card.** `kind: "comment"`, single-entry `replies: [{author:
  note.author ?? "You", body: note.body, …}]`, `resolved` undefined (local notes
  have no resolved concept), anchor from `relocateAnchor`.
- Output is sorted by `anchorFrom`, then `createdAt`.

Unit-testable with plain objects — no DOM, no Yjs live doc needed beyond building
`ResolvedSuggestion[]` from a `Y.Doc` in the test (as `suggestions.test.ts`
already does).

## Part 2 — The layout engine: `client/src/annotation-rail-layout.ts` (new, pure)

```ts
export interface CardAnchor {
  id: string;
  anchorY: number | null; // px from the rail's top; null = anchor not in the editor viewport
  height: number; // measured card height in px
}
export interface CardPlacement {
  id: string;
  top: number; // px from the rail's top
  clamped: "top" | "bottom" | null;
}
export function layoutCards(
  anchors: CardAnchor[],
  viewport: { height: number },
  gap: number,
): CardPlacement[];
```

Algorithm:

1. Partition into `above` (anchorY === null and originally scrolled past the top),
   `visible` (anchorY within `[0, viewport.height]`), `below` (null, past the
   bottom). The caller tags null anchors with direction; see Part 4.
2. `visible`, sorted by `anchorY` ascending: place the first at `max(anchorY,
   0)`. Each next at `max(anchorY, prevTop + prevHeight + gap)`. If that pushes
   the last card's bottom past `viewport.height`, walk backwards subtracting the
   overflow from each card's `top` down to a floor of its own `anchorY` (best-
   effort de-collision without shoving a card above its anchor).
3. `above`: stack upward from `top: 0`, `clamped: "top"` — most recent nearest
   the fold. `below`: stack from the bottom, `clamped: "bottom"`.
4. Deterministic and side-effect-free — exhaustive unit tests (empty, one, two
   colliding, all-off-screen, over-full).

The connector line and the actual `coordsAtPos` measurement live in the component
(Part 4); this module is just the arithmetic.

## Part 3 — `AnnotationCard.svelte` (new)

**Props:**
```ts
{ annotation: RailAnnotation;
  viewer: { role: "editor" | "reviewer" | "viewer" | null; name: string };
  focused: boolean;
  onAccept: () => void; onReject: () => void; onWithdraw: () => void;
  onResolve: (resolved: boolean) => void; onDelete: () => void;
  onReply: (body: string) => void; onJump: () => void; onFocus: () => void; }
```

**Frame:** `<article class="annotation-card" class:suggestion class:comment
class:focused class:resolved class:orphaned>`. Header, body, action row.

- **Header** — avatar (`https://github.com/<author>.png`, `#icon-user` fallback,
  same as `TopbarAccount`), author name, relative time (reuse whatever
  `VersionHistory` uses), and:
  - comment: the `quote` as a one-line italic clamp, click → `onJump`.
  - suggestion `insert`: `Add "<changeText>"`.
  - suggestion `delete`: `Remove "<changeText>"`.
  - suggestion replace (`groupedIds`): `Replace "<del>" → "<ins>"`.
- **Body** — comment: the first reply's body, then remaining replies as
  `<strong>author</strong> body`, then (when `focused`) a reply `<input>` +
  Reply button. Suggestion: nothing (deferred).
- **Action row** — comment: `Resolve`/`Reopen` toggle + `Delete` (delete gated to
  author or an `editor`, matching `CommentsPanel.removeEntry` today which is
  unconditional — tighten to author-or-editor as part of this). Suggestion:
  `viewer.role === "editor"` → `✓ Accept` / `✗ Reject`; else
  `viewer.name === annotation.author` → `Withdraw`; else no row.
- Collapsed (not `focused`) a comment card shows author + quote + a reply count
  ("2 replies"); focused expands the thread. A suggestion card is the same
  height either way.

Component tests: each `kind` × role renders the expected header text and action
buttons; clicking each button calls the matching prop; a non-editor non-author
reviewer gets no action row on a suggestion.

## Part 4 — `AnnotationRail.svelte` (replaces `CommentsPanel.svelte`)

`client/src/components/CommentsPanel.svelte` is renamed to `AnnotationRail.svelte`
and reworked. Only the component file name changes: the `#comments-panel-mount`
DOM id, the `comments` grid-area name, and `stores/commentsPanel.ts`
(`commentsPanelOpen`, `unresolvedCommentCount`, `remoteCommentsChanged`) are all
kept as-is, to hold the diff to the component. `main.ts`'s mount call imports the
renamed file.

**Kept verbatim from `CommentsPanel`:** `currentDocContext()`, the shared-vs-local
branch, `fetchAndMergeRepoHistory`, `submitDraft` / the `comment-draft-anchor`
floating box and its `commentDraft` store wiring, `submitReply`, `toggleResolve`,
`removeEntry`, `jumpTo`, the `$commentsBtn` class/disabled/badge `$effect`s, the
mobile `collapseSidebarForMobile` toggle, `remoteCommentsChanged` refetch.

**New — entry model.** `loadEntries()` now also pulls suggestions for a shared
doc (`listResolvedSuggestions(binding.doc)` via a new `window.MDE` accessor, or
directly from `collab.ts`'s active binding) and runs everything through
`railAnnotationsForShared` / `railAnnotationsForLocal`. A Yjs observer on the
suggestions map (mirrors `suggestion-editor.ts`'s own) triggers a re-derive
(cheap — no refetch). `unresolvedCommentCount` still counts only unresolved
comment threads (badge semantics unchanged).

**New — mode.**
```
anchored  when  isEditorOn($viewMode) && !isMobile()
list      otherwise (preview-only, mobile)  — plus a manual header toggle
```
The manual toggle (a segmented control or icon button in the rail header) forces
`list` even when `anchored` is available; it does not force `anchored` when the
editor is hidden.

**New — anchored positioning.** In `anchored` mode, an `$effect` +
`requestAnimationFrame` loop:

1. For each `RailAnnotation`, `cm.coordsAtPos(a.anchorFrom)` → viewport Y; convert
   to rail-relative Y by subtracting the rail's `getBoundingClientRect().top`.
   `null` (or outside the editor scroller's client rect) → tag `above` / `below`
   by comparing against the scroller rect.
2. Measure each rendered card's height (`ResizeObserver` on a hidden first pass,
   or read `offsetHeight` after render — cards are simple, one pass suffices).
3. `layoutCards(anchors, { height: railInnerHeight }, GAP)` → apply `top` to each
   card (absolute-positioned inside `.annotation-rail-canvas`).
4. Draw a connector: a 1px `<div>` from the card's left edge to the rail's left
   edge at the anchor's true Y, hidden when `clamped`.

Recompute triggers: the editor's `scrollDOM` `scroll` event (rAF-throttled), a
`ResizeObserver` on the editor scroller, `$viewMode` change, the derived
annotation list changing, and a card gaining/losing `focused`. A single shared
`activeAnnotationId` writable store (new, `stores/annotations.ts`) holds the
hovered/focused id.

**New — hover link.** `Editor.svelte`'s suggestion marks and `commentMarkerField`
marks get a `data-annotation-id` attribute (for the replace-group case, both
underlying marks carry the synthetic grouped id). A `mouseover`/`mouseout`
delegate on the editor DOM sets/clears `activeAnnotationId`; the rail highlights
the matching card. Hovering or focusing a card sets `activeAnnotationId` the other
way — `Editor.svelte` adds a `.cm-annotation-active` decoration to the matching
mark(s) and, on click/focus, `cm.dispatch({ effects:
EditorView.scrollIntoView(anchorFrom) })`.

**Styling** — `client/src/styles/_comments.scss` becomes `_annotations.scss`. The
`.comments-panel` rules (grid-area, width 320, slide-out, mobile bottom-sheet)
carry over renamed to `.annotation-rail`. New: `.annotation-rail-canvas`
(`position: relative` scroll container in anchored mode), `.annotation-card`
absolute positioning, `.annotation-connector`, the header mode toggle, the
`.cm-annotation-active` editor class.

## Part 5 — Editor integration (`client/src/suggestion-editor.ts`, `Editor.svelte`)

- **`suggestion-editor.ts`:** `suggestionDecorations` drops the
  `Decoration.widget({ widget: suggestionWidgetFor(...) })` range — it now
  returns only the `suggestionInsertMark` / `suggestionDeleteMark` ranges, each
  given `{ attributes: { "data-annotation-id": groupedIdOrOwnId } }`. The
  `SuggestionWidget` class and `suggestionWidgetFor` export are **deleted**
  (their tests move to `AnnotationCard`'s). `suggestionExtensions`,
  `suggestionTransactionFilter`, `suggestionInsertListener`, the D2
  `rangeWithinOwnInserts` path, and the map observer are all unchanged.
- **`Editor.svelte`:** `commentMarkerField`'s `Decoration.mark` gains the same
  `data-annotation-id` attribute (currently it only carries `id` in the spec).
  Add the `.cm-annotation-active` decoration field driven by `activeAnnotationId`.
  Add the editor-DOM `mouseover`/`mouseout` delegate.
- `client/src/types.ts` `MDEBridge`: add `getResolvedSuggestions?(): ResolvedSuggestion[]`
  — returns `listResolvedSuggestions(activeBinding.doc)` for a shared doc, `[]`
  otherwise — set in `collab.ts`'s `init()` (like `setCommentMarkers`). Lets the
  rail read suggestions without importing `collab.ts` (the circular dep
  `window.MDE` exists to prevent). Paired with a `onSuggestionsChanged` bridge
  hook the rail subscribes to (mirrors `onImageAdded` / `remoteCommentsChanged`).

## Part 6 — Testing

### Unit — `tests/client/src/annotation-rail-layout.test.ts` (new)
`layoutCards`: empty → `[]`; single visible → `top === anchorY` clamped to ≥ 0;
two anchors 10px apart, 60px cards → second pushed to `firstTop + 60 + gap`;
one null-`above` + one null-`below` → clamped top / bottom; more cards than fit →
last card bottom ≤ viewport height, no card above its own anchor unless forced.

### Unit — `tests/client/src/annotations.test.ts` (new)
`railAnnotationsForShared`: a lone insert / lone delete / a contiguous same-author
delete+insert (→ one grouped "replace" card with both ids) / a non-contiguous
delete+insert (→ two cards) / a different-author adjacent pair (→ two cards); a
comment thread maps its replies + quote; an unrelocatable thread → `orphaned`.
`railAnnotationsForLocal`: a note → single-reply comment card.

### Component — `tests/client/src/components/AnnotationCard.test.ts` (new)
Per Part 3.

### e2e — `tests/e2e/local/annotation-rail.spec.ts` (new, `local` project)
Local doc, add two comments on different lines → open the rail → two anchored
cards, the lower one's `top` greater than the upper's and both near their line's Y;
scroll the editor → card `top`s change; click the header list-view toggle → cards
render as a flat list; a comment far down the doc, scrolled out of view → its card
clamped at the rail bottom.

### e2e — `tests/e2e/collab/suggestion-rail.spec.ts` (new, `collab` project)
Two browser contexts, reviewer + editor. Reviewer types → an anchored suggestion
card appears in both rails with the change summary; **no** inline widget in the
editor text (`#editor-mount .cm-suggestion-card` count is 0). Editor clicks
`✓ Accept` on the card → suggestion resolves for both, text committed. Reviewer
hovers the underline → the matching card gets the active class. The existing
`tests/e2e/collab/suggestion-mode.spec.ts` is updated: its assertions on the
inline widget move to the rail card.

### Regression
`tests/client/src/suggestion-editor.test.ts` — the `suggestionWidgetFor` /
`SuggestionWidget` describe blocks are removed; the `suggestionDecorations` tests
lose the widget-range expectations (marks only now).
`tests/client/src/suggestion-preview.test.ts` — untouched.

## Part 7 — Rollout & release

- **Version:** minor → `1.61.0`. `package.json` + both `package-lock.json`
  `"version"` fields.
- `CHANGELOG.md` `## [1.61.0]` → `### Changed`: "Comments and suggestions now
  share one right-margin panel, with each card lined up next to the text it
  refers to instead of suggestions appearing inline in the document. A list view
  is still available from the panel header, and on narrow screens the panel stays
  a bottom sheet."
- `client/src/whats-new-entries.ts`: a new entry (version `1.61.0`) + a real
  screenshot in `client/public/whats-new/` captured via a Playwright script
  against a locally-built client showing the anchored rail with a comment and a
  suggestion card. **Not optional, not deferrable** (per `CLAUDE.md`).
- `docs/TEST-COVERAGE.md`: update `COLLAB-07` / `COLLAB-08` (widget → card),
  `PREV-23` unchanged, add rows for `annotation-rail-layout`, `annotations`,
  `AnnotationCard`, and the two new e2e specs.
- `ROADMAP.md`: mark D1 + the visual half of D5 shipped under Group D; note SP-B
  (D3 + data path) and SP-C (D4) still pending, referencing this spec.
- Copy this spec's Non-goals into `ROADMAP.md`'s deferred list at release
  (`feedback_roadmap_deferred_considerations`).

## File summary

| File | Change |
|---|---|
| `client/src/annotations.ts` | **new** — `RailAnnotation`, `railAnnotationsForShared/Local` |
| `client/src/annotation-rail-layout.ts` | **new** — pure `layoutCards` |
| `client/src/stores/annotations.ts` | **new** — `activeAnnotationId` writable |
| `client/src/components/AnnotationCard.svelte` | **new** — shared card |
| `client/src/components/CommentsPanel.svelte` → `AnnotationRail.svelte` | rename + rework (anchored/list mode, positioning loop, suggestions in the entry model) |
| `client/src/suggestion-editor.ts` | drop the inline widget; marks carry `data-annotation-id`; delete `SuggestionWidget` / `suggestionWidgetFor` |
| `client/src/components/Editor.svelte` | `data-annotation-id` on comment marks; `.cm-annotation-active` field; hover delegate |
| `client/src/types.ts` | `MDEBridge.getResolvedSuggestions?()` |
| `client/src/styles/_comments.scss` → `_annotations.scss` | rename + new rail/card/connector rules; import updated in the SCSS entry |
| `client/src/main.ts` | mount `AnnotationRail`; `#comments-panel-mount` id kept or renamed consistently |
| `tests/client/src/annotation-rail-layout.test.ts`, `annotations.test.ts`, `components/AnnotationCard.test.ts` | **new** |
| `tests/e2e/local/annotation-rail.spec.ts`, `tests/e2e/collab/suggestion-rail.spec.ts` | **new** |
| `tests/client/src/suggestion-editor.test.ts`, `tests/e2e/collab/suggestion-mode.spec.ts` | widget assertions → card assertions |
| `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/public/whats-new/*.png`, `docs/TEST-COVERAGE.md`, `ROADMAP.md` | `1.61.0` release |

## Open risks

1. **`coordsAtPos` cost at scale.** Called per annotation per rAF-throttled
   scroll frame. CodeMirror's `coordsAtPos` is O(1)-ish for positions near the
   viewport and returns `null` for far-off-screen positions (which is the signal
   we want). A document with hundreds of live annotations is not a realistic
   shared-doc review scenario; if it bites, memoise by `(anchorFrom, scrollTop)`.
2. **Card height measurement race.** A card's height isn't known until it renders,
   but `layoutCards` needs it. Mitigation: cards have a fixed collapsed height
   (only a focused comment card grows); measure once after mount, re-measure only
   the focused card on focus change.
3. **`relocateAnchor` vs Yjs offsets.** Comments use fuzzy text relocation;
   suggestions use exact resolved offsets. Both land as `anchorFrom` char offsets
   into the same editor text — consistent for the rail. (SP-B replaces the fuzzy
   path with relative positions.)
4. **The `CommentsPanel` → `AnnotationRail` rename is a big diff.** Kept as a
   rename + in-place rework (not a from-scratch rewrite) so the draft-box, repo-
   history, and mobile-sheet logic — all load-bearing and lightly tested — move
   verbatim rather than being re-derived.
5. **Preview-only fallback loses spatial context** for a reviewer working in
   Viewing/preview mode. Accepted for SP-A; preview-block anchoring is a named
   deferral.
