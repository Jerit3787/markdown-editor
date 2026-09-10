# Reviewer-delete anchor rebinding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the server reverts a reviewer's raw deletion of committed text, also rewrite any comment-thread or suggestion anchor that collapsed onto the re-inserted (new-ID) text, so suggestions stop vanishing and comments get a precise index-based re-anchor.

**Architecture:** A reverted reviewer delete is net-zero on committed text, so an annotation's position *in committed-text coordinates* survives the frame. `captureReviewerPreState` records every comment + suggestion anchor in those coordinates; `enforceReviewerConstraints`, inside the same transaction it already uses for the text repair, maps each back to an absolute index and rewrites any anchor whose resolved span drifted. Gated on that transaction running at all, so a well-behaved reviewer's typing pays nothing.

**Tech Stack:** TypeScript, Yjs (`yjs` — `RelativePosition`, `createRelativePositionFromTypeIndex`, `relativePositionToJSON`), Vitest (`unit` project), Playwright (`e2e-collab`). Cloudflare Worker + Durable Object.

**Spec:** `docs/superpowers/specs/2026-09-10-reviewer-delete-anchor-rebinding-design.md`

## Global Constraints

- `src/reviewer-integrity.ts` is **server-only**, pure, NOT hand-synced with `client/src/`.
- `src/comments-doc.ts` is hand-synced byte-for-byte with `client/src/comments-doc.ts` (guarded by `tests/src/comments-doc-parity.test.ts`) — **this plan does not touch it** (the rebind is server-only, in `workspace-room.ts`). If a task tempts you to edit it, stop.
- Do not edit `src/workspace-room.ts`'s top-of-file region (imports block, start of `fetch()`). `dev-login.patch` (used by `npm run test:e2e:collab` / `:github`) patches there and fails on a context shift. All edits here are deep in the class body; adding one name to an existing multi-line `import { … } from "./reviewer-integrity"` is fine.
- No new npm dependency.
- `tests/src/**` runs under the root `tsconfig.json` — full strict mode **plus** `noUncheckedIndexedAccess` (`arr[i]` is `T | undefined`; assert or guard).
- Ships as **patch** release `1.62.5`: `CHANGELOG.md` `### Fixed`, **no** `client/src/whats-new-entries.ts` entry, **no** screenshot. Do the `package.json` / `package-lock.json` bump as the **last step before the PR**.
- Branch: `security/reviewer-reanchor` off current `master` (has v1.62.4). The spec is committed on `security/reviewer-reanchor-spec` (commit `f12f1fc`) — branch from it, or cherry-pick that commit.
- Run `npm run format` before every commit; CI runs `npm run format:check`.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. Never add a `Claude-Session:` link. PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/reviewer-integrity.ts` | Pure server-only helpers for the reviewer write boundary. | Add `absoluteIndexToCommitted` and `committedIndexToAbsolute` — index math between the full text and "the text minus a set of ascending, non-overlapping insert ranges". |
| `src/workspace-room.ts` | The Durable Object. | `captureReviewerPreState` also returns `anchorsC` (every comment + suggestion anchor in committed-text coords). `enforceReviewerConstraints` calls a new private `rebindCollapsedAnchors` inside its existing `doc.transact(…, "suggestion")`. One-line comments at the `suggestionsMap` / `commentsMap` observers noting `enforceReviewerConstraints` also writes there. |
| `tests/src/reviewer-integrity.test.ts` | Unit tests for the pure helpers. | Round-trip, ranges before/after/around the index, index strictly inside a range → `null`, boundary positions, empty ranges, `inclusive` flag. |
| `tests/src/workspace-room.test.ts` | Integration tests driving a real `WorkspaceRoom`. | A hostile reviewer delete over a comment-anchored range → the comment resolves to its exact pre-frame span (proved with `listResolvedCommentThreads(doc)` — **no** `content` arg, so no quote fallback). Same for a suggestion entry (no quote). A reviewer delete + a legit insert-before in one frame → the comment lands shifted by the insert length. A normal reviewer insert (no delete) rewrites no anchors. |
| `tests/e2e/collab/suggestion-mode.spec.ts` | Real two-browser collab e2e. | Before the existing MDE-05 hostile-delete step, seed a comment over the target text; after, assert the owner still sees exactly one comment marker on that text. |
| `CHANGELOG.md` | Release notes. | New `## [1.62.5]` `### Fixed`. |
| `docs/TEST-COVERAGE.md` | Test catalogue. | `SEC-16`; bump §10 count + total. |
| `ROADMAP.md` | Planning surface. | Group D "Security follow-ups" — note done; drop the "anchor collapse" bullet from the deferred list. |
| `package.json`, `package-lock.json` | Version. | → `1.62.5` (last step, at PR time). |

---

