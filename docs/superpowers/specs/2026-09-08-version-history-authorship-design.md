# Version History Authorship — Design Spec

## Goal

Version History for a **shared** document should show *who* edited each
version — a name + colour-coded avatar per row, and the union of editors
on a collapsed session — the way Google Docs' version list does. Today
every shared snapshot row shows only a timestamp; there is no way to tell
which collaborator's work a given version represents.

## Non-goals / deferred scope

- **No author-coloured diff.** The Diff view keeps showing added/removed
  lines without per-line attribution. That needs the server to record
  authorship per text *range* inside each snapshot (not just a name set)
  and is its own future spec.
- **No live per-line blame** in the editor.
- **No "name this version" / manual named versions.** Separate feature.
- **Local (never-shared) documents are unchanged.** Their history is
  single-author by definition; `VersionSummary` for `listVersions` and the
  IndexedDB store keep their current shape.
- **No back-fill.** Snapshots captured before this ships (and snapshots
  migrated in from a legacy `CollabRoom`) have no author data; the UI
  renders them with no avatar rather than guessing.
- **No change to snapshot cadence, pruning, the 300-cap, session
  grouping, or restore semantics.**

## Current behaviour

- `WorkspaceRoom.handleDocUpdate(docId, docRoom, update, origin)` is
  called for every Y.Doc update. `origin` is the editing client's
  `WebSocket`; `this.sessions.get(origin)` yields `{ username, role }`.
  It calls `void this.maybeSnapshot(docId, docRoom)` (unless
  `origin === "restore"`).
- `maybeSnapshot` throttles to one capture per 30 s. A captured
  `Snapshot` is `{ id, timestamp, content, images? }`
  (`src/workspace-room.ts:47`). So one snapshot covers ~30 s of edits,
  possibly from several people.
- `forceSnapshot` is used on restore (captures the just-restored content).
- `handleVersionsListRequest` returns `{ id, timestamp }[]`, newest-first.
- Client: `listSharedVersions` → `VersionSummary { id, timestamp }` →
  `VersionHistory.svelte` maps to `LocalEntry { kind, id, timestamp }`,
  groups via `groupSnapshotsIntoSessions` into `SessionEntry`, renders
  `formatTimestamp(entry.timestamp)` per row. `CommitEntry` already
  carries and shows an `author` string — the precedent for an author on a
  row.

## Design

### Data model

**`Snapshot`** (`src/workspace-room.ts`) gains one optional field:

```ts
export interface Snapshot {
  id: string;
  timestamp: number;
  content: string;
  images?: Record<string, string>;
  authors?: string[]; // GitHub usernames who edited in this snapshot's window, first-seen order. Absent on pre-feature / migrated snapshots.
}
```

**`DocRoom`** (`src/workspace-room.ts:95`) gains a scratch accumulator,
reset each time a snapshot is taken:

```ts
export interface DocRoom {
  // ...existing...
  pendingAuthors: Set<string>; // usernames who have edited since the last snapshot capture
}
```

Initialised to `new Set()` alongside `snapshots: []` / `lastSnapshotAt`.

### Server flow

