# Shared Workspace Background Document Sync — Design Spec

**TODO item 21.** "Shared workspace does not pull all documents, only the
active document were synced." Root cause confirmed via
`superpowers:systematic-debugging`: the Yjs CRDT sync layer itself is
correct — every document in a shared workspace gets its own live-synced
`Y.Doc` binding, whether it's the one currently open or not. The gap is
one layer up: nothing ever writes a background document's live content
back into `docsStore`, so the sidebar, `localStorage`, and anything that
reads `doc.content` for a non-active document (most notably `pushToRepo`,
which reads every document in a linked workspace) only ever sees the
truth for whichever single document happens to be open.

## Goal

Every document in a shared workspace stays live-synced into `docsStore` —
not just the one currently open — matching the behavior v1.21.0's own
release notes already promised ("every document inside a shared workspace
syncs live to collaborators at once, not just whichever one is open").
Along the way, decouple the sidebar's display order from `updatedAt` so a
collaborator editing a document you aren't looking at doesn't reshuffle
your document list while you work.

## Non-goals (deferred)

- **Forcing a synchronous flush before every consumer that reads
  `doc.content`** (e.g. `pushToRepo`). The debounce window is short
  (~800ms) and `teardownWorkspace()` flushes synchronously on disconnect;
  a race where a push happens to land inside that ~800ms window and picks
  up slightly stale content for a document nobody is currently viewing is
  an accepted, narrow risk rather than a guarantee this spec closes. A
  tighter guarantee (e.g. `repo-sync.ts` explicitly calling into
  `collab.ts` to flush first) would introduce a new cross-module
  dependency for a narrow race window and isn't justified here.
- **Changing `MenuBar.svelte`'s "Open Recent" submenu's sort order.** That
  list's entire purpose is recency — a collaborator's live edit correctly
  belongs near the top of "recent," unlike the main sidebar's default
  list.
- **Changing `ensureActiveDocInWorkspace`'s "land on the most-recently-
  updated document" behavior when switching into a workspace.** That's a
  different semantic (what to open) from the sidebar's display order, and
  is unaffected by this spec.

## Behavior

### 1. Background documents sync live into `docsStore`

**`client/src/stores/docs.ts`** gains one new exported function:

```ts
// True key-set-and-value equality regardless of insertion order — Y.Map's
// own .entries() iteration order has no guaranteed relationship to the
// order doc.images' keys were originally inserted in, so a naive
// JSON.stringify comparison could report "changed" for genuinely
// identical image sets and bump updatedAt for no real reason.
function sameImages(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const aEntries = Object.entries(a ?? {});
  const bMap = b ?? {};
  if (aEntries.length !== Object.keys(bMap).length) return false;
  return aEntries.every(([key, value]) => bMap[key] === value);
}

// Writes a shared workspace's background (non-active) document content
// back into docsStore. Called by collab.ts for every document in a
// shared workspace that isn't the one currently open — the active
// document's content already flows through activeDocContent ->
// saveActiveDocContent instead, so this only ever runs for documents the
// user isn't looking at right now. Mirrors saveActiveDocContent's "don't
// bump updatedAt unless something actually changed" rule: a collaborator
// really editing a document is a real modification and should bump it
// the same way a local edit would, but reconnecting/resyncing identical
// content must not.
export function syncRemoteDocContent(id: string, content: string, images: Record<string, string> | undefined): boolean {
  const doc = findDocById(id);
  if (!doc) return false;
  const contentChanged = content !== doc.content;
  const imagesChanged = !sameImages(images, doc.images);
  if (!contentChanged && !imagesChanged) return false;
  updateDoc(id, { content, images, updatedAt: Date.now() });
  return true;
}
```

`updateDoc` already exists in this file (module-private); `findDocById` is
already exported and used elsewhere in the same file.

**`client/src/collab.ts`** tracks which documents have unflushed remote
changes and debounces writing them into `docsStore`:

- A new module-scoped `const dirtyBackgroundDocs = new Set<string>();` and
  `const backgroundSyncDebounce = debounceWithFlush(flushDirtyBackgroundDocs, 800);`
  (reusing the existing `debounceWithFlush` helper from `./debounce`, same
  one `app.ts` already uses elsewhere).
- `createDocBinding` gains a new `ytext.observe(...)` registered right
  alongside the existing `ydoc.on("update", ydocUpdateHandler)`: whenever
  the text changes and `docId !== workspaceRoom.activeDocId`, mark it
  dirty (`dirtyBackgroundDocs.add(docId); backgroundSyncDebounce.trigger();`).
- The existing `imagesMap.observe(...)` callback currently only acts when
  `workspaceRoom.activeDocId === docId` (pushing the new image into the
  live editor) and silently drops everything else. It gains an `else`
  branch: when it's *not* the active doc, mark it dirty the same way.
- `flushDirtyBackgroundDocs()`: for each id still in `dirtyBackgroundDocs`,
  skip it if it's now the active doc (ownership already transferred to
  the normal CodeMirror pipeline — the `Y.Text` itself is already correct,
  nothing is lost) or if its binding no longer exists (workspace was torn
  down mid-flight). Otherwise read `binding.ytext.toString()` and
  `Object.fromEntries(binding.imagesMap.entries())`, call
  `syncRemoteDocContent(docId, content, images)`, and track whether
  anything actually changed. Clear the set; call `persistDocs()` once at
  the end if any write happened (a single batched persist rather than one
  per document).
