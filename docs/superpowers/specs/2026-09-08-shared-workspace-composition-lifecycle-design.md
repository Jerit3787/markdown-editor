# Shared-workspace composition & lifecycle — design

**Status:** draft for review
**Date:** 2026-09-08
**Related backlog:** `docs/collab-roles-focus-suggesting-issues.md` — items **E1**, **F3**, **F4**

## Goal

Make three shared-workspace behaviours correct:

1. **E1** — a workspace that is *both* repo-linked and live-shared no longer
   loses its repo-pulled documents (they currently vanish from the sidebar
   and rebuild with fresh ids, making rows unclickable until the churn
   settles).
2. **F3** — deleting a shared workspace warns, in the confirm dialog, that
   collaborators lose access — with copy that differs for the owner vs a
   collaborator dropping their own mirrored copy.
3. **F4** — deleting a shared workspace as its owner *revokes* remote
   access immediately: the share link stops working and connected
   collaborators are torn down and lose their mirrored copy, with a
   banner explaining why.

## Non-goals / deferred

- **Collaborators running repo sync.** Repo sync stays owner-only — only
  the person who linked the repo (and holds the GitHub token) pulls or
  pushes. `repoLink` is not propagated to collaborators. Multi-party
  repo sync (per-user tokens, concurrent-pull races, per-user repo
  permissions) is out of scope.
- **Soft-delete / undo for workspace deletion.** Deletion is an immediate
  hard revoke. No grace period, no restore UI, no 30-day retention.
- **Preserving a collaborator's copy after the owner deletes.** The
  collaborator's *mirrored* copy is removed entirely — deletion is also
  the owner's tool for cutting off continued access. (A collaborator who
  *merged* the shared workspace into their own library is a separate
  case — see §4.6.)
- **Export-before-delete prompt** for the collaborator losing a mirror.
  Possible future softener; not in this spec.
- **G1/G2** (preview link / wikilink rendering) — unrelated cluster,
  tracked separately.

## Background — current state

### Roles & the room

`WorkspaceRoom` (`src/workspace-room.ts`) is one Durable Object per
shared workspace. `authorize()` resolves a connection's role
(`viewer`/`reviewer`/`editor`) from the stored access record. The client
mirrors the role into the UI best-effort (`collab.ts`).

The `Workspace` record (`client/src/stores/workspaces.ts`) carries
`shared?: boolean` and `remoteId?: string` (the room id). It is
localStorage-only; the only things that sync to collaborators are the
workspace `name` and its document order, via `MESSAGE_WORKSPACE_META`
(`applyWorkspaceMeta`).

Three ways a workspace record ends up `shared`:

| Path | Function | Meaning |
|---|---|---|
| Owner shares | `setAccessMode` / `addPerson` mutate the record in place | My workspace, I own the room |
| Join → "add as new" | `adoptSharedWorkspace(remoteId, name)` | A pure mirror of someone else's workspace |
| Join → "preview" | `previewSharedWorkspace(...)` (also `ephemeral`) | A pure mirror, not even persisted |
| Join → "merge into existing" | `mergeSharedWorkspaceInto(wsId, remoteId)` + `importRemoteDocs` | My existing workspace, now also pointed at a room |

There is **no marker** distinguishing "my workspace" from "a mirror of
someone else's".

### E1 root cause

`repo-sync.ts`'s `pullFromRepo` applies a pull by calling
`upsertDocFromRepo` / `removeDocsByRepoPaths` (`stores/docs.ts`), which
create documents with fresh client-side `uid()`s. These documents are
**never registered with the `WorkspaceRoom`** — `repo-sync.ts` has no
connection to `collab.ts`.

When the room next broadcasts `MESSAGE_WORKSPACE_META` (on any rename or
doc add/delete, from any collaborator), `applyWorkspaceMeta()` removes
every local document whose id is absent from the server's `docOrder`:

```ts
for (const doc of get(docsStore).filter((d) => d.workspaceId === local.id)) {
  if (!orderSet.has(doc.id)) { destroyBinding(doc.id); removeDocById(doc.id); }
}
```

So every repo-pulled doc is deleted locally. The next pull re-creates
them (new ids). A click on a sidebar row during that window calls
`switchDoc(staleId)` → `stores/docs.ts`'s `switchDoc` calls
`setActiveId(staleId)` even though `findDocById` returns nothing → the
`id === get(activeIdStore)` guard then makes the *next* click a no-op,
and the reactive editor-reload subscription's `id === lastLoadedId` guard
also blocks — the row is "stuck" until re-created and clicked again.

