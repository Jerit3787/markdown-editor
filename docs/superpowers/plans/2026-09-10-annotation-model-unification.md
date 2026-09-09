# Annotation Model Unification (SP-B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move shared-document comment threads into a `comments` `Y.Map` on each doc's `Y.Doc` (out of `WorkspaceRoom` HTTP storage), give suggestions their own reply threads (D3), and retire the four HTTP comment endpoints + the `MESSAGE_COMMENTS` broadcast.

**Architecture:** A hand-synced `comments-doc.ts` pair holds the `Y.Doc` comment CRUD (mirroring `suggestions.ts`). A pure `comment-integrity.ts` (server-only) validates writes. `WorkspaceRoom` gains a `comments`-map observer that reverts any write failing the rules, and seeds the legacy `comments` storage key into the `Y.Doc` once on load. The SP-A rail reads the map directly — no fetch, no refetch-on-poke; Yjs sync is the liveness. `AnnotationCard` gains a reply thread for suggestions.

**Tech Stack:** Yjs (`Y.Map`, relative positions, `Y.Map.observe` with `oldValue`), Cloudflare Workers Durable Object, Svelte 5, Vitest (`unit` + `components`), Playwright (`collab`).

**Spec:** `docs/superpowers/specs/2026-09-10-annotation-model-unification-design.md`

## Global Constraints

- `src/**` + `tests/src/**` are **full-strict** TS. `client/src/**` + `tests/client/src/**` have `strictNullChecks`/`noImplicitAny` **off**.
- **`client/src/comments-doc.ts` and `src/comments-doc.ts` are hand-synced byte-identical copies.** A `readFileSync` byte-equality test (`tests/src/comments-doc-parity.test.ts`) is added and must pass in CI.
- Every server `Y.Doc` write that fixes/seeds carries a dedicated transaction origin so its own observer ignores it: `"comment-reconcile"` (revert), `"comment-migrate"` (seed). The existing suggestion one is `"suggestion"`. Client mutators use `"comment"`.
- The `Y.Doc`'s existing top-level types: `ytext` ("content"), `imagesMap` ("images"), `metaMap` ("name"), `suggestions`. This adds `comments`.
- `npm run format` + `npm run typecheck` (`tsc --noEmit` + `svelte-check`) pass. `local` Playwright → `vite dev`; `collab` Playwright → `wrangler dev` + real `WorkspaceRoom` (started by `tests/scripts/e2e-collab.sh`, which patches `src/worker.ts` — **commit `src/worker.ts` changes before running it**; this plan touches no `src/worker.ts`).
- Release `1.62.0`: `package.json` + both `package-lock.json` `"version"` fields, hand-edited (lines 3 and 9). `CHANGELOG.md` `### Added` + `### Changed`. A `client/src/whats-new-entries.ts` entry **with a real captured screenshot** — not deferrable.
- Never add a `Claude-Session:` trailer. `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` only.
- Branch `docs/sp-b-spec` holds the spec commit; do implementation work on it (or a fresh branch off it — the PR ships spec + plan + code together).

---

## File Structure

| File | Responsibility |
|---|---|
| `client/src/comments-doc.ts`, `src/comments-doc.ts` (new, hand-synced) | `Y.Doc` comment CRUD: `getCommentsMap`, `listResolvedCommentThreads`, `createCommentThread`, `addCommentReply`, `resolveCommentThread`, `deleteCommentThread`, `addSuggestionReply`; `CommentThreadEntry` / `ResolvedCommentThread` / `Reply` types; `seedCommentThreadsIntoDoc` |
| `src/comment-integrity.ts` (new, server-only) | Pure `isValidNewThread`, `isAllowedThreadTransition` |
| `client/src/suggestions.ts`, `src/suggestions.ts` (modify) | `SuggestionEntry.replies?` field — nothing else |
| `src/workspace-room.ts` (modify) | `comments`-map observer (validate+revert); D3 reply guard on the suggestions observer; `cachedAccess`; migration in `loadDocRoom` + `/internal/seed`; **delete** `handleComments*Request` (4), their routes, `MESSAGE_COMMENTS`, `broadcastCommentsChanged`, `getComments`/`createThread`/`addReply`/`resolveThread`/`deleteThread`/`persistComments`, `DocRoom.commentThreads` |
| `client/src/collab.ts` (modify) | per-binding `comments` observer → `window.MDE.onCommentsChanged`; delete `MESSAGE_COMMENTS` branch + `remoteCommentsChanged` import |
| `client/src/types.ts` (modify) | `MDEBridge.onCommentsChanged?` |
| `client/src/stores/commentsPanel.ts` (modify) | delete `remoteCommentsChanged` |
| `client/src/annotations.ts` (modify) | `threads` param type → `ResolvedCommentThread[]`; `replies` on suggestion `RailAnnotation` |
| `client/src/components/AnnotationRail.svelte` (modify) | shared-doc `loadEntries` reads the map; actions call `comments-doc` ops; suggestion `onReply` |
| `client/src/components/AnnotationCard.svelte` (modify) | reply thread + input for suggestions (D3) |
| `client/src/comments.ts`, `tests/client/src/comments.test.ts` (delete) | replaced by `comments-doc.ts` |

---

## Task 1: `comments-doc.ts` — the Y.Doc comment CRUD module (×2 hand-synced)

**Files:**
- Create: `client/src/comments-doc.ts`, `src/comments-doc.ts` (byte-identical)
- Modify: `client/src/suggestions.ts`, `src/suggestions.ts` (add `replies?` to `SuggestionEntry`)
- Test: `tests/client/src/comments-doc.test.ts`, `tests/src/comments-doc-parity.test.ts`

**Interfaces:**
- Consumes: `getSuggestionsMap` from `./suggestions`; `relocateAnchor` + `AnchorEntry` from `./anchor`.
- Produces:
  ```ts
  export interface Reply { id: string; author: string; body: string; createdAt: number; }
  export interface CommentThreadEntry {
    author: string; createdAt: number;
    from: ReturnType<typeof import("yjs").relativePositionToJSON>;
    to: ReturnType<typeof import("yjs").relativePositionToJSON>;
    quote: string; resolved: boolean; replies: Reply[];
  }
  export interface ResolvedCommentThread {
    id: string; author: string; createdAt: number;
    from: number; to: number; quote: string; resolved: boolean; replies: Reply[];
  }
  export function getCommentsMap(doc: Y.Doc): Y.Map<CommentThreadEntry>;
  export function listResolvedCommentThreads(doc: Y.Doc, content?: string): ResolvedCommentThread[];
  export function createCommentThread(doc: Y.Doc, from: number, to: number, quote: string, author: string, body: string, now?: number): string;
  export function addCommentReply(doc: Y.Doc, threadId: string, author: string, body: string, now?: number): void;
  export function resolveCommentThread(doc: Y.Doc, threadId: string, resolved: boolean): void;
  export function deleteCommentThread(doc: Y.Doc, threadId: string): void;
  export function addSuggestionReply(doc: Y.Doc, suggestionId: string, author: string, body: string, now?: number): void;
  export function seedCommentThreadsIntoDoc(doc: Y.Doc, threads: { id: string; from: number; to: number; quote: string; resolved: boolean; comments: Reply[] }[]): void;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/client/src/comments-doc.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  getCommentsMap,
  listResolvedCommentThreads,
  createCommentThread,
  addCommentReply,
  resolveCommentThread,
  deleteCommentThread,
  addSuggestionReply,
  seedCommentThreadsIntoDoc,
} from "../../../client/src/comments-doc";
import { getSuggestionsMap, recordInsertSuggestion, listResolvedSuggestions } from "../../../src/suggestions";

function docWith(text: string): Y.Doc {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  return d;
}

describe("comments-doc", () => {
  it("createCommentThread stores a thread with one self-authored reply, unresolved", () => {
    const doc = docWith("hello world");
    const id = createCommentThread(doc, 0, 5, "hello", "alice", "is this right?", 100);
    const [t] = listResolvedCommentThreads(doc);
    expect(t).toMatchObject({ id, author: "alice", from: 0, to: 5, quote: "hello", resolved: false });
    expect(t.replies).toEqual([{ id: expect.any(String), author: "alice", body: "is this right?", createdAt: 100 }]);
  });

  it("addCommentReply appends a reply, leaving the rest untouched", () => {
    const doc = docWith("hello world");
    const id = createCommentThread(doc, 0, 5, "hello", "alice", "q?", 100);
    addCommentReply(doc, id, "bob", "yes", 200);
    const [t] = listResolvedCommentThreads(doc);
    expect(t.replies.map((r) => [r.author, r.body])).toEqual([["alice", "q?"], ["bob", "yes"]]);
    expect(t.resolved).toBe(false);
  });

  it("resolveCommentThread toggles resolved without touching replies", () => {
    const doc = docWith("hello world");
    const id = createCommentThread(doc, 0, 5, "hello", "alice", "q?", 100);
    resolveCommentThread(doc, id, true);
    expect(listResolvedCommentThreads(doc)[0].resolved).toBe(true);
    resolveCommentThread(doc, id, false);
    expect(listResolvedCommentThreads(doc)[0].resolved).toBe(false);
  });

  it("deleteCommentThread removes the entry", () => {
    const doc = docWith("hello world");
    const id = createCommentThread(doc, 0, 5, "hello", "alice", "q?", 100);
    deleteCommentThread(doc, id);
    expect(listResolvedCommentThreads(doc)).toEqual([]);
  });

  it("a thread's anchor tracks an edit made before it", () => {
    const doc = docWith("hello world");
    createCommentThread(doc, 6, 11, "world", "alice", "q?", 100);
    doc.getText("content").insert(0, "PREFIX ");
    const [t] = listResolvedCommentThreads(doc);
    expect(doc.getText("content").toString().slice(t.from, t.to)).toBe("world");
  });

  it("re-anchors via quote when the relative position died (version restore)", () => {
    const doc = docWith("alpha beta gamma");
    const id = createCommentThread(doc, 6, 10, "beta", "alice", "q?", 100);
    // Wholesale replace ytext — the relative position no longer resolves,
    // but the quoted word is still present.
    const ytext = doc.getText("content");
    doc.transact(() => {
      ytext.delete(0, ytext.length);
      ytext.insert(0, "gamma beta alpha");
    });
    const [t] = listResolvedCommentThreads(doc, doc.getText("content").toString());
    expect(t.id).toBe(id);
    expect(doc.getText("content").toString().slice(t.from, t.to)).toBe("beta");
  });

  it("addSuggestionReply appends a reply onto a SuggestionEntry", () => {
    const doc = docWith("hello world");
    recordInsertSuggestion(doc, 0, 5, "alice");
    const sid = listResolvedSuggestions(doc)[0].id;
    addSuggestionReply(doc, sid, "bob", "why?", 300);
    const entry = getSuggestionsMap(doc).get(sid) as { replies?: { author: string; body: string }[] };
    expect(entry.replies).toEqual([{ id: expect.any(String), author: "bob", body: "why?", createdAt: 300 }]);
  });

  it("seedCommentThreadsIntoDoc converts legacy threads to relative-position entries", () => {
    const doc = docWith("one two three");
    seedCommentThreadsIntoDoc(doc, [
      { id: "t1", from: 4, to: 7, quote: "two", resolved: true, comments: [{ id: "c1", author: "z", body: "b", createdAt: 1 }] },
    ]);
    const [t] = listResolvedCommentThreads(doc);
    expect(t).toMatchObject({ id: "t1", from: 4, to: 7, quote: "two", resolved: true });
  });
});
```

