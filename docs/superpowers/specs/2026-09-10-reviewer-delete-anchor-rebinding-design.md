# Reviewer-delete anchor rebinding — design

**Status:** draft, under review
**Trigger:** the deferred non-goal of `2026-09-10-reviewer-repair-diff-and-broadcast-design.md`
(MDE-13). When `enforceReviewerConstraints` reverts a reviewer's raw deletion of
committed `ytext`, it re-inserts the text as **new Yjs items**, so any
comment-thread or suggestion relative-position anchor that pointed into the
deleted range stays bound to the tombstones and collapses to a zero-width span.
**Predecessors:** `2026-09-10-reviewer-crdt-write-constraints-design.md`
(`enforceReviewerConstraints` / `captureReviewerPreState`),
`2026-09-10-annotation-model-unification-design.md` (SP-B — comment threads on
the doc, `quote`-based re-anchoring), `2026-09-10-reviewer-repair-diff-and-broadcast-design.md`.
**Ships as:** a patch release (`1.62.5`) — a correctness fix with no visible
behaviour change for a well-behaved client (a well-behaved reviewer client never
sends a raw committed-text delete): `CHANGELOG.md` `### Fixed`, no What's New.

## Global constraints

- `src/reviewer-integrity.ts` is **server-only**, pure, not hand-synced.
- `src/comments-doc.ts` **is** hand-synced byte-for-byte with `client/src/comments-doc.ts`
  (a `tests/src/comments-doc-parity.test.ts` guard enforces it) — any change to
  one is mirrored in the other in the same commit.
- Do not touch `src/workspace-room.ts`'s top-of-file region (imports, start of
  `fetch`) — `dev-login.patch` breaks on a context shift.
- No new dependency.
- `tests/src/**` is full-strict TS + `noUncheckedIndexedAccess`.

## Background

A reviewer sync frame that deletes committed `ytext` is applied to the
authoritative `Y.Doc` (`readSyncMessage`), then `enforceReviewerConstraints`
restores every removed committed run with `ytext.insert(at, text)`. The restored
characters are brand-new CRDT items with new `ID`s. Yjs relative positions
(`Y.RelativePosition`) that were anchored to the now-deleted items still
*resolve* — to the left edge of where the deletion happened — so an annotation
spanning any part of the deleted range comes back with `from ≈ to` (collapsed).

- **Comment threads** carry a `quote` string, so `listResolvedCommentThreads`
  re-matches the quote in the current text and rewrites the anchor at read time
  (SP-B). This recovers the common case but is lossy: it fails when the quote
  occurs more than once, or when a *legitimate* reviewer edit in the same frame
  changed the surrounding text, and the rewrite is recomputed on every read
  instead of being persisted.
- **Suggestion entries have no `quote` field.** A collapsed suggestion anchor
  has nothing to recover from — the suggestion silently disappears from the
  annotation rail and can never be accepted or rejected.

A well-behaved reviewer client never triggers this: `suggestion-editor.ts`'s
`suggestionTransactionFilter` intercepts the deletion and records a
delete-*suggestion* (strike-through) instead, leaving the underlying text — and
every anchor into it — untouched. The collapse is reachable only from a hostile
or buggy client that bypasses that filter, which is exactly the client
`enforceReviewerConstraints` exists to contain.

## Why not "validate before apply"

Rejected. Yjs deletion is monotonic across merges: the reviewer's client has
already applied the delete to its local `Y.Doc`, so even if the server never
applied the incoming frame, that deletion propagates to the server on the next
state-vector exchange and collapses the anchors anyway. Preventing that would
mean disconnecting the client on every contract violation (harsh, punishes
merely-buggy clients) or a client-side rollback protocol (a much larger change).
The server can only ever *repair after the fact* — so repair the anchors too.

## Design

### Where

Inside `enforceReviewerConstraints`, in the **same** `doc.transact(…, "suggestion")`
that already applies the text repairs and entry reverts — and only when that
transaction is going to run at all (`textRepairs.length > 0 || entryReverts.length > 0`).
A well-behaved reviewer's ordinary typing produces neither, so the rebinding
pass adds **zero** cost to the normal path.

### The mapping

A reverted delete is **net-zero on committed text**: after enforcement,
`removeRanges(ytext.toString(), reviewerOwnInsertRangesNow)` equals
`committedBefore`. So an annotation's position *in committed-text coordinates*
is invariant across the frame. The rebinding computes each annotation's target
`ytext` position by round-tripping through committed coordinates:

1. **Capture (in `captureReviewerPreState`, before the frame applies)** — for
   every entry in `getCommentsMap(doc)` and `getSuggestionsMap(doc)`, resolve
   `from`/`to` to absolute `ytext` indices against `pre.text` (anchors are still
   valid at this point) and convert each to a committed-text index with
   `absoluteIndexToCommitted`. Store `Map<id, { fromC: number; toC: number }>`.
   Skip (do not store) an annotation whose `from` or `to` resolves to `null`
   (unresolvable anchor) or lands *strictly inside* an own-insert range (a
   boundary position — `from` at a range's start, `to` at a range's end — is
   fine and keeps its committed index); such an annotation has no stable
   committed-coordinate representation, so leave its anchor untouched.

