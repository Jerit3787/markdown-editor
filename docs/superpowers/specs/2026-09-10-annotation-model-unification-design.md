# Annotation model unification (SP-B) — design

**Status:** approved approach (brainstorm 2026-09-10), design under review
**Part of:** the suggesting-mode redesign (ROADMAP → Active → "Group D"). SP-A (the
annotation rail) shipped v1.61.0–v1.61.2. This is **SP-B** — D3 + the data-path
half of D5. SP-C (D4, granularity) remains.
**Predecessors:** `docs/superpowers/specs/2026-09-09-annotation-rail-design.md`,
`docs/superpowers/specs/2026-08-31-suggestion-mode-collaboration-design.md`.
**Ships as:** a minor release (`1.62.0`) — suggestion reply threads and instant
comment sync are user-visible: `CHANGELOG.md` `### Changed`/`### Added`, a
`whats-new-entries.ts` entry, a real screenshot.

## Goal

Move shared-document comment threads out of `WorkspaceRoom` Durable Object HTTP
storage and into a `Y.Map` on each document's `Y.Doc`, so comments sync live over
the same WebSocket as text and suggestions — no HTTP round-trips, no
refetch-on-poke. Give suggestions their own reply threads (D3). Retire the four
HTTP comment endpoints, the `MESSAGE_COMMENTS` broadcast, and `client/src/comments.ts`.

## Why

Comments today are plain HTTP against the DO (`GET/POST /docs/:id/comments`, plus
`/reply`, `/resolve`, delete), persisted to their own `docStorageKey(docId,
"comments")`, with liveness faked by a `MESSAGE_COMMENTS` frame that tells every
client "refetch this doc's comments". That is the last piece of shared-document
state not riding the Yjs sync path. Moving it in gets: genuine real-time comment
sync (a long-standing ROADMAP deferral), robust edit-tracking anchors (Yjs
relative positions instead of fuzzy `quote` re-matching), and one place —
alongside `suggestions` — for the SP-A rail to read from. D3 (a suggestion card
that can hold a discussion, like a comment card) is the natural pairing and what
the SP-A spec deferred.

## Non-goals / deferred

- **Merging `comments` and `suggestions` into one `Y.Map`.** They stay as two
  separate top-level types on the same `Y.Doc`. The suggestion model (relative
  positions, contiguous-merge, `reconcileReviewerDelta`, the self-heal observer)
  is load-bearing and works; re-homing it into a unified record shape is
  gratuitous risk. The "unification" is: both live in the `Y.Doc`, both render
  through SP-A's one `AnnotationCard`.
- **Threads on local-document notes.** Local (never-shared) docs keep
  `stores/docs.ts` `Note`s — single body, no replies, no resolved state. The rail
  already renders them through `railAnnotationsForLocal`. Unchanged.
- **Deprecation shims for the HTTP endpoints.** Hard cut — deleted in this
  release. A client running cached pre-1.62.0 JS during the deploy window briefly
  `404`s on `/comments`; the HTML is `Cache-Control: no-store` so a reload fixes
  it fast. Acceptable for a solo project.
- **Versioning comments.** Version snapshots are content-only (`Snapshot.content`
  is a string, no comment field) — restoring a version never touched comments and
  still won't. A `Y.Map` comment survives a `ytext` wholesale-restore via its
  `quote` (re-anchored client-side), same as today's `relocateAnchor`.
- **SP-C (D4 granularity).** Separate.

## Global constraints

- `src/**` + `tests/src/**` are full-strict TS. `client/src/**` +
  `tests/client/src/**` have `strictNullChecks`/`noImplicitAny` off.
- **`client/src/comments-doc.ts` and `src/comments-doc.ts` are hand-synced
  byte-identical copies** — the same convention as `suggestions.ts` /
  `anchor.ts` / `markdown-code.ts` (which today rely on discipline + parallel
  test files, with no automated guard). This spec adds a `readFileSync`
  byte-equality test for the new pair — a small new convention worth having.
- Svelte 5 runes. Component tests under `tests/client/src/components/*.test.ts`.
- `npm run format` + `npm run typecheck` pass. `local` Playwright → `vite dev`;
  `collab` Playwright → `wrangler dev` + real `WorkspaceRoom`.
- The `Y.Doc`'s existing top-level types are `ytext` ("content"), `imagesMap`
  ("images"), `metaMap` ("name"), `suggestions`. This adds `comments`.