- [ ] **Step 2: Write the byte-parity test**

Create `tests/src/comments-doc-parity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");

describe("comments-doc hand-sync", () => {
  it("client/src/comments-doc.ts and src/comments-doc.ts are byte-identical", () => {
    const a = readFileSync(resolve(root, "client/src/comments-doc.ts"), "utf8");
    const b = readFileSync(resolve(root, "src/comments-doc.ts"), "utf8");
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `npx vitest run tests/client/src/comments-doc.test.ts tests/src/comments-doc-parity.test.ts`
Expected: FAIL — module `comments-doc` not found.

- [ ] **Step 4: Add `replies?` to `SuggestionEntry` in both `suggestions.ts` copies**

In `client/src/suggestions.ts` **and** `src/suggestions.ts`, change:

```ts
export interface SuggestionEntry {
  kind: "insert" | "delete";
  author: string;
  createdAt: number;
  from: ReturnType<typeof Y.relativePositionToJSON>;
  to: ReturnType<typeof Y.relativePositionToJSON>;
}
```

to add one line:

```ts
  to: ReturnType<typeof Y.relativePositionToJSON>;
  // SP-B / D3 — an optional discussion thread on the suggestion card.
  // Absent on every suggestion made before v1.62.0 and the common case.
  replies?: { id: string; author: string; body: string; createdAt: number }[];
```

Do not touch anything else in `suggestions.ts` — the merge/reconcile logic must stay frozen.

- [ ] **Step 5: Implement `comments-doc.ts` (write once, copy verbatim to the other path)**

Create `client/src/comments-doc.ts`:

```ts
import * as Y from "yjs";
import { getSuggestionsMap } from "./suggestions";
import { relocateAnchor } from "./anchor";

// Comment threads on a shared document's Y.Doc — a top-level `comments`
// Y.Map alongside `ytext`, `imagesMap`, `metaMap`, `suggestions`. Same
// relative-position anchoring as suggestions.ts (helpers copied, not
// imported — this file is hand-synced with src/comments-doc.ts and must
// stand alone).
//
// KEEP client/src/comments-doc.ts AND src/comments-doc.ts BYTE-IDENTICAL
// (tests/src/comments-doc-parity.test.ts fails CI otherwise).

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface CommentThreadEntry {
  author: string;
  createdAt: number;
  from: ReturnType<typeof Y.relativePositionToJSON>;
  to: ReturnType<typeof Y.relativePositionToJSON>;
  quote: string;
  resolved: boolean;
  replies: Reply[];
}

export interface ResolvedCommentThread {
  id: string;
  author: string;
  createdAt: number;
  from: number;
  to: number;
  quote: string;
  resolved: boolean;
  replies: Reply[];
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function getCommentsMap(doc: Y.Doc): Y.Map<CommentThreadEntry> {
  return doc.getMap<CommentThreadEntry>("comments");
}

// assoc: `to` uses -1 so an edit landing exactly at a thread's end does
// not silently grow it — same reasoning suggestions.ts documents.
function toRelative(ytext: Y.Text, index: number, assoc: 0 | -1 = 0): ReturnType<typeof Y.relativePositionToJSON> {
  return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, index, assoc));
}

function toAbsoluteIndex(doc: Y.Doc, ytext: Y.Text, json: ReturnType<typeof Y.relativePositionToJSON>): number | null {
  const pos = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc);
  if (!pos || pos.type !== ytext) return null;
  return pos.index;
}

// Every live thread, relative positions resolved to absolute offsets.
// When a relative position no longer resolves (a version restore rewrote
// ytext wholesale) but `content` is supplied and still holds the quoted
// text, re-anchor there and rewrite the entry's positions to fresh ones.
// A thread whose quote is also gone is dropped from the result.
export function listResolvedCommentThreads(doc: Y.Doc, content?: string): ResolvedCommentThread[] {
  const ytext = doc.getText("content");
  const map = getCommentsMap(doc);
  const out: ResolvedCommentThread[] = [];
  const reanchor: { id: string; from: number; to: number }[] = [];
  map.forEach((entry, id) => {
    let from = toAbsoluteIndex(doc, ytext, entry.from);
    let to = toAbsoluteIndex(doc, ytext, entry.to);
    if ((from === null || to === null) && content) {
      const loc = relocateAnchor(content, { from: 0, to: 0, quote: entry.quote });
      if (loc) {
        from = loc.from;
        to = loc.to;
        reanchor.push({ id, from, to });
      }
    }
    if (from === null || to === null) return;
    out.push({
      id,
      author: entry.author,
      createdAt: entry.createdAt,
      from,
      to,
      quote: entry.quote,
      resolved: entry.resolved,
      replies: entry.replies ?? [],
    });
  });
  if (reanchor.length) {
    doc.transact(() => {
      for (const r of reanchor) {
        const e = map.get(r.id);
        if (e) map.set(r.id, { ...e, from: toRelative(ytext, r.from), to: toRelative(ytext, r.to, -1) });
      }
    }, "comment");
  }
  return out.sort((a, b) => a.from - b.from || a.createdAt - b.createdAt);
}

export function createCommentThread(
  doc: Y.Doc,
  from: number,
  to: number,
  quote: string,
  author: string,
  body: string,
  now: number = Date.now(),
): string {
  const ytext = doc.getText("content");
  const map = getCommentsMap(doc);
  const id = uid();
  doc.transact(() => {
    map.set(id, {
      author,
      createdAt: now,
      from: toRelative(ytext, from),
      to: toRelative(ytext, to, -1),
      quote,
      resolved: false,
      replies: [{ id: uid(), author, body, createdAt: now }],
    });
  }, "comment");
  return id;
}

export function addCommentReply(doc: Y.Doc, threadId: string, author: string, body: string, now: number = Date.now()): void {
  const map = getCommentsMap(doc);
  const entry = map.get(threadId);
  if (!entry) return;
  doc.transact(() => {
    map.set(threadId, { ...entry, replies: [...entry.replies, { id: uid(), author, body, createdAt: now }] });
  }, "comment");
}

