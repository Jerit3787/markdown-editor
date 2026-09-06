# Workspace Structure Sync — Design Spec

## Goal

A shared workspace should mirror the sharer's side one-to-one, the way a shared folder does: its **name**, and the fact that a document was **removed** from it, should reach every collaborator live — not just each document's own content, images, and name, which already sync. Concretely:

- Joining (or already being connected to) a shared workspace with more than one document currently always shows the literal name `"Shared workspace"`, never the sharer's actual workspace name.
- Deleting a document from a shared workspace only removes it locally for the person who deleted it — every other collaborator keeps a silently-orphaned local copy forever, with nothing telling them it's gone.

## Non-goals

- **Document order.** `DocList.svelte` has no stored ordering at all — it sorts alphabetically by name on every render, with no drag-and-drop reordering UI anywhere in the app. Once every document's name is correct for everyone (already true after the sibling fix in `client/src/collab.ts`'s `setAccessMode`, shipped separately this session), the sidebar order is automatically identical for everyone. Nothing to build here.
- **A visible "am I currently live-synced" indicator.** The existing `Workspace.shared`/`remoteId` fields already answer "is this workspace remote-backed" (the concern originally raised in issue #129's first bullet); what this spec adds is an *internal* correctness guarantee — the client never treats a locally-cached workspace name/doc-list as current until a real sync from the room has actually landed, the same principle `DocBinding.whenSynced` already applies per-document. No new user-facing status UI.
- **Any change to how document content, images, names, or metadata already sync.** Untouched.
- **Renaming/deleting from a workspace that was never shared (no `remoteId`).** Purely local, unchanged — `renameWorkspace()`/`deleteDoc()` only take the new remote-facing path when the workspace they act on has `shared: true` and a `remoteId`.

## Architecture

`WorkspaceRoom` (the Durable Object) gains one more small piece of persisted, synced state: **workspace meta**, `{ name: string, docOrder: string[] }`. `docOrder` is the existing `docIds` array (already ordered, already persisted under DO storage key `"docs"`) — nothing changes about how it's tracked; it just gains a second consumer (broadcasting it, not only serving it over `GET /docs`). `name` is new: a plain string, stored under its own DO storage key (`"name"`), defaulting to `""` (meaning "not set — the join-preview path already falls back sensibly when a name is missing," see Data Flow).

This is deliberately **not** a Y.Doc. A workspace name is a single last-write-wins value nobody co-edits character-by-character the way document content is — forcing it through the Yjs sync/CRDT machinery built for concurrent text editing would be solving a problem this data doesn't have. It rides the *same* WebSocket every document already shares, as one new message type:

```
MESSAGE_WORKSPACE_META = 3   // client/src/collab.ts and src/workspace-room.ts, alongside
                              // the existing MESSAGE_SYNC=0 / MESSAGE_AWARENESS=1 / MESSAGE_PRESENCE=2
```

Wire format (mirrors the existing `varUint`/`varString` encoding already used throughout this file): `writeVarUint(MESSAGE_WORKSPACE_META)`, `writeVarString(name)`, `writeVarUint(docOrder.length)`, then `writeVarString(id)` for each entry.

**Mutations go over plain HTTP, not the WebSocket** — this is a deliberate, explicit choice (see "Why HTTP, not WS" below), matching how sharing settings (`/access`) and document list changes (`/docs`) already work today. The WebSocket is used only to *broadcast* the result of a mutation to already-connected sessions, and to *greet* a newly-opened connection with the current state — the same two jobs it already does for document content.

**Why HTTP, not WS:** `WorkspaceSwitcher.svelte`'s inline rename works on *any* workspace in the local list, not only the currently-active/connected one — the module-level `workspaceRoom` singleton in `collab.ts` only ever holds a live connection to one workspace at a time. Renaming a shared-but-not-currently-open workspace would have no WebSocket to send over. Routing the mutation through HTTP instead (like `/access` and `/docs` already do) works regardless of whether the person making the change happens to be connected via WS right now, and the server broadcasts the result to whoever *is* connected afterward either way.

## Components

**Server — `src/workspace-room.ts`:**
- `WorkspaceRoom` gains a `name: string` field, loaded in the constructor alongside `docIds` (from a new `"name"` storage key, defaulting to `""`).
- New method `broadcastWorkspaceMeta(exceptWs?: WebSocket)`: encodes the current `{name, docIds}` as one `MESSAGE_WORKSPACE_META` frame and calls the existing `broadcast()` helper.
- `handleSession()` (where a newly-opened socket is greeted with each document's own sync step1) also sends one `MESSAGE_WORKSPACE_META` frame with the current state, right after the per-document greeting loop.
- New endpoint `PUT /api/workspace/:id/meta`, body `{ name: string }`. Authorized via the same `this.authorize(request)` used by `/docs`'s `POST`/`DELETE` (editor-only — matches document rename's own editor-only write gate, not `/access`'s owner-only gate, since renaming a workspace is closer in spirit to renaming a document than to changing sharing settings). Persists `name`, calls `broadcastWorkspaceMeta()`, returns the new name.
- `DELETE /docs?docId=X` (already exists, already editor-gated, currently has no caller anywhere in the client) gains two things: (1) it now also deletes that document's stored content/snapshots/comments (`docStorageKey(docId, "update"|"snapshots"|"comments")`) instead of leaving them in DO storage indefinitely — a real gap, found while wiring up this endpoint's first real caller, fixed as part of this same change rather than left for later; (2) it calls `broadcastWorkspaceMeta()` after removing the id from `docIds`.
- `GET /access` (already fetched, unauthenticated, at pre-join preview time) additionally returns `workspaceName` in its JSON body, read from the same `name` field.

**Client — `client/src/collab.ts`:**
- `MESSAGE_WORKSPACE_META = 3` constant, mirroring the server's.
- `handleServerMessage()` gains a branch for this message type: decode `{name, docOrder}`, then (a) update the matching local `Workspace.name` (matched by `remoteId`) if `name` is non-empty, and (b) for any local `Doc` belonging to this workspace whose id is *not* in `docOrder`, remove it — tearing down its `workspaceRoom.docs` binding the same way `teardownWorkspace()` already tears down bindings (awareness destroy, ydoc `off`/`destroy`), and removing it from `docsStore`. If the removed document was the active one, fall back to whatever `stores/docs.ts` already does when the active document disappears locally (switch to another document in the workspace, or the empty state) — no new logic, just make sure this path reaches it instead of leaving the editor pointed at a torn-down binding.
- New exported function `pushWorkspaceRename(workspaceId: string, name: string)` in `collab.ts`: if the workspace has `shared: true` and a `remoteId`, fires `PUT /api/workspace/:id/meta` with the new name. `WorkspaceSwitcher.svelte` (a Svelte component, already directly importing from `collab.ts` elsewhere in this codebase — see `Share.svelte`'s own direct import of `setAccessMode`/`setRole` for the established pattern) calls this right alongside its existing `renameWorkspace()` call. No `window.MDE` bridge involved — that indirection exists specifically for `app.ts`'s vanilla-JS code, which document rename goes through (`docTitle` is a plain DOM input, not a Svelte component); workspace rename's UI is already a Svelte component with a direct import path available.
- `deleteDoc()` (in `stores/docs.ts`), when acting on a document whose workspace is `shared`+has a `remoteId`, calls `DELETE /api/workspace/:id/docs?docId=X` — fire-and-forget is acceptable here (the same tolerance the rest of this sync already has for a dropped request: the next broadcast/reconnect corrects it), matching how other collab-adjacent local mutations already don't block on their own network round trip.
- `fetchRemoteDocContent`'s existing per-document `"Shared document"` fallback (line ~1074) is untouched — already fixed by the sibling "seed every document" change.
- `decideJoinTarget`'s workspace-name heuristic (`validDocs[0].name` for a single doc, literal `"Shared workspace"` for multiple) is replaced: the pre-join preview (`joinSharedLink`, which already calls `fetchWorkspaceAccess`) uses the new `workspaceName` field from that response when present and non-empty, falling back to the existing heuristic only when it's genuinely empty (a workspace shared before this change shipped, or a workspace that was never explicitly named).

## Data Flow

- **Rename:** Owner/editor renames the active — or any — shared workspace in `WorkspaceSwitcher.svelte` → `renameWorkspace()` → `collab.ts` fires `PUT /meta` with the new name → `WorkspaceRoom` persists it and calls `broadcastWorkspaceMeta()` → every other currently-connected session receives `MESSAGE_WORKSPACE_META` and updates its local `Workspace.name` for that `remoteId`. A non-editor's local rename still fires the same PUT; the server's `authorize()` check rejects it (403) before anything is persisted or broadcast — their own tab shows the attempted name until the next real broadcast (or a reconnect) corrects it, the same self-correcting tolerance document rename already has for a rejected write.
- **Delete:** Editor deletes a document from a shared workspace → `deleteDoc()` calls `DELETE /docs?docId=X` → `WorkspaceRoom` removes the id from `docIds`, deletes its stored content/snapshots/comments, and calls `broadcastWorkspaceMeta()` → every other connected session receives the new `docOrder`, notices the missing id, and removes that document locally (tearing down its binding, handling an active-document removal gracefully as described in Components).
- **Fresh join / pre-join preview:** the preview modal's `fetchWorkspaceAccess()` call now also carries `workspaceName`; the live join's `handleSession()` greeting now also includes one `MESSAGE_WORKSPACE_META` frame alongside the existing per-document greeting — no separate fetch needed for either path.
- **Trust gating:** no new mechanism needed beyond what's described above — a freshly-connected session's first `MESSAGE_WORKSPACE_META` frame (sent unconditionally as part of the existing greeting) is what actually applies the name/doc-list; nothing about connecting silently trusts a stale local cache in the interim beyond the same brief, self-correcting window every other piece of synced state in this app already has (e.g. document content between connecting and the first sync reply).

## Error Handling

- **Non-editor write:** rejected server-side (403) before any persistence or broadcast, for both the new `/meta` endpoint and the now-wired-up `/docs` `DELETE` — no client-side role gate needed beyond not showing these as if they were guaranteed to stick (matching the existing tolerance for a rejected document rename/edit).
- **Active document deleted out from under the viewer:** routes through the same existing "active document disappeared" handling `stores/docs.ts` already has for a purely local deletion — no new UI, no crash path.
- **Orphaned DO storage for a deleted document:** closed as part of this change (see Components) rather than left as a new, first-time-exercised gap.
- **Two editors changing different things at once** (a rename and a delete landing close together): both are independent last-write-wins fields folded into the same small broadcast snapshot each time they change — no merge logic needed; worst case is two broadcasts arriving in quick succession, both converging on the same final state.
- **A workspace shared before this change shipped** (its DO has never had a `name` written): `GET /access`'s `workspaceName` comes back empty; the client falls back to the existing single-doc-name-or-"Shared workspace" heuristic exactly as it does today, until an editor renames it at least once.

## Testing

- **Unit (`tests/client/src/collab.test.ts`):** an incoming `MESSAGE_WORKSPACE_META` updates the local workspace's name (matched by `remoteId`); a document id missing from an incoming `docOrder` gets removed locally, its binding torn down; a document id still present is left alone.
- **Server (this file's own existing test file):** a non-editor's `PUT /meta` is rejected without persisting or broadcasting; an editor's `PUT /meta` persists and broadcasts; `DELETE /docs` removes the document's stored content/snapshots/comments in addition to its id; `DELETE /docs` broadcasts the new `docOrder` to other connected sessions; `GET /access` includes the current `workspaceName`.
- **e2e (`tests/e2e/collab/`):** two collaborators connected to the same shared workspace — the owner renames it and the other collaborator's `WorkspaceSwitcher` label updates with no reload; the owner deletes a document (not the one the other collaborator is currently viewing) and it disappears from the other collaborator's sidebar live; a variant where the deleted document *is* the one the other collaborator currently has open, asserting they land somewhere sane instead of a broken/blank editor.

## Versioning

User-facing (a shared workspace's name and document deletions now actually reach collaborators, instead of showing a placeholder name or leaving orphaned copies behind) — minor version bump, with a What's New entry (and its required real screenshot, captured live), per `CLAUDE.md`'s versioning convention. The DO storage cleanup fix folded into this same change has no visible behavior of its own beyond "the leak is gone," but rides along with the same version bump since it's part of the same commit set, not shipped as its own separate patch release.
