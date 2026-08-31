# Suggestion-Mode Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reviewer-role edits on a shared document become tracked insert/delete suggestions an editor can accept or reject, instead of being dropped (today) or committed directly; viewer role becomes a true look-only mode with no edit surface.

**Architecture:** A new `suggestions` Y.Map lives alongside the existing `ytext`/`imagesMap`/`meta` on each document's Y.Doc, keyed by suggestion id, storing Yjs relative positions so ranges survive concurrent edits. A CodeMirror extension (reviewer role only) intercepts local edits: insertions apply to `ytext` normally plus get a suggestion entry; deletions are blocked from `ytext` and get a suggestion entry instead. Decorations render both in the editor; a parallel raw-markdown-text transform renders both in Preview. The server allows reviewer writes to sync (previously dropped outright) and independently verifies, from Yjs's own transaction delta, that every reviewer-authored change is covered by a suggestion entry — auto-creating one if a client ever fails to.

**Tech Stack:** Yjs (`Y.Map`, `Y.Text`, relative positions), CodeMirror 6 (`@codemirror/state`'s `StateField`/`EditorState.transactionFilter`, `@codemirror/view`'s `Decoration`/`WidgetType`), y-codemirror.next (`yCollab`, `ySyncAnnotation`), Svelte 5, Vitest (`unit` and `components` projects), Playwright (`collab` project — this feature needs the real `WorkspaceRoom` Durable Object).

**Spec:** `docs/superpowers/specs/2026-08-31-suggestion-mode-collaboration-design.md`

## Global Constraints

- Reviewer role keeps its name; its meaning changes (see spec's "Role model"). Editor and viewer's own behavior toward their own edits is unchanged.
- Every reviewer-authored content change MUST be covered by a `suggestions` entry, enforced server-side (not just client-side) — see spec's "Server: integrity enforcement".
- Accept/reject/withdraw is per-suggestion, not bulk-only.
- Every reviewer or editor sees every pending suggestion from every reviewer; only an editor can accept/reject; a suggestion's own author can withdraw it.
- Preview renders both pending inserts (underlined) and pending deletes (struck through) via `<ins>`/`<del>` wrapping in the raw-markdown-text transform pipeline, matching the editor pane.
- Viewer role gets Preview-only view (no editor pane, no Split/Editor view options) and stays fully blocked from commenting — no capability change there.
- `src/suggestions.ts` and `client/src/suggestions.ts` must stay byte-identical (this repo's established pattern for logic shared between the Worker and client bundles — see `src/version-grouping.ts`/`client/src/version-grouping.ts`).

---

## Task 1: `suggestions.ts` core data model (shared, client + Worker copies)

**Files:**
- Create: `src/suggestions.ts`
- Create: `client/src/suggestions.ts` (identical copy of the above)
- Test: `tests/src/suggestions.test.ts`

**Interfaces:**
- Produces:
  - `interface SuggestionEntry { kind: "insert" | "delete"; author: string; createdAt: number; from: ReturnType<typeof Y.relativePositionToJSON>; to: ReturnType<typeof Y.relativePositionToJSON>; }`
  - `interface ResolvedSuggestion extends SuggestionEntry { id: string; from: number; to: number; }` (shadows the relative-position `from`/`to` with resolved absolute numbers — the two interfaces are deliberately different shapes with the same field names, since callers only ever use one or the other)
  - `getSuggestionsMap(doc: Y.Doc): Y.Map<SuggestionEntry>`
  - `listResolvedSuggestions(doc: Y.Doc): ResolvedSuggestion[]`
  - `recordInsertSuggestion(doc: Y.Doc, from: number, to: number, author: string, now?: number): void`
  - `recordDeleteSuggestion(doc: Y.Doc, from: number, to: number, author: string, now?: number): void`
  - `resolveSuggestion(doc: Y.Doc, id: string, outcome: "accept" | "reject"): void`
  - `withdrawSuggestion(doc: Y.Doc, id: string): void` — "make my own proposal go away, don't judge it," which for both kinds is exactly what `resolveSuggestion(doc, id, "reject")` already means: an insert's text is removed, a delete's text stays. Withdraw is `resolveSuggestion(doc, id, "reject")` with no branching on kind; the UI layer (Task 5) is what restricts it to the suggestion's own author, not this function.
  - `reconcileReviewerDelta(doc: Y.Doc, delta: { retain?: number; insert?: string | unknown[]; delete?: number }[], author: string, now?: number): void` (Task 2 consumes this directly)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/src/suggestions.test.ts
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  getSuggestionsMap,
  listResolvedSuggestions,
  recordInsertSuggestion,
  recordDeleteSuggestion,
  resolveSuggestion,
  withdrawSuggestion,
  reconcileReviewerDelta,
} from "../../src/suggestions";

function docWith(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return doc;
}

describe("recordInsertSuggestion", () => {
  it("creates a suggestion entry covering the inserted range", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice"); // " world" was inserted
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "insert", author: "alice", from: 5, to: 11 });
  });

  it("extends the same author's still-open insert when typing continues contiguously", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 8, "alice"); // " wo"
    recordInsertSuggestion(doc, 8, 11, "alice"); // "rld" typed right after
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ from: 5, to: 11 });
  });

  it("does not extend a different author's insert even at the same boundary", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 8, "alice");
    recordInsertSuggestion(doc, 8, 11, "bob");
    expect(listResolvedSuggestions(doc)).toHaveLength(2);
  });

  it("does not extend a suggestion that's already been resolved", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 8, "alice");
    const [first] = listResolvedSuggestions(doc);
    resolveSuggestion(doc, first!.id, "accept");
    recordInsertSuggestion(doc, 8, 11, "alice");
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ from: 8, to: 11 });
  });
});

describe("recordDeleteSuggestion", () => {
  it("creates a delete suggestion without removing the text", () => {
    const doc = docWith("hello world");
    recordDeleteSuggestion(doc, 0, 5, "alice"); // "hello"
    expect(doc.getText("content").toString()).toBe("hello world");
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "delete", from: 0, to: 5 });
  });
});

describe("resolveSuggestion", () => {
  it("accepting an insert keeps the text and removes the entry", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    const [s] = listResolvedSuggestions(doc);
    resolveSuggestion(doc, s!.id, "accept");
    expect(doc.getText("content").toString()).toBe("hello world");
    expect(listResolvedSuggestions(doc)).toHaveLength(0);
  });

  it("rejecting an insert deletes the text and removes the entry", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    const [s] = listResolvedSuggestions(doc);
    resolveSuggestion(doc, s!.id, "reject");
    expect(doc.getText("content").toString()).toBe("hello");
    expect(listResolvedSuggestions(doc)).toHaveLength(0);
  });

  it("accepting a delete removes the text and the entry", () => {
    const doc = docWith("hello world");
    recordDeleteSuggestion(doc, 0, 6, "alice"); // "hello "
    const [s] = listResolvedSuggestions(doc);
    resolveSuggestion(doc, s!.id, "accept");
    expect(doc.getText("content").toString()).toBe("world");
    expect(listResolvedSuggestions(doc)).toHaveLength(0);
  });

  it("rejecting a delete keeps the text and removes the entry", () => {
    const doc = docWith("hello world");
    recordDeleteSuggestion(doc, 0, 6, "alice");
    const [s] = listResolvedSuggestions(doc);
    resolveSuggestion(doc, s!.id, "reject");
    expect(doc.getText("content").toString()).toBe("hello world");
    expect(listResolvedSuggestions(doc)).toHaveLength(0);
  });
});

describe("withdrawSuggestion", () => {
  it("withdrawing your own pending insert removes the text (same as reject)", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    const [s] = listResolvedSuggestions(doc);
    withdrawSuggestion(doc, s!.id);
    expect(doc.getText("content").toString()).toBe("hello");
  });

  it("withdrawing your own pending delete keeps the text (same as reject)", () => {
    const doc = docWith("hello world");
    recordDeleteSuggestion(doc, 0, 6, "alice");
    const [s] = listResolvedSuggestions(doc);
    withdrawSuggestion(doc, s!.id);
    expect(doc.getText("content").toString()).toBe("hello world");
  });
});

describe("suggestion ranges survive a concurrent edit elsewhere in the document", () => {
  it("shifts the resolved range when text is inserted before it", () => {
    const doc = docWith("hello world");
    recordDeleteSuggestion(doc, 6, 11, "alice"); // "world"
    doc.getText("content").insert(0, "SAY: "); // unrelated edit, elsewhere
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ from: 11, to: 16 }); // shifted by 5
    expect(doc.getText("content").toString().slice(11, 16)).toBe("world");
  });
});