## Task 1: Index-mapping helpers in `reviewer-integrity.ts`

**Files:**
- Modify: `src/reviewer-integrity.ts` (add two exported functions near `removeRanges`, ~line 143)
- Test: `tests/src/reviewer-integrity.test.ts` (new `describe` block)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `absoluteIndexToCommitted(absIndex: number, insertRanges: ReadonlyArray<readonly [number, number]>): number | null` — the index in "the full text minus `insertRanges`" that `absIndex` corresponds to. Subtracts the length of every range that ends at or before `absIndex`. Returns `null` when `absIndex` is **strictly** inside a range (`from < absIndex < to`) — that position has no committed-text equivalent. `insertRanges` may be given in any order; they are assumed non-overlapping.
  - `committedIndexToAbsolute(committedIndex: number, insertRanges: ReadonlyArray<readonly [number, number]>, inclusive?: boolean): number` — the inverse: the absolute index in the full text for a committed-text index. `inclusive` defaults to `true` (a range whose start equals the running absolute position is counted — pushes the result past the insert; correct for an annotation's `from`). Pass `inclusive: false` for an annotation's `to` boundary, so an insert sitting exactly at the annotation's end is *not* pulled inside it.

### Steps

- [ ] **Step 1: Write the failing tests**

Add to `tests/src/reviewer-integrity.test.ts`. First extend the import on line 2:

```ts
import {
  diffOps,
  unionCovers,
  removeRanges,
  reviewerTextRepairs,
  isValidNewSuggestionEntry,
  absoluteIndexToCommitted,
  committedIndexToAbsolute,
} from "../../src/reviewer-integrity";
```

Then add a new `describe` block after the `removeRanges` block:

```ts
describe("committed <-> absolute index mapping", () => {
  // full text "AB[cc]DE[ff]GH" — inserts at absolute [2,4) and [6,8);
  // committed text is "ABDEGH"
  const R: Array<[number, number]> = [
    [2, 4],
    [6, 8],
  ];

  it("absoluteIndexToCommitted: subtracts inserts fully before the index", () => {
    expect(absoluteIndexToCommitted(0, R)).toBe(0); // 'A'
    expect(absoluteIndexToCommitted(2, R)).toBe(2); // boundary: start of first insert
    expect(absoluteIndexToCommitted(4, R)).toBe(2); // 'D' — first insert subtracted
    expect(absoluteIndexToCommitted(5, R)).toBe(3); // 'E'
    expect(absoluteIndexToCommitted(8, R)).toBe(4); // 'G' — both inserts subtracted
    expect(absoluteIndexToCommitted(10, R)).toBe(6); // end
  });

  it("absoluteIndexToCommitted: null strictly inside an insert", () => {
    expect(absoluteIndexToCommitted(3, R)).toBeNull(); // inside [2,4)
    expect(absoluteIndexToCommitted(7, R)).toBeNull(); // inside [6,8)
  });

  it("absoluteIndexToCommitted: unordered input, empty ranges ignored", () => {
    expect(
      absoluteIndexToCommitted(8, [
        [6, 8],
        [2, 4],
        [9, 9],
      ]),
    ).toBe(4);
    expect(absoluteIndexToCommitted(5, [])).toBe(5);
  });

  it("committedIndexToAbsolute: adds back the inserts before the position", () => {
    expect(committedIndexToAbsolute(0, R)).toBe(0);
    expect(committedIndexToAbsolute(2, R)).toBe(4); // 'D' sits after [2,4)
    expect(committedIndexToAbsolute(3, R)).toBe(5); // 'E'
    expect(committedIndexToAbsolute(4, R)).toBe(8); // 'G' sits after both
    expect(committedIndexToAbsolute(6, R)).toBe(10);
  });

  it("committedIndexToAbsolute: inclusive flag decides an insert exactly at the position", () => {
    // an insert whose start lands exactly on the target committed position
    const r: Array<[number, number]> = [[3, 5]];
    expect(committedIndexToAbsolute(3, r, true)).toBe(5); // from side: land after the insert
    expect(committedIndexToAbsolute(3, r, false)).toBe(3); // to side: stay before it
  });

  it("round-trips an interior index", () => {
    for (const c of [0, 1, 2, 3, 4, 5, 6]) {
      const abs = committedIndexToAbsolute(c, R);
      expect(absoluteIndexToCommitted(abs, R)).toBe(c);
    }
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run tests/src/reviewer-integrity.test.ts`
Expected: FAIL — `absoluteIndexToCommitted is not a function` (and `committedIndexToAbsolute`).

- [ ] **Step 3: Implement the two helpers**

In `src/reviewer-integrity.ts`, immediately after `removeRanges` (which ends ~line 153):

```ts
// Absolute index -> its index in the committed text (the full text minus
// `insertRanges`). Subtracts the length of every range that ends at or
// before `absIndex`. null when `absIndex` is strictly inside a range
// (from < absIndex < to) — it has no committed-text position. Ranges may
// be unordered; assumed non-overlapping.
export function absoluteIndexToCommitted(absIndex: number, insertRanges: ReadonlyArray<readonly [number, number]>): number | null {
  const sorted = [...insertRanges].filter((r) => r[1] > r[0]).sort((a, b) => a[0] - b[0]);
  let shift = 0;
  for (const [from, to] of sorted) {
    if (to <= absIndex) shift += to - from;
    else if (from < absIndex && absIndex < to) return null;
    else break; // from >= absIndex — this and every later range are past it
  }
  return absIndex - shift;
}

// Committed-text index -> its absolute index in the full text (the inverse
// of absoluteIndexToCommitted). `inclusive` (default true) counts a range
// whose start coincides with the running position, pushing the result
// past that insert — correct for an annotation's `from`. Pass false for a
// `to` boundary so an insert sitting exactly at the annotation's end is
// not pulled inside it.
export function committedIndexToAbsolute(
  committedIndex: number,
  insertRanges: ReadonlyArray<readonly [number, number]>,
  inclusive = true,
): number {
  const sorted = [...insertRanges].filter((r) => r[1] > r[0]).sort((a, b) => a[0] - b[0]);
  let abs = committedIndex;
  for (const [from, to] of sorted) {
    if (inclusive ? from <= abs : from < abs) abs += to - from;
    else break;
  }
  return abs;
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx vitest run tests/src/reviewer-integrity.test.ts`
Expected: PASS (all, including the pre-existing `diffOps` / `reviewerTextRepairs` blocks).

- [ ] **Step 5: `npm run typecheck`**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
npm run format
git add src/reviewer-integrity.ts tests/src/reviewer-integrity.test.ts
git commit -m "feat(security): committed<->absolute index helpers for anchor rebinding

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Rebind collapsed anchors in `enforceReviewerConstraints`

**Files:**
- Modify: `src/workspace-room.ts`:
  - import line ~20 — add the two helpers
  - `captureReviewerPreState` (~line 991-1002) — capture `anchorsC`
  - `enforceReviewerConstraints` (~line 1012-1040) — call `rebindCollapsedAnchors` inside the transaction
  - new private `rebindCollapsedAnchors` (place right after `enforceReviewerConstraints`)
  - `suggestionsMap.observe` (~line 281) and `commentsMap.observe` (~line 371) — one comment line each
- Modify: `CHANGELOG.md`, `docs/TEST-COVERAGE.md`
- Modify: `tests/e2e/collab/suggestion-mode.spec.ts`
- Test: `tests/src/workspace-room.test.ts`

**Interfaces:**
- Consumes (from Task 1): `absoluteIndexToCommitted(absIndex, insertRanges) => number | null`, `committedIndexToAbsolute(committedIndex, insertRanges, inclusive?) => number`.
- Consumes (existing): `toAbsoluteIndex(doc, ytext, json) => number | null` (from `./suggestions`), `getCommentsMap(doc)`, `getSuggestionsMap(doc)`, `listResolvedSuggestions(doc)`, `removeRanges(text, ranges)`, `CommentThreadEntry`, `SuggestionEntry`. `Y` is imported as `* as Y` (line 1).
- Produces:
  - `captureReviewerPreState` return type gains `anchorsC: Map<string, { fromC: number; toC: number }>` — comment + suggestion ids to their pre-frame anchor in committed-text coords. `enforceReviewerConstraints`'s parameter type (`ReturnType<WorkspaceRoom["captureReviewerPreState"]>`) tracks it automatically.
  - `private rebindCollapsedAnchors(doc: Y.Doc, pre: ReturnType<WorkspaceRoom["captureReviewerPreState"]>, committedBefore: string): void` — must run **inside** the enforcement `doc.transact(…, "suggestion")`, after the text repairs and entry reverts.

### Context an implementer needs

`enforceReviewerConstraints` currently:

```ts
const committedBefore = removeRanges(pre.text, pre.ownInsertRanges);
const textRepairs = reviewerTextRepairs(committedBefore, ytext.toString());
// … build entryReverts …
if (textRepairs.length === 0 && entryReverts.length === 0) return;
doc.transact(() => {
  for (const r of [...textRepairs].sort((a, b) => b.at - a.at)) ytext.insert(r.at, r.text);
  for (const revert of entryReverts) revert();
}, "suggestion");
```

The rebind slots in as the last statement inside that `transact` callback. It runs only when the transaction runs — i.e. only when the reviewer's frame deleted committed text or a suggestion entry. A well-behaved reviewer just typing hits the `return` above and never reaches it.

Why the anchors collapse: `ytext.insert` creates new CRDT items. A comment/suggestion `from`/`to` that was a relative position into the deleted range still references the (now tombstoned) old items, so it resolves to the deletion point — `from ≈ to`. The rebind computes where the annotation *should* be (its committed-coordinate position is unchanged by a net-zero revert) and, if the live anchor drifted, rewrites `from`/`to` to fresh relative positions there.

`toAbsoluteIndex` from `./suggestions` works on any relative-position JSON (comment or suggestion `from`/`to` are the same `ReturnType<typeof Y.relativePositionToJSON>` type), returning `number | null`.

Both observers skip a write made here: `suggestionsMap.observe` runs its guard block only for `transaction.origin !== "suggestion"`; `commentsMap.observe` does `this.sessions.get(transaction.origin as WebSocket)` which is `undefined` for the string `"suggestion"` and bails. No new origin needed.

### Steps

- [ ] **Step 1: Write the failing integration tests**

Add to `tests/src/workspace-room.test.ts` in the `describe("reviewer writes", …)` block (it has `reviewerApply`, `fakeSession`, and imports `createCommentThread`, `getCommentsMap`, `listResolvedCommentThreads`? — check the top imports; `getCommentsMap` and `listResolvedCommentThreads` are imported from `../../src/comments-doc`, `createCommentThread` too). Also needs `recordDeleteSuggestion` (imported from `../../src/suggestions`). If `listResolvedCommentThreads` is not already imported, add it to the `comments-doc` import.

```ts
it("rebinds a comment anchor collapsed by a reviewer's reverted delete", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnv);
  const ws = { send: () => {} } as unknown as WebSocket;
  const docRoom = await room.loadDocRoom("doc1");
  docRoom.doc.getText("content").insert(0, "the quick brown fox jumps");
  createCommentThread(docRoom.doc, 4, 9, "quick", "alice", "note"); // "quick" is [4,9)
  const cid = [...getCommentsMap(docRoom.doc).keys()][0]!;
  (room as any).sessions.set(ws, fakeSession("reviewer")); // bob

  // hostile reviewer deletes [4,12) — swallows the whole comment anchor
  await reviewerApply(room, ws, (c) => c.getText("content").delete(4, 12));

  expect(docRoom.doc.getText("content").toString()).toBe("the quick brown fox jumps");
  // resolve WITHOUT the quote fallback (no `content` arg) — proves the
  // stored relative positions themselves are correct, not just recoverable
  const threads = listResolvedCommentThreads(docRoom.doc);
  expect(threads).toHaveLength(1);
  expect(threads.find((t) => t.id === cid)).toMatchObject({ from: 4, to: 9 });
});

it("rebinds a suggestion anchor collapsed by a reviewer's reverted delete (no quote to fall back on)", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnv);
  const ws = { send: () => {} } as unknown as WebSocket;
  const docRoom = await room.loadDocRoom("doc1");
  docRoom.doc.getText("content").insert(0, "the quick brown fox jumps");
  recordDeleteSuggestion(docRoom.doc, 4, 9, "carol"); // a delete-suggestion on "quick"
  const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;
  (room as any).sessions.set(ws, fakeSession("reviewer")); // bob

  await reviewerApply(room, ws, (c) => c.getText("content").delete(4, 12)); // swallows "quick"

  expect(docRoom.doc.getText("content").toString()).toBe("the quick brown fox jumps");
  const s = listResolvedSuggestions(docRoom.doc).find((x) => x.id === sid);
  expect(s).toMatchObject({ from: 4, to: 9 });
});

it("shifts a rebound comment anchor by a reviewer's kept insert when a same-frame delete is reverted", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnv);
  const ws = { send: () => {} } as unknown as WebSocket;
  const docRoom = await room.loadDocRoom("doc1");
  docRoom.doc.getText("content").insert(0, "the quick brown fox jumps");
  createCommentThread(docRoom.doc, 4, 9, "quick", "alice", "note"); // "quick" is [4,9)
  const cid = [...getCommentsMap(docRoom.doc).keys()][0]!;
  (room as any).sessions.set(ws, fakeSession("reviewer")); // bob

  // one frame: delete [4,12) (contains the comment anchor, reverted) AND
  // insert "NEW " at 0 (kept, auto-wrapped as a suggestion)
  await reviewerApply(room, ws, (c) => {
    c.transact(() => {
      c.getText("content").delete(4, 12);
      c.getText("content").insert(0, "NEW ");
    });
  });

  expect(docRoom.doc.getText("content").toString()).toBe("NEW the quick brown fox jumps");
  const t = listResolvedCommentThreads(docRoom.doc).find((x) => x.id === cid)!;
  // "quick" is 4 chars further along; resolve without the quote fallback
  expect(docRoom.doc.getText("content").slice(t.from, t.to)).toBe("quick");
  expect(t).toMatchObject({ from: 8, to: 13 });
});

it("does not rewrite any anchor when the reviewer only inserted (rebind pass never runs)", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnv);
  const ws = { send: () => {} } as unknown as WebSocket;
  const docRoom = await room.loadDocRoom("doc1");
  docRoom.doc.getText("content").insert(0, "the quick brown fox");
  createCommentThread(docRoom.doc, 10, 15, "brown", "alice", "note");
  const cid = [...getCommentsMap(docRoom.doc).keys()][0]!;
  const beforeFrom = JSON.stringify(getCommentsMap(docRoom.doc).get(cid)!.from);
  (room as any).sessions.set(ws, fakeSession("reviewer"));

  await reviewerApply(room, ws, (c) => c.getText("content").insert(0, "AA "));

  // the anchor's stored relative position is byte-for-byte unchanged
  expect(JSON.stringify(getCommentsMap(docRoom.doc).get(cid)!.from)).toBe(beforeFrom);
  // and it still points at "brown" (relative positions tracked the shift on their own)
  const t = listResolvedCommentThreads(docRoom.doc, docRoom.doc.getText("content").toString()).find((x) => x.id === cid)!;
  expect(docRoom.doc.getText("content").slice(t.from, t.to)).toBe("brown");
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run tests/src/workspace-room.test.ts` and read the `reviewer writes` results.
Expected: the two "rebinds …" tests FAIL — the comment/suggestion resolves collapsed (e.g. `{ from: 4, to: 4 }`) after the reverted delete. The "shifts …" test likely FAILS the same way. The "does not rewrite …" test PASSES already (nothing rewrites anchors today) — it locks in the gate.

- [ ] **Step 3: Add the helper import**

`src/workspace-room.ts` line ~20:

```ts
import { removeRanges, reviewerTextRepairs, isValidNewSuggestionEntry, absoluteIndexToCommitted, committedIndexToAbsolute } from "./reviewer-integrity";
```

- [ ] **Step 4: Capture `anchorsC` in `captureReviewerPreState`**

Replace the body of `captureReviewerPreState`:

```ts
  private captureReviewerPreState(doc: Y.Doc, username: string) {
    const ytext = doc.getText("content");
    const ownInsertRanges: Array<[number, number]> = [];
    for (const s of listResolvedSuggestions(doc)) {
      if (s.kind === "insert" && s.author === username) ownInsertRanges.push([s.from, s.to]);
    }
    // Every comment + suggestion anchor in committed-text coordinates, so
    // rebindCollapsedAnchors can restore any that collapse when a raw
    // reviewer delete is reverted (the re-inserted text has new item IDs;
    // relative positions bound to the deleted items never rebind).
    const anchorsC = new Map<string, { fromC: number; toC: number }>();
    const capture = (id: string, fromJson: SuggestionEntry["from"], toJson: SuggestionEntry["to"]) => {
      const fa = toAbsoluteIndex(doc, ytext, fromJson);
      const ta = toAbsoluteIndex(doc, ytext, toJson);
      if (fa === null || ta === null) return;
      const fc = absoluteIndexToCommitted(fa, ownInsertRanges);
      const tc = absoluteIndexToCommitted(ta, ownInsertRanges);
      if (fc === null || tc === null) return; // anchor sat inside the reviewer's own insert
      anchorsC.set(id, { fromC: fc, toC: tc });
    };
    for (const [id, e] of getCommentsMap(doc).entries()) capture(id, e.from, e.to);
    for (const [id, e] of getSuggestionsMap(doc).entries()) capture(id, e.from, e.to);

    return {
      username,
      text: ytext.toString(),
      ownInsertRanges,
      entriesById: new Map<string, SuggestionEntry>(getSuggestionsMap(doc).entries()),
      anchorsC,
    };
  }
```

(`CommentThreadEntry["from"]` and `SuggestionEntry["from"]` are the same type — `ReturnType<typeof Y.relativePositionToJSON>` — so the `capture` param type annotation works for both maps.)

- [ ] **Step 5: Call the rebind inside the enforcement transaction**

In `enforceReviewerConstraints`, change the final `doc.transact`:

```ts
    if (textRepairs.length === 0 && entryReverts.length === 0) return;
    doc.transact(() => {
      for (const r of [...textRepairs].sort((a, b) => b.at - a.at)) ytext.insert(r.at, r.text);
      for (const revert of entryReverts) revert();
      this.rebindCollapsedAnchors(doc, pre, committedBefore);
    }, "suggestion");
```

- [ ] **Step 6: Implement `rebindCollapsedAnchors`**

Immediately after `enforceReviewerConstraints`:

```ts
  // Runs inside enforceReviewerConstraints' "suggestion" transaction, after
  // the text repairs. A reverted reviewer delete leaves committed text
  // net-unchanged, so each annotation's committed-coordinate position
  // (captured in pre.anchorsC) still holds — map it back to an absolute
  // index and rewrite any anchor whose live resolved span drifted (it
  // collapsed onto the re-inserted, new-ID text, or an entryRevert just
  // restored it with stale relative positions).
  private rebindCollapsedAnchors(doc: Y.Doc, pre: ReturnType<WorkspaceRoom["captureReviewerPreState"]>, committedBefore: string): void {
    if (pre.anchorsC.size === 0) return;
    const ytext = doc.getText("content");
    const suggestionsMap = getSuggestionsMap(doc);
    const commentsMap = getCommentsMap(doc);

    const ownInsertsNow: Array<[number, number]> = [];
    for (const s of listResolvedSuggestions(doc)) {
      if (s.kind === "insert" && s.author === pre.username) ownInsertsNow.push([s.from, s.to]);
    }
    // Only rebind against a document whose committed text was fully restored.
    if (removeRanges(ytext.toString(), ownInsertsNow) !== committedBefore) return;

    for (const [id, { fromC, toC }] of pre.anchorsC) {
      const suggestion = suggestionsMap.get(id);
      const comment = suggestion ? undefined : commentsMap.get(id);
      const entry = suggestion ?? comment;
      if (!entry) continue; // annotation gone this frame

      const targetFrom = committedIndexToAbsolute(fromC, ownInsertsNow, true);
      const targetTo = committedIndexToAbsolute(toC, ownInsertsNow, false);
      if (targetTo < targetFrom) continue;

      const curFrom = toAbsoluteIndex(doc, ytext, entry.from);
      const curTo = toAbsoluteIndex(doc, ytext, entry.to);
      if (curFrom === targetFrom && curTo === targetTo) continue; // anchor survived

      const from = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, targetFrom, 0));
      const to = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, targetTo, -1));
      if (suggestion) suggestionsMap.set(id, { ...suggestion, from, to });
      else if (comment) commentsMap.set(id, { ...comment, from, to });
    }
  }
```

- [ ] **Step 7: Add the observer comments**

`suggestionsMap.observe` — at the top of its callback, extend the existing lead comment (the block starting "A non-viewer's in-place `update`…") with a sentence:

```ts
      // (enforceReviewerConstraints' own "suggestion"-origin transaction
      // also writes here — to rebind an anchor collapsed by a reverted
      // delete — and is skipped by the origin check below.)
```

`commentsMap.observe` — after the `if (transaction.origin === "comment-reconcile" || transaction.origin === "comment-migrate") return;` line, add:

```ts
      // enforceReviewerConstraints rebinds a collapsed comment anchor in a
      // "suggestion"-origin transaction — no live session for that origin,
      // so the guard below bails and the rewrite stands.
```

- [ ] **Step 8: Run the integration tests**

Run: `npx vitest run tests/src/workspace-room.test.ts`
Expected: PASS — the two "rebinds" tests, the "shifts" test, and the "does not rewrite" test all green, plus **every** pre-existing `reviewer writes` / `WorkspaceRoom comments` test still green (the MDE-05/06 reverts are unchanged; anchors that already survived are left alone by the `curFrom === targetFrom && curTo === targetTo` check). If a pre-existing MDE-05 test that asserts `getSuggestionsMap(...).size` or exact entry contents breaks, inspect — the rebind should only ever change an entry's `from`/`to`, never its count or other fields.

- [ ] **Step 9: `npm run typecheck` + full unit suite**

Run: `npm run typecheck` then `npx vitest run --project=unit`
Expected: 0 type errors; unit suite green.

- [ ] **Step 10: Extend the collab e2e**

`tests/e2e/collab/suggestion-mode.spec.ts` — the MDE-05 block currently starts by deleting `[0,5)` on the reviewer side. Before that delete, seed a comment on the owner side over a stable phrase, and after the reverted-delete assertions, check the comment marker survived. Locate the block (search `MDE-05`). Add before `reviewer.evaluate(() => window.MDE.getActiveYDoc().getText("content").delete(0, 5))`:

```ts
  // Seed a comment spanning the text the hostile delete will hit, so we
  // can confirm its anchor is rebound (not collapsed) after the revert.
  await owner.evaluate(() => {
    const y = window.MDE.getActiveYDoc();
    const text = y.getText("content").toString();
    const at = text.indexOf("owner-authored");
    return import("/src/comments-doc.ts").then((m) => m.createCommentThread(y, at, at + "owner-authored".length, "owner-authored", "owner-e2e", "keep me"));
  });
  await owner.click("#commentsBtn");
  await expect(owner.locator(".cm-comment-marker")).toHaveCount(1);
```

and after the two `expect.poll(...).toContain("owner-authored content")` assertions:

```ts
  // MDE-13 follow-up — the comment anchor was rebound, not lost.
  await expect(owner.locator(".cm-comment-marker")).toHaveCount(1);
  await expect
    .poll(() =>
      owner.evaluate(() => {
        const y = window.MDE.getActiveYDoc();
        const t = y.getText("content").toString();
        const rel = (window as unknown as { Y?: unknown }).Y;
        void rel;
        return t;
      }),
    )
    .toContain("owner-authored content");
```

Keep it simple — if importing `/src/comments-doc.ts` at runtime in the page proves awkward, instead seed the comment through the UI (select the text, click "Add comment", type, submit) exactly as `tests/e2e/local/comments.spec.ts` does, then assert `.cm-comment-marker` count is 1 before and after. Use whichever is stable; the assertion that matters is **one comment marker, on the right text, after the reverted delete**.

- [ ] **Step 11: Run the collab e2e**

Run: `npm run test:e2e:collab`
Precondition: `git diff -- src/worker.ts` is empty (this plan never touches it). If the sandbox Playwright browser is stale, apply the `playwright.config.ts` `executablePath` workaround from `CLAUDE.md`, run, then revert before committing.
Expected: `suggestion-mode.spec.ts` passes with the new comment-survival assertions.

- [ ] **Step 12: CHANGELOG + coverage**

`CHANGELOG.md` — add above `## [1.62.4]`:

```markdown
## [1.62.5] - 2026-09-10

### Fixed

- When the server rejects a reviewer's direct deletion of document text and puts the text back, comment threads and suggestions anchored in that text now keep their exact position instead of collapsing — previously an affected suggestion could disappear entirely.
```

`docs/TEST-COVERAGE.md` — add after `SEC-15`:

```markdown
| SEC-16 | `enforceReviewerConstraints` rebinds every comment / suggestion anchor that collapses when it reverts a raw reviewer delete — `captureReviewerPreState` records each anchor in committed-text coords (`absoluteIndexToCommitted`), the enforcement transaction maps them back (`committedIndexToAbsolute`) and rewrites any drifted `from`/`to`; a suggestion (no `quote`) survives, a comment lands shifted by a same-frame kept insert, and a plain reviewer insert rewrites nothing (MDE-13 follow-up) | unit + integration + e2e-collab | covered | `tests/src/reviewer-integrity.test.ts`, `tests/src/workspace-room.test.ts`, `tests/e2e/collab/suggestion-mode.spec.ts` | v1.62.5 · external audit run-3 |
```

Bump `| 10. Workspace collab |` count by 1 and `| **Total** |` by 1 in the summary table.

- [ ] **Step 13: Commit**

```bash
npm run format
git add src/workspace-room.ts tests/src/workspace-room.test.ts tests/e2e/collab/suggestion-mode.spec.ts CHANGELOG.md docs/TEST-COVERAGE.md
git commit -m "fix(security): rebind comment/suggestion anchors after a reverted reviewer delete

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: ROADMAP + release finish

**Files:**
- Modify: `ROADMAP.md`, `package.json`, `package-lock.json`

### Steps

- [ ] **Step 1: ROADMAP**

`ROADMAP.md`, Group D "Security follow-ups" bullet — append after the v1.62.4 sentence:

```markdown
  The last rough edge of the revert model — a comment / suggestion anchor
  collapsing when a raw reviewer delete is reverted — is closed by
  server-side anchor rebinding (spec/plan
  `2026-09-10-reviewer-delete-anchor-rebinding`), **shipped v1.62.5**.
```

In "Deferred considerations", **delete** the checkbox item added for the v1.62.4 non-goal that reads "preventing the Yjs relative-position anchor collapse on a reviewer delete …" — keep the other two clauses of that item (huge-block-replace suggestion diff; deferring broadcast for non-reviewer writes) as their own item:

```markdown
- [ ] Reviewer repair diff + broadcast (v1.62.4, MDE-12/13) non-goals:
      emitting a tight suggestion diff for a huge reviewer block replace
      instead of restoring the whole committed middle (D4 / SP-C
      granularity work); deferring broadcast for any non-reviewer write
```

- [ ] **Step 2: Commit the ROADMAP**

```bash
npm run format
git add ROADMAP.md
git commit -m "docs: ROADMAP — anchor rebinding shipped, deferred list trimmed

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Version bump (last step before the PR)**

Hand-edit — do not run `npm install`:
- `package.json` line 4: `"version": "1.62.4"` → `"1.62.5"`
- `package-lock.json` line 3 and line 9: `"version": "1.62.4"` → `"1.62.5"`

```bash
grep -n '"version": "1.62' package.json package-lock.json   # expect 1.62.5 x3
npm run format:check
git add package.json package-lock.json
git commit -m "chore: release 1.62.5 — reviewer-delete anchor rebinding

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Full verification**

```bash
npm test
npm run typecheck
npm run build
npm run format:check
```

Expected: all green.

- [ ] **Step 5: Finish the branch**

**REQUIRED SUB-SKILL:** Use `superpowers:finishing-a-development-branch`. Base branch is `master`. Push and open a PR titled `fix(security): reviewer-delete anchor rebinding (MDE-13 follow-up) — v1.62.5`; body summarises the finding, links the spec, ends with the `🤖 Generated with [Claude Code](https://claude.com/claude-code)` line (no `Claude-Session:` link). Wait for CI green; merge (real merge commit) only on the user's go-ahead. `auto-tag.yml` → `release.yml` → Cloudflare deploy run on their own.

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
| --- | --- |
| `committedIndexToAbsolute`, `absoluteIndexToCommitted` pure + exported | Task 1 Step 3 |
| helper unit tests (round-trip, boundaries, inside→null, empty) | Task 1 Step 1 |
| `captureReviewerPreState` captures `anchorsC` for comments + suggestions | Task 2 Step 4 |
| skip anchors that are `null` or strictly inside an own-insert range | Task 2 Step 4 (`if (fc === null || tc === null) return;` — `absoluteIndexToCommitted` returns null strictly-inside) |
| rebind inside the existing enforcement transaction, gated on it running | Task 2 Steps 5-6 (call site is inside `doc.transact`, which is behind the `if (…) return`) |
| recompute reviewer own-inserts from current `listResolvedSuggestions` | Task 2 Step 6 (`ownInsertsNow`) |
| `committedBefore` mismatch guard → skip pass | Task 2 Step 6 (`removeRanges(...) !== committedBefore` → `return`) |
| leave surviving anchors alone | Task 2 Step 6 (`curFrom === targetFrom && curTo === targetTo` → `continue`) |
| `to` gets `assoc: -1`, `from` gets `0` | Task 2 Step 6 (`createRelativePositionFromTypeIndex(ytext, …, -1)` / `0`) |
| just-reverted entry flows through the rebind | Task 2 Step 6 (its id is in `pre.anchorsC`; `suggestionsMap.get(id)` finds the reverted entry) + test "rebinds a suggestion anchor" |
| observer comments, no new origin | Task 2 Step 7 |
| suggestions have no quote → index rebind is the whole recovery | Task 2 Step 1 "rebinds a suggestion anchor …" test |
| mixed delete + legit insert | Task 2 Step 1 "shifts a comment anchor …" test |
| zero cost on the normal path | Task 2 Step 1 "does not rewrite any anchor …" test |
| e2e comment survives a hostile delete | Task 2 Steps 10-11 |
| patch 1.62.5, `### Fixed`, no whats-new | Task 2 Step 12 + Task 3 Step 3 |
| TEST-COVERAGE SEC-16 + counts | Task 2 Step 12 |
| ROADMAP done + deferred trimmed | Task 3 Step 1 |
| Non-goal: don't add `quote` to `SuggestionEntry` | honoured — no `SuggestionEntry` shape change anywhere |
| Non-goal: `comments-doc.ts` untouched | honoured — Global Constraints + no task edits it |
| Non-goal: no retroactive fix for already-collapsed anchors | inherent — the rebind only runs during a reviewer frame |

No gaps.

**2. Placeholder scan** — no "TBD" / "handle edge cases" / "similar to Task N". Every code step has literal code. Task 2 Step 10 offers a named fallback (runtime import vs UI seeding) — both spelled out, not a placeholder.

**3. Type consistency**

- `absoluteIndexToCommitted(absIndex, insertRanges) => number | null` and `committedIndexToAbsolute(committedIndex, insertRanges, inclusive?) => number` — same names/signatures in Task 1 Produces, Task 1 Step 3, Task 2 imports, Task 2 Step 4/6. ✓
- `anchorsC: Map<string, { fromC: number; toC: number }>` — same shape captured (Step 4) and consumed (Step 6, destructured `{ fromC, toC }`). ✓
- `rebindCollapsedAnchors(doc, pre, committedBefore)` — declared and called with those three args, `committedBefore` is the local already computed at the top of `enforceReviewerConstraints`. ✓
- `toAbsoluteIndex(doc, ytext, json)` — existing import from `./suggestions`, used for both comment and suggestion `from`/`to` (same JSON type). ✓
- `Y.relativePositionToJSON` / `Y.createRelativePositionFromTypeIndex` — `Y` is `import * as Y from "yjs"` at line 1, already used. ✓
- rebind writes `{ ...suggestion, from, to }` / `{ ...comment, from, to }` — preserves `kind`/`author`/`createdAt`/`replies` (suggestion) and `quote`/`resolved`/`replies` (comment). ✓
