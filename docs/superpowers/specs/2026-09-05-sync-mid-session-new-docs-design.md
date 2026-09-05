# Sync Mid-Session New Documents — Design Spec

## Goal

A document created (or first switched to) after a workspace's live connection is already established doesn't reach any other already-connected collaborator. Concretely: Alice and Bob are both already viewing a shared workspace; Alice creates a new document and types content into it; Bob's document list never shows it, and no reload short of leaving and rejoining the workspace fixes that.

Half of this gap is already fixed (`seedNewDocBinding()` in `client/src/collab.ts`, shipped in `v1.43.0`): the *creator's* client now properly introduces a mid-session document to the server, which already supports a client introducing a new `docId` at any time (`src/workspace-room.ts`'s `isNewDoc` handling in `handleMessage`). This spec covers the other half: an *already-connected* collaborator has no way to discover that document at all.

## Non-goals / deferred scope

- **No new wire message type, no new server-side broadcast.** Investigation found the server already broadcasts every document's Y.Doc updates to every other connected session, tagged with that document's `docId` (`workspace-room.ts`'s `handleDocUpdate()` → `this.broadcast(...)`) — this already happens for a document's very first content-bearing update, same as any later edit. The only gap is that the *receiving* client silently drops any frame for a `docId` it doesn't already have a binding for. Fixing that is a client-only change.
- **No change to how a document becomes shared in the first place** (`openShareModal`, `setAccessMode`, `seedNewDocBinding`) — out of scope, already working.
- **No persisted "recently discovered" state, no notification/toast when a new document appears.** It simply appears in the document list, the same way a remote edit to an existing document simply appears — no new UI beyond that.
- **No handling for documents that existed in the room before this session ever joined.** That path already works today (`joinWorkspace()`'s own initial `fetchWorkspaceDocIds()` + `importRemoteDocs()`) and isn't touched by this spec.

## Client-side: discovering an unrecognized `docId`

`handleServerMessage()` (`client/src/collab.ts:680-711`) currently does:

```ts
const docId = decoding.readVarString(decoder);
const binding = workspaceRoom.docs.get(docId);
if (!binding) return;
```

— silently dropping any frame for a `docId` with no local binding, regardless of message type. This changes to lazily create a binding the first time a `MESSAGE_SYNC` frame (never a bare `MESSAGE_AWARENESS` frame — see below) arrives for an unrecognized `docId`:

```ts
const docId = decoding.readVarString(decoder);
const isNewToUs = messageType === MESSAGE_SYNC && !workspaceRoom.docs.has(docId);
const binding = isNewToUs ? discoverRemoteDocBinding(docId) : workspaceRoom.docs.get(docId);
if (!binding) return;

if (messageType === MESSAGE_SYNC) {
  // ...existing encode/readSyncMessage/send block, unchanged...
  if (isNewToUs) registerDiscoveredDoc(docId, binding);
} else if (messageType === MESSAGE_AWARENESS) {
  // ...existing block, unchanged...
}
```

A bare `MESSAGE_AWARENESS` frame for an unrecognized `docId` is still dropped (the `isNewToUs` check is gated to `MESSAGE_SYNC` only) — awareness carries no document content to seed a new binding with, and the real `MESSAGE_SYNC` frame introducing the document's content always arrives too (from the same `handleDocUpdate` broadcast that fires the moment the creator's real content reaches the server), so nothing is lost; awareness for that document simply starts applying normally once its binding exists.

Two new small functions, placed next to `createDocBinding`/`seedNewDocBinding` (`client/src/collab.ts:442-472`):

```ts
// A document another collaborator created (or first switched to) after
// this session already joined the workspace arrives here as an ordinary
// MESSAGE_SYNC frame for a docId never seen before — the server
// broadcasts every document's updates to every connected session the
// same way regardless of whether the recipient already knew about that
// document (see handleDocUpdate in workspace-room.ts). Role is per
// connection, not per document (see access-role.ts's resolveRole()), so
// any existing binding's role is this session's own role too.
function discoverRemoteDocBinding(docId: string): DocBinding {
  const role = workspaceRoom.docs.get(workspaceRoom.activeDocId ?? "")?.role ?? "editor";
  return createDocBinding(docId, role);
}

// Called once, immediately after the first incoming sync message has
// been applied into a freshly-discovered binding — turns it into a real
// local document so it shows up in the sidebar/doc list like any other,
// via the same import path used for every document already known when
// this session joined (see joinWorkspace's own importRemoteDocs call).
function registerDiscoveredDoc(docId: string, binding: DocBinding): void {
  if (findDocById(docId)) return;
  const localWorkspace = get(workspacesStore).find((w) => w.remoteId === workspaceRoom.workspaceId);
  if (!localWorkspace) return;
  const now = Date.now();
  importRemoteDocs(localWorkspace.id, [{ id: docId, name: binding.metaMap.get("name") || "Untitled", content: binding.ytext.toString(), updatedAt: now, createdAt: now }]);
}
```

`findDocById`, `importRemoteDocs`, `get`, and `workspacesStore` are already imported into `collab.ts` (used elsewhere in the same file) — no new imports beyond these two functions themselves.

## Why this is safe

- `importRemoteDocs()` already de-duplicates document names against the receiver's existing list (`nextAvailableName`) — a name collision with a document the receiver already has locally is handled the same way it already is at initial join.
- `createDocBinding()` already guards against re-creating an existing binding (`if (existing) return existing;`) and already wires up the same `ytext`/`imagesMap`/`metaMap` observers every other binding gets — a discovered binding behaves identically to one seeded at join time or via `seedNewDocBinding()` for every subsequent update.
- If the very first frame received for a `docId` happens to carry no name yet (a genuinely pathological ordering — the creator's own `seedNewDocBinding()` always sets `metaMap`'s `name` in the *same* Yjs transaction as the content, so this shouldn't occur in practice), `registerDiscoveredDoc` still falls back to `"Untitled"` and the display corrects itself on the next update via the existing background-sync path (`markDirty` → `flushDirtyBackgroundDocs` → `syncRemoteDocContent`) — same tolerance that path already has for any other document.

## Testing

- New e2e test (`tests/e2e/collab/live-sync.spec.ts`, alongside its existing two-collaborator live-edit test): both collaborators fully join and settle first (unlike the earlier, incorrect regression test this spec's first half fixed, which created the second document *before* the second collaborator ever joined) — then one creates a second document and types content into it, and the test asserts the *other*, already-connected collaborator's local document list picks up the new document (polling `localStorage`'s `mde:docs`, matching the existing pattern in `readonly-and-editing-mode.spec.ts`) without any reload or rejoin, and that switching to it shows the correct content.

## Versioning

User-facing (shared workspaces now behave as advertised — new documents appear live for everyone already connected, not just those who join afterward) — minor version bump, with a What's New entry, per `CLAUDE.md`'s versioning convention.