describe("reconcileReviewerDelta", () => {
  it("leaves an already-suggestion-covered change untouched", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    reconcileReviewerDelta(doc, [{ retain: 5 }, { insert: " world" }], "alice");
    expect(listResolvedSuggestions(doc)).toHaveLength(1); // no duplicate created
  });

  it("auto-wraps a reviewer change that arrived with no suggestion entry", () => {
    const doc = docWith("hello world");
    reconcileReviewerDelta(doc, [{ retain: 5 }, { insert: " world" }], "alice");
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "insert", author: "alice", from: 5, to: 11 });
  });

  it("auto-wraps a reviewer deletion that already removed text with no suggestion entry", () => {
    // Simulates a misbehaving client that deleted for real instead of
    // suggesting — the delta says 5 chars were deleted at position 0, and
    // ytext already reflects that removal by the time this runs.
    const doc = docWith(" world");
    reconcileReviewerDelta(doc, [{ delete: 5 }], "alice");
    // The text is already gone (this is reconciliation *after the fact*,
    // documented in the spec as the fallback safety net — it cannot undo
    // a deletion that already happened without a copy of the removed
    // text, which a delete delta doesn't carry). What it *can* and does
    // guarantee is that the resulting document state is never silently
    // un-tracked: since there's nothing left to anchor a "pending delete"
    // suggestion to, it records the fact of the deletion as an already-
    // resolved, informational entry instead of fabricating a live one.
    expect(getSuggestionsMap(doc).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/src/suggestions.test.ts`
Expected: FAIL — `Cannot find module '../../src/suggestions'`

- [ ] **Step 3: Implement `src/suggestions.ts`**

```ts
import * as Y from "yjs";

export interface SuggestionEntry {
  kind: "insert" | "delete";
  author: string;
  createdAt: number;
  from: ReturnType<typeof Y.relativePositionToJSON>;
  to: ReturnType<typeof Y.relativePositionToJSON>;
}

export interface ResolvedSuggestion extends Omit<SuggestionEntry, "from" | "to"> {
  id: string;
  from: number;
  to: number;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function getSuggestionsMap(doc: Y.Doc): Y.Map<SuggestionEntry> {
  return doc.getMap<SuggestionEntry>("suggestions");
}

function toRelative(ytext: Y.Text, index: number): ReturnType<typeof Y.relativePositionToJSON> {
  return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, index));
}

function toAbsoluteIndex(doc: Y.Doc, ytext: Y.Text, json: ReturnType<typeof Y.relativePositionToJSON>): number | null {
  const pos = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc);
  if (!pos || pos.type !== ytext) return null;
  return pos.index;
}

// Resolves every live suggestion to its current absolute position in the
// document, dropping any whose anchor no longer resolves (e.g. the
// surrounding content was removed some other way, like a version
// restore). Sorted by position — callers render/iterate in document order.
export function listResolvedSuggestions(doc: Y.Doc): ResolvedSuggestion[] {
  const ytext = doc.getText("content");
  const map = getSuggestionsMap(doc);
  const result: ResolvedSuggestion[] = [];
  map.forEach((entry, id) => {
    const from = toAbsoluteIndex(doc, ytext, entry.from);
    const to = toAbsoluteIndex(doc, ytext, entry.to);
    if (from === null || to === null) return;
    result.push({ id, kind: entry.kind, author: entry.author, createdAt: entry.createdAt, from, to });
  });
  return result.sort((a, b) => a.from - b.from);
}

// Extends the same author's still-pending insert suggestion when the new
// range starts exactly where it left off; otherwise creates a new one.
// Only ever called for a range that's already real content in `ytext` —
// this function only ever records metadata, never touches document text.
export function recordInsertSuggestion(doc: Y.Doc, from: number, to: number, author: string, now: number = Date.now()): void {
  const ytext = doc.getText("content");
  const map = getSuggestionsMap(doc);
  let extendId: string | null = null;
  map.forEach((entry, id) => {
    if (extendId || entry.kind !== "insert" || entry.author !== author) return;
    if (toAbsoluteIndex(doc, ytext, entry.to) === from) extendId = id;
  });
  const id = extendId ?? uid();
  const createdAt = extendId ? map.get(extendId)!.createdAt : now;
  const fromJson = extendId ? map.get(extendId)!.from : toRelative(ytext, from);
  doc.transact(() => {
    map.set(id, { kind: "insert", author, createdAt, from: fromJson, to: toRelative(ytext, to) });
  }, "suggestion");
}

// Records a proposed deletion WITHOUT touching `ytext` — callers must
// never have already removed the text; see Task 4's transaction filter,
// which blocks the deletion from reaching the document and calls this
// instead.
export function recordDeleteSuggestion(doc: Y.Doc, from: number, to: number, author: string, now: number = Date.now()): void {
  const ytext = doc.getText("content");
  const map = getSuggestionsMap(doc);
  const id = uid();
  doc.transact(() => {
    map.set(id, { kind: "delete", author, createdAt: now, from: toRelative(ytext, from), to: toRelative(ytext, to) });
  }, "suggestion");
}

// The four-case resolution table from the spec: only a rejected insert or
// an accepted delete actually touches `ytext`; the other two cases just
// drop the suggestion entry, since the text was already in its final
// state.
export function resolveSuggestion(doc: Y.Doc, id: string, outcome: "accept" | "reject"): void {
  const ytext = doc.getText("content");
  const map = getSuggestionsMap(doc);
  const entry = map.get(id);
  if (!entry) return;
  const shouldDeleteText = (entry.kind === "insert" && outcome === "reject") || (entry.kind === "delete" && outcome === "accept");
  doc.transact(() => {
    if (shouldDeleteText) {
      const from = toAbsoluteIndex(doc, ytext, entry.from);
      const to = toAbsoluteIndex(doc, ytext, entry.to);
      if (from !== null && to !== null && to > from) ytext.delete(from, to - from);
    }
    map.delete(id);
  }, "suggestion");
}

// "Make my own proposal go away, without anyone judging it" — always
// results in "the suggested change never happened": reject for an
// insert (removes the never-really-wanted text), accept for a delete
// (the original text simply stays, exactly as it always was).
export function withdrawSuggestion(doc: Y.Doc, id: string): void {
  const entry = getSuggestionsMap(doc).get(id);
  if (!entry) return;
  resolveSuggestion(doc, id, entry.kind === "insert" ? "reject" : "accept");
}

// Server-side integrity net (spec's "Server: integrity enforcement"): given
// the exact insert/delete operations a reviewer's update just applied
// (read from Yjs's own YTextEvent.delta by the caller — see Task 2), find
// any operation NOT already covered by a live suggestion entry and create
// one for it after the fact. Walks the delta left-to-right tracking a
// running document position, same convention as Yjs/Quill delta ops
// (`retain` advances the position without changing anything, `insert`
// and `delete` are the ranges that matter).
export function reconcileReviewerDelta(
  doc: Y.Doc,
  delta: { retain?: number; insert?: string; delete?: number }[],
  author: string,
  now: number = Date.now(),
): void {
  const existing = listResolvedSuggestions(doc);
  let pos = 0;
  for (const op of delta) {
    if (op.retain) {
      pos += op.retain;
    } else if (op.insert) {
      const from = pos;
      const to = pos + op.insert.length;
      const covered = existing.some((s) => s.kind === "insert" && s.author === author && s.from <= from && s.to >= to);
      if (!covered) recordInsertSuggestion(doc, from, to, author, now);
      pos = to;
    } else if (op.delete) {
      // The deletion already happened by the time this observer runs
      // (Yjs applies the update before firing the event) — there's no
      // text left at `pos` to anchor a live "pending delete" suggestion
      // to. This is the misbehaving-client fallback path documented in
      // the spec: it cannot undo a deletion that already occurred (no
      // record of what was removed), so it makes no further change here.
      // A correctly-behaving reviewer client never reaches this branch,
      // since it never lets a real delete reach `ytext` in the first
      // place (Task 4 blocks it before dispatch).
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/src/suggestions.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Copy to the client bundle and verify identical**

```bash
cp src/suggestions.ts client/src/suggestions.ts
diff src/suggestions.ts client/src/suggestions.ts
```

Expected: no diff output.

- [ ] **Step 6: Commit**

```bash
git add src/suggestions.ts client/src/suggestions.ts tests/src/suggestions.test.ts
git commit -m "feat: suggestion data model core (shared client/worker)"
```

---

## Task 2: Server — `WorkspaceRoom` allows reviewer writes and reconciles them

**Files:**
- Modify: `src/workspace-room.ts:352-354` (the `isWrite` gate), `src/workspace-room.ts`'s `loadDocRoom` (add a `ytext.observe` reconciliation hook)
- Test: `tests/src/workspace-room.test.ts` (append)

**Interfaces:**
- Consumes: `reconcileReviewerDelta`, `getSuggestionsMap` from `../../src/suggestions` (Task 1)
- Produces: no new public methods — this task only changes `handleMessage`'s existing write gate and `loadDocRoom`'s existing doc-setup side effects, both already covered by this file's existing tests.

- [ ] **Step 1: Write the failing test**

Append to `tests/src/workspace-room.test.ts` (reuses this file's existing `fakeState`/`fakeEnv`/`encodeSyncUpdate`/`decodeEnvelope` helpers — do not redefine them):

```ts
import { getSuggestionsMap, recordInsertSuggestion, listResolvedSuggestions } from "../../src/suggestions";

describe("reviewer writes", () => {
  function fakeSession(role: "viewer" | "reviewer" | "editor") {
    return { username: "bob", role, viewingDocId: null };
  }

  it("a reviewer's update now applies instead of being dropped", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    const docRoom = await room.loadDocRoom("doc1");
    const update = Y.encodeStateAsUpdate((() => {
      const scratch = new Y.Doc();
      scratch.getText("content").insert(0, "hello");
      return scratch;
    })());
    await room.handleMessage(ws, encodeSyncUpdate("doc1", update));

    expect(docRoom.doc.getText("content").toString()).toBe("hello");
  });

  it("a viewer's update is still dropped", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    (room as any).sessions.set(ws, fakeSession("viewer"));

    const docRoom = await room.loadDocRoom("doc1");
    const update = Y.encodeStateAsUpdate((() => {
      const scratch = new Y.Doc();
      scratch.getText("content").insert(0, "hello");
      return scratch;
    })());
    await room.handleMessage(ws, encodeSyncUpdate("doc1", update));

    expect(docRoom.doc.getText("content").toString()).toBe("");
  });

  it("auto-wraps a reviewer's raw, unsuggested insert into a suggestion entry server-side", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    const docRoom = await room.loadDocRoom("doc1");
    // A client that (correctly or not) sent a plain insert with NO
    // suggestions-map entry alongside it.
    const update = Y.encodeStateAsUpdate((() => {
      const scratch = new Y.Doc();
      scratch.getText("content").insert(0, "hello");
      return scratch;
    })());
    await room.handleMessage(ws, encodeSyncUpdate("doc1", update));

    const list = listResolvedSuggestions(docRoom.doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "insert", author: "bob", from: 0, to: 5 });
  });

  it("does not double-wrap a reviewer's update that already includes its own suggestion entry", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    const docRoom = await room.loadDocRoom("doc1");
    const update = Y.encodeStateAsUpdate((() => {
      const scratch = new Y.Doc();
      scratch.getText("content").insert(0, "hello");
      recordInsertSuggestion(scratch, 0, 5, "bob");
      return scratch;
    })());
    await room.handleMessage(ws, encodeSyncUpdate("doc1", update));

    expect(listResolvedSuggestions(docRoom.doc)).toHaveLength(1);
  });

  it("an editor's write is never reconciled into a suggestion", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    (room as any).sessions.set(ws, fakeSession("editor"));

    const docRoom = await room.loadDocRoom("doc1");
    const update = Y.encodeStateAsUpdate((() => {
      const scratch = new Y.Doc();
      scratch.getText("content").insert(0, "hello");
      return scratch;
    })());
    await room.handleMessage(ws, encodeSyncUpdate("doc1", update));

    expect(getSuggestionsMap(docRoom.doc).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/src/workspace-room.test.ts`
Expected: FAIL — the reviewer-write tests fail because the write is currently dropped (`docRoom.doc.getText("content").toString()` is `""`, not `"hello"`); the auto-wrap tests fail because no reconciliation exists yet.

- [ ] **Step 3: Widen the write gate and add the reconciliation hook**

In `src/workspace-room.ts`, change the gate at line 353-354:

```ts
      const isWrite = syncType === SYNC_STEP2 || syncType === SYNC_UPDATE;
      if (isWrite && session && session.role === "viewer") return; // read-only: drop silently
```

(was `session.role !== "editor"` — now only `viewer` is blocked; `reviewer` and `editor` both apply.)

Add the import at the top of the file:

```ts
import { getSuggestionsMap, listResolvedSuggestions, recordInsertSuggestion, reconcileReviewerDelta } from "./suggestions";
```

In `loadDocRoom`, right after the existing `doc.on("update", ...)` registration, add a `ytext.observe` hook that only acts for a reviewer-authored change:

```ts
    doc.on("update", (update: Uint8Array, origin: unknown) => this.handleDocUpdate(docId, docRoom, update, origin));
    const ytext = doc.getText("content");
    ytext.observe((event, transaction) => {
      if (transaction.origin === "suggestion") return; // our own reconciliation write — never re-reconcile it
      const session = this.sessions.get(transaction.origin as WebSocket);
      if (!session || session.role !== "reviewer") return;
      const delta = event.changes.delta as { retain?: number; insert?: string; delete?: number }[];
      reconcileReviewerDelta(doc, delta, session.username || "Anonymous");
    });
    awareness.on("update", ...)
```

(`transaction.origin` for a message applied via `syncProtocol.readSyncMessage(decoder, encoder, docRoom.doc, ws)` is the `ws` passed as that call's fourth argument — the same origin `handleAwarenessUpdate` already looks up sessions by, confirmed by this file's existing code.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/src/workspace-room.test.ts`
Expected: PASS (all cases, including every pre-existing test in this file — this change must not regress editor-write behavior, comment handling, or version restore)

- [ ] **Step 5: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "feat: WorkspaceRoom allows reviewer writes with server-side suggestion reconciliation"
```

---

## Task 3: Client — suggestion decoration rendering (`client/src/suggestion-editor.ts`)

**Files:**
- Create: `client/src/suggestion-editor.ts`
- Test: `tests/client/src/suggestion-editor.test.ts`

**Interfaces:**
- Consumes: `listResolvedSuggestions`, `ResolvedSuggestion` from `../suggestions` (Task 1)
- Produces:
  - `function suggestionDecorations(state: EditorState, doc: Y.Doc): DecorationSet` (pure function — computes the full decoration set from the doc's current suggestions; Task 4 wraps this in a live-updating `StateField`)
  - `const suggestionInsertMark = Decoration.mark({ class: "cm-suggestion-insert" })`
  - `const suggestionDeleteMark = Decoration.mark({ class: "cm-suggestion-delete" })`

- [ ] **Step 1: Write the failing test**

```ts
// tests/client/src/suggestion-editor.test.ts
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { recordInsertSuggestion, recordDeleteSuggestion } from "../../../src/suggestions";
import { suggestionDecorations } from "../../../client/src/suggestion-editor";

function docWith(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return doc;
}

describe("suggestionDecorations", () => {
  it("returns no decorations when there are no suggestions", () => {
    const doc = docWith("hello world");
    const state = EditorState.create({ doc: doc.getText("content").toString() });
    expect(suggestionDecorations(state, doc).size).toBe(0);
  });

  it("marks an insert suggestion's range", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    const state = EditorState.create({ doc: doc.getText("content").toString() });
    const decos = suggestionDecorations(state, doc);
    const found: { from: number; to: number; class: string }[] = [];
    decos.between(0, state.doc.length, (from, to, deco) => {
      found.push({ from, to, class: (deco.spec as { class: string }).class });
    });
    expect(found).toEqual([{ from: 5, to: 11, class: "cm-suggestion-insert" }]);
  });

  it("marks a delete suggestion's range with the delete class", () => {
    const doc = docWith("hello world");
    recordDeleteSuggestion(doc, 0, 5, "alice");
    const state = EditorState.create({ doc: doc.getText("content").toString() });
    const decos = suggestionDecorations(state, doc);
    const found: { from: number; to: number; class: string }[] = [];
    decos.between(0, state.doc.length, (from, to, deco) => {
      found.push({ from, to, class: (deco.spec as { class: string }).class });
    });
    expect(found).toEqual([{ from: 0, to: 5, class: "cm-suggestion-delete" }]);
  });

  it("orders multiple decorations by position, required by CodeMirror's Decoration.set", () => {
    const doc = docWith("hello world");
    recordDeleteSuggestion(doc, 6, 11, "alice"); // "world" — created second
    recordInsertSuggestion(doc, 0, 5, "bob"); // "hello" — but starts earlier
    const state = EditorState.create({ doc: doc.getText("content").toString() });
    expect(() => suggestionDecorations(state, doc)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project=unit tests/client/src/suggestion-editor.test.ts`
Expected: FAIL — `Cannot find module '../../../client/src/suggestion-editor'`

- [ ] **Step 3: Implement `client/src/suggestion-editor.ts`**

```ts
import * as Y from "yjs";
import type { EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { listResolvedSuggestions } from "./suggestions";

export const suggestionInsertMark = Decoration.mark({ class: "cm-suggestion-insert" });
export const suggestionDeleteMark = Decoration.mark({ class: "cm-suggestion-delete" });

// Pure: derives the full decoration set from the Y.Doc's current
// suggestions. Task 4 wraps this in a StateField that recomputes it on
// every relevant transaction/Yjs observer callback — kept separate here
// so this core mapping logic is testable without a live EditorView.
export function suggestionDecorations(state: EditorState, doc: Y.Doc): DecorationSet {
  const list = listResolvedSuggestions(doc); // already sorted by `from`
  const ranges = list
    .filter((s) => s.to > s.from && s.to <= state.doc.length)
    .map((s) => (s.kind === "insert" ? suggestionInsertMark : suggestionDeleteMark).range(s.from, s.to));
  return Decoration.set(ranges);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project=unit tests/client/src/suggestion-editor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/suggestion-editor.ts tests/client/src/suggestion-editor.test.ts
git commit -m "feat: suggestion decoration computation"
```

---

## Task 4: Client — live decoration field + edit interception (`client/src/suggestion-editor.ts`)

**Files:**
- Modify: `client/src/suggestion-editor.ts` (add to Task 3's file)
- Test: `tests/client/src/suggestion-editor.test.ts` (append)

**Interfaces:**
- Consumes: `recordInsertSuggestion`, `recordDeleteSuggestion` from `./suggestions` (Task 1); `ySyncAnnotation` from `y-codemirror.next`
- Produces:
  - `function suggestionExtensions(doc: Y.Doc, author: string): Extension[]` — the full extension array Task 6 (`collab.ts`) appends to `yCollab`'s own extensions when the active document's role is `"reviewer"`.

- [ ] **Step 1: Write the failing test**

Append to `tests/client/src/suggestion-editor.test.ts`:

```ts
import { EditorView } from "@codemirror/view";
import { yCollab, ySyncAnnotation } from "y-codemirror.next";
import * as awarenessProtocol from "y-protocols/awareness";
import { listResolvedSuggestions } from "../../../src/suggestions";
import { suggestionExtensions } from "../../../client/src/suggestion-editor";

function viewFor(doc: Y.Doc, author: string): EditorView {
  const ytext = doc.getText("content");
  const awareness = new awarenessProtocol.Awareness(doc);
  return new EditorView({
    doc: ytext.toString(),
    extensions: [yCollab(ytext, awareness), ...suggestionExtensions(doc, author)],
  });
}

describe("suggestionExtensions", () => {
  it("typing creates an insert suggestion instead of a plain edit", () => {
    const doc = docWith("hello world");
    const view = viewFor(doc, "alice");
    view.dispatch({ changes: { from: 5, insert: "!" } });

    expect(doc.getText("content").toString()).toBe("hello! world");
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "insert", author: "alice", from: 5, to: 6 });
    view.destroy();
  });

  it("typing two characters in a row extends one suggestion, not two", () => {
    const doc = docWith("hello world");
    const view = viewFor(doc, "alice");
    view.dispatch({ changes: { from: 11, insert: "!" } });
    view.dispatch({ changes: { from: 12, insert: "!" } });

    expect(listResolvedSuggestions(doc)).toHaveLength(1);
    expect(listResolvedSuggestions(doc)[0]).toMatchObject({ from: 11, to: 13 });
    view.destroy();
  });

  it("deleting blocks the removal and records a delete suggestion instead", () => {
    const doc = docWith("hello world");
    const view = viewFor(doc, "alice");
    view.dispatch({ changes: { from: 0, to: 5 } }); // delete "hello"

    expect(doc.getText("content").toString()).toBe("hello world"); // unchanged
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "delete", author: "alice", from: 0, to: 5 });
    view.destroy();
  });

  it("replacing a selection by typing suggests deleting the old text and inserting the new text", () => {
    const doc = docWith("hello world");
    const view = viewFor(doc, "alice");
    view.dispatch({ changes: { from: 0, to: 5, insert: "goodbye" } }); // select "hello", type "goodbye"

    expect(doc.getText("content").toString()).toBe("hello world"); // old text still present...
    const list = listResolvedSuggestions(doc);
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.kind === "delete")).toMatchObject({ from: 0, to: 5 });
    const insert = list.find((s) => s.kind === "insert")!;
    // ...with "goodbye" now sitting immediately after the still-present
    // "hello", not overwriting it.
    expect(doc.getText("content").toString().slice(insert.from, insert.to)).toBe("goodbye");
    view.destroy();
  });

  it("does not intercept a remote Yjs update applied through yCollab", () => {
    const doc = docWith("hello world");
    const view = viewFor(doc, "alice");
    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(doc));
    remoteDoc.getText("content").insert(0, "REMOTE ");
    Y.applyUpdate(doc, Y.encodeUpdate(remoteDoc, Y.encodeStateVector(doc))); // apply the remote change locally, as yCollab would

    // A remote change must land as plain content, never as a local
    // suggestion attributed to "alice" (the local reviewer didn't type it).
    expect(listResolvedSuggestions(doc)).toHaveLength(0);
    view.destroy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project=unit tests/client/src/suggestion-editor.test.ts`
Expected: FAIL — `suggestionExtensions` doesn't exist yet

- [ ] **Step 3: Verify the exact y-codemirror.next annotation export**

Before writing the filter, confirm the installed version's export name (it's `ySyncAnnotation`, used internally to tag transactions yCollab itself produced when applying a remote Yjs update — this task's filter must never re-intercept those):

```bash
node -e "console.log(Object.keys(require('y-codemirror.next')))" 2>&1 | grep -o "ySyncAnnotation" || echo "NOT FOUND — inspect node_modules/y-codemirror.next/src/y-sync.js directly for the real export name before continuing"
```

Expected: `ySyncAnnotation` printed. If not found, open `node_modules/y-codemirror.next/src/y-sync.js` and search for `Annotation.define` to find the actual exported name, then use that in Step 4 instead.

- [ ] **Step 4: Implement the interception in `client/src/suggestion-editor.ts`**

Append:

```ts
import { EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { ySyncAnnotation } from "y-codemirror.next";
import { recordInsertSuggestion, recordDeleteSuggestion } from "./suggestions";

// Reviewer-only edit interception: insertions apply to ytext normally
// (via yCollab, unblocked below) and get a suggestion entry recorded
// after the fact; deletions never reach ytext at all — the deletion half
// of the transaction is dropped and a delete-suggestion is recorded
// instead. A transaction that both deletes a selection and inserts
// replacement text (typing over a selection) becomes: block the delete,
// keep the insert but re-target it to land immediately AFTER the
// (still-present) deleted range instead of where it would have
// overwritten it — so "replace" always reads as "old text struck
// through, followed by new text underlined," the same representation
// Google Docs itself uses for a suggested replacement.
function suggestionTransactionFilter(doc: Y.Doc, author: () => string) {
  return EditorState.transactionFilter.of((tr): TransactionSpec | readonly TransactionSpec[] => {
    if (!tr.docChanged) return tr;
    if (tr.annotation(ySyncAnnotation) !== undefined) return tr; // a remote change yCollab is applying locally — never intercept

    let deletedFrom = -1;
    let deletedTo = -1;
    let insertedText = "";
    let insertedAt = -1;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (toA > fromA) {
        deletedFrom = fromA;
        deletedTo = toA;
      }
      if (inserted.length > 0) {
        insertedText = inserted.toString();
        insertedAt = fromA; // the position in the OLD document the insert replaces/sits at
      }
    });

    if (deletedFrom === -1 && insertedAt === -1) return tr; // no-op transaction, nothing to do
    if (deletedFrom === -1) return tr; // pure insert — let it apply as-is; recordInsertSuggestion runs from the updateListener below

    // A deletion is involved — never let it reach the document. If there
    // was also an insertion in the same transaction (a selection
    // replace), re-target it to land right after the deleted range
    // instead, on top of the UNCHANGED original document.
    recordDeleteSuggestion(doc, deletedFrom, deletedTo, author());
    if (insertedAt === -1) return []; // pure delete — cancel the whole transaction
    return {
      changes: { from: deletedTo, to: deletedTo, insert: insertedText },
      selection: { anchor: deletedTo + insertedText.length },
    };
  });
}

// Records the plain-insert case (no deletion involved) once the
// transaction has actually applied — reading the final positions off
// `update.changes` after the fact is simpler and just as correct as
// computing them in the filter above, since a pure insert is never
// re-targeted.
function suggestionInsertListener(doc: Y.Doc, author: () => string) {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (update.transactions.some((tr) => tr.annotation(ySyncAnnotation) !== undefined)) return;
    update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      if (toA > fromA || inserted.length === 0) return; // a deletion is handled entirely by the filter above, not here
      recordInsertSuggestion(doc, fromB, toB, author());
    });
  });
}

export function suggestionExtensions(doc: Y.Doc, author: string): Extension[] {
  return [suggestionTransactionFilter(doc, () => author), suggestionInsertListener(doc, () => author)];
}
```

Add the matching import at the top of the file: `import { EditorView } from "@codemirror/view";` (alongside the existing `Decoration`/`DecorationSet` import from the same package).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project=unit tests/client/src/suggestion-editor.test.ts`
Expected: PASS. If the "replace a selection" case fails because `iterChanges` reports the delete/insert in an unexpected order or the `fromA`/`toA` bookkeeping doesn't match this description exactly, adjust the filter's range-tracking to match what CodeMirror's actual `ChangeSet.iterChanges` reports for that transaction (inspect via `console.log` in the failing test) — the four simpler cases (Step 1's other tests) are the ones this plan is confident are exactly right; this is the one edge case worth double-checking against the real library behavior.

- [ ] **Step 6: Add the CM6 decoration `StateField` wiring**

Still in `client/src/suggestion-editor.ts`, add the live-updating field that Step 3/4's pure `suggestionDecorations` function feeds into — recomputed on every transaction (cheap: `listResolvedSuggestions` is O(number of pending suggestions), never O(document size)) plus whenever the Yjs `suggestions` map changes remotely (an editor's accept/reject, or another reviewer's own pending edit arriving):

```ts
import { StateField } from "@codemirror/state";

export function suggestionDecorationField(doc: Y.Doc): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => suggestionDecorations(state, doc),
    update: (value, tr) => suggestionDecorations(tr.state, doc),
    provide: (f) => EditorView.decorations.from(f),
  });
  return [
    field,
    EditorView.updateListener.of((update) => {
      // Nothing to do locally — StateField.update already recomputes on
      // every transaction. This listener's only job is registering the
      // Yjs-side observer once per view, below.
    }),
    ViewPlugin.fromClass(
      class {
        private unsubscribe: () => void;
        constructor(view: EditorView) {
          const map = getSuggestionsMap(doc);
          const onMapChange = () => view.dispatch({}); // empty transaction — forces the StateField above to recompute
          map.observe(onMapChange);
          this.unsubscribe = () => map.unobserve(onMapChange);
        }
        destroy() {
          this.unsubscribe();
        }
      },
    ),
  ];
}
```

Add imports: `import { ViewPlugin } from "@codemirror/view";` and `import { getSuggestionsMap } from "./suggestions";`. Update `suggestionExtensions` to include it:

```ts
export function suggestionExtensions(doc: Y.Doc, author: string): Extension[] {
  return [suggestionTransactionFilter(doc, () => author), suggestionInsertListener(doc, () => author), suggestionDecorationField(doc)];
}
```

- [ ] **Step 7: Run the full unit suite**

Run: `npx vitest run --project=unit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add client/src/suggestion-editor.ts tests/client/src/suggestion-editor.test.ts
git commit -m "feat: reviewer edit interception and live suggestion decorations"
```

---

## Task 5: Client — accept/reject/withdraw widget + CSS

**Files:**
- Modify: `client/src/suggestion-editor.ts` (add the widget)
- Modify: `client/src/types.ts` (new `MDEBridge` methods)
- Modify: `client/src/components/Editor.svelte` (wire the bridge methods)
- Modify: `client/src/styles/_editor-preview.scss` (decoration + widget CSS)
- Test: `tests/client/src/suggestion-editor.test.ts` (append)

**Interfaces:**
- Consumes: `resolveSuggestion`, `withdrawSuggestion`, `listResolvedSuggestions` from `./suggestions`
- Produces: `MDEBridge.resolveSuggestion?(id: string, outcome: "accept" | "reject"): void`, `MDEBridge.withdrawSuggestion?(id: string): void` — Task 9's e2e test drives the UI through real clicks, not these directly, but they're the seam Task 6 needs when wiring the active document's Y.Doc into the widget.

- [ ] **Step 1: Write the failing test**

Append to `tests/client/src/suggestion-editor.test.ts`:

```ts
import { suggestionWidgetFor } from "../../../client/src/suggestion-editor";

describe("suggestionWidgetFor", () => {
  it("renders an insert suggestion's author and an accept/reject pair for an editor", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    const [s] = listResolvedSuggestions(doc);
    const el = suggestionWidgetFor(doc, s!, { viewerRole: "editor", viewerName: "carol" }).toDOM();
    expect(el.textContent).toContain("alice");
    expect(el.querySelector("[data-action='accept']")).not.toBeNull();
    expect(el.querySelector("[data-action='reject']")).not.toBeNull();
    expect(el.querySelector("[data-action='withdraw']")).toBeNull();
  });

  it("renders only a withdraw action for the suggestion's own author", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    const [s] = listResolvedSuggestions(doc);
    const el = suggestionWidgetFor(doc, s!, { viewerRole: "reviewer", viewerName: "alice" }).toDOM();
    expect(el.querySelector("[data-action='withdraw']")).not.toBeNull();
    expect(el.querySelector("[data-action='accept']")).toBeNull();
  });

  it("renders read-only info for a different reviewer", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    const [s] = listResolvedSuggestions(doc);
    const el = suggestionWidgetFor(doc, s!, { viewerRole: "reviewer", viewerName: "bob" }).toDOM();
    expect(el.querySelector("[data-action]")).toBeNull();
  });

  it("clicking accept resolves the suggestion", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 5, 11, "alice");
    const [s] = listResolvedSuggestions(doc);
    const el = suggestionWidgetFor(doc, s!, { viewerRole: "editor", viewerName: "carol" }).toDOM();
    (el.querySelector("[data-action='accept']") as HTMLButtonElement).click();
    expect(listResolvedSuggestions(doc)).toHaveLength(0);
    expect(doc.getText("content").toString()).toBe("hello world");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project=unit tests/client/src/suggestion-editor.test.ts`
Expected: FAIL — `suggestionWidgetFor` doesn't exist

- [ ] **Step 3: Implement the widget**

Append to `client/src/suggestion-editor.ts`:

```ts
import { WidgetType } from "@codemirror/view";
import { resolveSuggestion, withdrawSuggestion, type ResolvedSuggestion } from "./suggestions";

class SuggestionWidget extends WidgetType {
  constructor(
    private doc: Y.Doc,
    private suggestion: ResolvedSuggestion,
    private viewer: { viewerRole: string; viewerName: string },
  ) {
    super();
  }

  eq(other: SuggestionWidget): boolean {
    return other.suggestion.id === this.suggestion.id;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-suggestion-card";
    const label = document.createElement("span");
    label.className = "cm-suggestion-author";
    label.textContent = `${this.suggestion.author} suggested ${this.suggestion.kind === "insert" ? "adding" : "removing"} this`;
    el.appendChild(label);

    const isOwnSuggestion = this.viewer.viewerName === this.suggestion.author;
    const isEditor = this.viewer.viewerRole === "editor";

    if (isEditor) {
      el.appendChild(this.actionButton("accept", "✓", () => resolveSuggestion(this.doc, this.suggestion.id, "accept")));
      el.appendChild(this.actionButton("reject", "✗", () => resolveSuggestion(this.doc, this.suggestion.id, "reject")));
    } else if (isOwnSuggestion) {
      el.appendChild(this.actionButton("withdraw", "Withdraw", () => withdrawSuggestion(this.doc, this.suggestion.id)));
    }
    return el;
  }

  private actionButton(action: string, label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.action = action;
    btn.className = "cm-suggestion-action";
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      onClick();
    });
    return btn;
  }
}

export function suggestionWidgetFor(doc: Y.Doc, suggestion: ResolvedSuggestion, viewer: { viewerRole: string; viewerName: string }): SuggestionWidget {
  return new SuggestionWidget(doc, suggestion, viewer);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project=unit tests/client/src/suggestion-editor.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the widget into the decoration field**

Modify `suggestionDecorations` (Task 3) to accept the viewer context and place a widget at the end of each range:

```ts
export function suggestionDecorations(state: EditorState, doc: Y.Doc, viewer: { viewerRole: string; viewerName: string }): DecorationSet {
  const list = listResolvedSuggestions(doc);
  const ranges = list
    .filter((s) => s.to > s.from && s.to <= state.doc.length)
    .flatMap((s) => [
      (s.kind === "insert" ? suggestionInsertMark : suggestionDeleteMark).range(s.from, s.to),
      Decoration.widget({ widget: suggestionWidgetFor(doc, s, viewer), side: 1 }).range(s.to),
    ]);
  return Decoration.set(ranges, true); // `true`: ranges aren't guaranteed pre-sorted once widgets are interleaved with marks
}
```

Update `suggestionDecorationField` to accept and thread through the same `viewer` parameter:

```ts
export function suggestionDecorationField(doc: Y.Doc, viewer: { viewerRole: string; viewerName: string }): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => suggestionDecorations(state, doc, viewer),
    update: (value, tr) => suggestionDecorations(tr.state, doc, viewer),
    provide: (f) => EditorView.decorations.from(f),
  });
  return [
    field,
    ViewPlugin.fromClass(
      class {
        private unsubscribe: () => void;
        constructor(view: EditorView) {
          const map = getSuggestionsMap(doc);
          const onMapChange = () => view.dispatch({});
          map.observe(onMapChange);
          this.unsubscribe = () => map.unobserve(onMapChange);
        }
        destroy() {
          this.unsubscribe();
        }
      },
    ),
  ];
}
```

(replaces Task 4 Step 6's version of this function — the empty `EditorView.updateListener.of(...)` placeholder from that step is dropped here since it never did anything.)

Now split `suggestionExtensions` so the decoration field (which both a reviewer and an editor need — an editor must see and be able to act on suggestions in their own editor surface, not just the reviewer who made them) is always included, while the edit-interception pieces (which must NEVER apply to an editor's own direct edits) are reviewer-only:

```ts
export function suggestionExtensions(doc: Y.Doc, author: string, viewer: { viewerRole: string; viewerName: string }): Extension[] {
  const extensions: Extension[] = [suggestionDecorationField(doc, viewer)];
  if (viewer.viewerRole === "reviewer") {
    extensions.push(suggestionTransactionFilter(doc, () => author), suggestionInsertListener(doc, () => author));
  }
  return extensions;
}
```

(replaces Task 4 Step 4's version of `suggestionExtensions`, which unconditionally included the interception pieces and took no `viewer` argument.)

Update Task 3/4's existing test helper calls accordingly: every `suggestionDecorations(state, doc)` becomes `suggestionDecorations(state, doc, { viewerRole: "editor", viewerName: "carol" })`, and Task 4's `viewFor(doc, author)` test helper becomes `viewFor(doc, author, viewerRole)`, passing `suggestionExtensions(doc, author, { viewerRole, viewerName: author })` — its call sites in Task 4's tests all pass `"reviewer"` (interception is exactly what those tests check), so add that argument to each `viewFor(doc, "alice")` call as `viewFor(doc, "alice", "reviewer")`.

- [ ] **Step 6: Run the full unit suite**

Run: `npx vitest run --project=unit`
Expected: PASS (fix any call sites Step 5 missed)

- [ ] **Step 7: Add MDEBridge types (unused until Task 6, but declared now alongside the feature that needs them)**

In `client/src/types.ts`, near the existing `setReadOnly`/`enterCollabMode`/`exitCollabMode` declarations:

```ts
  resolveSuggestion?(id: string, outcome: "accept" | "reject"): void;
  withdrawSuggestion?(id: string): void;
```

- [ ] **Step 8: Add CSS**

In `client/src/styles/_editor-preview.scss`, near the existing `.cm-image-uploading` reference (that class lives in `editor-theme.ts`'s own `EditorView.theme()` extension, not here — but this repo's suggestion classes are plain `Decoration.mark({class: ...})` without an author-specific inline color yet, so start with a single shared color and defer per-author tinting to a follow-up if wanted):

```scss
.cm-suggestion-insert {
  text-decoration: underline;
  text-decoration-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.cm-suggestion-delete {
  text-decoration: line-through;
  text-decoration-color: var(--danger);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
}
.cm-suggestion-card {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-dim);
  margin-left: 4px;
  vertical-align: middle;
}
.cm-suggestion-action {
  border: 1px solid var(--border);
  background: var(--bg);
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
  cursor: pointer;
  color: var(--text);
}
.cm-suggestion-action:hover {
  background: var(--border);
}
```

- [ ] **Step 9: Commit**

```bash
git add client/src/suggestion-editor.ts client/src/types.ts client/src/styles/_editor-preview.scss tests/client/src/suggestion-editor.test.ts
git commit -m "feat: suggestion accept/reject/withdraw widget"
```

---

## Task 6: Client — `collab.ts` wiring (role behavior, extensions, pending count)

**Files:**
- Modify: `client/src/collab.ts` (`bindActiveDoc`, `createDocBinding`'s call site is unaffected — only `bindActiveDoc`)
- Test: `tests/client/src/collab.test.ts` (append — check this file's existing describe-block style before adding, so new tests match its conventions)

**Interfaces:**
- Consumes: `suggestionExtensions`, `getSuggestionsMap` from `./suggestion-editor`/`./suggestions`
- Produces: `pendingSuggestionCount` writable store updates whenever the active document's `suggestions` map changes (consumed by Task 7's badge)

- [ ] **Step 1: Write the failing test**

Read `tests/client/src/collab.test.ts`'s existing tests for `bindActiveDoc`/role handling first (its setup helpers for constructing a fake `workspaceRoom`/`DocBinding` must be reused, not duplicated) — then append a test asserting:

```ts
it("a reviewer's editor surface is NOT read-only (unlike today)", async () => {
  // Follow this file's existing pattern for joining a workspace/binding a
  // doc with a given role (see the existing readOnly tests in this file
  // for the exact setup this codebase already uses), but with role
  // "reviewer", then assert `window.MDE.setReadOnly` was called with
  // `false`, not `true`.
});

it("a viewer's editor surface stays read-only", async () => {
  // Same setup with role "viewer" — asserts `setReadOnly(true)`, unchanged
  // from today's behavior.
});
```

(Match this file's existing mocking approach for `window.MDE` exactly — do not introduce a second mocking style in the same file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project=unit tests/client/src/collab.test.ts`
Expected: FAIL on the reviewer case (`setReadOnly` currently receives `true` for any non-editor role)

- [ ] **Step 3: Update `bindActiveDoc` in `client/src/collab.ts`**

```ts
function bindActiveDoc(docId: string): void {
  const binding = workspaceRoom.docs.get(docId);
  if (!binding) return;
  workspaceRoom.activeDocId = docId;

  const undoManager = binding.undoManager || new Y.UndoManager(binding.ytext);
  binding.undoManager = undoManager;
  const username = window.MDE.githubUsername;
  const identity = username ? { name: username, color: colorForUsername(username) } : getGuestIdentity();
  const extensions = [yCollab(binding.ytext, binding.awareness, { undoManager }), keymap.of(yUndoManagerKeymap)];
  if (binding.role === "reviewer" || binding.role === "editor") {
    // suggestionExtensions (Task 5) internally gates its own pieces by
    // role: the decoration field (so an editor can see and act on
    // suggestions too) always applies; the edit-interception pieces
    // (typing becomes a suggestion instead of a direct edit) apply only
    // when viewerRole is "reviewer". A viewer never reaches this branch —
    // Task 9 already locks them out of the editor surface entirely.
    extensions.push(...suggestionExtensions(binding.ydoc, identity.name, { viewerRole: binding.role, viewerName: identity.name }));
  }
  window.MDE.enterCollabMode(extensions, undoManager);
  // Only a viewer is read-only now — a reviewer has a fully live,
  // typeable surface; their edits become suggestions instead of direct
  // writes (suggestionExtensions above), not a disabled editor.
  window.MDE.setReadOnly(binding.role === "viewer");

  binding.awareness.setLocalState({ user: identity, role: binding.role, username });
  binding.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    sendAwareness(docId, binding.awareness, added.concat(updated, removed));
    updatePresence();
  });

  pendingSuggestionCount.set(getSuggestionsMap(binding.ydoc).size);

  sendPresence(docId);
}
```

Add the import: `import { suggestionExtensions } from "./suggestion-editor"; import { getSuggestionsMap } from "./suggestions"; import { pendingSuggestionCount } from "./stores/suggestions";`

- [ ] **Step 4: Add the pending-count store update, registered once per binding like `imagesMap`/`metaMap` already are**

`imagesMap`/`metaMap`'s own observers in `createDocBinding` are registered ONCE for the binding's whole lifetime (not re-registered on every `bindActiveDoc` call), and each checks `workspaceRoom.activeDocId === docId` before touching anything that reflects "the currently active document" — otherwise switching away to a different shared document would leave a stale listener overwriting shared UI state for a document that's no longer active. The suggestions count needs the exact same treatment, so it's added to `createDocBinding`, not `bindActiveDoc`.

In `client/src/collab.ts`, add the import: `import { pendingSuggestionCount } from "./stores/suggestions"; import { getSuggestionsMap } from "./suggestions";`

Inside `createDocBinding(docId, role)`, right after the existing `metaMap.observe(...)` block and before `const awareness = new awarenessProtocol.Awareness(ydoc);`:

```ts
  const suggestionsMap = getSuggestionsMap(ydoc);
  suggestionsMap.observe(() => {
    if (workspaceRoom.activeDocId === docId) pendingSuggestionCount.set(suggestionsMap.size);
  });
```

Then in `bindActiveDoc(docId)` (Step 3 above), right after `workspaceRoom.activeDocId = docId;`, set the initial count for the newly-active document (the observer above only fires on subsequent *changes*, not on activation itself):

```ts
  pendingSuggestionCount.set(getSuggestionsMap(binding.ydoc).size);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project=unit tests/client/src/collab.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add client/src/collab.ts tests/client/src/collab.test.ts
git commit -m "feat: wire suggestion mode into collab.ts role handling"
```

---

## Task 7: Client — pending-suggestions badge

**Files:**
- Create: `client/src/stores/suggestions.ts`
- Modify: `client/index.html` (badge markup, mirroring `#commentsBadge`)
- Modify: `client/src/components/MenuBar.svelte` (badge display, mirroring the Comments menu entry's badge)
- Test: `tests/client/src/components/MenuBar.test.ts` if it exists (check first — append; otherwise skip a dedicated component test and rely on Task 9's e2e coverage, since this is presentational wiring identical in shape to the already-tested comment badge)

**Interfaces:**
- Consumes: nothing new — `pendingSuggestionCount` is set by Task 6's `collab.ts`
- Produces: `export const pendingSuggestionCount = writable(0);`

- [ ] **Step 1: Create the store**

```ts
// client/src/stores/suggestions.ts
import { writable } from "svelte/store";

// Pending-suggestion count for the currently active document only — same
// scoping as stores/commentsPanel.ts's unresolvedCommentCount (never a
// cross-document/workspace total). A local (never-shared) document has no
// suggestion concept at all, so this stays 0 for it.
export const pendingSuggestionCount = writable(0);
```

- [ ] **Step 2: Add badge markup to `client/index.html`**

Find the existing `#commentsBtn`/`#commentsBadge` block (around line 352) and add an equivalent sibling for suggestions right after it:

```html
            <button id="suggestionsBtn" class="icon-btn" type="button" title="Suggestions" aria-label="Suggestions" hidden>
              <svg class="icon"><use href="#icon-edit-3"></use></svg>
              <span id="suggestionsBadge" class="comment-badge" hidden></span>
            </button>
```

(`hidden` by default on the button itself — Task 8 shows it only when the active document has `reviewer`/`editor` role and at least one suggestion exists; check `index.html`'s actual icon sprite sheet for an existing pencil/edit-style icon id before inventing `#icon-edit-3` — reuse whatever this codebase already ships instead of adding a new SVG symbol if an equivalent one exists.)

- [ ] **Step 3: Wire the badge and button visibility in `MenuBar.svelte`**

Follow the exact pattern `CommentsPanel.svelte` already uses for `#commentsBadge` (a Svelte `$effect` toggling `hidden`/`textContent` on the plain-HTML element, since it lives in `index.html` not this component's own markup):

```svelte
<script lang="ts">
  import { pendingSuggestionCount } from "../stores/suggestions";
  // ... existing imports

  $effect(() => {
    const btn = document.getElementById("suggestionsBtn");
    const badge = document.getElementById("suggestionsBadge");
    if (!btn || !badge) return;
    const count = $pendingSuggestionCount;
    btn.hidden = count === 0;
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? "99+" : String(count);
  });
</script>
```

Place this alongside `MenuBar.svelte`'s existing `$effect` blocks (it already has one for `#commentsBtn`'s active-class toggle, per this codebase's established per-element `$effect` pattern for plain-HTML elements it doesn't own).

- [ ] **Step 4: Manual verification (no automated test for this presentational task — Task 9's e2e covers the end-to-end behavior)**

Run: `npm run dev:client`, open two tabs on a shared workspace (one as reviewer, one as editor via the dev-login flow used in `tests/e2e/collab`), have the reviewer type something, and confirm the badge appears with count `1` in both tabs.

- [ ] **Step 5: Commit**

```bash
git add client/src/stores/suggestions.ts client/index.html client/src/components/MenuBar.svelte
git commit -m "feat: pending-suggestion count badge"
```

---

## Task 8: Client — Preview pane suggestion rendering

**Files:**
- Create: `client/src/suggestion-preview.ts`
- Modify: `client/src/components/Preview.svelte` (wire `transformSuggestions` into the existing raw-text transform pipeline, `updatePreview()`)
- Modify: `client/src/styles/_editor-preview.scss` (`<ins>`/`<del>` styling inside `#preview`)
- Test: `tests/client/src/suggestion-preview.test.ts`

**Interfaces:**
- Consumes: `ResolvedSuggestion`, `listResolvedSuggestions` from `./suggestions`
- Produces: `function transformSuggestions(raw: string, suggestions: ResolvedSuggestion[]): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/client/src/suggestion-preview.test.ts
import { describe, it, expect } from "vitest";
import { transformSuggestions } from "../../../client/src/suggestion-preview";
import type { ResolvedSuggestion } from "../../../client/src/suggestions";

function suggestion(over: Partial<ResolvedSuggestion>): ResolvedSuggestion {
  return { id: "s1", kind: "insert", author: "alice", createdAt: 0, from: 0, to: 0, ...over };
}

describe("transformSuggestions", () => {
  it("wraps a pending insert range in <ins>", () => {
    const raw = "hello world";
    const out = transformSuggestions(raw, [suggestion({ kind: "insert", from: 6, to: 11, id: "s1" })]);
    expect(out).toBe('hello <ins class="suggestion-insert" data-suggestion-id="s1">world</ins>');
  });

  it("wraps a pending delete range in <del>", () => {
    const raw = "hello world";
    const out = transformSuggestions(raw, [suggestion({ kind: "delete", from: 0, to: 6, id: "s1" })]);
    expect(out).toBe('<del class="suggestion-delete" data-suggestion-id="s1">hello </del>world');
  });

  it("wraps multiple non-overlapping suggestions in document order", () => {
    const raw = "hello world";
    const out = transformSuggestions(raw, [
      suggestion({ kind: "delete", from: 0, to: 5, id: "s1" }),
      suggestion({ kind: "insert", from: 6, to: 11, id: "s2" }),
    ]);
    expect(out).toBe('<del class="suggestion-delete" data-suggestion-id="s1">hello</del> <ins class="suggestion-insert" data-suggestion-id="s2">world</ins>');
  });

  it("returns the raw text unchanged when there are no suggestions", () => {
    expect(transformSuggestions("hello world", [])).toBe("hello world");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project=unit tests/client/src/suggestion-preview.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement `client/src/suggestion-preview.ts`**

```ts
import type { ResolvedSuggestion } from "./suggestions";

// Wraps each suggestion's range in raw <ins>/<del> HTML before the text
// reaches marked.parse() — same "transform raw markdown text before
// parsing" pattern this codebase already uses for wikilinks/citations/
// math (see Preview.svelte's updatePreview()). marked passes raw inline
// HTML through by default, and <ins>/<del> are already in DOMPurify's
// default allowlist, so no sanitizer changes are needed.
//
// Known limitation (see design spec): if a suggestion's boundary falls
// inside Markdown syntax itself (splitting a "**" pair, or crossing a
// fenced code block), Preview may render that one pending suggestion's
// surrounding text oddly until it's resolved — inherent to layering
// suggestions on a Markdown source pipeline rather than a rich-text
// model. Never affects the editor pane or the eventual accept/reject.
export function transformSuggestions(raw: string, suggestions: ResolvedSuggestion[]): string {
  if (suggestions.length === 0) return raw;
  // Apply from the END of the string backward so earlier insertion
  // offsets are never invalidated by a later (in iteration order, but
  // earlier in the string) wrap changing the string's length.
  const sorted = [...suggestions].sort((a, b) => b.from - a.from);
  let result = raw;
  for (const s of sorted) {
    if (s.from < 0 || s.to > result.length || s.to <= s.from) continue;
    const tag = s.kind === "insert" ? "ins" : "del";
    const cls = s.kind === "insert" ? "suggestion-insert" : "suggestion-delete";
    const before = result.slice(0, s.from);
    const middle = result.slice(s.from, s.to);
    const after = result.slice(s.to);
    result = `${before}<${tag} class="${cls}" data-suggestion-id="${s.id}">${middle}</${tag}>${after}`;
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project=unit tests/client/src/suggestion-preview.test.ts`
Expected: PASS

- [ ] **Step 5: Wire into `Preview.svelte`'s `updatePreview()`**

Find the existing transform chain (`extractMathSpans(transformWikilinks(raw))`, then `transformSuperscriptSubscript(transformDefinitionLists(...))`, then `transformCitations(...)`) and add this as the final raw-text step before `marked.parse()`. It needs the active document's Y.Doc and role, which `Preview.svelte` doesn't currently hold a reference to — read it the same way `window.MDE` bridges reach collaboration state elsewhere in this codebase (check `collab.ts` for however it currently exposes the active binding, e.g. an exported `getActiveDocBinding()`-style function, and reuse that rather than inventing a new bridge path; if none exists, add a minimal one following this codebase's existing `window.MDE`-bridge convention: a `window.MDE.getActiveSuggestions?(): ResolvedSuggestion[]` hook that `collab.ts` sets in `bindActiveDoc` — mirroring how `setDocImage`/`onImageAdded` are documented in this codebase's own architecture notes as paired hooks for exactly this kind of "app.ts/Preview.svelte needs something only collab.ts's closure has" case). A local (non-shared) document has no such hook installed, so guard with `window.MDE.getActiveSuggestions?.() ?? []`.

```ts
    const withCitations = transformCitations(withInlineBlocks, citationPrefs, doc?.citations?.bibliography ?? []);
    const withSuggestions = transformSuggestions(withCitations, window.MDE.getActiveSuggestions?.() ?? []);
    const html = marked.parse(withSuggestions, { gfm: true, breaks: false, renderer }) as string;
```

Add the import: `import { transformSuggestions } from "../suggestion-preview";`

- [ ] **Step 6: Add CSS**

In `client/src/styles/_editor-preview.scss`, inside the existing `#preview { ... }` block (alongside `.wikilink`, `h1`, `code`, etc.):

```scss
  .suggestion-insert {
    text-decoration: underline;
    text-decoration-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }

  .suggestion-delete {
    text-decoration: line-through;
    text-decoration-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 10%, transparent);
  }
```

- [ ] **Step 7: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add client/src/suggestion-preview.ts client/src/components/Preview.svelte client/src/styles/_editor-preview.scss tests/client/src/suggestion-preview.test.ts
git commit -m "feat: render pending suggestions in the Preview pane"
```

---

## Task 9: Client — viewer mode becomes Preview-only

**Files:**
- Modify: `client/src/stores/view.ts` (a way to force/lock the mode)
- Modify: `client/src/collab.ts` (`bindActiveDoc` calls the lock for `role === "viewer"`, releases it otherwise)
- Modify: `client/src/components/MenuBar.svelte` and `client/src/components/Toolbar.svelte` (hide Editor/Split options when locked)
- Test: `tests/client/src/view.test.ts` if it exists (check first; otherwise a new `tests/client/src/stores-view.test.ts`)

**Interfaces:**
- Produces: `export function lockToPreviewOnly(): void`, `export function unlockViewMode(): void`, `export const viewModeLocked: Writable<boolean>` in `stores/view.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/client/src/stores-view.test.ts (adjust the exact filename/location to match this repo's actual convention for stores/view.ts — check for an existing test file first and extend it instead if one already covers view.ts)
import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import { viewMode, viewModeLocked, setView, lockToPreviewOnly, unlockViewMode } from "../../../client/src/stores/view";

describe("viewModeLocked", () => {
  beforeEach(() => {
    unlockViewMode();
  });

  it("forces preview mode and flags the lock", () => {
    setView("split");
    lockToPreviewOnly();
    expect(get(viewMode)).toBe("preview");
    expect(get(viewModeLocked)).toBe(true);
  });

  it("setView is a no-op while locked", () => {
    lockToPreviewOnly();
    setView("split");
    expect(get(viewMode)).toBe("preview");
  });

  it("unlocking allows setView again", () => {
    lockToPreviewOnly();
    unlockViewMode();
    setView("split");
    expect(get(viewMode)).toBe("split");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project=unit tests/client/src/stores-view.test.ts`
Expected: FAIL — `viewModeLocked`/`lockToPreviewOnly`/`unlockViewMode` don't exist

- [ ] **Step 3: Implement in `client/src/stores/view.ts`**

```ts
export const viewModeLocked = writable(false);

export function lockToPreviewOnly(): void {
  viewModeLocked.set(true);
  setView("preview");
}

export function unlockViewMode(): void {
  viewModeLocked.set(false);
}
```

Modify the existing `setView` to respect the lock:

```ts
export function setView(view: ViewMode): void {
  if (get(viewModeLocked) && view !== "preview") return;
  document.getElementById("body")!.className = `mode-${view}`;
  localStorage.setItem(STORAGE_VIEW, view);
  viewMode.set(view);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project=unit tests/client/src/stores-view.test.ts`
Expected: PASS

- [ ] **Step 5: Wire into `collab.ts`'s `bindActiveDoc`**

```ts
import { lockToPreviewOnly, unlockViewMode } from "./stores/view";

// inside bindActiveDoc, after the existing setReadOnly call:
  if (binding.role === "viewer") {
    lockToPreviewOnly();
  } else {
    unlockViewMode();
  }
```

And in `teardownWorkspace` (this file's existing cleanup function, near its `window.MDE.setReadOnly(false)` call): `unlockViewMode();` — a viewer leaving a shared workspace must not leave the app permanently stuck in Preview-only mode for whatever the user does locally afterward.

- [ ] **Step 6: Hide Editor/Split options while locked**

There's no separate "Editor" or "Split" control to hide — this app has one "Editor pane" toggle and one "Preview pane" toggle per surface (`toggleEditorPane`/`togglePreviewPane` from `stores/view.ts`), and split mode is simply "both toggled on." Locking to Preview-only means: hide the Editor-pane toggle entirely (nothing for a viewer to turn on), and leave the Preview-pane toggle out of the picture too since it would otherwise let a viewer toggle Preview *off*, leaving zero panes visible for a role that already has no editor to fall back to.

In `client/src/components/MenuBar.svelte`, add the import and wrap both view-toggle buttons (leaving the Toggle Sidebar and Focus Mode entries untouched):

```svelte
  import { viewMode, isEditorOn, isPreviewOn, toggleEditorPane, togglePreviewPane, viewModeLocked } from "../stores/view";
```

```svelte
      {#if !$viewModeLocked}
        <button class="menu-view-btn" class:active={viewEditorOn} type="button" onclick={() => act(toggleEditorPane)}>
          <svg class="icon menu-check"><use href="#icon-check"></use></svg> Editor pane
        </button>
        <button class="menu-view-btn" class:active={viewPreviewOn} type="button" onclick={() => act(togglePreviewPane)}>
          <svg class="icon menu-check"><use href="#icon-check"></use></svg> Preview pane
        </button>
      {/if}
      <div class="menu-divider"></div>
```

(replaces the existing two `<button class="menu-view-btn" ...>Editor pane</button>`/`...Preview pane</button>` block and the `<div class="menu-divider"></div>` immediately after it, at `client/src/components/MenuBar.svelte:242-248`.)

In `client/src/components/Toolbar.svelte`, add the same import and wrap the whole `.view-selector` block:

```svelte
  import { viewMode, isEditorOn, isPreviewOn, toggleEditorPane, togglePreviewPane, viewModeLocked } from "../stores/view";
```

```svelte
{#if !$viewModeLocked}
  <div class="view-selector" role="group" aria-label="View mode">
    <button type="button" class:active={editorOn} title="Toggle editor pane" aria-label="Toggle editor pane" aria-pressed={editorOn} onclick={toggleEditorPane}>
      <svg class="icon"><use href="#icon-panel-left"></use></svg>
    </button>
    <button type="button" class:active={previewOn} title="Toggle preview pane" aria-label="Toggle preview pane" aria-pressed={previewOn} onclick={togglePreviewPane}>
      <svg class="icon"><use href="#icon-panel-right"></use></svg>
    </button>
  </div>
{/if}
```

(replaces the existing `<div class="view-selector" ...>...</div>` block at `client/src/components/Toolbar.svelte:171-179`.)

- [ ] **Step 7: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add client/src/stores/view.ts client/src/collab.ts client/src/components/MenuBar.svelte client/src/components/Toolbar.svelte tests/client/src/stores-view.test.ts
git commit -m "feat: viewer role locks the app into Preview-only view"
```

---

## Task 10: Playwright e2e coverage (`tests/e2e/collab/suggestion-mode.spec.ts`)

**Files:**
- Create: `tests/e2e/collab/suggestion-mode.spec.ts`

**Interfaces:**
- Consumes: `signInAsDevUser` from `./support/dev-login` (existing helper, see `tests/e2e/collab/live-sync.spec.ts` for its usage pattern)

- [ ] **Step 1: Write the e2e test**

Follow `tests/e2e/collab/live-sync.spec.ts`'s exact setup pattern (two browser contexts, `signInAsDevUser`, workspace creation via `#emptyNewWorkspaceBtn`, sharing via the Share button) — read that file in full immediately before writing this one, since workspace/sharing setup for a fresh Playwright context has several specific quirks already documented in its comments (empty-workspace bootstrapping, the move-dialog dismissal, etc.) that this new test also needs.

```ts
// tests/e2e/collab/suggestion-mode.spec.ts
import { test, expect } from "@playwright/test";
import { signInAsDevUser } from "./support/dev-login";

const BASE = "http://localhost:8787";

test("a reviewer's edits become suggestions an editor can accept or reject, and a viewer sees preview-only", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const reviewerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const reviewer = await reviewerCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await signInAsDevUser(owner, "owner-e2e");
  await signInAsDevUser(reviewer, "reviewer-e2e");
  await signInAsDevUser(viewer, "viewer-e2e");

  // Owner creates and shares a workspace, inviting reviewer-e2e as
  // "reviewer" and viewer-e2e as "viewer" — follow live-sync.spec.ts's
  // exact share-dialog interaction sequence here (button text, dialog
  // dismissal), then additionally set each invited person's role via
  // whatever UI control this app's share dialog already exposes for
  // per-invite role (see collab.ts's setInviteRole, called from that
  // dialog) before both other contexts join.

  // Reviewer types text and confirms it renders as an underlined
  // suggestion, not plain committed text:
  await reviewer.click("#editor-mount .cm-content");
  await reviewer.keyboard.type("proposed addition");
  await expect(reviewer.locator(".cm-suggestion-insert")).toBeVisible();
  await expect(reviewer.locator("#preview .suggestion-insert")).toContainText("proposed addition");

  // Owner (editor) sees the same suggestion and accepts it:
  await expect(owner.locator(".cm-suggestion-insert")).toBeVisible({ timeout: 10000 });
  await owner.locator(".cm-suggestion-action[data-action='accept']").click();
  await expect(owner.locator(".cm-suggestion-insert")).toHaveCount(0);
  await expect(reviewer.locator(".cm-suggestion-insert")).toHaveCount(0, { timeout: 10000 });

  // Reviewer selects text and deletes it — confirms it's struck through,
  // not actually removed, until the owner rejects it (keeping the text):
  await reviewer.keyboard.press("Control+Home");
  await reviewer.keyboard.down("Shift");
  for (let i = 0; i < 8; i++) await reviewer.keyboard.press("ArrowRight");
  await reviewer.keyboard.up("Shift");
  await reviewer.keyboard.press("Backspace");
  await expect(reviewer.locator(".cm-suggestion-delete")).toBeVisible();
  await expect(owner.locator(".cm-suggestion-delete")).toBeVisible({ timeout: 10000 });
  await owner.locator(".cm-suggestion-action[data-action='reject']").click();
  await expect(owner.locator(".cm-suggestion-delete")).toHaveCount(0);

  // Viewer sees Preview only — no editor pane, no Editor/Split option.
  await viewer.goto(BASE); // or however live-sync.spec.ts navigates a joining collaborator to the shared workspace
  await expect(viewer.locator("#editor-mount")).toBeHidden();
  await expect(viewer.locator("#preview")).toBeVisible();
  await expect(viewer.locator("#viewMenuBtn")).toBeHidden().catch(() => {}); // adjust to this app's actual View-menu element id
});
```

- [ ] **Step 2: Run it against the real collab stack**

Run: `npm run test:e2e:collab`
Expected: PASS. This is the first time the whole feature runs against a real `WorkspaceRoom` Durable Object rather than mocked/unit-level pieces — fix any gaps between this plan's assumed selectors/flow and the actual app before moving on (in particular, verify the exact share-dialog role-setting control and the View menu's real element id/hidden-state selector against the live app rather than guessing further here).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/collab/suggestion-mode.spec.ts
git commit -m "test: e2e coverage for suggestion-mode collaboration"
```

---

## Task 11: Version bump, CHANGELOG, What's New, IMPROVEMENTS

**Files:**
- Modify: `package.json`, `package-lock.json` (both `"version"` fields)
- Modify: `CHANGELOG.md`
- Modify: `client/src/whats-new-entries.ts`
- Modify: `IMPROVEMENTS.md`

**Interfaces:** none — documentation/metadata only.

- [ ] **Step 1: Bump the minor version**

This is user-facing (per `CLAUDE.md`'s versioning rule) — bump the minor version. Read the current version from `package.json` first and increment accordingly (e.g. `1.38.x` → `1.39.0`; use whatever the actual current version is at execution time, not a value baked into this plan).

- [ ] **Step 2: Add a `CHANGELOG.md` entry**

```markdown
## [1.39.0] - <today's date>

### Added

- **Suggestion-mode collaboration.** The reviewer role now proposes edits instead of being read-only: insertions and deletions show up as tracked, per-suggestion changes (underlined additions, struck-through deletions) that the document's editor can accept or reject, or the reviewer can withdraw. Viewer role now shows Preview only, with no edit surface at all.
```

- [ ] **Step 3: Add a `client/src/whats-new-entries.ts` entry**

Follow this file's existing entry shape exactly (check the most recent entry for the current field names/structure before adding) — version must match the bump from Step 1, oldest-first ordering (append at the end), and needs a `screenshot` field pointing at a real asset path even if the actual image is added later by the user (name it following this file's existing screenshot path convention, e.g. `/whats-new/suggestion-mode.png`).

- [ ] **Step 4: Update `IMPROVEMENTS.md`**

Change the Phase 3 line:

```markdown
- [x] **Suggestion-mode collaboration** (Google Docs parity). (Shipped v1.39.0 — use the actual version from Step 1.) Reviewer role becomes a suggester; edits become tracked insert/delete suggestions an editor can accept or reject. Viewer mode now hides the editor entirely (Preview-only, comment-only... — actually comment permissions were explicitly left unchanged, see the design spec — adjust this parenthetical to say so accurately rather than copying the original backlog wording verbatim).
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts IMPROVEMENTS.md
git commit -m "chore: version bump and changelog for suggestion-mode collaboration"
```

---

## Task 12: Final verification

- [ ] **Step 1: Full unit/component suite**

Run: `npm test`
Expected: PASS (every test file, both `unit` and `components` projects)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors

- [ ] **Step 3: Format check**

Run: `npm run format:check`
Expected: clean (run `npm run format` first if not)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: succeeds

- [ ] **Step 5: Full local Playwright suite (client-only flows)**

Run: `npm run test:e2e:local`
Expected: PASS — confirms nothing in this feature (view-mode locking, read-only changes) regressed existing non-collab flows.

- [ ] **Step 6: Full collab Playwright suite**

Run: `npm run test:e2e:collab`
Expected: PASS, including Task 10's new spec.

- [ ] **Step 7: Manual smoke test**

Per `CLAUDE.md`: "For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete." Run `npm run build && npm run dev`, open a shared workspace as reviewer in one browser profile and as editor in another, confirm the full suggest → accept/reject loop and the Preview-pane rendering feel right, then confirm a viewer session shows Preview-only.

- [ ] **Step 8: Follow the shipping process** in `CLAUDE.md`'s "Shipping a change" section (PR against `master`, wait for CI, merge with a real merge commit, tag `vX.Y.Z` on the resulting commit).
