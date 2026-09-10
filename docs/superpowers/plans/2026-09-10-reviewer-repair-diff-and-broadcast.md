# Reviewer repair diff + broadcast ordering (MDE-12 / MDE-13) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a reviewer's larger edits from bloating the shared document, and stop peers from ever seeing the un-repaired intermediate state.

**Architecture:** Two independent changes in the reviewer CRDT write path. (1) `src/reviewer-integrity.ts`: replace the LCS DP + 8 KB give-up in `diffOps` with a **bounded Myers diff**, so `reviewerTextRepairs` restores only the runs the reviewer actually removed instead of re-inserting the whole middle. (2) `src/workspace-room.ts`: buffer the Yjs updates a reviewer's sync frame produces (raw delta + the `enforceReviewerConstraints` repair) and broadcast them to peers as **one merged update** after enforcement, instead of the raw delta then the repair as two frames.

**Tech Stack:** TypeScript, Yjs (`yjs`, `y-protocols/sync`, `lib0/encoding`), Vitest (`unit` project), Playwright (`e2e-collab`). Cloudflare Worker + Durable Object.

**Spec:** `docs/superpowers/specs/2026-09-10-reviewer-repair-diff-and-broadcast-design.md`

## Global Constraints

- `src/reviewer-integrity.ts` is **server-only**, pure, NOT hand-synced with `client/src/` — no client counterpart to keep in step.
- Do **not** edit `src/workspace-room.ts`'s top-of-file region (imports block, the start of `fetch()`). `dev-login.patch` (used by `npm run test:e2e:collab` / `:github`) patches there and fails to apply on a context shift. All edits in this plan are deep in the class body.
- No new npm dependency. The Myers diff is written in-repo (~55 lines). `Y.mergeUpdates` is already exported by the `yjs` package.
- `MAX_EDIT_DISTANCE = 4096` (the Myers bail-out bound).
- `tests/src/**` runs under the root `tsconfig.json` — full strict mode **plus** `noUncheckedIndexedAccess` (every `arr[i]` is `T | undefined`; assert or guard).
- `client/src/**` strictness is deliberately looser — irrelevant here, nothing client-side changes.
- Ships as **patch** release `1.62.4`: `CHANGELOG.md` `### Fixed` only, **no** `client/src/whats-new-entries.ts` entry, **no** screenshot. Do the `package.json` / `package-lock.json` bump as the **last step before the PR**, not during implementation (per `CLAUDE.md`).
- Branch: `security/reviewer-repair-diff` off current `master` (which already has v1.62.3 / PR #210). The spec is already committed on `security/reviewer-repair-diff-spec` (commit `5e18828`) — cherry-pick it onto the impl branch, or branch from it.
- Run `npm run format` before every commit; CI runs `npm run format:check`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/reviewer-integrity.ts` | Pure server-only helpers deciding which reviewer `ytext` edits were legitimate and computing the repair inserts. | Replace `lcsOps` (LCS DP) with `myersOps` (bounded greedy Myers). Rewire `diffOps`'s middle branch: Myers when it stays within `MAX_EDIT_DISTANCE`, else the existing whole-middle `del`+`ins`. Delete `BULK_THRESHOLD`. `reviewerTextRepairs` body unchanged. |
| `src/workspace-room.ts` | The Durable Object: sync multiplexing, role enforcement, broadcast, snapshots. | Add `DocRoom.deferredUpdates: Uint8Array[] \| null`. `handleDocUpdate` buffers instead of broadcasting while it's non-null. New `flushDeferredReviewerBroadcast(docId, docRoom)`. `handleMessage`'s reviewer branch: engage the buffer before `readSyncMessage`, flush in a `finally` after `enforceReviewerConstraints`. |
| `tests/src/reviewer-integrity.test.ts` | Unit tests for the pure helpers. | Myers round-trip + parity, the `MAX_EDIT_DISTANCE` fallback, the both-ends-of-a-big-doc MDE-12 case, a `reviewerTextRepairs` "never restores more than was removed" property check. |
| `tests/src/workspace-room.test.ts` | Integration tests driving a real `WorkspaceRoom`. | A reviewer delete produces exactly **one** `broadcast` call; the merged payload converges a fresh peer doc to the repaired text; an editor's write path is unchanged; the buffer is cleared after a throwing frame. |
| `tests/e2e/collab/suggestion-mode.spec.ts` | Real two-browser collab e2e. | Extend the existing MDE-05 step: assert the **owner** observes the text restored without an intermediate empty/short read (poll that it never drops below the original length). |
| `CHANGELOG.md` | Release notes. | New `## [1.62.4]` `### Fixed` section (two bullets). |
| `docs/TEST-COVERAGE.md` | Test catalogue. | `SEC-14` (Myers repair), `SEC-15` (deferred broadcast); bump §10 count + total. |
| `ROADMAP.md` | Planning surface. | Group D "Security follow-ups" — note MDE-12/13 shipped; add this spec's non-goals to "Deferred considerations". |
| `package.json`, `package-lock.json` | Version. | → `1.62.4` (last step, at PR time). |

---

## Task 1: Bounded Myers diff in `reviewer-integrity.ts` (MDE-12)

**Files:**
- Modify: `src/reviewer-integrity.ts` (`diffOps` middle branch ~line 34-45; replace `lcsOps` ~line 51-88; delete `const BULK_THRESHOLD = 8192` line 14)
- Modify: `CHANGELOG.md` (new `## [1.62.4]` section — MDE-12 bullet)
- Modify: `docs/TEST-COVERAGE.md` (SEC-14 row + counts)
- Test: `tests/src/reviewer-integrity.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `diffOps(a: string, b: string): DiffOp[]` — unchanged signature. Still returns coalesced `keep`/`del`/`ins` ops in a-order; `del.aFrom`/`aTo` are offsets into `a`; `ins.text` is the inserted run, `ins.aFrom`/`aTo` are `0`. Applying `keep`+`ins` runs of the result to `a` reproduces `b`.
  - `MAX_EDIT_DISTANCE = 4096` — module-level `const`, not exported.
  - `reviewerTextRepairs(committedBefore: string, afterText: string): Array<{ at: number; text: string }>` — unchanged body and behaviour; now backed by Myers.
  - `myersOps(am: string, bm: string, aBase: number): DiffOp[] | null` — module-private. Returns the minimal edit script aligning `am`→`bm` with every a-coordinate offset by `aBase`, or `null` when the edit distance would exceed `MAX_EDIT_DISTANCE`.

### Context an implementer needs

`diffOps` today:
1. trims the common prefix (`p` chars) and common suffix (`s` chars, clamped by `maxS`);
2. emits a leading `keep [0,p)` if `p>0`;
3. for the middle (`aMid = a.slice(p, a.length-s)`, `bMid = b.slice(p, b.length-s)`):
   - both empty → nothing
   - `aMid` empty → one `ins` of `bMid`
   - `bMid` empty → one `del [p, a.length-s)`
   - **`aMid.length + bMid.length > BULK_THRESHOLD` → one `del` of the whole middle + one `ins` of `bMid`** ← the MDE-12 branch
   - else → `lcsOps(aMid, bMid, p)` (O(n·m) time AND memory)
4. emits a trailing `keep [a.length-s, a.length)` if `s>0`;
5. `return coalesce(ops)`.

The MDE-12 bug: an edit touching both ends of a >8 KB document leaves a middle that is almost the whole document but almost entirely unchanged. The bulk branch throws away that structure and `reviewerTextRepairs` then re-inserts the entire committed middle in front of the reviewer's version — the document roughly doubles, and compounds on the next frame.

The fix: align the middle with **Myers' greedy diff** (O((n+m)·D) where D = edit distance). After the prefix/suffix trim the input is only the changed region, and a real reviewer edit has small D even on a big doc, so Myers is near-linear and restores only the changed runs. Keep the whole-middle `del`+`ins` **only** as the fallback when D would exceed `MAX_EDIT_DISTANCE` (a reviewer pasting tens of KB of entirely different text) — that path is already offset-correct in `reviewerTextRepairs` (it yields exactly one repair, `{at: p, text: <committed middle>}`), just conservative.

The existing `diffOps` / `reviewerTextRepairs` tests all exercise the prefix/suffix single-branch paths (`aMid` or `bMid` empty) — Myers only runs when **both** middles are non-empty, so those tests are unaffected by construction. The tie-break Myers uses ("insert before delete on equal") can produce a different *minimal* script than the old LCS DP for an ambiguous replacement, but both round-trip; assert round-trip, not op-equality.

### Steps

- [ ] **Step 1: Write failing tests for `myersOps` behaviour via `diffOps`**

Add to `tests/src/reviewer-integrity.test.ts`, inside the existing `describe("diffOps", …)` block (the `applyOps` helper at the top of the file already reconstructs `b` from `a` + ops):

```ts
it("aligns a replacement mid-string instead of a bulk del+ins (small middle)", () => {
  const ops = diffOps("the quick brown fox", "the slow brown fox");
  expect(applyOps("the quick brown fox", ops)).toBe("the slow brown fox");
  // "brown fox" is kept, not deleted-and-reinserted
  expect(ops.some((o) => o.type === "keep" && "the quick brown fox".slice(o.aFrom, o.aTo).includes("brown"))).toBe(true);
});

it("aligns a change at BOTH ends of a large middle without duplicating it (MDE-12)", () => {
  const big = "x".repeat(20_000);
  const a = "A" + big + "B";
  const b = "C" + big + "D";
  const ops = diffOps(a, b);
  expect(applyOps(a, ops)).toBe(b);
  // the 20k identical middle survives as keeps; total del text is 2 chars ("A","B")
  const delChars = ops.filter((o) => o.type === "del").reduce((n, o) => n + (o.aTo - o.aFrom), 0);
  expect(delChars).toBe(2);
});

it("falls back to one del + one ins when the edit distance is enormous", () => {
  const a = "P " + "a".repeat(9000) + " S";
  const b = "P " + "z".repeat(9000) + " S"; // 9000 subs -> D ~ 18000 > MAX_EDIT_DISTANCE
  const ops = diffOps(a, b);
  expect(applyOps(a, ops)).toBe(b);
  expect(ops.filter((o) => o.type === "del")).toHaveLength(1);
  expect(ops.filter((o) => o.type === "ins")).toHaveLength(1);
});
```

Also **replace** the existing test `it("falls back to one del + one ins for a bulk change past the threshold", …)` — its premise (9000 identical-run chars swapped for another identical run, i.e. D≈18000) is now the *enormous distance* case, so fold it into the last test above and delete the old one. Keep every other existing `diffOps` / `reviewerTextRepairs` test untouched.

- [ ] **Step 2: Run the tests, verify the new ones fail**

Run: `npx vitest run tests/src/reviewer-integrity.test.ts`
Expected: the "both ends" test FAILS (current bulk branch makes `delChars` = 20002, not 2). The "small middle" and "fallback" tests likely pass already (LCS path / bulk path) — that's fine, they lock in behaviour for the rewrite.

- [ ] **Step 3: Add `myersOps` and `MAX_EDIT_DISTANCE`, delete `lcsOps` and `BULK_THRESHOLD`**

In `src/reviewer-integrity.ts`:

Delete line 14 (`const BULK_THRESHOLD = 8192;`). Add near the top instead:

```ts
// Myers greedy diff bails past this edit distance and diffOps uses a
// coarse whole-middle del+ins instead — reached only for a reviewer
// pasting tens of KB of entirely different text, where a minimal script
// has no practical value anyway.
const MAX_EDIT_DISTANCE = 4096;
```

Replace the whole `lcsOps` function (lines ~51-88) with:

```ts
// Greedy Myers diff over the trimmed middles, emitting ops in a-order.
// `aBase` is added to every a-coordinate so callers get offsets into the
// original string. Returns null when the shortest edit script is longer
// than MAX_EDIT_DISTANCE — diffOps then falls back to a whole-middle
// del + ins. O((n+m)·D) time, O((n+m)·D) memory for the trace (bounded
// by MAX_EDIT_DISTANCE²).
function myersOps(am: string, bm: string, aBase: number): DiffOp[] | null {
  const n = am.length;
  const m = bm.length;
  const max = n + m;
  const offset = max; // shift k (which ranges [-max, max]) into a 0-based index
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  let reached = -1;
  for (let d = 0; d <= max && d <= MAX_EDIT_DISTANCE; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      // choose the longer of "came from a delete" (k-1) vs "an insert" (k+1)
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)) {
        x = v[k + 1 + offset]!; // insert (down)
      } else {
        x = v[k - 1 + offset]! + 1; // delete (right)
      }
      let y = x - k;
      while (x < n && y < m && am[x] === bm[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        reached = d;
        break;
      }
    }
    if (reached >= 0) break;
  }
  if (reached < 0) return null;

  // Backtrack through the stored V snapshots, emitting ops from the end.
  const rev: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = reached; d > 0; d--) {
    const vPrev = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vPrev[k - 1 + offset]! < vPrev[k + 1 + offset]!) ? k + 1 : k - 1;
    const prevX = vPrev[prevK + offset]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      rev.push({ type: "keep", aFrom: aBase + x, aTo: aBase + x + 1, text: "" });
    }
    if (d > 0) {
      if (x === prevX) {
        y--;
        rev.push({ type: "ins", aFrom: 0, aTo: 0, text: bm[y]! });
      } else {
        x--;
        rev.push({ type: "del", aFrom: aBase + x, aTo: aBase + x + 1, text: "" });
      }
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    rev.push({ type: "keep", aFrom: aBase + x, aTo: aBase + x + 1, text: "" });
  }
  // any remaining x>0 (all-delete prefix) / y>0 (all-insert prefix)
  while (x > 0) {
    x--;
    rev.push({ type: "del", aFrom: aBase + x, aTo: aBase + x + 1, text: "" });
  }
  while (y > 0) {
    y--;
    rev.push({ type: "ins", aFrom: 0, aTo: 0, text: bm[y]! });
  }
  rev.reverse();
  return rev;
}
```

Then in `diffOps`, replace the two middle branches:

```ts
  } else if (aMid.length + bMid.length > BULK_THRESHOLD) {
    ops.push({ type: "del", aFrom: aMidFrom, aTo: aMidTo, text: "" });
    ops.push({ type: "ins", aFrom: 0, aTo: 0, text: bMid });
  } else {
    ops.push(...lcsOps(aMid, bMid, aMidFrom));
  }