### F3 / F4 root cause

`deleteWorkspaceRecord` (`stores/workspaces.ts`) and
`WorkspaceSwitcher.svelte`'s `remove()` are **purely local**: remove the
docs, remove the workspace record, fix up the active doc. No server call,
no `teardownWorkspace()`, no access revoke. The confirm copy is generic
(`"This also deletes its N documents. This can't be undone."`).

Server-side there is no delete/revoke endpoint. `handleDocsRequest`
supports `DELETE ?docId=` for a single document, but nothing deletes the
room. A stale share link keeps working forever.

## Design

### 4.1 `Workspace.mirrored` — owner vs mirror

Add an optional field to the `Workspace` type:

```ts
// Set when this workspace record is a *mirror* of a workspace someone
// else owns — created by adoptSharedWorkspace / previewSharedWorkspace
// when joining a share link. Absent for a workspace this user owns, and
// absent for one they merged a share into (mergeSharedWorkspaceInto):
// that record is still fundamentally theirs.
mirrored?: boolean;
```

- `adoptSharedWorkspace` and `previewSharedWorkspace` set `mirrored: true`.
- `mergeSharedWorkspaceInto` does **not** set it.
- `promoteEphemeralWorkspace` (keeps a previewed workspace) keeps
  `mirrored: true` — it's still a mirror, just now persisted.

`mirrored` alone can't tell an owner apart from a merger (both have
`shared && !mirrored`). Ownership is resolved by a fresh access fetch at
delete time (§4.5) rather than a second persisted field — the delete flow
is already an async confirm, one more request is cheap, and it avoids a
field that has to be kept in sync on every access change.

### 4.2 E1 — repo-sync → room propagation (owner-only)

**New seam.** `repo-sync.ts` must not import `collab.ts` (would be
circular via `stores`). Mirror the existing `docRemovalHook` pattern
(`stores/docs.ts`): add a module-level hook object that `collab.ts`
populates in `init()` and `repo-sync.ts` calls.

```ts
// stores/docs.ts  (next to docRemovalHook)
export const repoDocSyncHook: {
  onRepoDocsChanged?: (change: {
    workspaceId: string; // the LOCAL workspace id the pull was applied to
    created: string[];
    updated: string[];
    deleted: string[];
  }) => void;
} = {};
```

**`repo-sync.ts`** — after `pullFromRepo`'s apply loop (and after
`applyResolved` in the conflict path), collect the doc ids it touched and
call `repoDocSyncHook.onRepoDocsChanged?.({ workspaceId, created, updated, deleted })`.
`upsertDocFromRepo` already knows create-vs-update (its `existing`
branch); have it return which it did, or have `pullFromRepo` diff
`docsInWorkspace` before/after, so the ids can be bucketed. `deleted`
comes from `removeDocsByRepoPaths` — resolve repoPath → docId before
removal.

**`collab.ts`** — `init()` sets:

```ts
repoDocSyncHook.onRepoDocsChanged = ({ workspaceId, created, updated, deleted }) => {
  // Only act when THIS local workspace is the connected shared room and
  // we're its editor. workspaceRoom.workspaceId holds the *remote* id, so
  // match through the workspace record.
  const ws = get(workspacesStore).find((w) => w.id === workspaceId);
  if (!ws?.remoteId || ws.remoteId !== workspaceRoom.workspaceId || workspaceRoom.role !== "editor") return;
  for (const id of created) {
    const doc = findDocById(id);
    if (doc && !workspaceRoom.docs.has(id)) seedNewDocBinding(id, doc, "editor");
  }
  for (const id of updated) {
    const binding = workspaceRoom.docs.get(id);
    const doc = findDocById(id);
    if (binding && doc) replaceBindingContent(binding, doc); // full ytext + meta replace in one txn
  }
  for (const id of deleted) {
    if (workspaceRoom.docs.has(id)) pushWorkspaceDocDelete(id, workspaceId);
  }
};
```

- **created** → `seedNewDocBinding` (already exists — inserts content +
  meta into a fresh binding and sends its own sync-step1). The doc is now
  in the server's `docOrder`, so `applyWorkspaceMeta` keeps it.
- **updated** → the pull is authoritative for that file's content.
  `planPull` only classifies a file as `updates` (rather than
  `conflicts`) when the remote changed and the *local* `doc.content` did
  not — and in a shared workspace `doc.content` already tracks live
  collab edits, so a doc any collaborator has touched since the last sync
  goes to `conflicts`, not here. Replace the binding's `ytext` wholesale
  inside one `ydoc.transact(..., "local")` — delete `0..length`, insert
  the new content, reset `meta`. New helper
  `replaceBindingContent(binding, doc)` (extracted from the shared body
  of `seedDocBindingFromEditor` / `seedNewDocBinding`). Yjs merges this
  as a normal local edit, so it propagates to collaborators like any
  other.