export function resolveCommentThread(doc: Y.Doc, threadId: string, resolved: boolean): void {
  const map = getCommentsMap(doc);
  const entry = map.get(threadId);
  if (!entry || entry.resolved === resolved) return;
  doc.transact(() => map.set(threadId, { ...entry, resolved }), "comment");
}

export function deleteCommentThread(doc: Y.Doc, threadId: string): void {
  const map = getCommentsMap(doc);
  if (!map.has(threadId)) return;
  doc.transact(() => map.delete(threadId), "comment");
}

// D3 — a reply thread on a suggestion. Kept here (not suggestions.ts) so
// that file stays frozen. `replies` is an optional field on SuggestionEntry.
export function addSuggestionReply(doc: Y.Doc, suggestionId: string, author: string, body: string, now: number = Date.now()): void {
  const map = getSuggestionsMap(doc);
  const entry = map.get(suggestionId) as (Record<string, unknown> & { replies?: Reply[] }) | undefined;
  if (!entry) return;
  doc.transact(() => {
    map.set(suggestionId, { ...entry, replies: [...(entry.replies ?? []), { id: uid(), author, body, createdAt: now }] } as never);
  }, "comment");
}

// Convert legacy HTTP-stored threads (plain char offsets) into
// relative-position Y.Map entries. Used by the server's one-time
// migration and the legacy-CollabRoom /internal/seed path. `content` is
// the doc's current text; a thread whose quote no longer matches anchors
// at offset 0.
export function seedCommentThreadsIntoDoc(
  doc: Y.Doc,
  threads: { id: string; from: number; to: number; quote: string; resolved: boolean; comments: Reply[] }[],
): void {
  const ytext = doc.getText("content");
  const content = ytext.toString();
  const map = getCommentsMap(doc);
  doc.transact(() => {
    for (const t of threads) {
      const loc = relocateAnchor(content, { from: t.from, to: t.to, quote: t.quote });
      const from = loc?.from ?? 0;
      const to = loc?.to ?? 0;
      map.set(t.id, {
        author: t.comments[0]?.author ?? "",
        createdAt: t.comments[0]?.createdAt ?? Date.now(),
        from: toRelative(ytext, from),
        to: toRelative(ytext, to, -1),
        quote: t.quote,
        resolved: t.resolved,
        replies: t.comments.map((c) => ({ id: c.id, author: c.author, body: c.body, createdAt: c.createdAt })),
      });
    }
  }, "comment-migrate");
}
```

Then: `cp client/src/comments-doc.ts src/comments-doc.ts`. **Check** that `src/anchor.ts` exports `relocateAnchor` with the same signature (`relocateAnchor(content, { from, to, quote })` → `{ from, to } | null`) — it does (`AnchorEntry` interface); both `./anchor` imports resolve.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/client/src/comments-doc.test.ts tests/src/comments-doc-parity.test.ts && npm run typecheck`
Expected: PASS (8 + 1). Fix any strict-mode complaint in `src/comments-doc.ts` — since the two files are identical, the fix must satisfy both tsconfigs (the `as never` on the suggestion-map set is deliberate: the frozen `SuggestionEntry` type doesn't want extra fields spread onto it from a generic record).

- [ ] **Step 7: Commit**

```bash
git add client/src/comments-doc.ts src/comments-doc.ts client/src/suggestions.ts src/suggestions.ts tests/client/src/comments-doc.test.ts tests/src/comments-doc-parity.test.ts
git commit -m "$(cat <<'EOF'
feat(comments): Y.Doc comment CRUD module + SuggestionEntry.replies

client/src/comments-doc.ts + src/comments-doc.ts (hand-synced): a
`comments` Y.Map on the doc with the same relative-position anchoring as
suggestions, plus addSuggestionReply for D3 and seedCommentThreadsIntoDoc
for the server migration. suggestions.ts gains an optional `replies`
field only.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `comment-integrity.ts` — pure server-side validators

**Files:**
- Create: `src/comment-integrity.ts`
- Test: `tests/src/comment-integrity.test.ts`

**Interfaces:**
- Consumes: `CommentThreadEntry`, `Reply` from `./comments-doc`.
- Produces:
  ```ts
  export function isValidNewThread(entry: CommentThreadEntry, username: string | null): boolean;
  export function isAllowedThreadTransition(oldEntry: CommentThreadEntry, newEntry: CommentThreadEntry, username: string | null): boolean;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/src/comment-integrity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isValidNewThread, isAllowedThreadTransition } from "../../src/comment-integrity";
import type { CommentThreadEntry } from "../../src/comments-doc";

const REL = { type: null, tname: "content", item: null, assoc: 0 } as unknown as CommentThreadEntry["from"];

function thread(over: Partial<CommentThreadEntry> = {}): CommentThreadEntry {
  return {
    author: "alice",
    createdAt: 1,
    from: REL,
    to: REL,
    quote: "hi",
    resolved: false,
    replies: [{ id: "r1", author: "alice", body: "q?", createdAt: 1 }],
    ...over,
  };
}

describe("isValidNewThread", () => {
  it("accepts a self-authored, single-reply, unresolved thread", () => {
    expect(isValidNewThread(thread(), "alice")).toBe(true);
  });
  it("rejects an author mismatch", () => {
    expect(isValidNewThread(thread({ author: "bob" }), "alice")).toBe(false);
    expect(isValidNewThread(thread({ replies: [{ id: "r1", author: "bob", body: "q?", createdAt: 1 }] }), "alice")).toBe(false);
  });
  it("rejects multi-reply, pre-resolved, or empty body", () => {
    expect(isValidNewThread(thread({ replies: [thread().replies[0], { id: "r2", author: "alice", body: "x", createdAt: 2 }] }), "alice")).toBe(false);
    expect(isValidNewThread(thread({ resolved: true }), "alice")).toBe(false);
    expect(isValidNewThread(thread({ replies: [{ id: "r1", author: "alice", body: "   ", createdAt: 1 }] }), "alice")).toBe(false);
  });
});