```

with:

```ts
  } else {
    const aligned = myersOps(aMid, bMid, aMidFrom);
    if (aligned) {
      ops.push(...aligned);
    } else {
      // edit distance too large to align — restore the whole committed
      // middle next to the reviewer's replacement (conservative but
      // offset-correct; see reviewerTextRepairs)
      ops.push({ type: "del", aFrom: aMidFrom, aTo: aMidTo, text: "" });
      ops.push({ type: "ins", aFrom: 0, aTo: 0, text: bMid });
    }
  }
```

Leave the `aMid.length === 0` / `bMid.length === 0` branches above it exactly as they are.

- [ ] **Step 4: Run the reviewer-integrity tests**

Run: `npx vitest run tests/src/reviewer-integrity.test.ts`
Expected: PASS — all existing tests plus the three new ones. If the "small middle" keep-assertion fails, the Myers backtrack is emitting single-char ops that `coalesce` should be merging — confirm `coalesce` still runs on `myersOps` output inside `diffOps` (it does, at the `return coalesce(ops)` line).

- [ ] **Step 5: Add a `reviewerTextRepairs` property test**

Add inside `describe("reviewerTextRepairs", …)`:

```ts
it("never restores more text than the reviewer actually removed (MDE-12 property)", () => {
  const cases: Array<[string, string, Array<[number, number]>]> = [
    ["the quick brown fox jumps", "the brown fox", []],
    ["A" + "x".repeat(15_000) + "B", "C" + "x".repeat(15_000) + "D", []],
    ["start OWN middle end", "start end", [[6, 9]]],
    ["header\n" + "line\n".repeat(4000) + "footer", "HEADER\n" + "line\n".repeat(4000) + "FOOTER", []],
  ];
  for (const [pre, after, own] of cases) {
    const committed = removeRanges(pre, own);
    const repairs = reviewerTextRepairs(committed, after);
    const restored = repairs.reduce((n, r) => n + r.text.length, 0);
    // chars in `committed` not present (in order) in `after`
    let removed = 0;
    let j = 0;
    for (const ch of committed) {
      if (j < after.length && after[j] === ch) j++;
      else removed++;
    }
    expect(restored).toBeLessThanOrEqual(removed);
    // and applying the repairs to `after` must contain every committed char in order
    let out = after;
    for (const r of [...repairs].sort((a, b) => b.at - a.at)) out = out.slice(0, r.at) + r.text + out.slice(r.at);
    let k = 0;
    for (const ch of committed) if (k < out.length && out[k] === ch) k++;
    expect(k).toBe(committed.length);
  }
});
```

Run: `npx vitest run tests/src/reviewer-integrity.test.ts` — Expected: PASS.

- [ ] **Step 6: `npm run typecheck`**

Run: `npm run typecheck`
Expected: 0 errors. Watch for `noUncheckedIndexedAccess` on `am[x]` / `bm[y]` / `trace[d]` / `v[...]` — every one above is either `!`-asserted or a `Int32Array` access (which is `number`, not `number | undefined`, so `v[...]` needs no `!` … except TS still widens `Int32Array` index access to `number` — if it complains, add `!`). Fix by assertion, not by loosening tsconfig.

- [ ] **Step 7: Provisional CHANGELOG entry + coverage row**

`CHANGELOG.md` — add above `## [1.62.2]`:

