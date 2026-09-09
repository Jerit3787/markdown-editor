# Reviewer CRDT Write Constraints (MDE-05 / MDE-06) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `reviewer` role a server-enforced boundary for both CRDT types a reviewer can write (`ytext` and the `suggestions` `Y.Map`) — a reviewer can only ever *propose* changes, never delete authoritative text or self-accept a suggestion — without breaking the two legitimate reviewer flows that also delete reviewer-authored text (withdraw-own-insert and D2 self-retract).

**Architecture:** A new pure server-only module `src/reviewer-integrity.ts` computes a small prefix/suffix-trimmed diff of the document text and decides which of a reviewer's `ytext` deletions were legitimate (fell inside that reviewer's own pending insert suggestions). `WorkspaceRoom.handleMessage`, right after applying a reviewer's sync update, snapshots the pre-update text + the reviewer's own pending-insert ranges + a copy of the suggestions map, runs the check, and in one `"suggestion"`-origin transaction re-inserts any illegitimately-deleted text and re-adds any illegitimately-deleted or -modified suggestion entry. The existing `ytext.observe → reconcileReviewerDelta` (auto-wrap inserts) and the SP-B D3 `replies` guard are unchanged except for one extension.

**Tech Stack:** Yjs (`Y.Text`, `Y.Map`, relative positions), Cloudflare Workers Durable Object, Vitest (`unit`), Playwright (`collab`).

**Spec:** `docs/superpowers/specs/2026-09-10-reviewer-crdt-write-constraints-design.md`

## Global Constraints

- `src/**` + `tests/src/**` are **full-strict** TS with `noUncheckedIndexedAccess`. `src/reviewer-integrity.ts` is server-only — **not** hand-synced to `client/src/`.
- Every server `Y.Doc` write that repairs a bad client write carries transaction origin `"suggestion"` — the existing origin `reconcileReviewerDelta` and the suggestions self-heal use, and which both `ytext.observe` and `suggestionsMap.observe` skip. Do **not** introduce a new origin.
- The check runs **only for `session.role === "reviewer"`**. Editor / owner / viewer sync messages take exactly the path they take today (`viewer` writes are already dropped by the `isWrite` gate; editor/owner accept-reject is out of scope).
- Must not regress: `withdrawSuggestion` / `resolveSuggestion(id, "reject")` on a reviewer's own suggestion (one client transaction: `ytext.delete(from,to−from)` **and** `suggestionsMap.delete(id)` for an insert; `suggestionsMap.delete(id)` only for a delete-kind); and D2 (`suggestion-editor.ts`'s `suggestionTransactionFilter` — a pure deletion whose range is within the union of the author's own pending insert suggestions applies for real).
- `npm run format` + `npm run typecheck` (`tsc --noEmit` + `svelte-check`) pass. `collab` Playwright → `wrangler dev` + real `WorkspaceRoom` (started by `tests/scripts/e2e-collab.sh`, which patches `src/worker.ts` — commit `src/worker.ts` before running it; this plan touches no `src/worker.ts`).
- Release `1.62.2` (patch — behind-the-scenes security fix): `package.json` + both `package-lock.json` `"version"` fields hand-edited (lines 3, 9). `CHANGELOG.md` `### Fixed`. **No** `whats-new-entries.ts` entry.
- Never add a `Claude-Session:` trailer. `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` only.
- Branch `docs/reviewer-crdt-constraints-spec` holds the spec + this plan; do implementation work on it (the PR ships spec + plan + code together).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/reviewer-integrity.ts` (new, server-only) | Pure: `diffOps(a, b)` (prefix/suffix-trimmed, bounded LCS, bulk fallback), `unionCovers(range, ranges)`, `reviewerTextRepairs(preText, ops, ownInsertRanges)` |
| `src/workspace-room.ts` (modify) | In `handleMessage`'s MESSAGE_SYNC callback: snapshot pre-state for a reviewer, run the check after `readSyncMessage`, apply repairs. Extend the SP-B D3 `suggestionsMap.observe` guard so a reviewer `update` that changes an entry's `kind`/`author`/`from`/`to` reverts. |
| `src/suggestions.ts` (unchanged) | Referenced only — `listResolvedSuggestions` already returns `{ id, kind, author, createdAt, from, to, replies? }`. |
| `tests/src/reviewer-integrity.test.ts` (new) | Unit tests for the pure module |
| `tests/src/workspace-room.test.ts` (extend `describe("reviewer writes")`) | Integration tests driving a real `WorkspaceRoom` |
| `tests/e2e/collab/suggestion-mode.spec.ts` (extend) | A reviewer's raw `ytext.delete` of the owner's text is reverted after sync; COLLAB-11 (withdraw own) still green |
| `package.json`, `package-lock.json`, `CHANGELOG.md`, `docs/TEST-COVERAGE.md`, `ROADMAP.md` | `1.62.2` release |

---

## Task 1: `src/reviewer-integrity.ts` — the pure diff + coverage module

**Files:**
- Create: `src/reviewer-integrity.ts`
- Test: `tests/src/reviewer-integrity.test.ts`

**Interfaces:**
- Consumes: nothing (pure, no imports).
- Produces:
  ```ts
  export interface DiffOp {
    type: "keep" | "del" | "ins";
    aFrom: number; // for keep/del: start offset in `a` (0 for ins)
    aTo: number;   // for keep/del: end offset in `a` (0 for ins)
    text: string;  // for ins: the inserted text ("" for keep/del)
  }
  // Ordered edit script turning `a` into `b`. Common prefix/suffix are
  // trimmed first; the differing middle uses an LCS DP, or — when the
  // middle is larger than BULK_THRESHOLD (8192) combined — a single
  // del(whole middle) + ins(whole middle) as a conservative fallback.
  export function diffOps(a: string, b: string): DiffOp[];

  // True iff every offset in [range[0], range[1]) is inside the union of
  // `ranges` (each an inclusive-exclusive [from, to)). An empty range
  // (from === to) is trivially covered.
  export function unionCovers(range: readonly [number, number], ranges: ReadonlyArray<readonly [number, number]>): boolean;

  // Given the pre-edit text, the diff ops (from diffOps(preText, afterText)),
  // and the reviewer's own pending-insert ranges (in preText coordinates),
  // return the insertions needed to turn afterText back into a "sanitized"
  // text where only within-own-insert deletions were kept. Each repair's
  // `at` is an afterText coordinate; apply them to the live ytext in
  // DESCENDING `at` order. Empty array === the reviewer's text edits were
  // all legitimate.
  export function reviewerTextRepairs(
    preText: string,
    ops: DiffOp[],
    ownInsertRanges: ReadonlyArray<readonly [number, number]>,
  ): Array<{ at: number; text: string }>;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/src/reviewer-integrity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { diffOps, unionCovers, reviewerTextRepairs } from "../../src/reviewer-integrity";

