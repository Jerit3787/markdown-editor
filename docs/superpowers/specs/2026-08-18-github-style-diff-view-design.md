# GitHub-Style Diff View — Design

**TODO item:** New Bugs #4 — "i actually imagine the diff would look like github or something. Have line numbers, highlighted what's changed etc."

Split from New Bugs #2 ("Image is not loaded properly in the diffs preview") — that item needs per-snapshot image storage across local history, shared/server history, and the legacy collab-room path, which is enough surface area to deserve its own design. This spec covers layout only; images stay out of scope here and remain a known gap.

## Problem

`DiffView.svelte` (`client/src/components/DiffView.svelte`) renders a fixed two-column side-by-side diff with whole-line red/green backgrounds — no line numbers, no intraline (word-level) highlighting, and no way to switch to a unified single-column view. `diff-lines.ts`'s `computeDiffRows` only does line-level pairing via `diffLines`.

## Scope

- `client/src/diff-lines.ts` — diff algorithm: intraline segments, line numbers, unified-mode line flattening.
- `client/src/components/DiffView.svelte` — rendering: gutters, intraline highlight spans, Split/Unified toggle.
- `client/src/style.css` — new gutter/segment styling.
- **No changes to `VersionHistory.svelte`** — its usage (`<DiffView before={...} after={...} />`) is untouched; this is a self-contained rework of `DiffView`'s own internals.
- **No image rendering** — image refs still show as literal text in diff rows, same as today. Follow-up spec.
- **No collapsing of unchanged regions** — every line always renders in full.

## Diff algorithm (`diff-lines.ts`)

### Intraline segments

For each "changed" row (a line replaced by another, produced by the existing removed+added pairing logic), run `diffWordsWithSpace` (from the already-installed `diff` package) between the old and new line text. Word-level, not character-level: character-level diffing fragments mid-word in prose and reads noisily for markdown content; word-level matches how GitHub reads for text-heavy files.

```ts
export interface DiffSegment {
  text: string;
  changed: boolean;
}
```

`DiffRow` gains `leftSegments: DiffSegment[] | null` and `rightSegments: DiffSegment[] | null` — populated only for `"changed"` rows; `null` for `"same"`/`"removed"`/`"added"` rows, where the existing plain `leftText`/`rightText` string is rendered as-is (no need to wrap a whole unchanged or wholly-added/removed line in a trivial single-segment array).

### Line numbers

Two independent running counters, one per side, both starting at 1. Each counter increments whenever a row consumes a line from that side (`leftText !== null` / `rightText !== null` respectively) — this handles same/changed/removed/added rows uniformly, no special-casing needed.

`DiffRow` gains `leftLine: number | null` and `rightLine: number | null` — `null` exactly when the existing `leftText`/`rightText` is `null` (a pure addition has no `leftLine`; a pure removal has no `rightLine`).

### Unified-mode flattening

A new pure function:

```ts
export type UnifiedLineType = "same" | "removed" | "added";
export interface UnifiedLine {
  text: string;
  segments: DiffSegment[] | null;
  type: UnifiedLineType;
  leftLine: number | null;
  rightLine: number | null;
}
export function toUnifiedLines(rows: DiffRow[]): UnifiedLine[];
```

Converts the row list into a flat single-column sequence: `"same"` and `"removed"`/`"added"` rows map 1:1 (segments carried straight through: `null` for same, or `leftSegments`/`rightSegments` respectively for a pure add/remove that happens to have them — today's `computeDiffRows` never sets segments outside `"changed"` rows, so this is always `null` in practice, but the flattener shouldn't assume that). A `"changed"` row expands into two lines in this order: first the removed line (`text: row.leftText`, `segments: row.leftSegments`, `rightLine: null`), then the added line (`text: row.rightText`, `segments: row.rightSegments`, `leftLine: null`) — so intraline highlighting carries over into unified mode exactly as computed for split mode, just split across two stacked lines instead of two side-by-side cells. Kept as a separate pure function (not inlined into the component) so it's independently unit-testable, matching this file's existing pure-function-first style.

## Rendering (`DiffView.svelte`)

**Toggle:** a small Split/Unified pair of buttons in the diff view's own header, visually matching the existing Preview/Diff toggle already in `VersionHistory.svelte` (`.version-history-view-toggle`'s look). Local `$state<"split" | "unified">("split")` inside `DiffView.svelte` — defaults to Split (today's behavior), not persisted across sessions or component remounts.

**Split mode:** today's two-column grid, extended with a line-number gutter on each side (`leftLine`/`rightLine`) and intraline spans rendered inside each cell (when `leftSegments`/`rightSegments` is non-null, render each segment as its own `<span>`, highlighted or plain per `segment.changed`; otherwise render the plain text as today).

**Unified mode:** single content column with two number gutters side by side (old-line#, new-line#) — only one is populated per line depending on type (`same` populates both, `removed` populates only the left gutter, `added` only the right), matching GitHub's own unified view exactly.

## Styling (`style.css`)

- Gutter columns: fixed-width, monospace, dimmed (`var(--text-dim)`), right-aligned digits, `user-select: none` (matches typical code-diff UX — line numbers aren't meant to be selected/copied along with the text).
- Intraline highlight spans: a darker shade of the row's existing red/green tint layered on top of the row's own background, so a changed span reads as "more changed" within an already-tinted line.
- Split/Unified toggle buttons: reuse existing button/active-state styling patterns already established for `.version-history-view-toggle`, not a new visual language.

## Testing

- `diff-lines.test.ts`: intraline segment correctness (single-word change, multi-word change, whole-line replacement with no shared words), line-number correctness across same/changed/removed/added sequences (including a doc with only additions, only removals, and a mix), `toUnifiedLines` expansion (changed row → two lines in the right order, same/removed/added rows map 1:1, line-number gutters correctly null on the appropriate side).
- `DiffView.svelte`: no component-level test infrastructure exists in this codebase (no `@testing-library/svelte` dependency) — verified live in the browser (Version History → Diff, exercising both a local-snapshot diff and a repo-commit diff, both Split and Unified modes, a doc with genuine word-level edits) instead of an automated component test, consistent with how other `.svelte` files in this codebase are verified.