```markdown
## [1.62.4] - 2026-09-10

### Fixed

- A reviewer's larger edits (a big block replace, or fixing something near the top and the bottom of a long document at once) no longer make the server re-insert a whole copy of the surrounding text when it reconciles the change — it now restores only the part the reviewer actually removed.
```

(The MDE-13 bullet is added in Task 2 — same section.)

`docs/TEST-COVERAGE.md` — add after the `SEC-13` row:

```markdown
| SEC-14 | `diffOps` aligns a reviewer's edit with a bounded Myers diff (not an 8 KB LCS give-up) so `reviewerTextRepairs` restores only the runs the reviewer removed — a change at both ends of a >8 KB middle no longer re-inserts the whole middle (MDE-12); the whole-middle `del`+`ins` remains only as a `MAX_EDIT_DISTANCE` fallback | unit | covered | `tests/src/reviewer-integrity.test.ts` | v1.62.4 · external audit run-3 |
```

Bump `| 10. Workspace collab |` from `60` to `61` and `| **Total** |` from `330` to `331` in the summary table near the top (§ counts).

- [ ] **Step 8: Run the whole unit suite, format, commit**

```bash
npx vitest run --project=unit
npm run format
git add src/reviewer-integrity.ts tests/src/reviewer-integrity.test.ts CHANGELOG.md docs/TEST-COVERAGE.md
git commit -m "fix(security): bounded Myers diff for reviewer repair (MDE-12)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

Expected: unit suite green.

---

## Task 2: Defer + merge the reviewer broadcast in `workspace-room.ts` (MDE-13)

**Files:**
- Modify: `src/workspace-room.ts`:
  - `interface DocRoom` (~line 129-140) — add `deferredUpdates`
  - `loadDocRoom` `const docRoom: DocRoom = { … }` (~line 227-234) — initialise it
  - `handleMessage`, `MESSAGE_SYNC` branch inside `withDocRoom` (~line 911-952) — engage/flush around `readSyncMessage` + `enforceReviewerConstraints`
  - `handleDocUpdate` (~line 1056-1069) — buffer branch
  - new method `flushDeferredReviewerBroadcast` (place right after `handleDocUpdate`)
- Modify: `CHANGELOG.md` (`## [1.62.4]` — add the MDE-13 bullet)
- Modify: `docs/TEST-COVERAGE.md` (SEC-15 row + counts)
- Modify: `tests/e2e/collab/suggestion-mode.spec.ts` (extend the MDE-05 step)
- Test: `tests/src/workspace-room.test.ts`