- **deleted** → `pushWorkspaceDocDelete` (already exists — HTTP DELETE +
  local `destroyBinding`).

**Not connected / socket down:** `seedNewDocBinding`'s immediate `send()`
is a no-op when the socket isn't OPEN, but the binding is registered, so
`connectWorkspace`'s `ws.onopen` loop syncs it on reconnect. `pushWorkspaceDocDelete`
is plain HTTP and works regardless.

**Workspace not shared:** `workspaceRoom.workspaceId` is null → hook is a
no-op. Repo sync on a private workspace is unchanged.

**Collaborator side:** collaborators never call the hook (they have no
`repoLink`). They receive the seeded docs through the normal sync path.
Their `applyWorkspaceMeta` now sees the repo docs in `docOrder` and keeps
them — E1 fixed.

### 4.3 F3 — delete confirm copy

`WorkspaceSwitcher.svelte`'s `remove(id, name, e)` picks copy by the
workspace's relationship:

| Case | Detected by | Title | Body |
|---|---|---|---|
| Private workspace | `!ws.shared` | `Delete "<name>"?` | *(unchanged)* `This also deletes its N documents. This can't be undone.` |
| Mirror of someone else's | `ws.mirrored` | `Remove "<name>"?` | `This removes your local copy. You can open it again from the share link unless the owner has revoked access.` — **local only, no server call** |
| My shared workspace, I'm the owner | `ws.shared && !ws.mirrored` **and** fresh access fetch says `access.owner === githubUsername` | `Delete "<name>"?` | `This is a shared workspace. Deleting it revokes access for everyone you've shared it with and removes its N documents for them too. This can't be undone.` |
| Shared into my workspace, I'm not the owner | `ws.shared && !ws.mirrored` and `access.owner !== me` | `Remove "<name>"?` | `This removes your workspace and its N documents from this device. The shared workspace itself stays available to its owner and other collaborators.` — **local only** |

