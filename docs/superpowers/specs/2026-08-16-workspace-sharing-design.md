# Workspace-Level Sharing Design

## Context

This is the second of four planned sub-projects (workspace core → **workspace
sharing** → GitHub repo sync → Google Drive sync) toward letting a user share
an entire *workspace* instead of one document at a time. Workspace core
shipped as v1.20.0: every `Doc` now belongs to exactly one `Workspace`
(`client/src/types.ts`, `client/src/stores/workspaces.ts`), with one workspace
active/visible at a time.

Today, sharing is entirely per-document: `src/collab-room.ts`'s `CollabRoom`
Durable Object holds one Yjs doc, one access record (owner / general access /
invited usernames+roles), version snapshots, and comment threads — one DO
instance per shared document, addressed by the document's own id
(`env.COLLAB_ROOM.idFromName(docId)`, see `src/worker.ts`). The client's
`collab.ts` holds a single `room` singleton — one live WebSocket/Y.Doc/
awareness connection at a time, torn down and rebuilt on every doc switch
(`teardown()`/`joinRoom()`).

This spec redesigns that so a whole workspace's documents sync live
*simultaneously*, not just whichever one is currently open, and access
control (owner / general access / invited people / role) is set once per
workspace instead of once per document.

## Goals

- Every document inside a shared workspace is live (connected, receiving
  remote edits) for the whole time the workspace is open — not only the
  document currently on screen.
- Access control (`AccessRecord`: owner, general access, invited people +
  roles) moves from per-document to per-workspace: one record governs every
  document a collaborator can see in that workspace.
- A document's existing "Share" action still exists and still reads as
  sharing *that document* — but if the document isn't already alone in its
  workspace, sharing it first relocates it into its own new workspace (after
  a confirm dialog explaining that), then shares that workspace.
- Opening a shared workspace link prompts the recipient to choose: add it as
  a new workspace of its own, or merge its documents into one of their
  existing workspaces.
- Presence extends across files: a collaborator's awareness state now
  includes which document within the shared workspace they currently have
  open, not just their cursor within whichever one you're both viewing.
- Documents already shared under the old per-document model keep working
  through the transition (see Migration) — no dead links.

## Non-goals

- GitHub repo sync / Google Drive sync (sub-projects 3/4).
- Per-document-only sharing as a standing feature — every share ends up
  workspace-scoped, per the user's original framing for this whole pivot.
  (The single-document "Share" button survives only as a convenience that
  auto-creates a dedicated workspace, not as a parallel access model.)
- Changing version history or comment-thread *behavior* — both keep working
  exactly as today, just re-scoped from "per document" to "per document
  within a workspace" storage-wise (see Architecture).
- Fine-grained per-document roles within one shared workspace (e.g. "editor
  on doc A, viewer on doc B" for the same person). One role per person per
  workspace, applying uniformly to every document in it.
- A UI for browsing/reconciling merge conflicts when "merge into an existing
  workspace" collides with local document names — a same-name collision uses
  the existing rename-on-collision flow already used elsewhere in the app
  (see `stores/renameCollision.ts`), not new conflict-resolution UI.

## Architecture

### Server: `WorkspaceRoom` Durable Object

A new DO class, `WorkspaceRoom` (`src/workspace-room.ts`), replaces
`CollabRoom` for anything inside a shared workspace. One instance per shared
workspace, addressed by the workspace's own id
(`env.WORKSPACE_ROOM.idFromName(workspaceId)`).

Internally it holds a per-document map instead of a single `Y.Doc`:

```typescript
interface DocRoom {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  snapshots: Snapshot[];
  lastSnapshotAt: number | undefined;
  commentThreads: CommentThread[];
}

class WorkspaceRoom {
  docs: Map<string, DocRoom>; // keyed by docId
  access: AccessRecord;       // one record for the whole workspace now
  sessions: Map<WebSocket, SessionInfo>;
  ...
}
```

Each `DocRoom`'s internals (doc update handling, snapshot throttling, comment
CRUD, anchor relocation) are the same logic `CollabRoom` already has today —
just instantiated once per document inside the map instead of once per DO.
Durable storage keys become namespaced by doc id within the one DO:
`doc:<docId>:update`, `doc:<docId>:snapshots`, `doc:<docId>:comments`, plus a
single workspace-wide `access` key (no more per-doc `access` key). A new
`docs` key stores the list of document ids currently in the workspace, so a
freshly-created `WorkspaceRoom` instance (e.g. after a cold start) knows what
to load from storage without being told externally.