**Interfaces:**
- Consumes: `Y.mergeUpdates(updates: Uint8Array[]): Uint8Array` (from `yjs`, already imported as `* as Y`). `this.broadcast(message: Uint8Array, exceptWs: unknown)`. `this.maybeSnapshot(docId, docRoom)`.
- Produces:
  - `DocRoom.deferredUpdates: Uint8Array[] | null` — `null` = broadcast normally (the default and the state for every non-reviewer write); a `[]` engaged only for the duration of one reviewer sync frame's apply+enforce.
  - `WorkspaceRoom.flushDeferredReviewerBroadcast(docId: string, docRoom: DocRoom): void` — reads and clears `docRoom.deferredUpdates`, and if non-empty merges the buffered updates into one and `broadcast`s it to **all** sessions (`exceptWs = null`), then fires one `maybeSnapshot`.

### Context an implementer needs

`readSyncMessage(decoder, encoder, docRoom.doc, ws)` applies the reviewer's update to the shared `Y.Doc` **synchronously**, which fires `doc.on("update")` → `handleDocUpdate` → `this.broadcast(rawDelta, ws)` **before** the very next line, `enforceReviewerConstraints`, runs. The repair transaction inside `enforceReviewerConstraints` (`doc.transact(fn, "suggestion")`) then fires `doc.on("update")` again → a second `broadcast`. So a peer receives the raw deletion as its own frame, applies it (its `ytext.observe` recomputes the annotation rail against a document that's briefly wrong — comment/suggestion cards flash to "orphaned"), then receives the repair and recomputes again.

