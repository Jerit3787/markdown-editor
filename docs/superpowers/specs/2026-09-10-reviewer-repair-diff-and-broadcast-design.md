# Reviewer repair diff + broadcast ordering (MDE-12 / MDE-13) — design

**Status:** draft, under review
**Trigger:** external security audit **run-3** against `v1.62.2` — MDE-12
(reviewer repair diff corrupts large edits) and MDE-13 (raw reviewer update
reaches peers before the repair). Both sit in the reviewer CRDT write path that
`2026-09-10-reviewer-crdt-write-constraints-design.md` built; the other four
run-3 findings (MDE-11 / 14 / 15 / 16) shipped as the clear-cut batch in
`v1.62.3` (PR #210).
**Predecessor:** `2026-09-10-reviewer-crdt-write-constraints-design.md`
(`enforceReviewerConstraints` / `captureReviewerPreState` / `reviewer-integrity.ts`).
**Ships as:** a patch release (`1.62.4`) — a security / correctness fix with no
visible behaviour change for a well-behaved client: `CHANGELOG.md` `### Fixed`,
no What's New entry.

## Global constraints

- `src/reviewer-integrity.ts` is **server-only**, pure, not hand-synced with
  `client/src/`.
- `src/workspace-room.ts`'s top-of-file region (imports, start of `fetch`) must
  stay untouched — `dev-login.patch` (e2e-collab / e2e-github) patches there and
  breaks on a context shift. All edits here are deep in the class body.
- No new dependency. Myers diff is ~40 lines, written in-repo.
- `tests/src/**` is full-strict TS + `noUncheckedIndexedAccess`.

## Background

`enforceReviewerConstraints(doc, pre)` (runs right after a reviewer's sync frame
applies) restores every committed `ytext` character the reviewer removed, so the
reviewer's net effect on the document is *add-only* (their inserts are
separately auto-wrapped into suggestions by `reconcileReviewerDelta`). It does
this by:

```
committedBefore = removeRanges(pre.text, pre.ownInsertRanges)   // doc minus reviewer's own pending inserts
textRepairs     = reviewerTextRepairs(committedBefore, ytext.toString())
// one doc.transact(…, "suggestion"): ytext.insert(at, text) for each repair, descending `at`
```

`reviewerTextRepairs` walks `diffOps(committedBefore, afterText)` and, for every
`del` op (a committed char the reviewer removed), emits an insert to put it back.

## MDE-12 — `diffOps` bulk fallback corrupts large reviewer edits

### What's wrong

`diffOps` trims the common prefix/suffix, then:

```ts
} else if (aMid.length + bMid.length > BULK_THRESHOLD) {   // 8192
  ops.push({ type: "del", aFrom: aMidFrom, aTo: aMidTo, text: "" });
  ops.push({ type: "ins", aFrom: 0, aTo: 0, text: bMid });
}
```

When both middles are non-empty and their combined length exceeds 8 KB, it
skips the LCS alignment and emits one whole-middle `del` + one whole-middle
`ins`. `reviewerTextRepairs` then produces a single repair
`{ at: p, text: <the entire committed middle> }` — re-inserting the whole
pre-edit middle in front of the reviewer's version, **even though most of that
middle is unchanged and still present in `afterText`.**

The prefix/suffix trim does *not* save us here: an edit that touches **both
ends** of a document larger than ~8 KB in one sync frame (fix a typo near the
top and one near the bottom; a large block replace; a select-most-and-retype)
leaves a middle that is almost the whole document but almost entirely identical.
The current code dumps a full copy of it back in. The document roughly doubles,
and it compounds — the next frame's `pre.text` is the doubled document.

Confirmed against the real code path; `reviewer-integrity.ts:40-42`,
`reviewerTextRepairs` bulk branch, `enforceReviewerConstraints`
`ytext.insert(r.at, r.text)`.

Note the **pure-delete** case is already fine — `bMid.length === 0` takes the
earlier clean-`del` branch before the threshold check, and its repair restores
exactly the deleted run at the right place.

### Fix — align the middle with Myers instead of giving up

Replace the O(n·m)-memory LCS DP (`lcsOps`) with **Myers' O(N·D) diff**
(`N = n+m`, `D = edit distance`), and delete the `BULK_THRESHOLD` bulk branch.

Why Myers is the right call:

- The prefix/suffix trim already runs first, so the input to the aligner is
  only the region between the outermost changes.
- A reviewer's real edit has a **small `D`** even when that region is large
  ("two typos in a 40 KB doc" → the two middles differ by a handful of chars →
  `D` ≈ that handful → `O(N·D)` ≈ linear). This is the case the current bulk
  fallback mangles; Myers handles it in a few milliseconds and restores only
  the runs that actually changed.