**Wire protocol.** Today's protocol needs no document identifier — one DO
connection means one document. A `WorkspaceRoom` connection carries several
documents over one socket, so every message frame gains a leading doc id:

```
[existing 1-byte message type][varString docId][existing message payload]
```

`MESSAGE_SYNC` and `MESSAGE_AWARENESS` keep their existing internal shape
(`y-protocols/sync` / `awareness` encoders) — only the outer envelope
changes. `handleMessage` dispatches by reading the doc id first, then routing
the remaining bytes to that `DocRoom`'s existing sync/awareness handling
(same code as `CollabRoom.handleMessage` today, just parameterized).

**Adding/removing documents.** A workspace member with editor access can add
an existing local document into the shared workspace, or remove one from it
(unshares just that document, moving it back to a local-only workspace) —
both are just workspace-membership operations (edit the `docs` key,
lazily create/tear down the corresponding `DocRoom` entry), not access
changes.

**Access control.** `authorize()` moves near-verbatim from `CollabRoom`, but
resolves once per WebSocket connection (governing every document in the
workspace) instead of once per document connection. The owner/general-access/
invited-list semantics are unchanged — see today's `authorize()` in
`src/collab-room.ts:337-369`, which this reuses as-is, just reading the
workspace-level `AccessRecord` instead of a per-doc one.

### Client: multi-doc `workspaceRoom`

`collab.ts`'s single `room` singleton generalizes into a `workspaceRoom` that
opens **one** WebSocket for the entire active shared workspace:

```typescript
const workspaceRoom = {
  workspaceId: null as string | null,
  ws: null as WebSocket | null,
  docs: new Map<string, { ydoc: Y.Doc; ytext: Y.Text; imagesMap: Y.Map<string>; awareness: Awareness; undoManager: Y.UndoManager | null }>(),
  ...
};
```

Every document belonging to the active shared workspace gets its own `Y.Doc`
in `workspaceRoom.docs`, all synced concurrently over the one socket —
switching which document is on screen only changes which `Y.Doc` is bound to
CodeMirror (`bindEditor`); it does not open or close any connection. Opening
a *different* workspace (shared or not) tears the whole thing down and, if
the new workspace is itself shared, opens a fresh connection seeded with
its documents.

Non-shared documents and non-shared workspaces are completely unaffected —
they never touch `workspaceRoom` and keep using IndexedDB exactly as today.

### Data model changes (`client/src/types.ts`)

```typescript
export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  // Set once this workspace has ever been shared or joined from a share
  // link — same "try to reconnect on load" role Doc.shared plays today,
  // just at workspace scope now.
  shared?: boolean;
  // The WorkspaceRoom DO's name, once shared/joined. Deliberately separate
  // from `id`: a workspace joined via "merge into an existing workspace"
  // keeps its own local id/name but still needs to know which remote room
  // to connect to.
  remoteId?: string;
}
```