Fix: while a reviewer frame is being applied+enforced, `handleDocUpdate` pushes each update into `docRoom.deferredUpdates` instead of broadcasting. After `enforceReviewerConstraints`, `flushDeferredReviewerBroadcast` merges everything buffered (`Y.mergeUpdates`) and broadcasts it as **one** frame to everyone — including the reviewer, whose re-application of their own delta is a Yjs no-op and who *needs* the repair. Peers apply one coherent update; their `ytext.observe` fires once, on the final state.

Non-reviewer writes never set `deferredUpdates`, so `handleDocUpdate` is byte-for-byte unchanged for editors/owners.

### Steps

- [ ] **Step 1: Write failing integration tests**

Add to `tests/src/workspace-room.test.ts`, in the `describe("reviewer writes", …)` block (it already has the `reviewerApply` helper — sync a client `Y.Doc` to the room, mutate it, send the diff as `ws` — and `fakeSession`). Add a `broadcast` spy helper at the top of the block or inline:

```ts
it("a reviewer's committed-text delete reaches peers as ONE merged frame, already repaired (MDE-13)", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnv);
  const ws = { send: () => {} } as unknown as WebSocket;
  const docRoom = await room.loadDocRoom("doc1");
  docRoom.doc.getText("content").insert(0, "the quick brown fox");
  (room as any).sessions.set(ws, fakeSession("reviewer"));

  // a connected peer whose outbound frames we capture
  const peerFrames: ArrayBuffer[] = [];
  const peerWs = { send: (d: ArrayBuffer) => peerFrames.push(d) } as unknown as WebSocket;
  (room as any).sessions.set(peerWs, fakeSession("editor"));

  await reviewerApply(room, ws, (c) => c.getText("content").delete(4, 12)); // "quick brown "

  // exactly one MESSAGE_SYNC frame to the peer for this reviewer edit
  const syncFrames = peerFrames.filter((b) => decoding.readVarUint(decoding.createDecoder(new Uint8Array(b))) === 0);
  expect(syncFrames).toHaveLength(1);

  // applying that one frame to a fresh peer doc (synced to the pre-edit
  // state) converges to the repaired text
  const peerDoc = new Y.Doc();
  Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(makePreDoc("the quick brown fox")));
  const dec = decoding.createDecoder(new Uint8Array(syncFrames[0]!));
  decoding.readVarUint(dec); // MESSAGE_SYNC
  decoding.readVarString(dec); // docId
  syncProtocol.readSyncMessage(dec, encoding.createEncoder(), peerDoc, "peer");
  expect(peerDoc.getText("content").toString()).toBe("the quick brown fox");

  // and the authoritative doc is repaired too
  expect(docRoom.doc.getText("content").toString()).toBe("the quick brown fox");
});

it("an editor's write still broadcasts immediately, one frame, excluding the sender", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnv);
  const ws = { send: () => {} } as unknown as WebSocket;
  const docRoom = await room.loadDocRoom("doc1");
  (room as any).sessions.set(ws, fakeSession("editor"));
  const calls: unknown[] = [];
  const realBroadcast = room.broadcast.bind(room);
  room.broadcast = (msg: Uint8Array, except: unknown) => {
    calls.push(except);
    return realBroadcast(msg, except);
  };

  await reviewerApply(room, ws, (c) => c.getText("content").insert(0, "hello"));

  expect(calls).toEqual([ws]); // one broadcast, sender excluded — unchanged behaviour
});

it("clears the deferred buffer even if the sync frame throws", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnv);
  const ws = { send: () => {} } as unknown as WebSocket;
  const docRoom = await room.loadDocRoom("doc1");
  (room as any).sessions.set(ws, fakeSession("reviewer"));

  // a malformed sync frame: MESSAGE_SYNC + docId + garbage
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  encoding.writeVarString(enc, "doc1");
  encoding.writeVarUint(enc, 99); // not a valid sync sub-type
  await room.handleMessage(ws, encoding.toUint8Array(enc).buffer as ArrayBuffer).catch(() => {});

  expect(docRoom.deferredUpdates).toBeNull();
});
```

Add whatever tiny helpers are missing near the other helpers in the file:

```ts
function makePreDoc(text: string): Y.Doc {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  return d;
}
```

If `reviewerApply` currently seeds the room doc itself (it does — it reads `docRoom.doc` state, mutates a client copy, sends the diff), `makePreDoc` just needs to match the text the test inserted before the reviewer edit.

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "MDE-13"` and `… -t "deferred buffer"`
Expected: the MDE-13 test FAILS with `syncFrames` length 2 (raw delete + repair). The "editor" and "throws" tests may pass already — they lock in behaviour.

- [ ] **Step 3: Add the `DocRoom.deferredUpdates` field**

`src/workspace-room.ts`, `interface DocRoom` — add after `persistScheduled: boolean;`:

```ts
  // Non-null only for the duration of one reviewer sync frame's
  // apply-then-enforce: handleDocUpdate buffers every Y.Doc update here
  // instead of broadcasting, and flushDeferredReviewerBroadcast then
  // sends the raw delta + the enforceReviewerConstraints repair to peers
  // as ONE merged frame, so a peer never applies the un-repaired state
  // (MDE-13). null = broadcast each update immediately (every other case).
  deferredUpdates: Uint8Array[] | null;
```

In `loadDocRoom`, the `const docRoom: DocRoom = { … }` literal — add:

```ts
      deferredUpdates: null,
