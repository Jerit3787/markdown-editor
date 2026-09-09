# Reviewer CRDT write constraints (MDE-05 / MDE-06) — design

**Status:** draft, under review
**Trigger:** external security audit findings MDE-05 (reviewer arbitrary text deletion)
and MDE-06 (reviewer unauthorized suggestion self-acceptance). Both were split
out of the v1.62.1 security batch (PR #206) because the fix interacts with two
load-bearing legitimate flows and needs a considered design.
**Predecessors:** `2026-08-31-suggestion-mode-collaboration-design.md` (the
reviewer role + suggestions model), `2026-09-10-annotation-model-unification-design.md`
(SP-B — the observer-revert pattern for comments).
**Ships as:** a patch release (`1.62.2`) — a security fix with no visible
behaviour change for a well-behaved client: `CHANGELOG.md` `### Fixed`, no What's
New entry.

## Goal

Make the **reviewer** role a real server-enforced boundary for both of the CRDT
types a reviewer can write: `ytext` and the `suggestions` `Y.Map`. Today the
server only blocks *viewers* from writing at all (`handleMessage`'s `isWrite`
gate); a reviewer's `ytext` deletions and `suggestions`-map deletions apply
unchecked.

## Why

`WorkspaceRoom.handleMessage` lets a reviewer session send Yjs updates because a
reviewer must be able to type suggestions. The server's integrity net is
`ytext.observe → reconcileReviewerDelta`, which **auto-wraps a reviewer's
uncovered inserts** into suggestion entries. It does nothing else:

- **MDE-05.** `reconcileReviewerDelta`'s `op.delete` branch is a deliberate
  no-op (`src/suggestions.ts` — "it cannot undo a deletion that already
  occurred"). A hostile reviewer client sends a raw Yjs update deleting any
  range of `ytext`; the deletion applies to the authoritative document, is
  broadcast to everyone, and is persisted. No suggestion, no revert. The
  Reviewer role provides **no protection for existing document text**.

- **MDE-06.** `suggestionsMap.observe` only does the same-author merge pass
  plus (since SP-B / D3) a guard on `update` actions for a foreign `replies`
  append. It never inspects `change.action === "delete"`. Accepting an insert
  suggestion is implemented
  purely as `suggestionsMap.delete(id)` (the inserted text is already in
  `ytext`). So a reviewer sends `suggestionsMap.delete(<their own insert
  entry's id>)` and the text they proposed becomes committed, unmarked,
  unreviewed — a unilateral self-accept. They can also delete *another*
  author's entry to silently discard a proposal.

## The two legitimate flows the fix must not break

1. **Withdraw-own (`withdrawSuggestion` → `resolveSuggestion(id, "reject")`).**
   A reviewer retracting their own not-yet-resolved proposal. Client-side this
   is one `doc.transact`:
   - insert kind → `ytext.delete(from, to−from)` **and** `suggestionsMap.delete(id)`
   - delete kind → `suggestionsMap.delete(id)` only (text was never removed)

2. **D2 self-retract (`suggestion-editor.ts`'s `suggestionTransactionFilter`,
   shipped v1.60.4).** A reviewer backspacing inside their *own* still-pending
   insert suggestion. The real `ytext` deletion is allowed through when the
   deleted range falls entirely within the union of that reviewer's own pending
   insert suggestions (`rangeWithinOwnInserts`); fully-swallowed entries are
   dropped, partial ones shrink via their relative positions.

Both (1-insert) and (2) delete real `ytext` characters from a reviewer session.
A naive "revert every reviewer `ytext` deletion" breaks both. Editor/owner
accept/reject is unaffected — those sessions are `editor` role and out of scope.

## The invariant

> Every `ytext` character a reviewer deletes must have been inside **that same
> reviewer's own pending insert suggestion(s)** immediately before the
> transaction. Every `suggestions`-map entry a reviewer deletes must be **their
> own**, and for an `insert` entry the covered text must also be gone by the end
> of the transaction (i.e. it was a withdraw, not a self-accept).

This single invariant covers withdraw-own-insert, D2, and rejects both attacks.
(Withdrawing a *delete*-kind suggestion touches no text and is always allowed
for the author; a reviewer editing an existing entry's range/kind/author, or a
foreign `replies` write, is already reverted by the SP-B D3 guard, which this
spec extends.)

## Non-goals / deferred

- **Converting an illegitimate reviewer `ytext` deletion into a
  delete-suggestion.** The safe minimum is to revert it (re-insert the deleted
  text); a well-behaved client never sends one, and turning a hostile raw
  delete into a "proposed deletion" would let a misbehaving client still spam
  suggestion cards. Revert only.
- **Reviewer edits to `imagesMap` / `metaMap`.** A reviewer writing those is a
  separate question (arguably they shouldn't) — not part of these two findings.
- **Moving suggestion resolution off the CRDT onto an HTTP endpoint.** SP-B
  just moved comments the other way; re-introducing an RPC path for
  accept/reject/withdraw is a larger design that this doesn't need.
- **Rate-limiting or abuse heuristics** beyond the invariant.

---

## Design

### Where the check runs

Both relevant observers (`ytext.observe`, `suggestionsMap.observe`) fire inside
the sender's transaction, and the check needs *coordinated* state from both
(did the text for this deleted entry also go away?) plus the *pre-transaction*
suggestion ranges. Rather than thread state between two observers, do it as a
**post-apply validation in `handleMessage`**, mirroring how SP-B's comment
observer batches its reverts:

```ts
// in handleMessage, MESSAGE_SYNC / isWrite branch, before readSyncMessage:
const reviewerGuard =
  session?.role === "reviewer"
    ? captureReviewerPreState(docRoom.doc, session.username ?? "Anonymous")
    : null;

syncProtocol.readSyncMessage(decoder, encoder, docRoom.doc, ws);

if (reviewerGuard) enforceReviewerConstraints(docRoom.doc, reviewerGuard);
```

`captureReviewerPreState` records, for that reviewer:
- `text: string` — `ytext.toString()` before
- `ownInsertRanges: Array<[from, to]>` — absolute ranges of their own
  `kind === "insert"` pending suggestions (from `listResolvedSuggestions`)
- `entriesById: Map<id, SuggestionEntry>` — a shallow copy of the suggestions
  map (for `oldValue` on a delete)

`enforceReviewerConstraints` runs after the update applied:

1. **`ytext` deletions.** Diff `pre.text` against `ytext.toString()`. For a
   reviewer transaction this is at most a few small edits; a small hand-rolled
   longest-common-subsequence diff over the two strings (no new dependency —
   they differ by one keystroke-sized edit) is acceptable per reviewer message.
   (Plan-time alternative: walk `event.changes.delta` in `ytext.observe` with
   `event.changes.deleted` for the removed content — see Open Risk 1.) For
   every deleted span `[a, b)` in `pre.text`, require it to be covered by the
   union of
   `pre.ownInsertRanges`. If any deleted character falls outside → the
   transaction is illegitimate: **re-insert** the deleted substring at its
   position (a `doc.transact(…, "suggestion")` write the observer ignores),
   restoring `ytext` to `pre.text` for the parts that weren't within own
   inserts. (Inserts the reviewer made in the same transaction are kept and
   still get wrapped by `reconcileReviewerDelta`.)

2. **`suggestions`-map deletions.** For each id in `pre.entriesById` now absent
   from the map:
   - `old.author !== reviewer` → revert: `suggestionsMap.set(id, old)`.
   - `old.kind === "delete"` → allowed (withdraw of a proposed deletion).
   - `old.kind === "insert"` → allowed **iff** the entry's covered text is no
     longer present, i.e. step 1 already accepted a `ytext` deletion spanning
     `old`'s range (withdraw). If `old`'s range still resolves to live text →
     revert: `suggestionsMap.set(id, old)` (self-accept attempt).

3. **`suggestions`-map updates.** Keep the SP-B D3 guard (foreign `replies`
   append → revert) and extend it: a reviewer `update` that changes `kind`,
   `author`, `from` or `to` of an entry → revert to `oldValue`.

All reverts batch into one `doc.transact(() => …, "suggestion")` — the same
origin `reconcileReviewerDelta` and the merge pass already use, so neither
observer re-processes the repair.

### Ordering / races

- Two reviewers editing concurrently: each transaction is validated
  independently against its own pre-state; a revert is a normal CRDT write that
  merges. Worst case a revert briefly races a legitimate concurrent edit and is
  re-reverted on the next message — the same eventual-consistency the SP-B
  comment observer and the suggestions self-heal already accept.
- The check adds one `ytext.toString()` + a small diff per **reviewer** message
  only. Editor/owner/viewer messages are untouched. Reviewer traffic is
  low-volume (one person, keystroke-paced).

### Alternative considered — full transaction snapshot + revert

Capture `Y.encodeStateAsUpdate(doc)` before every reviewer message; on any
violation, discard the doc and rebuild from the snapshot, then re-sync the
sender. **Rejected:** heavier (full doc encode per reviewer keystroke), and
"rebuild the doc" interacts badly with other sessions' concurrent updates
arriving in the same tick. The targeted per-delta check above is cheaper and
composes with the existing observer-repair model.

### Alternative considered — block reviewer `ytext` deletes at the wire

In `handleMessage`, parse the incoming update and drop it entirely if it
contains any `ytext` delete from a reviewer. **Rejected:** it also drops the
legitimate withdraw-own-insert and D2 transactions (which delete `ytext`), and
parsing a raw Yjs update to classify its ops before applying is more fragile
than observing the applied delta.

---

## Testing

### Unit — `tests/src/workspace-room.test.ts` (extend `describe("reviewer writes")`)

- A reviewer's raw `ytext` delete of committed text is reverted; the text is
  restored, no suggestion entry is created for the (nonexistent) deletion.
- A reviewer's raw `ytext` delete that lands **inside their own pending insert**
  is allowed (D2), and fully-swallowed entries drop.
- A reviewer's `resolveSuggestion(id, "reject")` on their **own insert**
  (delete text + delete entry, one transaction) is allowed — text and entry
  both gone, nothing reverted.
- A reviewer deleting their own **insert** entry while the text stays is
  reverted (self-accept attempt) — entry re-added, text still there.
- A reviewer deleting **another author's** entry is reverted.
- A reviewer withdrawing their own **delete**-kind suggestion (entry delete,
  no text change) is allowed.
- An **editor**'s accept (`resolveSuggestion(id, "accept")` → entry delete,
  text unchanged) is **not** touched by the guard.
- A reviewer `update` changing an entry's `from`/`to`/`kind`/`author` is
  reverted; a self-authored `replies` append still passes (regression for the
  SP-B D3 guard).

### e2e — `tests/e2e/collab/suggestion-mode.spec.ts` (extend)

- A reviewer page runs `window.MDE.getActiveYDoc()` and directly
  `ytext.delete(...)`s a chunk of the owner's text; assert the owner's document
  is unchanged after sync (server reverted it).
- The existing "reviewer withdraws their own pending suggestion" flow
  (COLLAB-11) still passes unchanged.

### Regression

`tests/client/src/suggestion-editor.test.ts` (D2 filter) and the whole
`reviewer writes` block stay green — this is server-only, client behaviour
for a well-behaved client is identical.

---

## Rollout

- **Version:** patch → `1.62.2`. `CHANGELOG.md` `### Fixed` ("A reviewer can no
  longer delete document text directly or accept their own suggestions without
  an editor — the server now enforces that a reviewer only ever proposes
  changes."). No What's New entry.
- `docs/TEST-COVERAGE.md` — extend `COLLAB-05` (reviewer writes) with the
  deletion/self-accept guard rows.
- `ROADMAP.md` — note under Group D / the suggesting-mode security follow-ups;
  copy this spec's Non-goals into the deferred list.
- No staged rollout — the guard is server-side and only ever *adds* reverts for
  writes a correct client never makes.

## Open risks

1. **Diff cost on a large document with a chatty reviewer.** `ytext.toString()`
   + LCS per reviewer message. Mitigation: only runs for `reviewer` sessions;
   if it ever matters, switch to walking `event.changes.delta` in the
   `ytext.observe` callback with the deleted-item content
   (`event.changes.deleted`) instead of a string diff — same logic, no full
   scan. Starting with the string diff for clarity.
2. **A legitimate withdraw where the entry-delete and text-delete arrive in
   *separate* updates** (a misbehaving-but-not-malicious client). The
   entry-delete update would be reverted (text still present at that moment),
   then the text-delete update reverted (not within own inserts, because the
   entry that made it "own" was just re-added… actually it's still there).
   Net: the withdraw fails closed and the reviewer retries. Acceptable — the
   real client does both in one transaction (`resolveSuggestion`).
3. **`cachedAccess` / role staleness** — same as MDE-02; a just-downgraded
   reviewer is now also caught by `reconcileSessionRoles` closing their socket.