describe("isAllowedThreadTransition", () => {
  it("accepts a resolve toggle and nothing else changed", () => {
    expect(isAllowedThreadTransition(thread(), thread({ resolved: true }), "carol")).toBe(true);
  });
  it("accepts one self-authored reply appended", () => {
    const next = thread({ replies: [thread().replies[0], { id: "r2", author: "bob", body: "yes", createdAt: 5 }] });
    expect(isAllowedThreadTransition(thread(), next, "bob")).toBe(true);
  });
  it("rejects a foreign-authored appended reply", () => {
    const next = thread({ replies: [thread().replies[0], { id: "r2", author: "eve", body: "yes", createdAt: 5 }] });
    expect(isAllowedThreadTransition(thread(), next, "bob")).toBe(false);
  });
  it("rejects editing an existing reply, changing author/quote, or two replies at once", () => {
    expect(isAllowedThreadTransition(thread(), thread({ replies: [{ id: "r1", author: "alice", body: "EDITED", createdAt: 1 }] }), "alice")).toBe(false);
    expect(isAllowedThreadTransition(thread(), thread({ author: "bob" }), "bob")).toBe(false);
    expect(isAllowedThreadTransition(thread(), thread({ quote: "changed" }), "alice")).toBe(false);
    const two = thread({ replies: [thread().replies[0], { id: "a", author: "bob", body: "1", createdAt: 2 }, { id: "b", author: "bob", body: "2", createdAt: 3 }] });
    expect(isAllowedThreadTransition(thread(), two, "bob")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/src/comment-integrity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/comment-integrity.ts`:

```ts
import type { CommentThreadEntry, Reply } from "./comments-doc";

function repliesEqual(a: Reply[], b: Reply[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => r.id === b[i].id && r.author === b[i].author && r.body === b[i].body && r.createdAt === b[i].createdAt);
}

// Everything except `resolved` and `replies` must match — those two are
// the only fields a transition is allowed to move.
function coreEqual(a: CommentThreadEntry, b: CommentThreadEntry): boolean {
  return a.author === b.author && a.createdAt === b.createdAt && a.quote === b.quote && JSON.stringify(a.from) === JSON.stringify(b.from) && JSON.stringify(a.to) === JSON.stringify(b.to);
}

export function isValidNewThread(entry: CommentThreadEntry, username: string | null): boolean {
  return (
    !!username &&
    entry.author === username &&
    entry.resolved === false &&
    Array.isArray(entry.replies) &&
    entry.replies.length === 1 &&
    entry.replies[0].author === username &&
    typeof entry.replies[0].body === "string" &&
    entry.replies[0].body.trim() !== "" &&
    entry.from != null &&
    entry.to != null
  );
}

export function isAllowedThreadTransition(oldEntry: CommentThreadEntry, newEntry: CommentThreadEntry, username: string | null): boolean {
  if (!coreEqual(oldEntry, newEntry)) return false;

  // resolve / reopen toggle, replies unchanged
  if (repliesEqual(oldEntry.replies, newEntry.replies) && oldEntry.resolved !== newEntry.resolved) return true;

  // exactly one reply appended, by the writer, non-empty, resolved unchanged
  if (
    oldEntry.resolved === newEntry.resolved &&
    newEntry.replies.length === oldEntry.replies.length + 1 &&
    repliesEqual(oldEntry.replies, newEntry.replies.slice(0, oldEntry.replies.length)) &&
    !!username &&
    newEntry.replies[newEntry.replies.length - 1].author === username &&
    newEntry.replies[newEntry.replies.length - 1].body.trim() !== ""
  ) {
    return true;
  }

  return false;
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run tests/src/comment-integrity.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/comment-integrity.ts tests/src/comment-integrity.test.ts
git commit -m "$(cat <<'EOF'
feat(comments): pure server-side comment-write validators

isValidNewThread / isAllowedThreadTransition — the rules the WorkspaceRoom
comments-map observer enforces (author match, reply-append or
resolve-toggle only).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Server — the `comments` map observer, `cachedAccess`, D3 reply guard

**Files:**
- Modify: `src/workspace-room.ts` — `loadDocRoom` (add the observer + migration hook-in point), a new `cachedAccess` field + its refreshers, the suggestions observer (D3 guard)
- Test: `tests/src/workspace-room.test.ts` (extend — new `describe("comment writes")`)

**Interfaces:**
- Consumes: `getCommentsMap`, `CommentThreadEntry`, `Reply` from `./comments-doc`; `isValidNewThread`, `isAllowedThreadTransition` from `./comment-integrity`; the existing `this.sessions` map and `SessionInfo`.
- Produces: nothing new exported — behaviour only.

- [ ] **Step 1: Write the failing integration tests**

Add to `tests/src/workspace-room.test.ts` a new block (near `describe("reviewer writes")`, reusing its `fakeSession`, `scratchUpdateWith`, `encodeSyncUpdate` helpers — check their exact names in the file and match):

```ts
import { getCommentsMap, createCommentThread, addCommentReply, deleteCommentThread, listResolvedCommentThreads } from "../../src/comments-doc";

describe("comment writes", () => {
  function fakeSession(username: string, role: "viewer" | "reviewer" | "editor") {
    return { username, role, viewingDocId: null };
  }

  async function roomWithDoc(text: string) {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, text);
    return { room, ws, docRoom };
  }

  // Apply a client-authored comments-map change to the room the way a real
  // WS sync frame would (origin = ws), so the server observer runs.
  async function applyFrom(room: any, ws: WebSocket, docRoom: any, mutate: (client: Y.Doc) => void) {
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(docRoom.doc));
    const before = Y.encodeStateVector(client);
    mutate(client);
    await room.handleMessage(ws, encodeSyncUpdate("doc1", Y.encodeStateAsUpdate(client, before)));
  }

  it("a reviewer's new thread survives", async () => {
    const { room, ws, docRoom } = await roomWithDoc("hello world");
    (room as any).sessions.set(ws, fakeSession("bob", "reviewer"));
    await applyFrom(room, ws, docRoom, (c) => createCommentThread(c, 0, 5, "hello", "bob", "q?", 1));
    expect(listResolvedCommentThreads(docRoom.doc)).toHaveLength(1);
  });

  it("a thread claiming a different author is reverted (deleted)", async () => {
    const { room, ws, docRoom } = await roomWithDoc("hello world");
    (room as any).sessions.set(ws, fakeSession("bob", "reviewer"));
    await applyFrom(room, ws, docRoom, (c) => createCommentThread(c, 0, 5, "hello", "eve", "q?", 1));
    expect(listResolvedCommentThreads(docRoom.doc)).toHaveLength(0);
  });

  it("a reply appended under someone else's name is reverted to the prior state", async () => {
    const { room, ws, docRoom } = await roomWithDoc("hello world");
    (room as any).sessions.set(ws, fakeSession("bob", "reviewer"));
    await applyFrom(room, ws, docRoom, (c) => createCommentThread(c, 0, 5, "hello", "bob", "q?", 1));
    const tid = listResolvedCommentThreads(docRoom.doc)[0].id;
    await applyFrom(room, ws, docRoom, (c) => addCommentReply(c, tid, "eve", "hi", 2));
    expect(listResolvedCommentThreads(docRoom.doc)[0].replies).toHaveLength(1);
  });

  it("deleting a thread the session neither started nor owns is reverted", async () => {
    const { room, ws, docRoom } = await roomWithDoc("hello world");
    await (room as any).state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [{ username: "bob", role: "reviewer" }] });
    (room as any).cachedAccess = null; // force a refresh path
    (room as any).sessions.set(ws, fakeSession("alice", "editor"));
    await applyFrom(room, ws, docRoom, (c) => createCommentThread(c, 0, 5, "hello", "alice", "q?", 1));
    const tid = listResolvedCommentThreads(docRoom.doc)[0].id;
    (room as any).sessions.set(ws, fakeSession("bob", "reviewer")); // bob is not the author, not owner
    await applyFrom(room, ws, docRoom, (c) => deleteCommentThread(c, tid));
    expect(listResolvedCommentThreads(docRoom.doc)).toHaveLength(1);
  });

  it("a viewer's comment write never applies (isWrite gate)", async () => {
    const { room, ws, docRoom } = await roomWithDoc("hello world");
    (room as any).sessions.set(ws, fakeSession("carol", "viewer"));
    await applyFrom(room, ws, docRoom, (c) => createCommentThread(c, 0, 5, "hello", "carol", "q?", 1));
    expect(listResolvedCommentThreads(docRoom.doc)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "comment writes"`
Expected: FAIL — the "author mismatch" / "foreign reply" / "delete" tests fail (no observer reverting them yet); the "survives" and "viewer" tests may already pass.

- [ ] **Step 3: Add `cachedAccess`**

In `src/workspace-room.ts`, add a private field to the class (near the other instance fields):

```ts
  // The access record, cached so the synchronous comments-map observer
  // can read `owner` without an async storage hit. Refreshed on load and
  // wherever `access` is written.
  private cachedAccess: AccessRecord | null = null;
```

In `getAccess()`, after computing the record and before returning it, add `this.cachedAccess = record;` (assign to a local `record` first if the current code returns an expression directly). Anywhere `this.state.storage.put("access", …)` is called (`PUT /access` handler, the request-access approve path, `/internal/seed`), follow it with `this.cachedAccess = await this.getAccess();`.

- [ ] **Step 4: Wire the `comments` observer in `loadDocRoom`**

In `loadDocRoom`, after the existing `suggestionsMap.observe(...)` block (the self-heal one), add:

```ts
    const commentsMap = getCommentsMap(doc);
    commentsMap.observe((event, txn) => {
      if (txn.origin === "comment-reconcile" || txn.origin === "comment-migrate") return;
      const session = this.sessions.get(txn.origin as WebSocket);
      if (!session || session.role === "viewer") return; // isWrite already dropped a viewer write; defensive
      const owner = this.cachedAccess?.owner ?? null;
      const reverts: Array<() => void> = [];
      event.changes.keys.forEach((change, key) => {
        if (change.action === "add") {
          const now = commentsMap.get(key);
          if (!now || !isValidNewThread(now, session.username)) reverts.push(() => commentsMap.delete(key));
        } else if (change.action === "update") {
          const now = commentsMap.get(key);
          const old = change.oldValue as CommentThreadEntry;
          if (!now || !isAllowedThreadTransition(old, now, session.username)) reverts.push(() => commentsMap.set(key, old));
        } else if (change.action === "delete") {
          const old = change.oldValue as CommentThreadEntry;
          if (session.username !== old.author && session.username !== owner) reverts.push(() => commentsMap.set(key, old));
        }
      });
      if (reverts.length) doc.transact(() => reverts.forEach((r) => r()), "comment-reconcile");
    });
```

Add imports at the top of `src/workspace-room.ts`:

```ts
import { getCommentsMap, seedCommentThreadsIntoDoc, type CommentThreadEntry } from "./comments-doc";
import { isValidNewThread, isAllowedThreadTransition } from "./comment-integrity";
```

For the delete test where `cachedAccess` starts `null`: make the observer's `owner` resolution fall back — replace `const owner = this.cachedAccess?.owner ?? null;` with a synchronous best-effort plus an async re-check:

```ts
      const owner = this.cachedAccess?.owner ?? null;
      // If the cache was cold, re-validate deletes async and revert then.
      if (this.cachedAccess === null && [...event.changes.keys.values()].some((c) => c.action === "delete")) {
        void this.getAccess().then((acc) => {
          const ownerNow = acc.owner;
          const late: Array<() => void> = [];
          event.changes.keys.forEach((change, key) => {
            if (change.action !== "delete") return;
            const old = change.oldValue as CommentThreadEntry;
            if (session.username !== old.author && session.username !== ownerNow && !commentsMap.has(key)) late.push(() => commentsMap.set(key, old));
          });
          if (late.length) doc.transact(() => late.forEach((r) => r()), "comment-reconcile");
        });
        return;
      }
```

(place this right after `const owner = ...`, before building `reverts`.)

- [ ] **Step 5: D3 — reply-author guard on the suggestions observer**

In the existing `suggestionsMap.observe(...)` callback (the self-heal one), at the very top, before the merge pass, add a reply-validation pass that reverts a foreign-authored reply append:

```ts
      const session = this.sessions.get(transaction.origin as WebSocket);
      if (session && session.role !== "viewer") {
        const reverts: Array<() => void> = [];
        event.changes.keys.forEach((change, key) => {
          if (change.action !== "update") return;
          const now = suggestionsMap.get(key) as { replies?: { author: string }[] } | undefined;
          const old = change.oldValue as { replies?: { author: string }[] };
          const oldN = old.replies?.length ?? 0;
          const newN = now?.replies?.length ?? 0;
          if (newN > oldN && now?.replies?.[newN - 1]?.author !== session.username) {
            reverts.push(() => suggestionsMap.set(key, old as never));
          }
        });
        if (reverts.length) doc.transact(() => reverts.forEach((r) => r()), "suggestion");
      }
```

Check the callback's actual parameter names — the existing one is `suggestionsMap.observe(() => { ... })` with **no** params (it re-reads the whole map). You must change its signature to `suggestionsMap.observe((event, transaction) => { ... })` to get `event`/`transaction`; verify that doesn't break the existing merge logic (it reads `listResolvedSuggestions(doc)` fresh, so adding params is safe).

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/src/workspace-room.test.ts && npm run typecheck`
Expected: PASS (whole file — the new block + all existing suggestion/reviewer tests still green).

- [ ] **Step 7: Commit**

```bash
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "$(cat <<'EOF'
feat(comments): server-side comments-map observer + D3 reply guard

WorkspaceRoom validates every comments-map write against the writing
session and reverts anything failing the rules (author match, reply
append or resolve toggle only, author-or-owner delete). A foreign
suggestion reply is likewise reverted. cachedAccess added so the sync
observer can read owner without an async hit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Server — migration + `/internal/seed`, then retire the HTTP endpoints

**Files:**
- Modify: `src/workspace-room.ts` — `loadDocRoom` (migration), `handleInternalSeedRequest`, and **delete** the comment HTTP surface
- Modify: `tests/src/workspace-room.test.ts` — a migration test; remove/rewrite the HTTP-comment tests

- [ ] **Step 1: Write the migration test**

Add to the `describe("comment writes")` block:

```ts
  it("seeds legacy stored comment threads into the Y.Doc once on load", async () => {
    const state = fakeState();
    // Pre-seed the doc's ytext + a legacy comments storage key.
    const seedDoc = new Y.Doc();
    seedDoc.getText("content").insert(0, "the quick brown fox");
    await state.storage.put("mde:doc:doc1:update", Y.encodeStateAsUpdate(seedDoc)); // match docStorageKey(...) format — check it
    await state.storage.put("mde:doc:doc1:comments", [
      { id: "t1", from: 4, to: 9, quote: "quick", orphaned: false, resolved: false, comments: [{ id: "c1", author: "alice", body: "why quick?", createdAt: 1 }] },
    ]);
    const room = new WorkspaceRoom(state, fakeEnv);
    const docRoom = await room.loadDocRoom("doc1");
    const threads = listResolvedCommentThreads(docRoom.doc);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: "t1", quote: "quick", from: 4, to: 9 });
    // A second load must not double-seed.
    const room2 = new WorkspaceRoom(state, fakeEnv);
    const docRoom2 = await room2.loadDocRoom("doc1");
    expect(listResolvedCommentThreads(docRoom2.doc)).toHaveLength(1);
  });
```

Run `grep -n "function docStorageKey" src/workspace-room.ts` and use the exact key format in the test's `state.storage.put` calls.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "seeds legacy"`
Expected: FAIL — no migration yet.

- [ ] **Step 3: Add the migration to `loadDocRoom`**

In `loadDocRoom`, replace:

```ts
    const storedComments = await this.state.storage.get<CommentThread[]>(docStorageKey(docId, "comments"));
```

and the `commentThreads: storedComments || [],` line in the `DocRoom` literal (delete that field — see Step 5), with a migration after the Y.Doc is populated from storage and **before** the observers are wired:

```ts
    // One-time migration: legacy HTTP-stored comment threads → the doc's
    // `comments` Y.Map. Runs server-side in the single-threaded DO before
    // any client syncs this doc, so no duplicate-seed race. The old
    // storage key is left in place as a backstop; nothing writes it now.
    const legacyComments = await this.state.storage.get<
      { id: string; from: number; to: number; quote: string; resolved: boolean; comments: { id: string; author: string; body: string; createdAt: number }[] }[]
    >(docStorageKey(docId, "comments"));
    if (legacyComments?.length && getCommentsMap(doc).size === 0) {
      seedCommentThreadsIntoDoc(doc, legacyComments);
    }
```

- [ ] **Step 4: Update `handleInternalSeedRequest`**

Replace:

```ts
    if (Array.isArray(body.comments)) {
      docRoom.commentThreads = body.comments as CommentThread[];
      await this.persistComments(docId, docRoom);
    }
```

with:

```ts
    if (Array.isArray(body.comments) && getCommentsMap(docRoom.doc).size === 0) {
      seedCommentThreadsIntoDoc(docRoom.doc, body.comments as never);
    }
```

- [ ] **Step 5: Delete the HTTP comment surface**

Remove from `src/workspace-room.ts`:
- `const MESSAGE_COMMENTS = 4;`
- `broadcastCommentsChanged(docId: string)` method (and its ~3 lines building/sending the frame)
- The four route matches in `fetch()`: `replyMatch`, `resolveMatch`, `commentIdMatch`, `commentsMatch` and their `if (...) return this.handleComment*Request(...)` lines
- `handleCommentsRequest`, `handleCommentReplyRequest`, `handleCommentResolveRequest`, `handleCommentDeleteRequest`
- `getComments`, `createThread`, `addReply`, `resolveThread`, `deleteThread`, `persistComments`
- `DocRoom.commentThreads` field
- `CommentThread` and `CommentReply` interface exports — **but** first check `grep -rn "CommentThread\|CommentReply" src/ tests/src/ client/src/` for other importers. `Snapshot` at line ~88 has a `comments: CommentReply[]`? Re-check — the earlier read showed `CommentReply` defined near `CommentThread` but `Snapshot` had no comment field. If nothing else imports them, delete; if `version-grouping.ts` or a test does, keep the interface (move it to be re-exported from `./comments-doc` as `LegacyCommentThread` and update those importers).
- The `import ... remoteCommentsChanged` is client-side (Task 6).

- [ ] **Step 6: Rewrite the HTTP-comment tests in `workspace-room.test.ts`**

Delete any `describe`/`it` exercising `GET/POST /docs/:id/comments`, `/reply`, `/resolve`, comment `DELETE`, or `broadcastCommentsChanged` / `MESSAGE_COMMENTS` receipt. Their coverage is replaced by Task 3's observer tests + Task 1's CRUD tests + Task 8's e2e. Grep: `grep -n "comments\|Comment" tests/src/workspace-room.test.ts`.

- [ ] **Step 7: Run**

Run: `npx vitest run tests/src/workspace-room.test.ts && npm run typecheck && npm run build`
Expected: PASS. `tsc` will flag every now-dead reference — chase them all down.

- [ ] **Step 8: Commit**

```bash
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "$(cat <<'EOF'
feat(comments): migrate stored threads to the Y.Doc; drop the HTTP endpoints

loadDocRoom + /internal/seed seed legacy comment threads into the
`comments` Y.Map once. The four HTTP comment handlers, their routes,
MESSAGE_COMMENTS, broadcastCommentsChanged, DocRoom.commentThreads and
persistComments are removed — comments now ride the doc's Yjs sync +
update persistence.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Client — bridge hook + `collab.ts` wiring

**Files:**
- Modify: `client/src/types.ts` (`MDEBridge.onCommentsChanged?`)
- Modify: `client/src/collab.ts` (per-binding observer; delete `MESSAGE_COMMENTS` branch + `remoteCommentsChanged` import)
- Modify: `client/src/stores/commentsPanel.ts` (delete `remoteCommentsChanged`)

**Interfaces:**
- Consumes: `getCommentsMap` from `./comments-doc`.
- Produces: `window.MDE.onCommentsChanged: (() => void) | null`.

- [ ] **Step 1: Extend `MDEBridge`**

In `client/src/types.ts`, next to the SP-A `onSuggestionsChanged?` line:

```ts
  /** Set by AnnotationRail.svelte; called by collab.ts's per-binding comments-map observer. */
  onCommentsChanged?: (() => void) | null;
```

- [ ] **Step 2: Wire the observer in `collab.ts`**

Add `import { getCommentsMap } from "./comments-doc";` near the `./suggestions` import.

In `applyEditorMode` (where SP-B added the `binding.suggestionsObserved` guard + `getSuggestionsMap(binding.ydoc).observe(...)`), add a sibling:

```ts
  if (!binding.commentsObserved) {
    binding.commentsObserved = true;
    getCommentsMap(binding.ydoc).observe(() => window.MDE.onCommentsChanged?.());
  }
```

Add `commentsObserved?: boolean;` to the `DocBinding` interface.

- [ ] **Step 3: Delete the `MESSAGE_COMMENTS` client branch**

In `client/src/collab.ts`:
- delete `import { remoteCommentsChanged } from "./stores/commentsPanel";`
- delete `const MESSAGE_COMMENTS = 4;`
- delete the `if (messageType === MESSAGE_COMMENTS) { const docId = ...; remoteCommentsChanged.update(...); return; }` block in `handleWorkspaceMessage`

- [ ] **Step 4: `stores/commentsPanel.ts`**

Delete the `remoteCommentsChanged` export and its doc comment. Keep `commentsPanelOpen`, `unresolvedCommentCount`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: FAIL — `AnnotationRail.svelte` still imports `remoteCommentsChanged` and `listComments`. That's Task 7. For now, temporarily comment out the `remoteCommentsChanged` `$effect` in `AnnotationRail.svelte` so `tsc` is green, OR do Steps of Task 7 first. **Recommended: do Task 7 in the same commit as Task 5** — they're mutually dependent. (This plan lists them separately for review clarity; the executor may merge them.)

- [ ] **Step 6: Commit (with Task 7)**

See Task 7 Step 8.

---

## Task 6: Client — `annotations.ts` adapter

**Files:**
- Modify: `client/src/annotations.ts`
- Test: `tests/client/src/annotations.test.ts` (extend)

**Interfaces:**
- Consumes: `ResolvedCommentThread` from `./comments-doc`, `ResolvedSuggestion` (with optional `replies`) from `./suggestions`.
- Produces: `railAnnotationsForShared(suggestions, threads: ResolvedCommentThread[], content)`; suggestion `RailAnnotation`s gain `replies?: Reply[]`.

- [ ] **Step 1: Write the failing test**

Add to `tests/client/src/annotations.test.ts`:

```ts
import type { ResolvedCommentThread } from "../../../client/src/comments-doc";

it("carries a suggestion's replies onto its RailAnnotation", () => {
  const doc = docWith(CONTENT);
  recordInsertSuggestion(doc, 5, 11, "alice");
  const list = listResolvedSuggestions(doc).map((s) => ({ ...s, replies: [{ id: "r", author: "bob", body: "why?", createdAt: 1 }] }));
  const [a] = railAnnotationsForShared(list, [], CONTENT);
  expect(a.replies).toEqual([{ id: "r", author: "bob", body: "why?", createdAt: 1 }]);
});

it("maps a ResolvedCommentThread (no HTTP CommentThread shape any more)", () => {
  const thread: ResolvedCommentThread = {
    id: "t1", author: "bob", createdAt: 0, from: 0, to: 5, quote: "hello", resolved: false,
    replies: [{ id: "c1", author: "bob", body: "sure?", createdAt: 10 }],
  };
  const [a] = railAnnotationsForShared([], [thread], CONTENT);
  expect(a).toMatchObject({ kind: "comment", author: "bob", quote: "hello", anchorFrom: 0, anchorTo: 5 });
  expect(a.replies).toHaveLength(1);
});
```

Update the existing `railAnnotationsForShared — comments` tests: replace the `CommentThread` literal (which had `from`/`to`/`orphaned` + `comments`) with a `ResolvedCommentThread` literal (`from`/`to` are already-resolved numbers, `replies` not `comments`, no `orphaned`). The adapter no longer calls `relocateAnchor` for threads — they arrive pre-resolved.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/client/src/annotations.test.ts`
Expected: FAIL — type/shape mismatch, `replies` not carried.

- [ ] **Step 3: Update the adapter**

In `client/src/annotations.ts`:
- `import type { ResolvedCommentThread, Reply } from "./comments-doc";` (drop the `CommentThread` import from `./comments`).
- `RailAnnotation` gains `replies?: Reply[]` (it may already have `replies` from SP-A for comments — confirm the shape matches `Reply`; align it).
- `suggestionCards(...)` — each produced `RailAnnotation` gets `replies: s.replies ?? undefined` (thread `s.replies` through — `ResolvedSuggestion` now optionally has it).
- `commentCard(thread: ResolvedCommentThread)` — the thread is **already resolved**: `anchorFrom: thread.from`, `anchorTo: thread.to`, no `relocateAnchor` call, `orphaned: false` (a thread that couldn't resolve was already dropped by `listResolvedCommentThreads`), `replies: thread.replies`, `author: thread.replies[0]?.author ?? thread.author`.
- `railAnnotationsForShared(suggestions: ResolvedSuggestion[], threads: ResolvedCommentThread[], content: string)`.
- `railAnnotationsForLocal` unchanged (still `Note[]` + `relocateAnchor`).

- [ ] **Step 4: Run**

Run: `npx vitest run tests/client/src/annotations.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit (standalone — this one has no cross-dependency)**

```bash
git add client/src/annotations.ts tests/client/src/annotations.test.ts
git commit -m "$(cat <<'EOF'
feat(comments): adapter takes ResolvedCommentThread + suggestion replies

railAnnotationsForShared's threads are now pre-resolved Y.Doc comment
threads (no relocateAnchor, no orphan-at-0). Suggestion RailAnnotations
carry their `replies` for the D3 card thread.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Client — `AnnotationRail.svelte` reads the Y.Map; delete `comments.ts`

**Files:**
- Modify: `client/src/components/AnnotationRail.svelte`
- Delete: `client/src/comments.ts`, `tests/client/src/comments.test.ts`

**Interfaces:**
- Consumes: `listResolvedCommentThreads`, `createCommentThread`, `addCommentReply`, `resolveCommentThread`, `deleteCommentThread`, `addSuggestionReply` from `../comments-doc`; `window.MDE.getActiveYDoc()`, `window.MDE.onCommentsChanged` (Task 5).

- [ ] **Step 1: Rewire imports**

In `AnnotationRail.svelte`:
- Remove `import { listComments, createComment, replyToComment, resolveComment, deleteComment, countUnresolvedComments, type CommentThread } from "../comments";`
- Remove `import { commentsPanelOpen, unresolvedCommentCount, remoteCommentsChanged } from "../stores/commentsPanel";` → `import { commentsPanelOpen, unresolvedCommentCount } from "../stores/commentsPanel";`
- Add `import { listResolvedCommentThreads, createCommentThread, addCommentReply, resolveCommentThread, deleteCommentThread, addSuggestionReply } from "../comments-doc";`

- [ ] **Step 2: `loadEntries` shared branch**

Replace the shared-doc branch:

```ts
    if (ctx.isShared) {
      const ydoc = window.MDE.getActiveYDoc?.() ?? null;
      const suggestions = window.MDE.getResolvedSuggestions?.() ?? [];
      const threads = ydoc ? listResolvedCommentThreads(ydoc, editorContent()) : [];
      annotations = railAnnotationsForShared(suggestions, threads, editorContent());
      unresolvedCommentCount.set(threads.filter((t) => !t.resolved).length);
    } else {
```

(no `await` — the whole `loadEntries` can stay `async` for the local `fetchAndMergeRepoHistory` branch.)

- [ ] **Step 3: Action handlers, shared branch**

- `submitDraft` shared: replace `await createComment(...)` with
  ```ts
  const ydoc = window.MDE.getActiveYDoc?.();
  if (ydoc) createCommentThread(ydoc, $commentDraft.from, $commentDraft.to, quote, window.MDE.githubUsername ?? "", draftBody.trim());
  ```
- `submitReply(threadId, body)` shared: `const ydoc = window.MDE.getActiveYDoc?.(); if (ydoc) addCommentReply(ydoc, threadId, window.MDE.githubUsername ?? "", body.trim());`
- `toggleResolve(threadId, resolved)` shared: `resolveCommentThread(ydoc, threadId, resolved)`
- `removeAnnotation(a)` shared: `deleteCommentThread(ydoc, a.id)`
- Each still calls `void loadEntries()` after (the observer also fires; idempotent).
- Wire `onReply` on the `<AnnotationCard>` for **suggestion** annotations too:
  ```ts
  onReply={(body) => {
    const ydoc = window.MDE.getActiveYDoc?.();
    if (!ydoc) return;
    if (a.kind === "suggestion") underlyingIds(a).forEach((id) => addSuggestionReply(ydoc, id, window.MDE.githubUsername ?? "", body));
    else submitReply(a.id, body);
  }}
  ```
  (for a grouped "replace" card, reply onto the first underlying id only — `underlyingIds(a)[0]`; adjust so it doesn't double-post.)

- [ ] **Step 4: Replace the `remoteCommentsChanged` effect with `onCommentsChanged`**

Delete the `$effect(() => { const signal = $remoteCommentsChanged; ... })` block. In `onMount`, alongside `window.MDE.onSuggestionsChanged = ...`:

```ts
    window.MDE.onCommentsChanged = () => queueMicrotask(() => void loadEntries());
```

and in the cleanup return, `window.MDE.onCommentsChanged = null;`.

- [ ] **Step 5: Delete `client/src/comments.ts` + its test**

```bash
git rm client/src/comments.ts tests/client/src/comments.test.ts
```

Grep for stragglers: `grep -rn 'from "../comments"\|from "./comments"\|client/src/comments"' client/src/ tests/`.

- [ ] **Step 6: Run**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS. `npm test` runs the whole unit suite — `comments-doc`, `annotations`, `workspace-room`, `AnnotationRail.test` (CV2-1b button gating — still valid), etc.

- [ ] **Step 7: Local e2e sanity**

Run: `npm run test:e2e:local -- comments annotation-rail`
Expected: PASS. The local specs use **local** docs (notes path, unchanged) — they should be unaffected. Fix any selector drift.

- [ ] **Step 8: Commit (Tasks 5 + 7 together)**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(comments): rail reads comments from the Y.Doc, not HTTP

AnnotationRail reads listResolvedCommentThreads(getActiveYDoc()) and
writes via the comments-doc ops; a per-binding comments-map observer
(collab.ts) drives re-derive through window.MDE.onCommentsChanged. The
MESSAGE_COMMENTS branch, remoteCommentsChanged, and client/src/comments.ts
are gone. Suggestion cards can now be replied to (D3).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Client — `AnnotationCard.svelte` suggestion reply thread + component tests

**Files:**
- Modify: `client/src/components/AnnotationCard.svelte`
- Modify: `client/src/styles/_annotations.scss` (if the thread block needs suggestion-scoped tweaks)
- Test: `tests/client/src/components/AnnotationCard.test.ts` (extend)

- [ ] **Step 1: Write the failing component test**

Add to `tests/client/src/components/AnnotationCard.test.ts`:

```ts
const suggestionWithThread: RailAnnotation = {
  id: "s1", kind: "suggestion", author: "alice", createdAt: 0, anchorFrom: 5, anchorTo: 11,
  changeKind: "insert", changeText: "world",
  replies: [{ id: "r1", author: "bob", body: "is this needed?", createdAt: 0 }],
};

test("a suggestion card shows its reply thread and a reply input when focused", async () => {
  const onReply = vi.fn();
  const screen = await render(AnnotationCard, {
    annotation: suggestionWithThread, viewer: { role: "editor", name: "carol" }, focused: true, onReply,
  });
  await expect.element(screen.getByText(/is this needed\?/)).toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: /accept/i })).toBeInTheDocument(); // action row still there
  const input = screen.getByPlaceholder(/reply/i);
  await input.fill("yes, matches the heading");
  await screen.getByRole("button", { name: /^reply$/i }).click();
  expect(onReply).toHaveBeenCalledWith("yes, matches the heading");
});

test("a collapsed suggestion card shows a reply count, not the input", async () => {
  const screen = await render(AnnotationCard, {
    annotation: suggestionWithThread, viewer: { role: "editor", name: "carol" }, focused: false,
  });
  await expect.element(screen.getByText(/1 repl/i)).toBeInTheDocument();
  expect(screen.container.querySelector("input")).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project=components tests/client/src/components/AnnotationCard.test.ts`
Expected: FAIL — the reply thread block is comment-only.

- [ ] **Step 3: Restructure the card body**

In `AnnotationCard.svelte`, the body block currently gated `{#if !isSuggestion}` becomes: render the thread affordance for **any** annotation that has one.

```svelte
{#if !isSuggestion || (annotation.replies?.length ?? 0) > 0 || focused}
  <div class="annotation-card-body">
    {#each annotation.replies ?? [] as reply (reply.id)}
      <p class="annotation-card-reply">{#if reply.author}<strong>{reply.author}</strong>&nbsp;{/if}{reply.body}</p>
    {/each}
    {#if focused}
      <div class="annotation-card-reply-row">
        <input type="text" placeholder="Reply…" bind:value={replyBody} onkeydown={(e) => e.key === "Enter" && submitReply()} />
        <button type="button" class="secondary-btn" onclick={submitReply}>Reply</button>
      </div>
    {:else if (annotation.replies?.length ?? 0) > (isSuggestion ? 0 : 1)}
      <p class="annotation-card-count">{annotation.replies!.length} {annotation.replies!.length === 1 ? "reply" : "replies"}</p>
    {/if}
  </div>
{/if}
```

For a **comment**, the first reply IS the comment text so the count starts at "> 1"; for a **suggestion**, every reply is discussion so "> 0". The action row (`{#if isSuggestion && isEditor}` etc.) is unchanged and still renders below.

- [ ] **Step 4: Run**

Run: `npx vitest run --project=components tests/client/src/components/AnnotationCard.test.ts && npm run typecheck`
Expected: PASS (the SP-A `AnnotationCard` tests + the 2 new ones). Check the screenshot in `__screenshots__/` if one fails.

- [ ] **Step 5: Format + commit**

```bash
npm run format
git add client/src/components/AnnotationCard.svelte client/src/styles/_annotations.scss tests/client/src/components/AnnotationCard.test.ts
git commit -m "$(cat <<'EOF'
feat(comments): reply thread on suggestion cards (D3)

The AnnotationCard thread block renders for suggestions too — collapsed
shows a reply count, focused shows the input; the Accept/Reject/Withdraw
row is unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: e2e — `comments-collab.spec.ts` rewrite + suggestion-reply

**Files:**
- Modify: `tests/e2e/collab/comments-collab.spec.ts`
- Modify: `tests/e2e/collab/suggestion-mode.spec.ts` (add a reply assertion) OR a new `tests/e2e/collab/suggestion-reply.spec.ts`

- [ ] **Step 1: Rewrite `comments-collab.spec.ts` CMT-15**

The test currently waits on `MESSAGE_COMMENTS`-driven refetch. Rewrite so both sides are driven by Yjs sync:

```ts
test("CMT-15: a comment added, replied, resolved and deleted on a shared doc propagates live", async ({ browser }) => {
  // ... ownerWithDoc / shareAnyoneLink("Editor") / joinSharedWorkspace as before ...
  await peer.click("#commentsBtn");

  // owner selects "quick" and comments
  // ... (existing selection keystrokes) ...
  await owner.click('button:has-text("Add comment")');
  await owner.fill(".comment-draft-box textarea", "why quick?");
  await owner.click(".comment-draft-box button.primary-btn");

  // peer sees the highlight AND the card, no reload
  await expect(peer.locator(".cm-comment-marker")).toBeVisible({ timeout: 10000 });
  await peer.click("#commentsBtn");
  await expect(peer.locator(".annotation-card", { hasText: "why quick?" })).toBeVisible({ timeout: 10000 });

  // peer replies -> owner sees it live
  await peer.locator(".annotation-card", { hasText: "why quick?" }).click(); // focus to reveal the input
  await peer.locator(".annotation-card", { hasText: "why quick?" }).getByPlaceholder(/reply/i).fill("it was the example");
  await peer.locator(".annotation-card", { hasText: "why quick?" }).getByRole("button", { name: "Reply" }).click();
  await expect(owner.locator(".annotation-card", { hasText: "it was the example" })).toBeVisible({ timeout: 10000 });

  // owner resolves -> peer's card flips
  await owner.locator(".annotation-card", { hasText: "why quick?" }).getByRole("button", { name: "Resolve" }).click();
  await expect(peer.locator(".annotation-card", { hasText: "why quick?" }).getByRole("button", { name: "Reopen" })).toBeVisible({ timeout: 10000 });

  // owner deletes -> peer's highlight drops
  await owner.locator(".annotation-card", { hasText: "why quick?" }).getByRole("button", { name: "Delete" }).click();
  await expect(peer.locator(".cm-comment-marker")).toHaveCount(0, { timeout: 10000 });
});
```

Keep CMT-14 (anchor-follows-edit) — but note the anchor is now a Yjs relative position, so it should track *better*; the assertion (`.cm-comment-marker` text is "quick" after a prefix insert) stays valid.

- [ ] **Step 2: Suggestion-reply e2e**

Add to `suggestion-mode.spec.ts` (after the reviewer's suggestion appears and the owner opens the rail):

```ts
  // D3 — the owner replies on the suggestion card; the reviewer sees it.
  await owner.locator(".annotation-card.suggestion").first().click();
  await owner.locator(".annotation-card.suggestion").first().getByPlaceholder(/reply/i).fill("good catch");
  await owner.locator(".annotation-card.suggestion").first().getByRole("button", { name: "Reply" }).click();
  await reviewer.click("#commentsBtn");
  await expect(reviewer.locator(".annotation-card.suggestion", { hasText: "good catch" })).toBeVisible({ timeout: 10000 });
```

- [ ] **Step 3: Run the collab suite**

Run: `npm run test:e2e:collab`
Expected: PASS — all of it (`comments-collab`, `suggestion-mode`, the SP-A `annotation-rail`/`suggestion` additions, `live-sync`, etc.).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/collab/
git commit -m "$(cat <<'EOF'
test(comments): collab e2e for live Y.Doc comment sync + suggestion replies

CMT-15 rewritten around Yjs sync (no MESSAGE_COMMENTS wait): add, reply,
resolve, delete all propagate live between two browsers. A suggestion
reply round-trips too.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Release 1.62.0

**Files:** `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/public/whats-new/suggestion-replies.png` (new), `tests/scripts/manual-testing/capture-suggestion-replies-screenshot.mjs` (new), `docs/TEST-COVERAGE.md`, `ROADMAP.md`, the two predecessor specs (pointer notes).

- [ ] **Step 1: Version bump**

`package.json`: `"version": "1.61.2"` → `"1.62.0"`. `package-lock.json` lines 3 and 9 likewise. Do not regenerate.

- [ ] **Step 2: CHANGELOG**

Insert above `## [1.61.2] - 2026-09-10`:

```markdown
## [1.62.0] - 2026-09-10

### Added

- Reply to a suggestion. A tracked-change suggestion now carries its own discussion thread on its card, the same as a comment — talk it over before it's accepted or rejected.

### Changed

- Comments on a shared document now sync instantly over the same live connection as the document text, instead of each change nudging every other collaborator to refetch. Comment anchors also track edits more precisely.
```

- [ ] **Step 3: Screenshot capture script**

Create `tests/scripts/manual-testing/capture-suggestion-replies-screenshot.mjs` modelled on `capture-annotation-rail-screenshot.mjs`: owner + reviewer share a workspace, reviewer makes a suggestion, owner replies on its card, screenshot the owner's window with the suggestion card + its reply thread visible in the rail. Output `client/public/whats-new/suggestion-replies.png`, viewport `1360×820`, selection cleared before the shot.

- [ ] **Step 4: Capture**

```bash
bash tests/scripts/manual-testing/enable-dev-login.sh
npm run build && (npx wrangler dev --local-upstream localhost:8787 &)
# wait for :8787
node tests/scripts/manual-testing/capture-suggestion-replies-screenshot.mjs
lsof -ti:8787 | xargs -r kill -9
bash tests/scripts/manual-testing/disable-dev-login.sh
```

Verify `client/public/whats-new/suggestion-replies.png` exists and shows a suggestion card with a reply. **Do not proceed with a missing/placeholder image.**

- [ ] **Step 5: What's New entry**

Append to `WHATS_NEW_ENTRIES` in `client/src/whats-new-entries.ts`:

```ts
  {
    version: "1.62.0",
    title: "Talk It Over on a Suggestion",
    description:
      "A tracked-change suggestion now has its own reply thread on its card — hash out the wording with your collaborators right there before anyone accepts or rejects it. Comments on a shared doc also sync instantly now, no refetch.",
    screenshot: "/whats-new/suggestion-replies.png",
    category: "Collaboration",
  },
```

- [ ] **Step 6: TEST-COVERAGE + ROADMAP + predecessor specs**

- `docs/TEST-COVERAGE.md`: replace the HTTP-comment rows (comment CRUD, `MESSAGE_COMMENTS` broadcast — search `CMT-` / `COMMENT`) with Y.Doc equivalents referencing `tests/client/src/comments-doc.test.ts`, `tests/src/comment-integrity.test.ts`, `tests/src/comments-doc-parity.test.ts`, the extended `workspace-room.test.ts` block, and the rewritten `comments-collab.spec.ts`. Update `COLLAB-06/07/08` to note `replies` on suggestions (D3).
- `ROADMAP.md` Group D block: mark **D3** and the data-path half of **D5** shipped v1.62.0 (spec `docs/superpowers/specs/2026-09-10-annotation-model-unification-design.md`, plan `.../plans/2026-09-10-annotation-model-unification.md`). SP-C (D4) remains. Add this spec's Non-goals to the Deferred considerations list (notably: `Y.Array`-per-thread to avoid whole-entry last-writer-wins; deleting the legacy `comments` storage key backstop).
- `docs/superpowers/specs/2026-09-09-annotation-rail-design.md` + `2026-08-31-suggestion-mode-collaboration-design.md`: strike the "comment threads and suggestions are independent systems" / "data-path" non-goals with a pointer to this spec.

- [ ] **Step 7: Full verification**

```bash
npm run build && npm test && npm run typecheck && npm run format:check && npm run test:e2e:local
```
Expected: all PASS. `WhatsNew.svelte`'s dev version warning is now clear (`1.62.0` entry present).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: release 1.62.0 — comments in the Y.Doc + suggestion replies

CHANGELOG ### Added + ### Changed. What's New entry with a captured
screenshot. TEST-COVERAGE + ROADMAP (Group D: D3 + data-path D5 shipped).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| Part 1 — `comments` Y.Map shape, `SuggestionEntry.replies?` | Task 1 |
| Part 2 — `comments-doc.ts` ×2 (CRUD, `listResolvedCommentThreads` w/ quote re-anchor, `addSuggestionReply`, `seedCommentThreadsIntoDoc`) | Task 1 |
| Part 3a — `cachedAccess` | Task 3 Step 3 |
| Part 3b — comments observer, validate + revert | Task 3 Steps 4, + `comment-integrity.ts` Task 2 |
| Part 3c — D3 reply guard on the suggestions observer | Task 3 Step 5 |
| Part 3d — migration in `loadDocRoom` | Task 4 Step 3 |
| Part 3e — `/internal/seed` | Task 4 Step 4 |
| Part 3f — retire HTTP surface, `MESSAGE_COMMENTS`, `DocRoom.commentThreads`, `persistComments` | Task 4 Step 5 |
| Part 4a — bridge `onCommentsChanged` + per-binding observer | Task 5 |
| Part 4b — `stores/commentsPanel.ts` drop `remoteCommentsChanged` | Task 5 Step 4 |
| Part 4c — `AnnotationRail` reads the map, actions call the ops, suggestion `onReply` | Task 7 |
| Part 4c — `annotations.ts` adapter `ResolvedCommentThread` + suggestion `replies` | Task 6 |
| Part 4d — `AnnotationCard` reply thread for suggestions | Task 8 |
| Part 4e — delete `client/src/comments.ts` | Task 7 Step 5 |
| Part 5 — unit (`comments-doc`, `comment-integrity`, parity), integration (`workspace-room`), component (`AnnotationCard`), e2e (`comments-collab`, suggestion reply) | Tasks 1, 2, 3, 4, 8, 9 |
| Part 6 — 1.62.0, CHANGELOG, whats-new + screenshot, TEST-COVERAGE, ROADMAP, predecessor specs | Task 10 |

No gaps.

**2. Placeholder scan:** Task 4 Step 5 says "check `grep` for other importers" before deleting `CommentThread`/`CommentReply` — that's a real conditional instruction with both branches specified, not a placeholder. Task 5 Step 5 explicitly flags the Task 5↔7 mutual dependency and tells the executor to merge them. The screenshot script (Task 10 Step 3) points at a concrete sibling to model rather than inlining ~70 lines — acceptable for a manual one-off; the executor copies + adapts.

**3. Type consistency:** `CommentThreadEntry` / `ResolvedCommentThread` / `Reply` — same fields in Task 1's Produces block, the module, `comment-integrity.ts` (Task 2), the server observer (Task 3), the adapter (Task 6). `seedCommentThreadsIntoDoc(doc, threads: {id, from, to, quote, resolved, comments: Reply[]}[])` — same signature in Task 1, Task 4 Step 3 (`loadDocRoom`), Task 4 Step 4 (`/internal/seed`). `addSuggestionReply(doc, id, author, body, now?)` — Task 1, Task 7 Step 3. `window.MDE.onCommentsChanged` — declared Task 5 Step 1, consumed Task 7 Step 4. `listResolvedCommentThreads(doc, content?)` — Task 1, Task 7 Step 2 (`listResolvedCommentThreads(ydoc, editorContent())`). `railAnnotationsForShared(suggestions, threads: ResolvedCommentThread[], content)` — Task 6, Task 7 Step 2.

**Fix applied during review:** Task 3's observer needs `event`/`transaction` params on the existing `suggestionsMap.observe` callback, which today takes none — Task 3 Step 5 now calls that out explicitly (change the signature, verify the merge logic which reads the map fresh is unaffected).