```

- [ ] **Step 4: Buffer in `handleDocUpdate`**

Replace the body of `handleDocUpdate` (keep the signature):

```ts
  handleDocUpdate(docId: string, docRoom: DocRoom, update: Uint8Array, origin: unknown): void {
    if (docRoom.deferredUpdates) {
      // A reviewer frame is mid apply+enforce — hold this update; the
      // flush after enforcement broadcasts the merged result once.
      docRoom.deferredUpdates.push(update);
      if (origin !== "storage" && origin !== "restore") {
        const editor = this.sessions.get(origin as WebSocket);
        if (editor?.username) docRoom.pendingAuthors.add(editor.username);
        this.schedulePersist(docId, docRoom);
      }
      return;
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarString(encoder, docId);
    syncProtocol.writeUpdate(encoder, update);
    this.broadcast(encoding.toUint8Array(encoder), origin);
    if (origin === "storage") return;
    const editor = this.sessions.get(origin as WebSocket);
    if (editor?.username) docRoom.pendingAuthors.add(editor.username);
    this.schedulePersist(docId, docRoom);
    if (origin !== "restore") void this.maybeSnapshot(docId, docRoom);
  }
```

- [ ] **Step 5: Add `flushDeferredReviewerBroadcast`**

Immediately after `handleDocUpdate`:

```ts
  // Send everything a reviewer sync frame produced (their raw delta plus
  // the enforceReviewerConstraints repair, both buffered by
  // handleDocUpdate while docRoom.deferredUpdates was engaged) to every
  // session as ONE merged update. Broadcast to all, not "except the
  // reviewer": Yjs re-applying the reviewer's own delta is a no-op, and
  // the reviewer needs the repair.
  flushDeferredReviewerBroadcast(docId: string, docRoom: DocRoom): void {
    const buffered = docRoom.deferredUpdates ?? [];
    docRoom.deferredUpdates = null;
    if (buffered.length === 0) return;
    const merged = Y.mergeUpdates(buffered);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarString(encoder, docId);
    syncProtocol.writeUpdate(encoder, merged);
    this.broadcast(encoding.toUint8Array(encoder), null);
    void this.maybeSnapshot(docId, docRoom);
  }
```

- [ ] **Step 6: Engage + flush in `handleMessage`**

In `handleMessage`'s `MESSAGE_SYNC` branch, inside the `await this.withDocRoom(docId, (docRoom) => { … })` callback. Currently:

```ts
        const reviewerPre = session?.role === "reviewer" ? this.captureReviewerPreState(docRoom.doc, session.username ?? "Anonymous") : null;

        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        encoding.writeVarString(encoder, docId);
        const baseLength = encoding.length(encoder);
        syncProtocol.readSyncMessage(decoder, encoder, docRoom.doc, ws);
        if (encoding.length(encoder) > baseLength) ws.send(encoding.toUint8Array(encoder));

        if (reviewerPre) this.enforceReviewerConstraints(docRoom.doc, reviewerPre);
```

Change to:

```ts
        const reviewerPre = session?.role === "reviewer" ? this.captureReviewerPreState(docRoom.doc, session.username ?? "Anonymous") : null;
        if (reviewerPre) docRoom.deferredUpdates = [];

        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        encoding.writeVarString(encoder, docId);
        const baseLength = encoding.length(encoder);
        try {
          syncProtocol.readSyncMessage(decoder, encoder, docRoom.doc, ws);
          if (encoding.length(encoder) > baseLength) ws.send(encoding.toUint8Array(encoder));
          if (reviewerPre) this.enforceReviewerConstraints(docRoom.doc, reviewerPre);
        } finally {
          if (reviewerPre) this.flushDeferredReviewerBroadcast(docId, docRoom);
        }
```

Leave the `if (isNewDoc) { … step1 … }` block that follows exactly as it is (a reviewer's very first frame for a brand-new doc is not a realistic path — reviewers join existing shared docs — but if it happens, `deferredUpdates` is already `null` again by the time the step1 `ws.send` runs, and step1 is a direct `ws.send`, not a broadcast, so it's unaffected).

- [ ] **Step 7: Run the integration tests**

Run: `npx vitest run tests/src/workspace-room.test.ts`
Expected: PASS — the MDE-13 test now sees one frame; editor + throw tests green; **every pre-existing `reviewer writes` and `WorkspaceRoom` test still green** (the MDE-05/06 reverts still land, they're just delivered merged now). If an existing test that counts broadcasts or inspects frame-by-frame delivery for a reviewer breaks, update it to expect the merged single frame — that's the intended change — and note it in the commit.

- [ ] **Step 8: `npm run typecheck`**

Run: `npm run typecheck` — Expected: 0 errors.

- [ ] **Step 9: Extend the collab e2e**

`tests/e2e/collab/suggestion-mode.spec.ts` — the MDE-05 step currently does:

```ts
await reviewer.evaluate(() => window.MDE.getActiveYDoc().getText("content").delete(0, 5));
await expect
  .poll(() => reviewer.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? ""), { timeout: 10000 })
  .toContain("owner-authored content");