- Myers produces the same *shape* of op stream (`keep` / `del` / `ins` in
  a-order) that `lcsOps` does today, so `reviewerTextRepairs`, `coalesce`, and
  every existing `diffOps` / `reviewerTextRepairs` test are unchanged.

Keep one guard for the genuinely pathological case (a reviewer pastes tens of KB
of *entirely* different text — large `D`): if `D` would exceed
`MAX_EDIT_DISTANCE` (proposed `4096`), Myers bails and `diffOps` falls back to
the current whole-middle `del` + `ins`. That path is already *offset-correct* —
`reviewerTextRepairs` turns it into exactly one repair,
`{ at: <after the kept prefix>, text: <committed middle> }` — so no change is
needed there; it is just conservative (restores the committed middle in full
next to the reviewer's replacement rather than only the changed runs). Under
"reviewer may only add" that outcome is *correct* — every committed char
survives, the reviewer's text stands as an addition — it is only ugly, and after
this change it is reached only for genuinely unalignable edits instead of any
edit whose changed region tops 8 KB.

Myers implementation notes:

- Standard greedy LR two-endpoint is unnecessary; the classic single-array
  greedy Myers (`V` keyed by diagonal `k`, `D` from `0`) with backtracking via
  stored `V` snapshots is enough and is ~40 lines.
- Operate on the trimmed middles (`aMid`, `bMid`); add `aMidFrom` to every
  a-coordinate on the way out, exactly as `lcsOps(am, bm, aBase)` does now.
- `coalesce` still runs on the result.

### `reviewerTextRepairs` change

**None to the function body.** It walks whatever op stream `diffOps` returns;
Myers output has the same `keep`/`del`/`ins` shape as `lcsOps` output, and the
`MAX_EDIT_DISTANCE` fallback is the same whole-middle `del`+`ins` it already
handles. The invariant `sum(repair.text.length) ≤ (chars the reviewer removed)`
holds by construction in both paths; assert it as a property in the tests.

## MDE-13 — raw reviewer update broadcast before enforcement

### What's wrong

`handleMessage` (reviewer branch):

```ts
syncProtocol.readSyncMessage(decoder, encoder, docRoom.doc, ws);   // applies raw delta
//   → doc.on("update") → handleDocUpdate → this.broadcast(rawDelete, ws)   ← peers get the delete
if (reviewerPre) this.enforceReviewerConstraints(docRoom.doc, reviewerPre);
//   → doc.transact("suggestion") → doc.on("update") → handleDocUpdate → this.broadcast(repair)  ← then the repair
```

Peers receive the reviewer's raw deletion as its own frame, then the repair as a
second frame. There is no `await` between the two `broadcast` calls (the DO runs
this synchronously), so the wall-clock gap is negligible — but a peer still
**applies frame 1 alone**: its `ytext.observe` fires with the deleted span
missing, the annotation rail re-derives comment/suggestion cards against a
document that is briefly wrong (quote-match fails → cards flash to "orphaned"),
then frame 2 lands and it re-derives again. A visible flicker on every peer for
every reviewer edit that trips a repair.

### Not in scope to "fix"

Yjs relative-position anchors for comments/suggestions over the deleted range
**collapse when the delete applies and do not rebind to the repair's
re-inserted text** (new items, new IDs). This is a pre-existing, deliberate
tradeoff of the revert-on-disallowed-write model — documented in the predecessor
spec — and is mitigated by the quote-based re-anchoring in
`listResolvedCommentThreads` / `listResolvedSuggestions`. Merging the broadcast
frames does **not** change this (the merged update still contains the delete of
the original items). Genuinely preventing the collapse would mean validating the
reviewer's frame *before* applying it to the shared doc — a rewrite of the
reviewer sync path, explicitly deferred.

### Fix — defer peer broadcast across the apply + enforce, flush once merged

Add a per-`DocRoom` broadcast buffer, engaged only around a reviewer's
apply-then-enforce:

```ts
interface DocRoom { …; deferredUpdates: Uint8Array[] | null; }   // null = broadcast normally
```

`handleDocUpdate(docId, docRoom, update, origin)`:

```ts
if (docRoom.deferredUpdates) {
  docRoom.deferredUpdates.push(update);
  // still do the non-broadcast bookkeeping (pendingAuthors, schedulePersist);
  // skip maybeSnapshot here — it runs once after the flush (see below)
  return;
}
// …unchanged…
```

`handleMessage`, reviewer branch:

```ts
const reviewerPre = session?.role === "reviewer" ? this.captureReviewerPreState(…) : null;
if (reviewerPre) docRoom.deferredUpdates = [];
try {
  syncProtocol.readSyncMessage(decoder, encoder, docRoom.doc, ws);
  if (encoding.length(encoder) > baseLength) ws.send(encoding.toUint8Array(encoder));
  if (reviewerPre) this.enforceReviewerConstraints(docRoom.doc, reviewerPre);
} finally {
  if (reviewerPre) {
    const buffered = docRoom.deferredUpdates ?? [];
    docRoom.deferredUpdates = null;
    if (buffered.length) {
      const merged = Y.mergeUpdates(buffered);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      encoding.writeVarString(enc, docId);
      syncProtocol.writeUpdate(enc, merged);
      this.broadcast(encoding.toUint8Array(enc), null);   // to everyone incl. reviewer — Yjs updates are idempotent
      void this.maybeSnapshot(docId, docRoom);            // once, against the post-repair document
    }
  }
}
```

Result: peers (and the reviewer) get **one** update that already contains the
delete *and* the repair. A peer's `ytext.observe` fires once, on the coherent
post-repair state — no flash. `Y.mergeUpdates` is in the `yjs` package already
imported. Broadcasting to `null` origin (everyone) is safe because the
reviewer re-applying their own delta is a no-op in Yjs, and they *need* the
repair.

Edge cases to cover in the plan:

- **No repair needed** (reviewer only inserted): `buffered` holds just the raw
  insert; merge-of-one broadcasts it to everyone. The reviewer re-applies its
  own insert as a no-op. Equivalent to today's behaviour, one extra
  `mergeUpdates` of a single element. Acceptable; or short-circuit
  `buffered.length === 1 && no enforcement writes` to broadcast with `origin =
  ws` like today. Plan picks one — prefer the simple always-merge path unless a
  test shows the echo matters.
- **`readSyncMessage` throws**: `finally` still clears `deferredUpdates` and
  flushes what was buffered, so a partial apply is still delivered and the
  buffer never leaks into the next frame.
- **A non-reviewer's frame** never sets `deferredUpdates`, so `handleDocUpdate`
  is completely unchanged for editors/owners.
- **`maybeSnapshot`** already got a `this.deleted` guard in `v1.62.3` (MDE-14);
  moving its reviewer-path call to after the flush also means it sees the final
  text, not the mid-delete text (a latent MDE-13 sub-issue).

## Files

| File | Change |
| --- | --- |
| `src/reviewer-integrity.ts` | replace `lcsOps` with `myersOps` (bounded by `MAX_EDIT_DISTANCE`); `diffOps` mid-branch: Myers when within the bound, else the existing whole-middle `del`+`ins` (rename `BULK_THRESHOLD` → gone, replaced by the distance bound). `reviewerTextRepairs` unchanged. |
| `src/workspace-room.ts` | `DocRoom.deferredUpdates`; `handleDocUpdate` buffer branch; `handleMessage` reviewer branch engage/flush; move reviewer-path `maybeSnapshot` after flush |
| `tests/src/reviewer-integrity.test.ts` | Myers parity vs current LCS on small inputs; the both-ends-of-a-big-doc case restores only the changed runs; the `MAX_EDIT_DISTANCE` fallback yields exactly one repair of the committed middle; `reviewerTextRepairs` never restores more than was removed (property check) |
| `tests/src/workspace-room.test.ts` | a reviewer delete over `reviewerApply` results in peers receiving **one** merged frame (spy `broadcast`); the merged frame applied to a fresh peer doc converges to the repaired text; an editor's frame still broadcasts exactly as before; buffer cleared after a throwing frame |
| `CHANGELOG.md` | `## [1.62.4]` `### Fixed` |
| `package.json` / `package-lock.json` | → 1.62.4 (at PR time) |
| `docs/TEST-COVERAGE.md` | SEC-14 (Myers repair), SEC-15 (deferred broadcast); §10 + total |
| `ROADMAP.md` | Group D security follow-ups: MDE-12/13 done; copy this spec's non-goals into the deferred list |

## Non-goals / deferred

- **Preventing the anchor collapse** on a reviewer delete (would require
  validate-before-apply — a reviewer-sync-path rewrite). Quote re-anchoring
  stays the mitigation.
- **Converting a large reviewer replace into a minimal suggestion diff.** The
  `MAX_EDIT_DISTANCE` fallback restores the whole committed middle; making that
  path emit a tight suggestion is D4-granularity work (SP-C), not this.
- **Deferring broadcast for non-reviewer writes / batching unrelated updates.**
  Scope is strictly the reviewer apply+enforce pair.
- **A general Myers diff utility for the client** (`diff-lines.ts` has its own
  LCS for the version-history view; leave it).

## Test / rollout

`npm test`, `npm run typecheck`, `npm run build`, `npm run format:check`, then
`npm run test:e2e:collab` locally (the reviewer boundary has an e2e in
`tests/e2e/collab/suggestion-mode.spec.ts` — extend it to assert the peer sees
the repaired text in one go). PR → CI green → merge → auto-tag → release →
Cloudflare auto-deploy.