function applyOps(a: string, ops: ReturnType<typeof diffOps>): string {
  let out = "";
  for (const op of ops) {
    if (op.type === "ins") out += op.text;
    else if (op.type === "keep") out += a.slice(op.aFrom, op.aTo);
    // del contributes nothing
  }
  return out;
}

describe("diffOps", () => {
  it("returns a single keep for identical strings", () => {
    expect(diffOps("hello", "hello")).toEqual([{ type: "keep", aFrom: 0, aTo: 5, text: "" }]);
  });

  it("round-trips a mid-string insertion", () => {
    const ops = diffOps("the fox", "the quick fox");
    expect(applyOps("the fox", ops)).toBe("the quick fox");
    expect(ops.some((o) => o.type === "ins" && o.text.includes("quick"))).toBe(true);
  });

  it("round-trips a mid-string deletion and reports the deleted range in `a` coords", () => {
    const ops = diffOps("the quick brown fox", "the fox");
    expect(applyOps("the quick brown fox", ops)).toBe("the fox");
    const del = ops.find((o) => o.type === "del")!;
    expect("the quick brown fox".slice(del.aFrom, del.aTo)).toBe("quick brown ");
  });

  it("round-trips a replacement (del + ins)", () => {
    const ops = diffOps("color me", "colour me");
    expect(applyOps("color me", ops)).toBe("colour me");
  });

  it("falls back to one del + one ins for a bulk change past the threshold", () => {
    const a = "PFX " + "x".repeat(9000) + " SFX";
    const b = "PFX " + "y".repeat(9000) + " SFX";
    const ops = diffOps(a, b);
    expect(applyOps(a, ops)).toBe(b);
    expect(ops.filter((o) => o.type === "del")).toHaveLength(1);
    expect(ops.filter((o) => o.type === "ins")).toHaveLength(1);
  });
});

describe("unionCovers", () => {
  it("covers a range fully inside one span", () => {
    expect(unionCovers([3, 7], [[0, 10]])).toBe(true);
  });
  it("covers a range spanning two touching spans", () => {
    expect(unionCovers([2, 8], [[0, 5], [5, 10]])).toBe(true);
  });
  it("rejects a range poking outside every span", () => {
    expect(unionCovers([2, 12], [[0, 10]])).toBe(false);
    expect(unionCovers([0, 3], [[5, 10]])).toBe(false);
  });
  it("treats an empty range as covered", () => {
    expect(unionCovers([4, 4], [])).toBe(true);
  });
});