await expect.poll(() => owner.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? ""), { timeout: 10000 }).toContain("owner-authored content");
```

Add, right after the reviewer's `delete(0, 5)` and before the poll, a guard that the **owner** never observes a shortened document (the merged frame means they jump straight from the pre-edit text to the repaired text):

```ts
// MDE-13 — the owner must never see the un-repaired (shorter) state:
// the reviewer's raw delete and the server's repair arrive as one frame.
const ownerLenBaseline = await owner.evaluate(() => window.MDE.getEditor().state.doc.length);
let ownerDippedBelowBaseline = false;
const stopWatch = setInterval(async () => {
  const len = await owner.evaluate(() => window.MDE.getEditor()?.state?.doc?.length ?? 0).catch(() => ownerLenBaseline);
  if (len > 0 && len < ownerLenBaseline) ownerDippedBelowBaseline = true;
}, 50);
```

and after the owner poll asserts the repaired text:

```ts
clearInterval(stopWatch);
expect(ownerDippedBelowBaseline).toBe(false);
```

(If the polling-in-`setInterval` proves flaky under CI load, fall back to a simpler assertion: `owner.evaluate` a `MutationObserver` / `window.MDE.getActiveYDoc().getText("content").observe(...)` recorded-lengths array set up *before* the reviewer delete, then assert none of the recorded lengths is between 1 and `baseline-1`. Keep whichever is stable.)

- [ ] **Step 10: Run the collab e2e**

Run: `npm run test:e2e:collab` (needs a clean `git diff -- src/worker.ts` — this plan never touches `worker.ts`, so that holds. If the sandbox browser cache is stale, apply the `playwright.config.ts` `executablePath` workaround from `CLAUDE.md`, run, then revert it before committing.)
Expected: `suggestion-mode.spec.ts` passes, `ownerDippedBelowBaseline` stays `false`.

- [ ] **Step 11: CHANGELOG + coverage + commit**

`CHANGELOG.md` — add a second bullet under the `## [1.62.4]` `### Fixed` section from Task 1:

```markdown
- A tracked-change reviewer's edit and the server's reconciliation of it now reach other collaborators as a single update, so a comment or suggestion anchored near the edit no longer flickers to "detached" for a frame while everyone catches up.
```

`docs/TEST-COVERAGE.md` — add after `SEC-14`:

```markdown
| SEC-15 | A reviewer sync frame's raw delta + the `enforceReviewerConstraints` repair are buffered (`DocRoom.deferredUpdates`) and broadcast to peers as one `Y.mergeUpdates` frame — peers never apply the un-repaired intermediate state; a non-reviewer write still broadcasts immediately, sender-excluded; the buffer is cleared on a throwing frame (MDE-13) | integration + e2e-collab | covered | `tests/src/workspace-room.test.ts`, `tests/e2e/collab/suggestion-mode.spec.ts` | v1.62.4 · external audit run-3 |
```

Bump `| 10. Workspace collab |` `61` → `62` and `| **Total** |` `331` → `332`.

```bash
npm run format
git add src/workspace-room.ts tests/src/workspace-room.test.ts tests/e2e/collab/suggestion-mode.spec.ts CHANGELOG.md docs/TEST-COVERAGE.md
git commit -m "fix(security): merge reviewer delta + repair into one peer broadcast (MDE-13)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: ROADMAP + release finish

**Files:**
- Modify: `ROADMAP.md`
- Modify: `package.json`, `package-lock.json`

### Steps

- [ ] **Step 1: ROADMAP — mark shipped + migrate non-goals**

`ROADMAP.md`, Group D "Security follow-ups" bullet (~line 155-159) — append after the existing MDE-05/06 sentence:

```markdown
  A run-3 follow-up audit of that reconciliation code then closed MDE-11..MDE-16:
  the clear-cut four (preview-socket role pin, suggestion-`add` author check,
  connect-time role re-resolve, snapshot-after-delete guard) in **v1.62.3**, and
  the reviewer repair diff + broadcast ordering (spec/plan
  `2026-09-10-reviewer-repair-diff-and-broadcast`) in **v1.62.4** — MDE-12
  (Myers-aligned repair, no whole-middle re-insert) and MDE-13 (raw delta +
  repair delivered as one merged frame).
```

In the "Deferred considerations" list, add a new checkbox item near the existing "Reviewer CRDT write constraints (v1.62.2, MDE-05/06) non-goals" one (~line 435):

```markdown
- [ ] Reviewer repair diff + broadcast (v1.62.4, MDE-12/13) non-goals:
      preventing the Yjs relative-position anchor collapse on a reviewer
      delete (needs validate-before-apply — a reviewer-sync-path rewrite;
      quote re-anchoring stays the mitigation); emitting a tight suggestion
      diff for a huge reviewer block replace instead of restoring the whole
      committed middle (D4 / SP-C granularity work); deferring broadcast for
      any non-reviewer write.
```

- [ ] **Step 2: Commit the ROADMAP**

```bash
npm run format
git add ROADMAP.md
git commit -m "docs: ROADMAP — MDE-12/13 shipped, non-goals migrated

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Version bump (last step before the PR)**

Hand-edit — do not run `npm install`:
- `package.json` line 4: `"version": "1.62.3"` → `"1.62.4"`
- `package-lock.json` line 3 and line 9: `"version": "1.62.3"` → `"1.62.4"` (both occurrences)

Verify the `CHANGELOG.md` heading is `## [1.62.4] - <today>` and there is **no** stray earlier bump on this branch (there isn't — this is the branch's only version change).