- `teardownWorkspace()` calls `backgroundSyncDebounce.flush()` as its
  very first line, before any binding is destroyed — `debounceWithFlush`'s
  `flush()` both cancels the pending timer and runs the flush function
  immediately (synchronously, even though it returns a `Promise`), so no
  pending remote edit is lost when disconnecting, switching away, or
  unlinking.

### 2. Sidebar sort order

**`client/src/components/DocList.svelte`** changes its sort from:

```ts
[...$docsStore].filter((d) => d.workspaceId === $activeWorkspaceIdStore).sort((a, b) => b.updatedAt - a.updatedAt)
```

to:

```ts
[...$docsStore].filter((d) => d.workspaceId === $activeWorkspaceIdStore).sort((a, b) => a.name.localeCompare(b.name))
```

This applies to every workspace, not only shared ones — one consistent
rule, and it means a workspace doesn't visibly reorder itself the moment
it becomes shared. `MenuBar.svelte`'s "Open Recent" submenu and
`ensureActiveDocInWorkspace`'s target-doc selection are both explicitly
unchanged (see Non-goals).

## Error handling

No new error paths — this is pure local data reconciliation between
already-received Yjs state and `docsStore`, with no network calls of its
own. `syncRemoteDocContent` can't throw under normal operation (a plain
store update); if `findDocById` returns nothing (the document was deleted
locally while a remote edit was in flight), it's a no-op.

## Testing

- `stores/docs.test.ts`: `syncRemoteDocContent` bumps `updatedAt` and
  writes new content/images when either actually differs from what's
  stored; returns `false` and leaves `updatedAt` untouched when both are
  identical to what's already stored, including when the same image set
  arrives with keys in a different order (proving the comparison is
  order-independent, not a naive stringify-equality check); returns
  `false` when the doc id doesn't exist.
- No automated coverage for `collab.ts`'s observer/debounce/WebSocket
  wiring or `DocList.svelte`'s sort — matches this codebase's established
  precedent (no Svelte component tests, no tests touching the WebSocket
  transport). Manual verification: with two browser sessions sharing a
  workspace with 2+ documents, edit a document in session A while session
  B has a *different* document open — confirm session B's sidebar shows
  the edited document's heading outline update within ~1s without
  switching to it, and that the sidebar list itself stays in alphabetical
  order (doesn't reorder) throughout. Reload session B and confirm the
  edit persisted (localStorage actually has the updated content, not just
  the live in-memory `Y.Doc`). Disconnect session B (switch to an unshared
  workspace) immediately after a remote edit lands and confirm it wasn't
  lost.