describe("reviewerTextRepairs", () => {
  const R = (pre: string, after: string, own: Array<[number, number]>) => reviewerTextRepairs(pre, diffOps(pre, after), own);

  it("no repairs when the reviewer only inserted", () => {
    expect(R("the fox", "the quick fox", [])).toEqual([]);
  });

  it("no repairs when the deletion was fully inside the reviewer's own pending insert", () => {
    // pre: "keep XXXX end", the reviewer's own pending insert is [5,9) ("XXXX")
    expect(R("keep XXXX end", "keep  end", [[5, 9]])).toEqual([]);
  });

  it("restores committed text the reviewer deleted outside their own inserts", () => {
    // reviewer deleted "quick brown " (committed) — must be put back
    const repairs = R("the quick brown fox", "the fox", []);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toEqual({ at: 4, text: "quick brown " });
  });

  it("restores only the out-of-bounds part of a mixed deletion", () => {
    // pre: "AA OWN BB", own insert covers [3,6) ("OWN"); reviewer deleted
    // "A OWN B" (indices 1..8) — the "A " and " B" parts are committed.
    const repairs = R("AA OWN BB", "AB", [[3, 6]]);
    // sanitized should be "AA  BB" -> afterText "AB"; repairs turn "AB" back
    // into "AA  BB" (restoring "A " before B and " B" after)... assert the
    // net effect rather than exact op split:
    let out = "AB";
    for (const rp of [...repairs].sort((a, b) => b.at - a.at)) out = out.slice(0, rp.at) + rp.text + out.slice(rp.at);
    expect(out).toBe("AA  BB");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/src/reviewer-integrity.test.ts`
Expected: FAIL — module `src/reviewer-integrity.ts` not found.

- [ ] **Step 3: Implement `src/reviewer-integrity.ts`**

```ts
// Pure, server-only. Decides which of a reviewer's ytext edits were
// legitimate: a reviewer may insert anywhere (auto-wrapped as a
// suggestion elsewhere) but may only DELETE text that was inside their
// own pending insert suggestion(s). Everything else must be restored.
// Not hand-synced with client/src/.

export interface DiffOp {
  type: "keep" | "del" | "ins";
  aFrom: number;
  aTo: number;
  text: string;
}

const BULK_THRESHOLD = 8192;

export function diffOps(a: string, b: string): DiffOp[] {
  // Trim common prefix / suffix — a reviewer keystroke changes a tiny
  // middle; the LCS DP below then runs on a bounded region.
  let p = 0;
  const maxP = Math.min(a.length, b.length);
  while (p < maxP && a[p] === b[p]) p++;
  let s = 0;
  const maxS = Math.min(a.length - p, b.length - p);
  while (s < maxS && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;

  const aMidFrom = p;
  const aMidTo = a.length - s;
  const bMid = b.slice(p, b.length - s);
  const aMid = a.slice(aMidFrom, aMidTo);

  const ops: DiffOp[] = [];
  if (p > 0) ops.push({ type: "keep", aFrom: 0, aTo: p, text: "" });

  if (aMid.length === 0 && bMid.length === 0) {
    // pure prefix/suffix match — nothing in the middle
  } else if (aMid.length === 0) {
    ops.push({ type: "ins", aFrom: 0, aTo: 0, text: bMid });
  } else if (bMid.length === 0) {
    ops.push({ type: "del", aFrom: aMidFrom, aTo: aMidTo, text: "" });
  } else if (aMid.length + bMid.length > BULK_THRESHOLD) {
    ops.push({ type: "del", aFrom: aMidFrom, aTo: aMidTo, text: "" });
    ops.push({ type: "ins", aFrom: 0, aTo: 0, text: bMid });
  } else {
    ops.push(...lcsOps(aMid, bMid, aMidFrom));
  }

  if (s > 0) ops.push({ type: "keep", aFrom: a.length - s, aTo: a.length, text: "" });
  return coalesce(ops);
}

// Classic LCS DP over the trimmed middles, emitting ops in a-order.
// `aBase` is added to every a-coordinate so callers get offsets into the
// original string.
function lcsOps(am: string, bm: string, aBase: number): DiffOp[] {
  const n = am.length;
  const m = bm.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = am[i] === bm[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (am[i] === bm[j]) {
      out.push({ type: "keep", aFrom: aBase + i, aTo: aBase + i + 1, text: "" });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: "del", aFrom: aBase + i, aTo: aBase + i + 1, text: "" });
      i++;
    } else {
      out.push({ type: "ins", aFrom: 0, aTo: 0, text: bm[j]! });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: "del", aFrom: aBase + i, aTo: aBase + i + 1, text: "" });
    i++;
  }
  while (j < m) {
    out.push({ type: "ins", aFrom: 0, aTo: 0, text: bm[j]! });
    j++;
  }
  return out;
}

// Merge adjacent same-type ops (keep+keep, del+del, ins+ins).
function coalesce(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && last.type === op.type && op.type !== "ins" && last.aTo === op.aFrom) {
      last.aTo = op.aTo;
    } else if (last && last.type === "ins" && op.type === "ins") {
      last.text += op.text;
    } else {
      out.push({ ...op });
    }
  }
  return out;
}

export function unionCovers(range: readonly [number, number], ranges: ReadonlyArray<readonly [number, number]>): boolean {
  if (range[0] >= range[1]) return true;
  const sorted = [...ranges].filter((r) => r[1] > r[0]).sort((x, y) => x[0] - y[0]);
  let cursor = range[0];
  for (const [from, to] of sorted) {
    if (from > cursor) break;
    if (to > cursor) cursor = to;
    if (cursor >= range[1]) return true;
  }
  return cursor >= range[1];
}

