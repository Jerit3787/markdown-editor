# Suggestion line-grouping (D4) — design

**Status:** approved (brainstorm 2026-09-11)
**Sizing:** feature-sized — the last unshipped piece of the D1–D5
suggesting-mode redesign (ROADMAP Group D). Display-layer only, but it
adds a new card shape + a per-sub-edit action path, so: full spec + plan.

## Goal

When a reviewer makes several small pending edits close together — two
fixes on one line, a word swapped then another inserted a few words over
— the annotation rail shows **one card per source line** with a row per
sub-edit, instead of a stack of near-identical cards ("card spam"). The
editor keeps independent accept/reject of each sub-edit.

## Background — what already exists

`client/src/annotations.ts` `suggestionCards(suggestions, content)`
builds `RailAnnotation[]` for the rail:

- suggestions are sorted by `from`
- **replace-pair detection:** an adjacent delete + insert, same author,
  `next.from === s.to` → one `RailAnnotation` with `groupedIds:
  [del.id, ins.id]`, `replacedText`, `changeText` (renders "Replace X →
  Y")
- everything else → one card per `ResolvedSuggestion`

`underlyingIds(a)` returns `a.groupedIds ?? [a.id]` — already the "which
entries does this card represent" accessor.

`RailAnnotation` today carries: `id, kind, author, authorName?,
createdAt, anchorFrom, anchorTo, quote?, resolved?, orphaned?, replies?,
changeKind?, changeText?, replacedText?, groupedIds?`.

`AnnotationCard.svelte` renders a suggestion header as one of "Replace
_X_ → _Y_" / "Add _Y_" / "Remove _X_", plus an actions row: editor sees
Accept / Reject; the author sees Withdraw; a third party sees nothing.

`AnnotationRail.svelte`'s `acceptSuggestion` / `rejectSuggestion` /
`withdrawOwn` each do `underlyingIds(a).forEach((id) =>
resolveSuggestion(doc, id, outcome))` — so a multi-id card's "accept"
already resolves every underlying entry. Hover-link:
`activeAnnotationIds.set(underlyingIds(a))`.

Contiguous-typing already merges into one insert entry
(`recordInsertSuggestion`'s extend + the server self-heal). The gap D4
closes is **separate** small edits near each other.

## Design

### 1. Grouping — `client/src/suggestion-group.ts` (new, pure)

`groupSuggestionCards(cards: RailAnnotation[], content: string):
RailAnnotation[]` runs on the output of the existing replace-pair pass
(so it groups *cards*, and a replace-pair is one indivisible member).

Two or more cards form a **line group** when, for every member:

- `kind === "suggestion"`
- same source **line** — `lineRange(content, card.anchorFrom)` is equal
  (`lineRange` = `[content.lastIndexOf("\n", i - 1) + 1,
  content.indexOf("\n", i) === -1 ? content.length :
  content.indexOf("\n", i))`)
- same `author`
- `card.replies` is empty/absent (a discussed suggestion stays
  standalone — it needs the thread UI room)

A qualifying run of ≥ 2 becomes one `RailAnnotation`:

```ts
{
  id: members.map((m) => m.id).join("+"),
  kind: "suggestion",
  author: members[0].author,
  authorName: members[0].authorName,
  createdAt: Math.min(...members.map((m) => m.createdAt)),
  anchorFrom: Math.min(...members.map((m) => m.anchorFrom)),
  anchorTo: Math.max(...members.map((m) => m.anchorTo)),
  groupedIds: members.flatMap(underlyingIds),   // flat entry ids
  subEdits: members.map((m) => ({
    ids: underlyingIds(m),
    kind: m.replacedText != null ? "replace" : (m.changeKind ?? "insert"),
    changeText: m.changeText ?? "",
    replacedText: m.replacedText,
    from: m.anchorFrom,
    to: m.anchorTo,
  })),
}
```

A run of 1, or any card with a thread, passes through unchanged.
`suggestionCards` calls `groupSuggestionCards` on its result before
returning; `railAnnotationsForShared` then merges with comment cards and
sorts by `bySortKey` as today.

`RailAnnotation` gains:

```ts
subEdits?: {
  ids: string[];
  kind: "insert" | "delete" | "replace";
  changeText: string;
  replacedText?: string;
  from: number;
  to: number;
}[];
```

`underlyingIds` is unchanged (a group has `groupedIds`, so it already
returns the flat list).

### 2. Card — `AnnotationCard.svelte`

A `{#if annotation.subEdits}` branch, before the existing single-suggestion
header/actions:

- **Header:** avatar + `{label}` + `· {subEdits.length} changes`.
- **Rows** (`.annotation-card-subedit`, one per `subEdits` entry, in
  document order):
  - `Replace `~~{replacedText}~~` → `{changeText}`` /
    `Add `{changeText}`` / `Remove `{replacedText ?? changeText}``
  - editor only: a compact `✓` / `✗` pair (`data-act="accept"` /
    `"reject"`, `data-sub` = the row index) calling
    `onSubEdit?.(row.ids, "accept" | "reject")`
- **Footer actions:**
  - editor → **Accept all** / **Reject all** (`onAccept` / `onReject` —
    unchanged handlers, they iterate `underlyingIds`)
  - author (`isOwn`) → **Withdraw all** (`onWithdraw`)
  - third party → no footer

The non-grouped suggestion path, the comment path, and the reply-thread
block are untouched.

New prop: `onSubEdit?: (ids: string[], outcome: "accept" | "reject") => void`.

### 3. Actions — `AnnotationRail.svelte`

- `acceptSuggestion` / `rejectSuggestion` / `withdrawOwn` — unchanged
  (already `underlyingIds(a).forEach(...)`).
- New `resolveSubEdit(ids: string[], outcome: "accept" | "reject")`:
  `const doc = ydoc(); if (doc) ids.forEach((id) => resolveSuggestion(doc,
  id, outcome));` passed as `onSubEdit` to `AnnotationCard`.
- Hover-link unchanged: `activeAnnotationIds.set(underlyingIds(a))` on
  the card lights every sub-edit's mark. (Per-row hover lighting a single
  mark is a deferred nicety, not in scope.)

### 4. Inline marks — unchanged

`suggestion-editor.ts` still draws one underline/strike mark per
`ResolvedSuggestion`. Grouping is rail-only.

## Non-goals

- Grouping across lines / by a proximity gap (the ROADMAP wording said
  "line/span"; line is the unit).
- Merging suggestions into fewer CRDT entries (would lose independent
  accept/reject — explicitly ruled out).
- Grouping comment threads, or a suggestion that has a `replies` thread.
- Per-row hover → single-mark highlight (whole group lights on hover).
- A group-level reply thread.
- Any change to `suggestion-editor.ts`, `reviewer-integrity.ts`, the
  server, or the `SuggestionEntry` schema.
- Touching the replace-pair detection itself (a pair is a group member).

## Edge cases

| Case | Behaviour |
|---|---|
| One pending edit on a line | today's card, unchanged |
| A sub-edit range spans a `\n` | grouped by the line of its `from` |
| Accept/reject the last-but-one row | group re-derives to a single lone card next tick |
| Two reviewers edit the same line | not grouped (different `author`) — two cards / groups |
| A line's only two edits are a replace-pair | already one "Replace X → Y" card — `groupSuggestionCards` sees one member, no group |
| A discussed suggestion + a quiet one on one line | the discussed one stays its own card; the quiet one is a lone card (group needs ≥ 2 groupable members) |
| Preview-only / mobile / list view | same `RailAnnotation[]`, same `AnnotationCard` — grouped card renders in the list too |

## Testing

**`tests/client/src/suggestion-group.test.ts` (new)** — `groupSuggestionCards`:
- two inserts on the same line, same author → one card, `subEdits.length === 2`, `groupedIds` has both entry ids
- a replace-pair + a lone insert on one line → one group, first `subEdit.kind === "replace"`
- two edits on *different* lines → two cards, no group
- two edits same line, *different* authors → two cards
- a card with `replies` on a line with another edit → the discussed one stays standalone
- a single edit on a line → returned unchanged (identity)
- `subEdits` order is document order

**`tests/client/src/annotations.test.ts`** — `railAnnotationsForShared`
produces a grouped card end-to-end from real `recordInsertSuggestion`
entries on one line; comment on the same line is a separate card.

**`tests/client/src/components/AnnotationCard.test.ts`** — a `subEdits`
card: renders N rows; an editor sees per-row ✓/✗ and Accept all / Reject
all; a third-party reviewer sees rows but no buttons; the author sees
Withdraw all; `onSubEdit` fires with the row's `ids`.

**`tests/client/src/components/AnnotationRail.test.ts`** — `resolveSubEdit`
wired: clicking a row's ✓ calls `resolveSuggestion` for exactly that
row's ids (mock `window.MDE.getActiveYDoc`).

Full: `npm test`, `npx vitest run --project=components`, `npm run
typecheck`, `npm run build`, `npm run format:check`, `npm run
check:no-dev-login`.

## Versioning

Visible change to how suggestion cards render → **minor** bump.
`CHANGELOG.md` `### Changed`, a `client/src/whats-new-entries.ts` entry
(category "Collaboration") **with a real captured screenshot** (a line
with 2–3 grouped sub-edits in the rail). ROADMAP Group D: mark **D4 /
SP-C** shipped, close out the "D1–D5" arc.