1. **`handleDocUpdate`** — after the existing `origin === "storage"`
   early-return and before `maybeSnapshot`, record the editor:

   ```ts
   const editor = this.sessions.get(origin as WebSocket);
   if (editor?.username) docRoom.pendingAuthors.add(editor.username);
   ```

   (`origin` is `"restore"` for a restore — a `string`, not in
   `this.sessions` — so `editor` is `undefined` and nothing is recorded,
   which is correct: a restore's author is set explicitly in step 3.)

2. **`maybeSnapshot`** — when it actually pushes a snapshot:

   ```ts
   const authors = [...docRoom.pendingAuthors];
   snapshots.push({ id: uid(), timestamp: now, content, images: this.imagesFromDoc(docRoom), authors: authors.length ? authors : undefined });
   docRoom.pendingAuthors.clear();
   ```

   Every early-return path in `maybeSnapshot` (`< 30 s`,
   `last.content === content`) leaves `pendingAuthors` untouched, so
   contributions carry into the next real capture. The one subtlety: the
   `last.content === content` branch sets `lastSnapshotAt` and returns
   without capturing — `pendingAuthors` correctly stays, since no snapshot
   representing that work exists yet.

3. **`forceSnapshot`** — takes a new `author?: string` parameter and
   stores `authors: author ? [author] : undefined`. Its one caller,
   `handleVersionRestoreContentRequest` (and the plain
   `handleVersionRestoreRequest`), passes `auth.username ?? undefined` —
   the person performing the restore. `pendingAuthors` is **also cleared**
   here (a restore is a clean cut-point).

4. **`handleVersionsListRequest`** — include authors:

   ```ts
   const list = snapshots.map((s) => ({ id: s.id, timestamp: s.timestamp, authors: s.authors ?? [] })).reverse();
   ```

5. **`handleInternalSeedRequest`** (legacy migration) — migrated
   `body.snapshots` are stored as-is; they have no `authors`, and the list
   endpoint's `?? []` handles that. `pendingAuthors` for a freshly-seeded
   `DocRoom` starts empty via `loadDocRoom`. No change needed beyond the
   `DocRoom` initialiser.

6. **`persistAllNow` / DO hibernation** — `pendingAuthors` is in-memory
   only. If the DO evicts between an edit and the next snapshot, those
   usernames are lost and the eventual snapshot simply has fewer (or no)
   authors. Acceptable — matches how `lastSnapshotAt` already behaves
   across eviction, and no correctness issue.

### Client flow

**`VersionSummary`** (`client/src/history.ts:26`) gains `authors: string[]`
(always an array from the endpoint). `listSharedVersions` passes it
through unchanged.

**`VersionHistory.svelte`:**

- `LocalEntry` gains `authors: string[]`.
- `SessionEntry` gains `authors: string[]` — the de-duped union of its
  nested entries' authors, in first-seen order, computed where
  `groupSnapshotsIntoSessions` results are mapped to `SessionEntry`
  (`~line 296`).
- A small `{#snippet authorAvatars(names: string[])}` renders up to ~3
  `.presence-avatar` circles (reusing the existing class +
  `colorForUsername` from `../collab`, already imported for the roster
  elsewhere — import it here) with a `title`/`aria-label` of the full
  comma-joined list, and a `+N` overflow chip. Rendered inline in the row
  label area of both a standalone `LocalEntry` row and a `SessionEntry`
  header row (`~lines 423`, `450`), after `formatTimestamp(...)`.
- Nested rows inside an expanded session (`~line 437`) also get the
  avatars for their own entry.
- A `LocalEntry` with an empty `authors` array renders no avatar (the
  pre-feature / migrated case) — the row is just the timestamp, exactly
  as today.

**`listVersions`** (local, non-shared) is untouched; its `VersionSummary`
objects get `authors: []` at the `.map` in `VersionHistory.svelte`'s
`loadVersions` so the two branches produce the same `LocalEntry` shape.

### Styling

Reuse `.presence-avatar` (already themed, used by the Share roster and
the topbar presence bar). Add a `.version-history-authors` flex wrapper
and a `.version-history-author-more` chip token in
`client/src/styles/` next to the existing version-history rules. No new
colours — `colorForUsername` is the single source.

## Testing

### Server — `tests/src/workspace-room.test.ts`

- `handleDocUpdate` from two different sessions within one 30 s window →
  `maybeSnapshot` → the snapshot's `authors` is `["alice", "bob"]`
  (first-seen order), and `docRoom.pendingAuthors` is cleared afterward.
- An edit whose session has `username: null` (anonymous) contributes
  nothing to `authors`.
- `< 30 s` re-entry: authors from the skipped call still land on the next
  real capture.
- `forceSnapshot(docId, docRoom, content, now, "carol")` → `authors:
  ["carol"]`; a restore via `handleVersionRestoreContentRequest` records
  the requester.
- `handleVersionsListRequest` returns `authors: []` for a legacy snapshot
  with no `authors` field, and the real array otherwise.

### Component — `tests/client/src/components/VersionHistory.test.ts`

- A shared version list with `authors: ["alice", "bob"]` renders two
  `.presence-avatar` in that row; `title` contains both names.
- A `SessionEntry` grouping entries by alice and by bob shows the union
  on its header, once each.
- `authors: []` → no `.presence-avatar` in that row.
- More than 3 distinct authors → 3 avatars + a `+N` chip.

### e2e-collab — extend `tests/e2e/collab/version-history-collab.spec.ts`

VER-17: two signed-in collaborators (`signInAsDevUser`) both edit a shared
doc; the peer opens Version History and a row shows both usernames'
avatars. (Snapshot-cadence caveat from VER-08 applies — assert on the row
that *does* capture, using the same one-atomic-edit-per-author setup.)

## Versioning

User-facing → **minor bump `1.48.0`**, `CHANGELOG.md` `### Added`, a
`whats-new-entries.ts` entry (category `"Version History"`) + a captured
screenshot in `client/public/whats-new/`.

## Catalogue

`docs/TEST-COVERAGE.md` §8: new rows for the server authorship capture
(unit), the avatar rendering (component), and VER-17 (e2e-collab).

## Files touched

| File | Change |
| --- | --- |
| `src/workspace-room.ts` | `Snapshot.authors?`; `DocRoom.pendingAuthors`; record in `handleDocUpdate`; flush in `maybeSnapshot`; `forceSnapshot` author param; list endpoint |
| `src/collab-room.ts` | none (legacy snapshots stay author-less) |
| `client/src/history.ts` | `VersionSummary.authors: string[]` |
| `client/src/components/VersionHistory.svelte` | `LocalEntry`/`SessionEntry` `authors`; union computation; `authorAvatars` snippet; render in rows |
| `client/src/styles/…` | `.version-history-authors` wrapper + overflow chip |
| tests | server unit, component, VER-17 e2e |
| `CHANGELOG.md`, `whats-new-entries.ts`, `client/public/whats-new/…`, `package.json`, `package-lock.json` | 1.48.0 |