export function reviewerTextRepairs(
  preText: string,
  ops: DiffOp[],
  ownInsertRanges: ReadonlyArray<readonly [number, number]>,
): Array<{ at: number; text: string }> {
  const repairs: Array<{ at: number; text: string }> = [];
  let out = 0; // running length of the afterText-equivalent output
  for (const op of ops) {
    if (op.type === "keep") {
      out += op.aTo - op.aFrom;
    } else if (op.type === "ins") {
      out += op.text.length;
    } else {
      // a deletion — legit only if fully inside the reviewer's own inserts
      if (unionCovers([op.aFrom, op.aTo], ownInsertRanges)) {
        // legitimate: the chars are gone from afterText, nothing to do
      } else {
        repairs.push({ at: out, text: preText.slice(op.aFrom, op.aTo) });
        // restored text is NOT in afterText → `out` does not advance
      }
    }
  }
  return repairs;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/src/reviewer-integrity.test.ts && npm run typecheck`
Expected: PASS (all). Fix any `noUncheckedIndexedAccess` complaint with a `!` only where the loop bounds already guarantee the index.

- [ ] **Step 5: Commit**

```bash
git add src/reviewer-integrity.ts tests/src/reviewer-integrity.test.ts
git commit -m "$(cat <<'EOF'
feat(security): pure diff + own-insert coverage for reviewer edits

src/reviewer-integrity.ts — diffOps (prefix/suffix trim + bounded LCS +
bulk fallback), unionCovers, and reviewerTextRepairs, which returns the
insertions needed to undo any ytext deletion a reviewer made outside
their own pending insert suggestions.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Server — enforce the reviewer `ytext`-deletion boundary (MDE-05)

**Files:**
- Modify: `src/workspace-room.ts` — `handleMessage`'s MESSAGE_SYNC callback; a new private `enforceReviewerConstraints`
- Test: `tests/src/workspace-room.test.ts` (extend `describe("reviewer writes")`)

**Interfaces:**
- Consumes: `diffOps`, `reviewerTextRepairs` from `./reviewer-integrity`; `getSuggestionsMap`, `listResolvedSuggestions`, `type SuggestionEntry` from `./suggestions` (already imported).
- Produces: behaviour only — no new export.

- [ ] **Step 1: Write the failing integration tests**

In `tests/src/workspace-room.test.ts`, inside `describe("reviewer writes", () => { … })`, add a helper and tests. The block already has `fakeSession(role)` (returns `{ username: "bob", role, viewingDocId: null }`) and `scratchUpdateWith`; `encodeSyncUpdate` is a top-level helper.

```ts
  // Sync a client Y.Doc to the room, mutate it, send the diff as `ws`.
  async function reviewerApply(room: WorkspaceRoom, ws: WebSocket, mutate: (client: Y.Doc) => void) {
    const docRoom = await room.loadDocRoom("doc1");
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(docRoom.doc));
    const before = Y.encodeStateVector(client);
    mutate(client);
    await room.handleMessage(ws, encodeSyncUpdate("doc1", Y.encodeStateAsUpdate(client, before)));
    return docRoom;
  }

  it("reverts a reviewer's raw deletion of committed text (MDE-05)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "the quick brown fox");
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    await reviewerApply(room, ws, (c) => {
      const t = c.getText("content");
      t.delete(4, 12); // "quick brown "
    });

    expect(docRoom.doc.getText("content").toString()).toBe("the quick brown fox");
    expect(getSuggestionsMap(docRoom.doc).size).toBe(0); // no bogus delete-suggestion fabricated
  });

  it("allows a reviewer to delete inside their own pending insert (D2)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "start end");
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    // reviewer types " MIDDLE" at 5 (becomes a suggestion), then backspaces "DLE"
    await reviewerApply(room, ws, (c) => c.getText("content").insert(5, " MIDDLE"));
    await reviewerApply(room, ws, (c) => c.getText("content").delete(9, 3)); // delete "DLE" from " MIDDLE"

    expect(docRoom.doc.getText("content").toString()).toBe("start MID end");
  });

  it("allows a reviewer to withdraw their own pending insert (delete text + entry in one txn)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "start end");
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    await reviewerApply(room, ws, (c) => c.getText("content").insert(5, " NEW"));
    const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;

    await reviewerApply(room, ws, (c) => {
      const s = listResolvedSuggestions(c).find((x) => x.id === sid)!;
      c.transact(() => {
        c.getText("content").delete(s.from, s.to - s.from);
        getSuggestionsMap(c).delete(sid);
      });
    });

    expect(docRoom.doc.getText("content").toString()).toBe("start end");
    expect(getSuggestionsMap(docRoom.doc).size).toBe(0);
  });

  it("an editor's raw deletion is untouched", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "the quick brown fox");
    (room as any).sessions.set(ws, fakeSession("editor"));

    await reviewerApply(room, ws, (c) => c.getText("content").delete(4, 12));

    expect(docRoom.doc.getText("content").toString()).toBe("the fox");
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "reviewer writes"`
Expected: FAIL — "reverts a reviewer's raw deletion" (text is `"the fox"`, not restored) and "allows … withdraw" may fail depending on current behaviour; "D2" and "editor" pass already.

- [ ] **Step 3: Add the pre-state snapshot + enforcement to `handleMessage`**

In `src/workspace-room.ts`, add the imports to the existing `./reviewer-integrity` line group (top of file, after the `./suggestions` import):

```ts
import { diffOps, reviewerTextRepairs } from "./reviewer-integrity";
```

In `handleMessage`, the `MESSAGE_SYNC` branch, replace the `await this.withDocRoom(docId, (docRoom) => { … })` call's body so it snapshots and enforces around `readSyncMessage`:

```ts
      await this.withDocRoom(docId, (docRoom) => {
        const reviewerPre =
          session?.role === "reviewer" ? this.captureReviewerPreState(docRoom.doc, session.username ?? "Anonymous") : null;

        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        encoding.writeVarString(encoder, docId);
        const baseLength = encoding.length(encoder);
        syncProtocol.readSyncMessage(decoder, encoder, docRoom.doc, ws);
        if (encoding.length(encoder) > baseLength) ws.send(encoding.toUint8Array(encoder));

        if (reviewerPre) this.enforceReviewerConstraints(docRoom.doc, reviewerPre);

        if (isNewDoc) {
          const step1Encoder = encoding.createEncoder();
          encoding.writeVarUint(step1Encoder, MESSAGE_SYNC);
          encoding.writeVarString(step1Encoder, docId);
          syncProtocol.writeSyncStep1(step1Encoder, docRoom.doc);
          ws.send(encoding.toUint8Array(step1Encoder));
        }
      });
```

Add the two private methods (near `withDocRoom`):

```ts
  private captureReviewerPreState(doc: Y.Doc, username: string) {
    const ytext = doc.getText("content");
    const ownInsertRanges: Array<[number, number]> = [];
    const ownInsertEntryRanges = new Map<string, [number, number]>();
    for (const s of listResolvedSuggestions(doc)) {
      if (s.kind === "insert" && s.author === username) {
        ownInsertRanges.push([s.from, s.to]);
        ownInsertEntryRanges.set(s.id, [s.from, s.to]);
      }
    }
    return {
      username,
      text: ytext.toString(),
      ownInsertRanges,
      ownInsertEntryRanges,
      entriesById: new Map<string, SuggestionEntry>(getSuggestionsMap(doc).entries()),
    };
  }

  private enforceReviewerConstraints(doc: Y.Doc, pre: ReturnType<WorkspaceRoom["captureReviewerPreState"]>): void {
    const ytext = doc.getText("content");
    const ops = diffOps(pre.text, ytext.toString());
    const repairs = reviewerTextRepairs(pre.text, ops, pre.ownInsertRanges);
    if (repairs.length === 0) return;
    doc.transact(() => {
      for (const r of [...repairs].sort((a, b) => b.at - a.at)) ytext.insert(r.at, r.text);
    }, "suggestion");
  }
```

(Task 3 extends `enforceReviewerConstraints` with the suggestions-map checks; the `ops` / `pre.ownInsertEntryRanges` / `pre.entriesById` it captures are already here for that.)

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/src/workspace-room.test.ts && npm run typecheck`
Expected: PASS — the whole file. The `reconcileReviewerDelta` auto-wrap tests still pass (a reviewer's *insert* is untouched by the new code; only illegitimate deletes are repaired, and the repair transaction's `"suggestion"` origin is skipped by both observers).

- [ ] **Step 5: Commit**

```bash
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "$(cat <<'EOF'
fix(security): a reviewer can't delete document text directly (MDE-05)

After a reviewer's sync update applies, the server diffs the document
text against a pre-update snapshot and re-inserts any run the reviewer
deleted that wasn't inside their own pending insert suggestion(s), in a
"suggestion"-origin transaction the observers skip. Withdraw-own-insert
and D2 self-retract (deletions inside own inserts) are unaffected;
editor/owner writes never hit this path.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Server — reviewer can't delete or re-target a suggestion entry to self-accept (MDE-06)

**Files:**
- Modify: `src/workspace-room.ts` — extend `enforceReviewerConstraints`; extend the SP-B D3 `suggestionsMap.observe` guard
- Test: `tests/src/workspace-room.test.ts` (extend `describe("reviewer writes")`)

**Interfaces:**
- Consumes: `pre.entriesById`, `pre.ownInsertEntryRanges`, `ops` from Task 2's `enforceReviewerConstraints`; `unionCovers` from `./reviewer-integrity`.
- Produces: behaviour only.

- [ ] **Step 1: Write the failing tests**

Add to `describe("reviewer writes", …)`:

```ts
  it("reverts a reviewer deleting their own insert entry while the text stays (self-accept) (MDE-06)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "start end");
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    await reviewerApply(room, ws, (c) => c.getText("content").insert(5, " NEW"));
    const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;

    await reviewerApply(room, ws, (c) => getSuggestionsMap(c).delete(sid)); // text " NEW" left behind

    expect(getSuggestionsMap(docRoom.doc).has(sid)).toBe(true); // entry restored
    expect(listResolvedSuggestions(docRoom.doc)[0]).toMatchObject({ kind: "insert", author: "bob" });
  });

  it("reverts a reviewer deleting another author's suggestion entry (MDE-06)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "hello world");
    recordInsertSuggestion(docRoom.doc, 0, 5, "alice"); // alice's, not bob's
    const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;
    (room as any).sessions.set(ws, fakeSession("reviewer")); // bob

    await reviewerApply(room, ws, (c) => getSuggestionsMap(c).delete(sid));

    expect(getSuggestionsMap(docRoom.doc).has(sid)).toBe(true);
  });

  it("allows a reviewer to withdraw their own DELETE-kind suggestion (no text change)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "hello world");
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    await reviewerApply(room, ws, (c) => recordDeleteSuggestion(c, 0, 5, "bob"));
    const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;
    await reviewerApply(room, ws, (c) => getSuggestionsMap(c).delete(sid));

    expect(getSuggestionsMap(docRoom.doc).has(sid)).toBe(false); // allowed
  });

  it("an editor accepting an insert (delete entry, keep text) is untouched", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "start NEW end");
    recordInsertSuggestion(docRoom.doc, 5, 9, "bob");
    const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;
    (room as any).sessions.set(ws, fakeSession("editor"));

    await reviewerApply(room, ws, (c) => getSuggestionsMap(c).delete(sid));

    expect(getSuggestionsMap(docRoom.doc).has(sid)).toBe(false); // editor accept stands
    expect(docRoom.doc.getText("content").toString()).toBe("start NEW end");
  });

  it("reverts a reviewer re-targeting a suggestion entry's range/kind/author", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "hello world");
    recordInsertSuggestion(docRoom.doc, 0, 5, "bob");
    const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    await reviewerApply(room, ws, (c) => {
      const m = getSuggestionsMap(c);
      const e = m.get(sid)!;
      m.set(sid, { ...e, kind: "delete" }); // flip kind
    });

    expect(getSuggestionsMap(docRoom.doc).get(sid)).toMatchObject({ kind: "insert" });
  });
```

Ensure `recordDeleteSuggestion` is in the file's imports from `../../src/suggestions` (it is — used elsewhere).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "reviewer writes"`
Expected: FAIL on the self-accept, foreign-delete, and re-target tests.

- [ ] **Step 3: Extend `enforceReviewerConstraints` with the suggestions-map checks**

Add `unionCovers` to the `./reviewer-integrity` import. Replace the body of `enforceReviewerConstraints` from Task 2 with:

```ts
  private enforceReviewerConstraints(doc: Y.Doc, pre: ReturnType<WorkspaceRoom["captureReviewerPreState"]>): void {
    const ytext = doc.getText("content");
    const map = getSuggestionsMap(doc);
    const ops = diffOps(pre.text, ytext.toString());
    const delRanges: Array<[number, number]> = ops
      .filter((o) => o.type === "del")
      .map((o) => [o.aFrom, o.aTo]);
    const textRepairs = reviewerTextRepairs(pre.text, ops, pre.ownInsertRanges);

    const entryReverts: Array<() => void> = [];
    for (const [id, old] of pre.entriesById) {
      if (map.has(id)) continue; // not deleted this transaction
      if (old.author !== pre.username) {
        entryReverts.push(() => map.set(id, old)); // not yours to discard
        continue;
      }
      if (old.kind === "delete") continue; // withdrawing a proposed deletion — no text implication, allowed
      // own insert entry deleted — legitimate ONLY if this same transaction
      // also removed the entry's whole text range (a real withdraw). If the
      // text is still there, it's a unilateral self-accept.
      const range = pre.ownInsertEntryRanges.get(id);
      if (!range || !unionCovers(range, delRanges)) entryReverts.push(() => map.set(id, old));
    }

    if (textRepairs.length === 0 && entryReverts.length === 0) return;
    doc.transact(() => {
      for (const r of [...textRepairs].sort((a, b) => b.at - a.at)) ytext.insert(r.at, r.text);
      for (const revert of entryReverts) revert();
    }, "suggestion");
  }
```

- [ ] **Step 4: Extend the SP-B D3 `suggestionsMap.observe` guard**

In `loadDocRoom`'s `suggestionsMap.observe((event, transaction) => { … })`, the SP-B D3 block currently only reverts a bad `replies` change on an `update`. Widen it so a reviewer `update` that changes `kind`, `author`, `from` or `to` also reverts (the `enforceReviewerConstraints` path handles deletes; this handles in-place mutation, which arrives as an `update`):

Replace the inner `event.changes.keys.forEach` body in that block with:

```ts
          event.changes.keys.forEach((change, key) => {
            if (change.action !== "update") return;
            const now = suggestionsMap.get(key);
            const old = change.oldValue as SuggestionEntry;
            if (!now) return;
            // Structural fields a reviewer may never edit in place.
            const structuralChanged =
              now.kind !== old.kind ||
              now.author !== old.author ||
              JSON.stringify(now.from) !== JSON.stringify(old.from) ||
              JSON.stringify(now.to) !== JSON.stringify(old.to);
            const oldReplies = old.replies ?? [];
            const newReplies = now.replies ?? [];
            const prefixMatches = (n: number) =>
              oldReplies.slice(0, n).every((r, i) => r.author === newReplies[i]?.author && r.body === newReplies[i]?.body);
            const repliesUnchanged = newReplies.length === oldReplies.length && prefixMatches(oldReplies.length);
            const appendedBySelf =
              newReplies.length === oldReplies.length + 1 &&
              prefixMatches(oldReplies.length) &&
              newReplies[newReplies.length - 1]?.author === actor;
            if (structuralChanged || (!repliesUnchanged && !appendedBySelf)) {
              replyReverts.push(() => suggestionsMap.set(key, old));
            }
          });
```

(The `actor` / `replyReverts` / outer `if (transaction.origin !== "suggestion")` + role guard already exist from SP-B.)

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/src/workspace-room.test.ts && npm run typecheck`
Expected: PASS — the whole file, including the SP-B D3 tests (`D3: a foreign-authored reply appended to a suggestion is reverted`, `D3: a self-authored reply on a suggestion is kept`) and all `reviewer writes` tests.

- [ ] **Step 6: Commit**

```bash
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "$(cat <<'EOF'
fix(security): a reviewer can't self-accept or discard a suggestion (MDE-06)

enforceReviewerConstraints now also reverts: a reviewer deleting another
author's suggestion entry; a reviewer deleting their own INSERT entry
without the same transaction removing its text (a unilateral self-accept
— withdrawing a DELETE-kind entry, or an insert entry whose text also
went, is still allowed). The suggestions observer's D3 guard is widened
to revert an in-place kind/author/range edit too. Editor/owner
accept-reject is untouched.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: e2e — reviewer boundary over a real WebSocket

**Files:**
- Modify: `tests/e2e/collab/suggestion-mode.spec.ts`

- [ ] **Step 1: Add the e2e assertion**

In `tests/e2e/collab/suggestion-mode.spec.ts`, in the main `"a reviewer's edits become suggestions an editor can accept or reject…"` test, after the reviewer has joined and the owner's content is confirmed present on the reviewer side (before the reviewer starts typing suggestions), add:

```ts
  // MDE-05 — a hostile reviewer client deleting the owner's text directly
  // is reverted by the server.
  await reviewer.evaluate(() => {
    const t = window.MDE.getActiveYDoc().getText("content");
    t.delete(0, 5); // chop the first 5 chars of committed text
  });
  await expect
    .poll(() => reviewer.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? ""), { timeout: 10000 })
    .toContain("owner-authored content");
  await expect
    .poll(() => owner.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? ""), { timeout: 10000 })
    .toContain("owner-authored content");
```

The existing COLLAB-11 test (`tests/e2e/collab/suggestion-mode.spec.ts:201` — "a reviewer withdraws their own pending suggestion, and it clears for both sides") is the withdraw-own regression guard — do not modify it; it must stay green.

- [ ] **Step 2: Run the collab suite**

Run: `npm run test:e2e:collab`
Expected: PASS — all of it (`suggestion-mode`, `comments-collab`, `annotation-rail`, `live-sync`, …).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/collab/suggestion-mode.spec.ts
git commit -m "$(cat <<'EOF'
test(security): reviewer raw ytext delete reverts over a real socket

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Release 1.62.2

**Files:** `package.json`, `package-lock.json`, `CHANGELOG.md`, `docs/TEST-COVERAGE.md`, `ROADMAP.md`

- [ ] **Step 1: Version bump**

`package.json`: `"version": "1.62.1"` → `"1.62.2"`. `package-lock.json` lines 3 and 9 likewise. Do not regenerate the lockfile.

- [ ] **Step 2: CHANGELOG**

Insert above `## [1.62.1] - 2026-09-10`:

```markdown
## [1.62.2] - 2026-09-10

### Fixed

- A reviewer (Suggesting mode) can no longer delete document text directly or accept their own suggestions without an editor — the server now enforces that a reviewer only ever *proposes* changes. Withdrawing your own pending suggestion still works exactly as before.
```

- [ ] **Step 3: TEST-COVERAGE**

In `docs/TEST-COVERAGE.md`, extend the `COLLAB-05` row (reviewer writes) — append to its Scenario cell:
`; a reviewer's raw ytext deletion of committed text is reverted (only deletions inside the reviewer's own pending inserts apply — D2 / withdraw-own); a reviewer deleting or re-targeting a suggestion entry to self-accept or discard is reverted (MDE-05 / MDE-06)` and add `tests/src/reviewer-integrity.test.ts` + the extended `tests/e2e/collab/suggestion-mode.spec.ts` to its Test cell. Bump the §10 "Workspace collab" covered/total counts by 1 (new `reviewer-integrity` unit row) and the grand total line.

- [ ] **Step 4: ROADMAP**

In `ROADMAP.md`, under the Group D block, add a line to the D-series notes:
`- Security follow-ups: the reviewer role is now a server-enforced write boundary for both ytext and the suggestions map (spec/plan 2026-09-10-reviewer-crdt-write-constraints, shipped v1.62.2) — closes audit findings MDE-05 / MDE-06.`
Copy this spec's Non-goals into the "Deferred considerations" list (reviewer edits to imagesMap/metaMap; converting an illegitimate reviewer deletion into a delete-suggestion rather than a plain revert; moving suggestion resolution off the CRDT).

- [ ] **Step 5: Full verification**

```bash
npm run format && npm test && npm run typecheck && npm run format:check && npm run test:e2e:local
```
Expected: all PASS. The dev-only `WhatsNew: no announcement entry for the current version (1.62.2)` console warning is expected for a patch release (no whats-new entry) — same as v1.61.1 / v1.61.2 / v1.62.1.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: release 1.62.2 — reviewer CRDT write boundary (MDE-05 / MDE-06)

CHANGELOG ### Fixed. Patch release, no What's New entry. TEST-COVERAGE
COLLAB-05 + reviewer-integrity; ROADMAP Group D security follow-ups.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| Goal — reviewer server-enforced for `ytext` + `suggestions` map | Tasks 2, 3 |
| MDE-05 — reviewer arbitrary text deletion | Task 2 (`reviewerTextRepairs` + `enforceReviewerConstraints`) |
| MDE-06 — reviewer suggestion self-accept / foreign discard | Task 3 (entry-delete + entry-update guards) |
| The invariant (both halves) | Task 1 (`unionCovers`), Task 2 (text half), Task 3 (map half) |
| Legit flow 1 — withdraw-own (insert: text + entry; delete: entry only) | Task 2 test "allows … withdraw their own pending insert", Task 3 test "allows … withdraw their own DELETE-kind" |
| Legit flow 2 — D2 self-retract | Task 2 test "allows a reviewer to delete inside their own pending insert" |
| Editor/owner untouched | Task 2 test "an editor's raw deletion is untouched", Task 3 test "an editor accepting an insert … is untouched" |
| Design — check runs in `handleMessage` post-apply, `"suggestion"` origin, reviewer-only | Task 2 Step 3 |
| Design — `captureReviewerPreState` (text, ownInsertRanges, entriesById) | Task 2 Step 3 |
| Design — `enforceReviewerConstraints` steps 1-3 | Task 2 (text), Task 3 (map deletes + `suggestions.observe` update guard) |
| Rejected alternative — full snapshot+revert / wire-level block | documented in the spec; plan follows the chosen design |
| Testing — unit (`reviewer-integrity`), integration (`workspace-room` reviewer writes), e2e (`suggestion-mode`) | Tasks 1, 2, 3, 4 |
| Rollout — `1.62.2`, CHANGELOG `### Fixed`, no whats-new, TEST-COVERAGE, ROADMAP | Task 5 |
| Open risk 1 — diff cost | `diffOps` prefix/suffix trim + `BULK_THRESHOLD` fallback (Task 1) |
| Open risk 2 — split-update withdraw fails closed | acceptable per spec; the real client does both in one `doc.transact` (Task 2/3 tests use one transaction, matching `resolveSuggestion`) |
| Open risk 3 — role staleness | already handled by MDE-02's `reconcileSessionRoles` (shipped v1.62.1) — no work here |

No gaps.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Task 3 Step 4 quotes the full replacement `forEach` body rather than referring back to SP-B. Task 2 Step 3 and Task 3 Step 3 both give the complete `enforceReviewerConstraints` (Task 3's supersedes Task 2's — called out explicitly). The e2e snippet (Task 4) names the exact host test and insertion point.

**3. Type consistency:** `DiffOp` (`type`/`aFrom`/`aTo`/`text`) — same in Task 1's Produces, the module, and Task 2/3's `ops.filter(o => o.type === "del")`. `reviewerTextRepairs(preText, ops, ownInsertRanges) → Array<{at, text}>` — Task 1, Task 2 Step 3, Task 3 Step 3. `unionCovers(range, ranges) → boolean` — Task 1, Task 3 Step 3. `captureReviewerPreState` returns `{ username, text, ownInsertRanges, ownInsertEntryRanges, entriesById }` — defined Task 2 Step 3, consumed Task 3 Step 3 (`pre.entriesById`, `pre.ownInsertEntryRanges`). `SuggestionEntry` — imported in `workspace-room.ts` already (SP-B added it to the type import); used as `change.oldValue as SuggestionEntry` in Task 3 Step 4, matching the existing SP-B code. `listResolvedSuggestions(doc)` returns `{ id, kind, author, createdAt, from, to, replies? }` — used for `ownInsertRanges`/`ownInsertEntryRanges` in Task 2 Step 3.

**Fix applied during review:** Task 2's `enforceReviewerConstraints` is a deliberate first cut that Task 3 replaces wholesale — Task 3 Step 3 now says "Replace the body of `enforceReviewerConstraints` from Task 2" so an executor reading Task 3 alone rewrites the whole method rather than trying to merge.