The access fetch happens once, before showing the dialog, only for the
`shared && !mirrored` case. On fetch failure, fall back to the
owner-phrasing but still attempt the DELETE (the server is the final
authority — a non-owner's DELETE 403s harmlessly, §4.5).

### 4.4 F4 — server: revoke on delete

**New message type:** `MESSAGE_WORKSPACE_DELETED = 5` (both
`client/src/collab.ts` and `src/workspace-room.ts`; next free after
`MESSAGE_COMMENTS = 4`). Frame is just the type byte — no payload.

**`WorkspaceRoom` gains a `deleted` flag:**

```ts
private deleted = false;
// in the blockConcurrencyWhile init:
this.deleted = (await this.state.storage.get<boolean>("deleted")) === true;
```

**Early guard in `fetch()`** — before any route matching:

```ts
if (this.deleted) return new Response("This workspace has been deleted.", { status: 410 });
```

This covers `/access`, `/docs`, `/meta`, comments, versions, and the WS
upgrade in one place.

**New handler `handleDeleteRequest(request)`**, routed from the bare
`DELETE /api/workspace/:id`:

```ts
if (request.method === "DELETE") return this.handleDeleteRequest(request);
// ...
async handleDeleteRequest(request: Request): Promise<Response> {
  const auth = await this.authorize(request);
  if (!auth.ok) return new Response(auth.message, { status: auth.status });
  const access = (await this.state.storage.get<AccessRecord>("access")) ?? null;
  if (!access?.owner || access.owner !== auth.username) {
    return new Response("Only the workspace owner can delete it.", { status: 403 });
  }
  this.deleted = true;
  await this.state.storage.put("deleted", true);

  // Tell every live session, then close them.
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_WORKSPACE_DELETED);
  this.broadcast(encoding.toUint8Array(encoder), null);
  for (const ws of this.sessions.keys()) { try { ws.close(1000, "workspace deleted"); } catch {} }
  this.sessions.clear();

  // Free storage — the room is a tombstone now. Keep only the `deleted` flag.
  await this.state.storage.deleteAll();
  await this.state.storage.put("deleted", true);
  return new Response(null, { status: 204 });
}
```

`deleteAll()` + re-put keeps the DO as a cheap tombstone: any later
request re-reads `deleted: true` and 410s. (A Durable Object can't truly
delete itself; a tombstone is the idiom.)

**`worker.ts`** — allow `DELETE` through the bare workspace route:

```ts
if (workspaceMatch) {
  if (request.method !== "DELETE" && request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected websocket", { status: 426 });
  }
  ...
}
```

### 4.5 F4 — client: owner delete flow

`WorkspaceSwitcher.remove()` for the owner case, after the confirm:

```ts
if (ws.shared && !ws.mirrored) {
  const res = await fetch(`/api/workspace/${encodeURIComponent(ws.remoteId!)}`, { method: "DELETE" });
  if (res.status === 403) {
    // Not the owner after all — this was a merged workspace. Local removal only.
    showToast("Removed from this device. The shared workspace still exists for its owner.", "info");
  } else if (!res.ok && res.status !== 410) {
    showToast("Couldn't reach the server to revoke sharing — removed locally; collaborators may keep access until the room is cleaned up.", "error");
  }
}
if (workspaceRoom.workspaceId === ws.remoteId) teardownWorkspace();
// existing local removal:
docIds.forEach(removeDocById);
deleteWorkspaceRecord(id);
```

The local removal always runs — the user's own data goes regardless of
the server round trip.

### 4.6 F4 — client: collaborator teardown

**Live (`MESSAGE_WORKSPACE_DELETED` while connected).** New branch in
`handleServerMessage`:

```ts
if (messageType === MESSAGE_WORKSPACE_DELETED) {
  handleWorkspaceDeletedRemotely();
  return;
}
```

```ts
function handleWorkspaceDeletedRemotely(): void {
  const remoteId = workspaceRoom.workspaceId;
  const local = get(workspacesStore).find((w) => w.remoteId === remoteId);
  teardownWorkspace();
  if (!local) return;
  if (local.mirrored) {
    // Pure mirror — remove it and its docs entirely (the owner's intent
    // is to cut off access).
    for (const d of get(docsStore).filter((d) => d.workspaceId === local.id)) removeDocById(d.id);
    deleteWorkspaceRecord(local.id);
    workspaceAccessDenied.set("deleted");
  } else {
    // A workspace this user merged a share into — keep it and its docs
    // (their own library), just sever the live link.
    workspacesStore.update((all) => all.map((w) =>
      w.id === local.id ? { ...w, shared: undefined, remoteId: undefined, updatedAt: Date.now() } : w));
    persistWorkspaces();
    showToast(`"${local.name}" is no longer shared — its owner deleted the shared workspace. Your local copy is kept.`, "info");
  }
}
```

**On reconnect / fresh load (`410` from the access fetch).**
`fetchWorkspaceAccess` currently swallows every non-ok into
`DEFAULT_ACCESS`. Make it distinguish 410:

```ts
async function fetchWorkspaceAccess(workspaceId: string): Promise<AccessRecord> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/access`);
    if (res.status === 410) return { ...DEFAULT_ACCESS, deleted: true };
    if (!res.ok) return { ...DEFAULT_ACCESS };
    return { ...DEFAULT_ACCESS, ...(await res.json()) };
  } catch { return { ...DEFAULT_ACCESS }; }
}
```

(`AccessRecord` gains `deleted?: boolean`, client-only — the server never
sends it, the 410 status *is* the signal.)

`joinSharedLink` and `rejoinKnownWorkspace` check it right after the
fetch:

```ts
if (access.deleted) { handleWorkspaceGoneOnLoad(workspaceId); return; }
```

`handleWorkspaceGoneOnLoad` is `handleWorkspaceDeletedRemotely`'s
by-remoteId sibling (same mirror-vs-merged split), plus
`workspaceAccessDenied.set("deleted")` for the mirror case so the banner
shows on the next render.

**`WorkspaceAccessBanner.svelte` + `stores/share.ts`.** Extend the union:

```ts
export type WorkspaceAccessDeniedReason = "no-session" | "no-access" | "deleted";
```

New banner branch:

> **This shared workspace was deleted by its owner.** You no longer have
> access to it. *(no action button — the local copy is already gone)*

`teardownWorkspace()` must not clear `workspaceAccessDenied` for the
`"deleted"` case — check its current handling (it doesn't touch that
store today, so likely fine; verify in implementation).

## Data flow — owner deletes a shared workspace

```
Owner: WorkspaceSwitcher.remove()
  ├─ confirmAction(owner copy)  ──────── user confirms
  ├─ DELETE /api/workspace/<remoteId>
  │     └─ WorkspaceRoom.handleDeleteRequest
  │          ├─ authorize() → editor, username === access.owner ✓
  │          ├─ deleted = true; storage.put("deleted", true)
  │          ├─ broadcast(MESSAGE_WORKSPACE_DELETED)
  │          ├─ close all sessions
  │          └─ storage.deleteAll(); storage.put("deleted", true) → 204
  ├─ teardownWorkspace()  (was the active room)
  ├─ removeDocById × N
  └─ deleteWorkspaceRecord