```bash
grep -n '"version": "1.62' package.json package-lock.json   # expect 1.62.4 x3
npm run format:check
git add package.json package-lock.json
git commit -m "chore: release 1.62.4 — reviewer repair diff + broadcast ordering (MDE-12/13)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Full verification before the PR**

```bash
npm test
npm run typecheck
npm run build
npm run format:check
```

Expected: all green (unit + components, tsc + svelte-check, vite build, prettier). `npm run test:e2e:local` and `:collab` also run in CI on the PR.

- [ ] **Step 5: Finish the branch**

**REQUIRED SUB-SKILL:** Use `superpowers:finishing-a-development-branch`. Base branch is `master`. Push and open a PR titled `fix(security): reviewer repair diff + broadcast ordering (MDE-12/13) — v1.62.4`; PR body summarises both findings, links the spec, and ends with the `🤖 Generated with [Claude Code](https://claude.com/claude-code)` line (and **no** `Claude-Session:` link). Wait for CI green; merge (real merge commit) only on the user's go-ahead. `auto-tag.yml` → `release.yml` → Cloudflare deploy happen on their own.

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
| --- | --- |
| MDE-12: replace `lcsOps` with bounded Myers; delete `BULK_THRESHOLD`; `MAX_EDIT_DISTANCE` fallback = whole-middle `del`+`ins` | Task 1 Step 3 |
| MDE-12: `reviewerTextRepairs` body unchanged | Task 1 (no edit to it; Step 5 only adds a test) |
| MDE-12: property "never restores more than removed" | Task 1 Step 5 |
| MDE-13: `DocRoom.deferredUpdates` field | Task 2 Step 3 |
| MDE-13: `handleDocUpdate` buffer branch, non-reviewer path unchanged | Task 2 Step 4 |
| MDE-13: `handleMessage` engage before `readSyncMessage`, flush in `finally` after `enforceReviewerConstraints` | Task 2 Step 6 |
| MDE-13: flush = one `Y.mergeUpdates` broadcast to all (`exceptWs = null`) | Task 2 Step 5 |
| MDE-13: `maybeSnapshot` once, after the flush, against the repaired doc | Task 2 Steps 4 (removed from buffer branch) + 5 (called in flush) |
| MDE-13 edge: no-repair reviewer insert → merge-of-one still converges | Task 2 Step 1 (editor test covers the merge-of-one path; a clean reviewer insert is the same shape) — **add** an explicit `it("a clean reviewer insert still converges on a peer via the merged frame")` to Task 2 Step 1 |
| MDE-13 edge: `readSyncMessage` throws → buffer cleared | Task 2 Step 1 "clears the deferred buffer" test + Step 6 `finally` |
| MDE-13 edge: non-reviewer frame never engages | Task 2 Step 1 "editor's write still broadcasts immediately" test |
| MDE-13 not-in-scope: anchor collapse stays | documented, Task 3 Step 1 deferred item |
| `CHANGELOG` `## [1.62.4]` `### Fixed`, no whats-new | Task 1 Step 7 + Task 2 Step 11 + Task 3 Step 3 |
| `TEST-COVERAGE` SEC-14 / SEC-15 + counts | Task 1 Step 7, Task 2 Step 11 |
| `ROADMAP` shipped note + non-goals | Task 3 Step 1 |
| version bump at PR time | Task 3 Step 3 |
| e2e extension in `suggestion-mode.spec.ts` | Task 2 Step 9 |

Gap found in review → **fixed**: added the explicit "clean reviewer insert converges" test to Task 2 Step 1.

```

### Add to Task 2, Step 1 (the extra test the self-review flagged)

```ts
it("a clean reviewer insert (no repair) still converges on a peer via the merged frame", async () => {
  const room = new WorkspaceRoom(fakeState(), fakeEnv);
  const ws = { send: () => {} } as unknown as WebSocket;
  const docRoom = await room.loadDocRoom("doc1");
  docRoom.doc.getText("content").insert(0, "start end");
  (room as any).sessions.set(ws, fakeSession("reviewer"));

  const peerFrames: ArrayBuffer[] = [];
  const peerWs = { send: (d: ArrayBuffer) => peerFrames.push(d) } as unknown as WebSocket;
  (room as any).sessions.set(peerWs, fakeSession("editor"));

  await reviewerApply(room, ws, (c) => c.getText("content").insert(5, " NEW"));

  const syncFrames = peerFrames.filter((b) => decoding.readVarUint(decoding.createDecoder(new Uint8Array(b))) === 0);
  expect(syncFrames.length).toBe(1);

  const peerDoc = makePreDoc("start end");
  const dec = decoding.createDecoder(new Uint8Array(syncFrames[0]!));
  decoding.readVarUint(dec);
  decoding.readVarString(dec);
  syncProtocol.readSyncMessage(dec, encoding.createEncoder(), peerDoc, "peer");
  expect(peerDoc.getText("content").toString()).toBe("start NEW end");
  expect(docRoom.doc.getText("content").toString()).toBe("start NEW end");
});
```

**2. Placeholder scan** — no "TBD"/"handle edge cases"/"similar to Task N". Every code step has literal code. The e2e step offers a named fallback strategy (not a placeholder — both variants are spelled out).

**3. Type consistency**

- `myersOps(am, bm, aBase) => DiffOp[] | null` — used only inside `diffOps`, null-checked there. ✓
- `DiffOp` shape (`type`/`aFrom`/`aTo`/`text`) — matches the existing `export interface DiffOp`. ✓
- `DocRoom.deferredUpdates: Uint8Array[] | null` — initialised `null` in `loadDocRoom`, set `[]` / read / reset `null` consistently in `handleMessage` + `handleDocUpdate` + `flushDeferredReviewerBroadcast`. ✓
- `flushDeferredReviewerBroadcast(docId: string, docRoom: DocRoom): void` — called once, in the `finally`. ✓
- `Y.mergeUpdates` / `this.broadcast(msg, null)` / `this.maybeSnapshot(docId, docRoom)` — all existing signatures. ✓
- `MAX_EDIT_DISTANCE` referenced in Task 1 code, CHANGELOG, and SEC-14 row — consistent name. ✓