`Doc.shared` (today's per-document flag) is removed — once workspace-level
sharing ships, a document is shared if and only if its containing workspace
is (`Workspace.shared`), so a separate per-doc flag has nothing left to mean.
`AccessRecord`/`InvitedPerson` (today's `types.ts:4-18`) are unchanged in
shape, just now fetched via `/api/workspace/<workspaceId>/access` instead of
`/api/collab/<docId>/access`.

### Share links

Today's `/d/<docId>/<view|review|edit>` link format is replaced by
`/w/<workspaceId>/<docId>/<view|review|edit>` — the workspace id resolves
which `WorkspaceRoom` to connect to (and is what access control is actually
checked against); the doc id is just which document to land on inside it
once connected. Old `/d/<docId>/...` links keep resolving during the
migration window (see Migration below) by redirecting to the new format.

### Join flow

Opening a `/w/<workspaceId>/<docId>/...` link:

1. Fetch the workspace's access record, compute the opener's role
   (identical `computeMyRole()` logic to today, just against workspace
   access instead of doc access). No access → same sign-in-required /
   no-access messaging as today.
2. If authorized and this is the first time this browser has seen this
   `remoteId`, show a choice instead of silently adding it:
   - **Add as a new workspace** — creates a local `Workspace` record
     (`shared: true`, `remoteId` set, name copied from the remote workspace)
     and downloads its document list into it.
   - **Merge into an existing workspace** — prompts which of the user's own
     workspaces to file it under; that existing local workspace gains
     `shared: true` + `remoteId`, and the remote documents are added
     alongside whatever local documents it already had (name collisions go
     through the existing rename-on-collision flow).
3. Either way, `workspaceRoom` connects and every document in the workspace
   starts syncing immediately — not just the one from the link's `docId`.

### Sharing a single document (relocate-and-share)

The existing per-document "Share" action stays, but its behavior changes:

- If the active document is **already alone in its workspace**, share that
  workspace directly — no relocation needed.
- Otherwise, confirm first: *"Sharing this document moves it into its own
  workspace so it can be shared. Continue?"* On confirm: create a new local
  `Workspace` (name defaulted from the document's name), move the document
  into it (`doc.workspaceId` reassignment — the same primitive Workspace
  Core's existing "move to another workspace" menu action already uses),
  then proceed with the normal share flow against that new workspace.

### Presence across files

`WorkspaceRoom`'s awareness state gains a `docId` field per connected client
(which document they currently have open), alongside the existing
`user`/`role` fields already set in `joinRoom`'s `awareness.setLocalState`
call. The document list UI can then show a presence indicator per document
(who's currently on it), not just within whichever document is on screen —
exact UI treatment (avatar stack in the doc list vs. a simpler dot indicator)
is left to implementation; the spec's requirement is only that the data is
available.

### Migration of already-shared documents

There's no server-side index of "every document that has ever been shared"
— `CollabRoom` DOs are addressed by name with no registry, and the only
record of which documents are shared lives in each user's own local
`doc.shared` flags. Migration therefore has to be lazy and per-document,
triggered the next time each shared document is actually opened, rather than
a single bulk pass at deploy time:

1. A client loads a local document with the legacy `doc.shared: true` flag
   still set (untouched by Workspace Core, which only added `workspaceId`).
2. It calls a new endpoint, `POST /api/collab/<docId>/migrate`, routed to
   that document's existing `CollabRoom` DO.
3. If that `CollabRoom` hasn't been migrated yet, it creates a new
   `WorkspaceRoom` (fresh workspace id), copies its Yjs state, access
   record, snapshots, and comment threads across as that workspace's sole
   document, then stores a tombstone (`migratedTo: <newWorkspaceId>`) and
   responds with the new workspace id. If it's already been migrated
   (a second collaborator triggers this after the first), it just returns
   the existing tombstone's target.
4. The client creates/updates its local `Workspace` record accordingly
   (same as a fresh join — see Join flow) and switches to the new
   `/w/<workspaceId>/<docId>/...` link going forward, clearing the legacy
   `doc.shared` flag.
5. Any late-arriving collaborator who still has an old `/d/<docId>/...` link
   hits the `CollabRoom`'s tombstone (step 3) and gets redirected the same
   way — the old link keeps working indefinitely, it just always resolves
   through one redirect hop.

`CollabRoom` itself is not deleted from the codebase in this sub-project —
it stays only as the migration path's read side (steps 2-3 above) until a
later cleanup once real-world usage confirms no more legacy rooms are being
hit. New shares never create a `CollabRoom`; only pre-existing ones migrate
through it.

## Error handling

- A `WorkspaceRoom` write from a non-editor session is silently dropped,
  same as `CollabRoom` does today (`handleMessage`'s `isWrite` check) — the
  client's own read-only enforcement is UX only, the server is the real
  authority.
- Losing access mid-session (e.g. the owner removes an invited person while
  they're connected) is handled the same way it is today: the next
  reconnect attempt re-runs `authorize()` and fails closed. Nothing new
  needed here since the workspace-level `authorize()` reuses the exact
  per-connection check.
- A `migrate` call racing two collaborators opening the same legacy link at
  once is resolved by the tombstone check in step 3 above — second caller
  reads the first caller's tombstone instead of creating a duplicate
  workspace.

## Testing

- `src/collab-room.test.ts`'s existing coverage (access rules, snapshot
  throttling, comment CRUD, anchor relocation) moves to a new
  `src/workspace-room.test.ts`, adapted for the multi-doc map instead of a
  single `Y.Doc` — same test cases, parameterized by doc id.
- New coverage: multiplexed sync (two documents' updates over one socket
  don't cross-talk), the migration endpoint (fresh migration, idempotent
  re-migration via tombstone, redirect for a late joiner), and the
  merge-vs-new-workspace join choice (`stores/workspaces.test.ts`).