Collaborator A (connected): ws.onmessage → MESSAGE_WORKSPACE_DELETED
  └─ handleWorkspaceDeletedRemotely()
       ├─ teardownWorkspace()
       ├─ mirror? remove docs + record; workspaceAccessDenied = "deleted"
       └─ merged? sever shared/remoteId, keep docs, toast

Collaborator B (offline, reopens link later): GET /access → 410
  └─ fetchWorkspaceAccess → { deleted: true }
       └─ joinSharedLink: handleWorkspaceGoneOnLoad() → same split + banner
```

## Error handling

| Situation | Behaviour |
|---|---|
| Owner's `DELETE` request fails (network) | Local removal still happens; toast warns remote revoke unconfirmed |
| Non-owner (merger) hits `DELETE` | Server 403; client treats as "local removal only", neutral toast |
| `MESSAGE_WORKSPACE_DELETED` arrives for a workspace already locally gone | `local` lookup is null → `teardownWorkspace()` only, no-op otherwise |
| 410 on a doc-level fetch (comments/versions) mid-session | Existing fetch-failure handling shows its error; the `MESSAGE_WORKSPACE_DELETED` / next `/access` 410 does the real cleanup |
| Repo pull's `onRepoDocsChanged` fires while not connected | Bindings registered locally; synced on next `connectWorkspace` |
| Repo pull on a workspace shared by someone else (collaborator somehow has repoLink) | `workspaceRoom.role !== "editor"` guard, or `access.owner` check — no push |

## Testing

**Server (`tests/src/workspace-room.test.ts`):**
- `DELETE` by the owner → 204, `deleted` persisted, subsequent `/access`
  and WS upgrade → 410.
- `DELETE` by a non-owner editor → 403, room still live.
- `DELETE` unauthenticated → 401.
- A connected session receives `MESSAGE_WORKSPACE_DELETED` and is closed.

**Client collab (`tests/client/src/collab.test.ts`):**
- `MESSAGE_WORKSPACE_DELETED` on a `mirrored` workspace → docs + record
  removed, `workspaceAccessDenied === "deleted"`.
- `MESSAGE_WORKSPACE_DELETED` on a merged workspace → `shared`/`remoteId`
  cleared, docs retained, toast.
- `fetchWorkspaceAccess` 410 → `{ deleted: true }`; `joinSharedLink`
  routes to the gone-on-load path.
- `repoDocSyncHook.onRepoDocsChanged` with `created` ids on a connected
  shared workspace → `seedNewDocBinding` called, ids now in
  `workspaceRoom.docs`.
- Same hook on a **non-shared** workspace → no-op.
- Same hook `deleted` ids → `pushWorkspaceDocDelete` fired.

**Client repo-sync (`tests/client/src/repo-sync.test.ts`):**
- `pullFromRepo` applying creates/updates/deletes calls
  `repoDocSyncHook.onRepoDocsChanged` with the right id buckets.

**Component (`tests/client/src/components/`):**
- `WorkspaceSwitcher` delete confirm copy: private / mirror / owned-shared
  variants (mock the access fetch).
- `WorkspaceAccessBanner` renders the `"deleted"` branch.

**E2E (`tests/e2e/collab/`):**
- New spec: owner shares a 2-doc workspace, collaborator joins, owner
  deletes → collaborator's editor tears down, workspace gone from their
  sidebar, banner shown; re-opening the link shows the deleted banner.
- New spec (or extend an existing repo one): a repo-linked workspace is
  shared, owner pulls a new file, collaborator sees it appear.

**Regression guard for E1:** a Vitest test that reproduces the original
churn — repo docs present, `MESSAGE_WORKSPACE_META` with a `docOrder`
that excludes them, assert they survive once the seam has registered
them.

## Rollout / versioning

User-facing (new confirm copy, new banner, "collaborators lose access"
behaviour) → **minor bump**, `CHANGELOG.md` `### Added` + `### Fixed`,
and a `whats-new-entries.ts` entry with a real screenshot (the delete
confirm dialog or the "deleted by owner" banner).

Single implementation plan expected (server revoke → client teardown →
delete-flow copy → E1 seam → tests), one PR, one release. If the plan
runs long, split at "E1 seam" as its own plan on the same branch.