2. **Rebind (after the text repairs + entry reverts, still in the transaction)** —
   recompute the reviewer's own insert ranges from the *current*
   `listResolvedSuggestions(doc)` (`kind === "insert" && author === pre.username`).
   For each captured `{ id, fromC, toC }`:
   - `targetFrom = committedIndexToAbsolute(fromC, ownInsertRangesNow)`,
     `targetTo = committedIndexToAbsolute(toC, ownInsertRangesNow)`.
   - Resolve the annotation's **current** `from`/`to` with `toAbsoluteIndex`.
   - If the current span already equals `[targetFrom, targetTo)`, the anchor
     survived — do nothing.
   - Otherwise rewrite it: `map.set(id, { ...entry, from: toRelative(ytext, targetFrom), to: toRelative(ytext, targetTo, -1) })`
     (matching how `createCommentThread` / `recordInsertSuggestion` build their
     anchors — `to` gets `assoc: -1`).
   - Guard: if `removeRanges(ytext.toString(), ownInsertRangesNow) !== committedBefore`
     (enforcement didn't fully restore committed text — shouldn't happen), skip
     the whole rebinding pass rather than rewrite anchors against a document
     that isn't in the expected state.

   An entry that `entryReverts` just restored (`map.set(id, old)` with `old`'s
   stale pre-frame relative positions) is in `anchorsC` and flows through this
   same pass, so its anchor is rewritten to the correct target too — the revert
   restores the entry's *content/metadata*, the rebind fixes its *position*.

### New pure helper (`src/reviewer-integrity.ts`)

```ts
// Map an index in the committed text (document minus the given, ascending,
// non-overlapping insert ranges) to its absolute index in the full text.
// Inverse of "abs index minus the insert lengths before it".
export function committedIndexToAbsolute(committedIndex: number, insertRanges: ReadonlyArray<readonly [number, number]>): number
```

and its partner, already expressible but worth naming for symmetry / tests:

```ts
// Absolute index -> committed index: subtract the length of every insert
// range that ends at or before `absIndex`. Returns null when `absIndex`
// is strictly inside a range (rangeStart < absIndex < rangeEnd) — it has
// no committed-text position. Boundary positions map through cleanly.
export function absoluteIndexToCommitted(absIndex: number, insertRanges: ReadonlyArray<readonly [number, number]>): number | null
```

### Transaction origin

Everything stays in the single `doc.transact(fn, "suggestion")`. The
`suggestionsMap` observer skips `"suggestion"`-origin transactions for its guard
block (so a deliberate re-target is allowed) and its merge pass is idempotent
against a correct rebind. The `commentsMap` observer bails for any origin that
isn't a live session (`this.sessions.get("suggestion")` is `undefined`), so a
comment rewrite here is not reverted. No new origin string needed; add a one-line
comment at both observers noting `enforceReviewerConstraints` also writes here.

### `captureReviewerPreState` shape change

```ts
private captureReviewerPreState(doc: Y.Doc, username: string) {
  // …existing username / text / ownInsertRanges / entriesById…
  return {
    username,
    text,
    ownInsertRanges,
    entriesById,
    anchorsC: Map<string, { fromC: number; toC: number }>, // NEW — comment + suggestion ids
  };
}
```

`enforceReviewerConstraints`'s signature is unchanged (it already takes
`ReturnType<WorkspaceRoom["captureReviewerPreState"]>`).

## Files

| File | Change |
| --- | --- |
| `src/reviewer-integrity.ts` | `committedIndexToAbsolute`, `absoluteIndexToCommitted` (pure, exported) |
| `src/workspace-room.ts` | `captureReviewerPreState` also captures `anchorsC` for every comment + suggestion; `enforceReviewerConstraints` runs the rebind pass inside its existing transaction, gated on that transaction running at all |
| `tests/src/reviewer-integrity.test.ts` | `committedIndexToAbsolute` / `absoluteIndexToCommitted` — round-trip, boundaries, index-inside-range → null, empty ranges |
| `tests/src/workspace-room.test.ts` | via `reviewerApply`: a hostile reviewer delete over a comment-anchored range → after enforcement the comment's resolved span is exactly its pre-frame span (not collapsed); same for a suggestion entry (which has no quote to recover from); a delete + a legit insert-before in one frame → the comment lands shifted by the insert length; a normal reviewer keystroke touches no anchors and adds no `map.set` calls |
| `tests/e2e/collab/suggestion-mode.spec.ts` | after the existing MDE-05 hostile-delete step, seed a comment over the target range first and assert it is still anchored (visible, correct quote highlight) on the owner side afterward |
| `CHANGELOG.md` | `## [1.62.5]` `### Fixed` |
| `package.json` / `package-lock.json` | → 1.62.5 (at PR time) |
| `docs/TEST-COVERAGE.md` | SEC-16; §10 + total |
| `ROADMAP.md` | Group D security follow-ups — note done; remove the "anchor collapse" line from the deferred list |

## Non-goals / deferred

- **Adding a `quote` field to `SuggestionEntry`.** The index-based rebind makes
  it unnecessary for this fix; a suggestion `quote` is its own small design if
  ever wanted for read-time recovery on a *version restore* (comments have it
  for that reason).
- **Rebinding anchors on a legitimate reviewer *insert* that isn't accompanied
  by a revert.** A plain insert doesn't collapse anything — relative positions
  with `assoc` already track it. Out of scope.
- **Client-side hardening of `suggestionTransactionFilter`** so fewer raw
  deletes escape a buggy client. Worth doing separately; doesn't remove the need
  for a server backstop.
- **Retroactively rebinding anchors already collapsed on disk** by a delete that
  happened before this ships. `listResolvedCommentThreads`' quote match still
  covers comments; a pre-existing collapsed suggestion stays lost.

## Test / rollout

`npm test`, `npm run typecheck`, `npm run build`, `npm run format:check`, then
`npm run test:e2e:collab`. PR → CI green → merge → auto-tag → release →
Cloudflare auto-deploy.
