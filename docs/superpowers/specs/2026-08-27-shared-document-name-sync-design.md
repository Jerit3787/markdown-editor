# Shared Document Name Sync — Design Spec

**IMPROVEMENTS.md Phase 2 item.** Only document *content* and *images* sync
between collaborators today (via the per-document Y.Doc's `ytext`/
`imagesMap`) — the document name is purely local per-browser and never
touches the collab layer at all, so a rename by one party never reaches
anyone else until they happen to reload.

## Goal

Renaming a shared document reaches every collaborator live, the same way a
content edit or an inserted image already does — including a fresh joiner,
who should see the real name instead of the client's own hardcoded
placeholder.

## Design decision: where the name lives

Two options were on the table (per the original backlog note):

1. **A second Y-doc field alongside `ytext`.** The per-document `Y.Doc`
   already carries a second top-level type beyond `ytext` —
   `imagesMap` (`Y.Map<string>`, keyed by image reference) — added when
   local image inserts needed to reach collaborators too. A `meta` map
   (`Y.Map<string>`, holding `name`) is the same pattern a third time.
2. **A `WorkspaceRoom`-stored metadata field with its own sync path** (like
   `access`, comment threads, and version snapshots, which all live in DO
   storage outside Yjs, each with its own HTTP endpoint or message type).

Option 1 wins. It rides the exact wire format and persistence path that
already exists for `ytext`/`imagesMap` — no new `MESSAGE_*` type on the
WebSocket protocol (`client/src/collab.ts`, `src/workspace-room.ts`), no new
DO storage key, no new HTTP endpoint. The server's `handleMessage` treats a
Y.Doc update as an opaque blob regardless of which top-level type inside it
changed, so `WorkspaceRoom` needs zero changes to broadcast, persist, or
snapshot-exclude the name correctly — it already does all three for the
whole Y.Doc.

## Design decision: role gating

Comments allow reviewer+editor; content edits are editor-only (`isWrite &&
session.role !== "editor"` in `WorkspaceRoom.handleMessage`). A document's
name is closer to document *identity/structure* than to an annotation, so
renaming is gated the same as content: **editor-only**. This is also the
only option that requires no new server code — because the name lives in
the same Y.Doc as content, the server's existing write gate already covers
it for free. (A per-field write permission within one Y.Doc update — so a
reviewer could rename but not edit text — would need to inspect the update's
structural op targets, which Yjs doesn't offer cleanly; not worth it for a
field nobody asked reviewers to control.)

## Non-goals (deferred)

- **No conflict-resolution UI for concurrent renames.** Y.Map is
  last-writer-wins per key with Yjs's usual causal ordering — good enough;
  no new UI beyond what already exists for concurrent text edits.
- **No rename history / version tracking.** Version History (snapshots)
  continues to track `content`/`images` only; a rename is not a "version"
  to restore, and restoring a version must not revert the name (it doesn't
  — `handleVersionRestoreRequest`'s transaction only touches `text` and the
  `images` map, never `meta`).
- **No changes to the legacy single-document `CollabRoom`.** Every document
  reaching this feature has already been migrated onto `WorkspaceRoom`
  (`migrateLegacyDoc` runs before any live sync attaches, see
  `handleDocChanged` in `collab.ts`) — `CollabRoom` needs no equivalent.

## Client wiring

`DocBinding` (`client/src/collab.ts`) gains a third top-level type,
`metaMap: Y.Map<string>` (`ydoc.getMap("meta")`), alongside `ytext`/
`imagesMap`.

**Seeding on first share.** `seedDocBindingFromEditor` (called when a
document is shared for the first time) already seeds `ytext`/`imagesMap`
from the local doc's current state — it now also seeds
`metaMap.set("name", doc.name || "Untitled")` in the same transaction.

**Local rename → shared doc.** A new `MDEBridge` hook,
`onDocRenamed(id, name)`, mirrors the existing `onImageAdded` pattern
exactly: `app.ts`'s docTitle `input` handler calls it after every keystroke
commits a rename (same handler `RenameCollisionModal.svelte`'s
Replace/Save-as/Cancel actions already re-dispatch through), and
`collab.ts` sets it in `init()` to push the name into the bound document's
`metaMap` if one exists — a no-op if the document isn't shared or isn't the
currently-bound doc.

**Remote rename → UI.** `metaMap.observe(...)` mirrors `imagesMap`'s own
observer: a change with `tr.origin !== "local"` and the active document
calls a new bridge method, `setDocName(id, name)` (mirroring
`setDocImage`); a change on a document that isn't currently open marks it
dirty for the existing background-flush path
(`flushDirtyBackgroundDocs`/`markDirty`), same as background content/image
changes. `setDocName` (implemented in `app.ts`, alongside `setDocImage`)
updates `docsStore`, persists, and — only if the renamed document is the
active one — updates the `#docTitle` input value, resizes it, and updates
the page title.

**Uniqueness.** The app enforces globally-unique document names (wikilink
resolution depends on it). A collaborator's rename could collide with an
unrelated *local* document that collaborator has never heard of — both
`setDocName` (active doc) and `syncRemoteDocContent`'s new `name` parameter
(background docs, in `stores/docs.ts`) re-run the same
`ensureUniqueName`/silent-`-2`-suffix rule `importRemoteDocs` already uses
for exactly this reason, rather than trusting the incoming name as-is.

**Join preview.** `fetchRemoteDocContent` (the throwaway sync handshake used
to preview a workspace's documents before joining) read only
`scratchDoc.getText("content")` and hardcoded `name: "Shared document"` for
every entry — it now also reads `scratchDoc.getMap<string>("meta").get("name")`
after the sync handshake completes, falling back to the same placeholder
only if the field is genuinely absent (a workspace shared before this
feature shipped).

## Testing

- `tests/client/src/stores/docs.test.ts`: `syncRemoteDocContent`'s new
  `name` parameter — writes a changed name and bumps `updatedAt`; no-ops on
  an unchanged name; silently suffixes a name that collides with another
  local document.
- `tests/client/src/collab.test.ts`: sharing a document for the first time
  (via the already-exported `setAccessMode`) seeds its current name into
  the Y.Doc's `meta` map; a remote `meta` change on the active document
  calls `MDE.setDocName`. (The local-rename-push direction,
  `onDocRenamed`, is wired inside `collab.ts`'s `init()`, which — like the
  existing `onImageAdded` wiring — never runs in this test environment,
  since jsdom's `DOMContentLoaded` has already fired before the module
  loads; this matches the test suite's existing coverage boundary for that
  entry point.)
- No server-side test changes needed: `WorkspaceRoom`'s sync/broadcast/
  persist/write-gate logic is untouched, and its existing Y.Doc-level tests
  already cover it generically.