- Every `Y.Doc` write the server makes to fix a bad client write uses a
  dedicated transaction origin so its own observer ignores it — `"suggestion"`
  is the existing one; this adds `"comment-reconcile"` and `"comment-migrate"`.
- Release `1.62.0`: `package.json` + both `package-lock.json` `"version"` fields
  hand-edited (lines 3, 9).
- Never add a `Claude-Session:` trailer. `Co-Authored-By: Claude Sonnet 5
  <noreply@anthropic.com>` only.

---

## Part 1 — Data model

### `comments` — a new `Y.Map` on the doc's `Y.Doc`

```ts
// Y.Map<string /* threadId, = the map key */, CommentThreadEntry>
interface CommentThreadEntry {
  author: string;      // GitHub username of the thread's starter (or guest name)
  createdAt: number;
  from: RelativePositionJSON;  // Y.relativePositionToJSON(...)
  to: RelativePositionJSON;
  quote: string;       // the anchored text, for re-matching after a version restore
  resolved: boolean;
  replies: { id: string; author: string; body: string; createdAt: number }[];
}
```

`from`/`to` are Yjs relative positions on `ytext` (`Y.createRelativePositionFromTypeIndex`,
`to` with `assoc: -1` — the same convention `suggestions.ts` documents at length),
serialized via `Y.relativePositionToJSON`. A thread starts with exactly one reply
(the starter's, `body` = the initial comment text).

### `SuggestionEntry.replies` (D3)

`SuggestionEntry` (in `suggestions.ts`, both copies) gains:

```ts
  replies?: { id: string; author: string; body: string; createdAt: number }[];
```

Optional — absent on every suggestion created before this release, and on the
common "no discussion" case. The suggestion's `kind`, `author`, `createdAt`,
`from`, `to` are unchanged. `reconcileReviewerDelta` (reads only the `ytext`
delta) and the suggestions self-heal observer (keys on `kind`/`author`/range —
never `replies`) are unaffected.

---

## Part 2 — Client op modules: `comments-doc.ts` (× 2, hand-synced)

`client/src/comments-doc.ts` and `src/comments-doc.ts`, byte-identical. Modelled
directly on `suggestions.ts` — the same `toRelative` / `toAbsoluteIndex` helpers
(copied, not imported — the files must stand alone), the same `uid()`.

```ts
export function getCommentsMap(doc: Y.Doc): Y.Map<CommentThreadEntry>;

export interface ResolvedCommentThread {
  id: string;
  author: string;
  createdAt: number;
  from: number;   // absolute offset into current ytext; null-dropped
  to: number;
  quote: string;
  resolved: boolean;
  replies: { id: string; author: string; body: string; createdAt: number }[];
}
// Resolves every thread's relative positions to absolute offsets against the
// current ytext, dropping any whose anchor no longer resolves. Sorted by `from`.
export function listResolvedCommentThreads(doc: Y.Doc): ResolvedCommentThread[];

// All write metadata only — never touches ytext.
export function createCommentThread(doc: Y.Doc, from: number, to: number, quote: string, author: string, body: string, now?: number): string; // returns threadId
export function addCommentReply(doc: Y.Doc, threadId: string, author: string, body: string, now?: number): void;
export function resolveCommentThread(doc: Y.Doc, threadId: string, resolved: boolean): void;
export function deleteCommentThread(doc: Y.Doc, threadId: string): void;

// D3 — same shape, on the suggestions map.
export function addSuggestionReply(doc: Y.Doc, suggestionId: string, author: string, body: string, now?: number): void;
```

Each mutator wraps its change in `doc.transact(() => …, "comment")` (a plain
local-edit origin — the server's own `"comment-reconcile"` writes are what the
observer skips; a legit client write carries the WebSocket origin server-side and
is validated).

`addSuggestionReply` lives here (not `suggestions.ts`) so `suggestions.ts` stays
frozen; it imports `getSuggestionsMap` from `./suggestions`.

**Anchor after a version restore:** `listResolvedCommentThreads` first tries the
relative position; if it fails to resolve (a wholesale `ytext` replace broke it),
it falls back to `content.indexOf(quote)` — pass `content` in, or expose a
`relocateOrphans(doc, content)` the rail calls. Simplest: `listResolvedCommentThreads(doc)`
takes an optional `content` string; when a relative position is dead but `quote`
is found in `content`, use that span and re-write the entry's `from`/`to` to fresh
relative positions (a `"comment"` transaction — small, self-healing).

---

## Part 3 — Server (`src/workspace-room.ts`)

### 3a. Cached access record

The comment observer is synchronous (`Y.Map.observe`); it needs `access.owner`
for delete validation, but `getAccess()` is async (storage read). Add
`private cachedAccess: AccessRecord | null` — populated in `loadDocRoom` (or
lazily) and refreshed wherever the access record is written (`PUT /access`, the
request-access approve path, `/internal/seed`). The observer reads
`this.cachedAccess` synchronously; if it's somehow `null`, it defers that one
check to a `queueMicrotask` that calls `getAccess()` then reverts.

### 3b. The `comments` map observer — full validation + revert

In `loadDocRoom`, after the existing `ytext.observe` / `suggestionsMap.observe`
blocks:

```ts
const commentsMap = getCommentsMap(doc);
commentsMap.observe((event, txn) => {
  if (txn.origin === "comment-reconcile" || txn.origin === "comment-migrate") return;
  const session = this.sessions.get(txn.origin as WebSocket);
  if (!session || session.role === "viewer") return; // isWrite already dropped a viewer's write; belt-and-braces
  const owner = this.cachedAccess?.owner ?? null;
  const reverts: Array<() => void> = [];

  event.changes.keys.forEach((change, key) => {
    const now = commentsMap.get(key);
    if (change.action === "add") {
      if (!isValidNewThread(now, session.username)) reverts.push(() => commentsMap.delete(key));
    } else if (change.action === "update") {
      if (!isAllowedThreadTransition(change.oldValue as CommentThreadEntry, now!, session.username, session.role)) {
        reverts.push(() => commentsMap.set(key, change.oldValue as CommentThreadEntry));
      }
    } else if (change.action === "delete") {
      const old = change.oldValue as CommentThreadEntry;
      if (session.username !== old.author && session.username !== owner) {
        reverts.push(() => commentsMap.set(key, old));
      }
    }
  });

  if (reverts.length) doc.transact(() => reverts.forEach((r) => r()), "comment-reconcile");
});
```

Validation helpers (pure — in `src/comment-integrity.ts`, unit-tested; not
hand-synced, server-only):

- `isValidNewThread(entry, username)` — `entry.author === username`,
  `entry.replies.length === 1 && entry.replies[0].author === username &&
  entry.replies[0].body.trim() !== ""`, `entry.resolved === false`, `from`/`to`
  present.
- `isAllowedThreadTransition(old, now, username, role)` — exactly one of:
  - **resolve toggle:** `now` deep-equals `old` except `resolved` flipped
    (`role !== "viewer"` — already guaranteed).
  - **reply appended:** `now.replies` is `old.replies` with exactly one entry
    appended; the new entry's `author === username`, `body.trim() !== ""`;
    every other field of `now` deep-equals `old`.
  - anything else (an edited existing reply, a changed `author` / `quote` /
    `from` / `to`, a wholesale `replies` swap, multiple replies added at once) →
    disallowed.

Revert is idempotent (`set` to the captured `oldValue`), and the reverting
transaction's `"comment-reconcile"` origin means the observer skips it — no
loop. A concurrent legit write from another session lands as its own
observer invocation and is validated independently.

### 3c. D3 — suggestion reply validation

Extend the existing `suggestionsMap.observe` self-heal callback (the one that
merges overlapping same-author entries): before/after the merge pass, for each
`update` where `change.oldValue` and the new value differ only by an appended
`replies` entry, require that entry's `author === session.username`; otherwise
revert that key. Keep it minimal — the merge logic is untouched, this is one
extra guarded branch.

### 3d. Migration

In `loadDocRoom`, after `Y.applyUpdate(doc, stored…)` and before wiring
observers:

```ts
const legacyComments = await this.state.storage.get<CommentThread[]>(docStorageKey(docId, "comments"));
const commentsMap = doc.getMap<CommentThreadEntry>("comments");
if (legacyComments?.length && commentsMap.size === 0) {
  const ytext = doc.getText("content");
  const text = ytext.toString();
  doc.transact(() => {
    for (const t of legacyComments) {
      const loc = relocateAnchor(text, t); // { from, to } | null
      const from = loc?.from ?? 0;
      const to = loc?.to ?? 0;
      commentsMap.set(t.id, {
        author: t.comments[0]?.author ?? "",
        createdAt: t.comments[0]?.createdAt ?? Date.now(),
        from: relToJSON(ytext, from),
        to: relToJSON(ytext, to, -1),
        quote: t.quote,
        resolved: t.resolved,
        replies: t.comments.map((c) => ({ id: c.id, author: c.author, body: c.body, createdAt: c.createdAt })),
      });
    }
  }, "comment-migrate");
}
```

Runs once, in the single-threaded DO, before any client syncs this doc — no
duplicate-seed race. The old `docStorageKey(docId, "comments")` value is **left
in place** as a backstop (it's tiny; a follow-up release can delete it). Nothing
writes it after this.

`relocateAnchor` is imported from `src/anchor.ts` (already a Worker module).

### 3e. `/migrate` (legacy `CollabRoom` → `WorkspaceRoom`)

`handleInternalSeedRequest` currently does `docRoom.commentThreads = body.comments`.
Change to: apply the same seed-into-`commentsMap` loop against `body.comments`
(in a `"comment-migrate"` transaction). `CollabRoom.handleMigrateRequest` on the
client side already collects `comments` from its own HTTP store — no change
there.

### 3f. Retire

Delete: `MESSAGE_COMMENTS` const, `broadcastCommentsChanged`,
`handleCommentsRequest`, `handleCommentReplyRequest`, `handleCommentResolveRequest`,
`handleCommentDeleteRequest`, their four URL-route matches, `getComments`,
`createThread`, `addReply`, `resolveThread`, `deleteThread`, `persistComments`,
`DocRoom.commentThreads`, the `storedComments` read that feeds it (kept only in
the migration block above), `CommentThread` / `CommentReply` interfaces (move
`CommentThreadEntry` + the reply shape into scope; keep a small exported type if
`version-*` or tests reference it).

The `ytext.observe` `reconcileReviewerDelta` block and `handleDocUpdate`
persistence path are unchanged — the `comments` map rides the doc's existing
`update` persistence for free.

---

## Part 4 — Client (`collab.ts`, `AnnotationRail.svelte`, `AnnotationCard.svelte`, adapter)

### 4a. Bridge (`types.ts` + `collab.ts`)

- `MDEBridge` gains `onCommentsChanged?: (() => void) | null` — mirrors the SP-A
  `onSuggestionsChanged`.
- `collab.ts`: in `applyEditorMode` (where the per-binding suggestions observer
  is attached), also attach `getCommentsMap(binding.ydoc).observe(() =>
  window.MDE.onCommentsChanged?.())`, guarded by a `binding.commentsObserved`
  flag.
- Delete the `import { remoteCommentsChanged }` line, the `MESSAGE_COMMENTS`
  const, and the `if (messageType === MESSAGE_COMMENTS) { … remoteCommentsChanged.update(…) }`
  branch in `handleWorkspaceMessage`.
- `window.MDE.getActiveYDoc()` already exists (SP-A).

### 4b. `stores/commentsPanel.ts`

Delete `remoteCommentsChanged`. Keep `commentsPanelOpen` and `unresolvedCommentCount`.

### 4c. `AnnotationRail.svelte`

`loadEntries` shared-doc branch:

```ts
if (ctx.isShared) {
  const ydoc = window.MDE.getActiveYDoc?.();
  const suggestions = window.MDE.getResolvedSuggestions?.() ?? [];
  const threads = ydoc ? listResolvedCommentThreads(ydoc, editorContent()) : [];
  annotations = railAnnotationsForShared(suggestions, threads, editorContent());
  unresolvedCommentCount.set(threads.filter((t) => !t.resolved).length);
}
```

No `await`, no HTTP. `onMount`: `window.MDE.onCommentsChanged = () =>
queueMicrotask(() => void loadEntries())`; cleared on destroy.

Action handlers, shared-doc branch — replace the HTTP calls with `comments-doc`
ops against `window.MDE.getActiveYDoc()`:
- `submitDraft` → `createCommentThread(ydoc, from, to, quote, username, body)`
- `submitReply(threadId, body)` → `addCommentReply(ydoc, threadId, username, body)`
- `toggleResolve(threadId, resolved)` → `resolveCommentThread(ydoc, threadId, resolved)`
- `removeAnnotation(a)` shared → `deleteCommentThread(ydoc, a.id)`
- suggestion reply (D3, new `onReply` wired for suggestion cards) →
  `addSuggestionReply(ydoc, id, username, body)`

Each is followed by `void loadEntries()` (the observer also fires, but an
immediate re-derive keeps the UI snappy — idempotent).

The `railAnnotationsForShared` adapter (`annotations.ts`): its `threads`
parameter type changes from `CommentThread[]` to `ResolvedCommentThread[]`
(same `from`/`to`/`quote`/`resolved`/`replies` fields — `commentCard` already
reads exactly those). Suggestion `RailAnnotation`s gain `replies` from the
entry (thread it through `suggestionCards`).

### 4d. `AnnotationCard.svelte`

The reply thread block (`{#if !isSuggestion}` → body with `replies` + reply
input) becomes available for suggestions too. Restructure: render `replies` +
the reply row for **any** annotation that has a thread affordance — a comment
always, a suggestion when `focused`. Keep the suggestion's Accept/Reject/Withdraw
action row. A suggestion with `replies.length > 0` shows the count collapsed,
same as a comment.

### 4e. Delete `client/src/comments.ts`

All its callers are `AnnotationRail.svelte` (rewired above) and its own tests.

---

## Part 5 — Testing

### Unit — `tests/client/src/comments-doc.test.ts` (new)
Against a real `Y.Doc` (as `suggestions.test.ts` does): create a thread → one
self-authored reply, `resolved:false`; add a reply; resolve/reopen; delete;
`listResolvedCommentThreads` resolves absolute offsets and drops a thread whose
anchor died after an unrelated edit; a thread whose relative position broke but
whose `quote` is still in `content` re-anchors. `addSuggestionReply` appends to
a `SuggestionEntry`.

### Unit — `tests/src/comment-integrity.test.ts` (new)
`isValidNewThread`: accepts a self-authored single-reply unresolved thread;
rejects `author` mismatch, multi-reply, pre-resolved, empty body. `isAllowedThreadTransition`:
accepts a resolve toggle and a single self-authored reply append; rejects an
edited existing reply, a changed `author`/`quote`/anchor, a foreign-authored
reply, two replies at once.

### Unit — hand-sync parity
`tests/src/comments-doc-parity.test.ts` — `client/src/comments-doc.ts` bytes ===
`src/comments-doc.ts` bytes.

### Integration — `tests/src/workspace-room.test.ts` (extend)
Drive `WorkspaceRoom` with a fake WS session (existing helpers): a reviewer's
`createCommentThread` write survives; an update that rewrites another author's
reply is reverted to `oldValue`; a delete of a thread the session didn't start
(and isn't owner for) is reverted; a viewer's comment write never applies
(isWrite gate). Migration: seed `docStorageKey(_, "comments")`, load the room,
assert the `comments` `Y.Map` now holds the threads and `commentsMap.size`
guards against a re-seed on the next load.

### Component — `tests/client/src/components/AnnotationCard.test.ts` (extend)
A suggestion card with `replies` renders the thread; `focused` shows the reply
input; `onReply` fires with the typed body.

### e2e — `tests/e2e/collab/comments-collab.spec.ts` (rewrite the assertions)
Two contexts. Owner comments → the collaborator sees the highlight **and the
card** with **no refetch / no reload** (drop the `MESSAGE_COMMENTS` wait — it's
gone; assert on Yjs-sync latency instead). Collaborator replies → owner sees it
live. Owner resolves → collaborator's card flips to "Reopen" live. Owner deletes
→ collaborator's highlight drops live. A reviewer replies on a **suggestion** →
the editor sees the reply on that card.

### e2e — `tests/e2e/collab/` regression
`suggestion-mode.spec.ts`, `annotation-rail` collab additions from SP-A — still
green (the suggestions map path is untouched; `replies` is additive).

---

## Part 6 — Rollout & release

- **Version:** minor → `1.62.0`.
- `CHANGELOG.md` `## [1.62.0]`:
  - `### Added` — "Reply to a suggestion. A tracked-change suggestion now carries
    its own discussion thread, the same as a comment — talk it over on the card
    before it's accepted."
  - `### Changed` — "Comments on a shared document now sync instantly over the
    same live connection as the text, instead of each change nudging everyone
    else to refetch. Comment anchors also track edits more precisely."
- `client/src/whats-new-entries.ts` — one entry (version `1.62.0`), screenshot
  in `client/public/whats-new/` captured via a Playwright script against a
  locally-built client showing a suggestion card with a reply thread. **Not
  optional.**
- `docs/TEST-COVERAGE.md` — update `COLLAB-05/06/07` (D3 `replies` on
  suggestions), replace the HTTP-comment rows (`COLLAB-1x` — comment CRUD, live
  broadcast) with `Y.Doc` equivalents; add `comment-integrity`, `comments-doc`,
  the parity test.
- `ROADMAP.md` — Group D: mark **D3** and the data-path half of **D5** shipped
  v1.62.0 (this spec + plan). SP-C (D4) remains. Copy this spec's Non-goals into
  the Deferred considerations list.
- No `Report-Only` / staged rollout. The migration is server-side and idempotent;
  the endpoint removal is a hard cut per the brainstorm decision.

## File summary

| File | Change |
|---|---|
| `client/src/comments-doc.ts`, `src/comments-doc.ts` | **new**, hand-synced — `Y.Doc` comment CRUD + `addSuggestionReply` |
| `src/comment-integrity.ts` | **new** — pure `isValidNewThread` / `isAllowedThreadTransition` |
| `src/workspace-room.ts` | `comments` map observer (validate + revert); D3 reply guard on the suggestions observer; migration in `loadDocRoom` + `/internal/seed`; `cachedAccess`; **delete** the 4 comment handlers + routes + `MESSAGE_COMMENTS` + `broadcastCommentsChanged` + `DocRoom.commentThreads` + `persistComments` |
| `client/src/suggestions.ts`, `src/suggestions.ts` | `SuggestionEntry.replies?` field only |
| `client/src/collab.ts` | per-binding `comments` observer → `onCommentsChanged`; delete `MESSAGE_COMMENTS` branch + `remoteCommentsChanged` import |
| `client/src/types.ts` | `MDEBridge.onCommentsChanged?` |
| `client/src/stores/commentsPanel.ts` | delete `remoteCommentsChanged` |
| `client/src/components/AnnotationRail.svelte` | shared-doc `loadEntries` reads the `Y.Map`; actions call `comments-doc` ops; suggestion `onReply` wired |
| `client/src/components/AnnotationCard.svelte` | reply thread + input for suggestions (D3) |
| `client/src/annotations.ts` | `threads` param → `ResolvedCommentThread[]`; `replies` on suggestion `RailAnnotation` |
| `client/src/comments.ts` | **deleted** |
| `tests/client/src/comments-doc.test.ts`, `tests/src/comment-integrity.test.ts`, `tests/src/comments-doc-parity.test.ts` | **new** |
| `tests/src/workspace-room.test.ts`, `tests/client/src/components/AnnotationCard.test.ts`, `tests/e2e/collab/comments-collab.spec.ts` | extend / rewrite |
| `tests/client/src/comments.test.ts` | **deleted** (was for `comments.ts`) |
| `package.json`, `package-lock.json`, `CHANGELOG.md`, `whats-new-entries.ts`, `client/public/whats-new/*.png`, `docs/TEST-COVERAGE.md`, `ROADMAP.md` | `1.62.0` release |

## Open risks

1. **Observer revert vs. a legit concurrent write.** Session A appends a reply,
   session B toggles resolve, both in flight. Each lands as a separate observer
   call with its own `oldValue`; each transition is independently valid; no
   conflict. Yjs merges the two `Y.Map` value writes last-writer-wins on the
   *whole entry* — so B's resolve could clobber A's reply if they raced within
   one sync window. **Mitigation:** the mutators do a read-modify-write inside
   `doc.transact` against the *current* map value, and Yjs `Y.Map` set is
   atomic per key — the later of the two updates wins the key, losing the other
   change. This is the same last-writer-wins `Y.Map` semantics `metaMap` (doc
   name) and `imagesMap` already live with. For threads this is acceptable (a
   dropped reply is rare and recoverable); noted, not solved here. A CRDT-list
   `replies` (`Y.Array` per thread) would fix it but multiplies the model —
   deferred.
2. **`cachedAccess` staleness.** If ownership changed and the cache is stale, a
   delete check could use the wrong owner. Refreshed on every access write;
   worst case a former owner briefly can/can't delete a thread. Low stakes.
3. **Migration for a doc that's open in two tabs during deploy.** The DO seeds
   before serving either tab's first `SYNC_STEP1`; both then receive the seeded
   state. A tab still on old JS keeps calling `GET /comments` → `404` → its rail
   shows no comments until reload. The `no-store` HTML shortens that window.
4. **Hand-sync drift** between the two `comments-doc.ts` copies — the parity
   test fails CI if they diverge, same guard `suggestions.ts` relies on.
