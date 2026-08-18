# Portable Local History & Notes for Repo-Linked Documents — Design

## Problem

For a repo-linked (not shared) document, two kinds of per-document data
exist only in this browser's local storage and never travel with the
repo:

- **Version history snapshots** (`history.ts`, IndexedDB) — the
  autosave history shown in Version History's "local" entries.
- **Personal notes** (`doc.notes`, part of the `Doc` object in
  `localStorage`) — the annotations shown in the Comments panel for a
  document that has never been shared.

Pulling the same repo on a second device (or after clearing local
storage) shows neither: only the file content and, since the
"Version History Meets Repo Commits" feature, the repo's own git
commits. The snapshots and notes captured between commits are lost.

## Goals

- Make local snapshots and notes for a repo-linked doc available on any
  device that pulls the repo.
- No new commits: this data rides along in the same commit a normal
  push already creates.
- No slowdown to pull: this data is fetched lazily, not eagerly walked
  during every pull.
- Never lose a device's own not-yet-synced local data on pull.

## Non-goals

- **Not a full two-way sync with deletion tracking.** Merging is
  additive/union-only, deduped by id. Deleting a note or letting a
  snapshot age out of the cap on one device does not propagate as a
  deletion to another device — a note deleted locally can reappear via
  merge from a device (or the repo) that still has it. This mirrors the
  simple, best-effort nature `history.ts` and `doc.notes` already have
  today; a real delete-tombstone system is out of scope.
- **Not for shared workspaces.** Shared docs' version history already
  lives server-side in the Durable Object (portable already), and
  shared docs use full `CommentThread`s via `comments.ts`, not
  `doc.notes`. This feature only applies where `doc.repoPath` is set
  and the workspace is not shared.
- Does not change what Version History or the Comments panel display
  today beyond adding these previously-invisible entries — no UI
  redesign.

## Data Format

One new companion file per repo-linked doc, alongside its content and
`assets/<slug>/` folder:

```
.mde/history/<slug>.json
```

`<slug>` is `slugFromRepoPath(doc.repoPath)` — the same slug convention
`assets/<slug>/...` already uses, so renames keep both in sync (see
Cleanup below).

```json
{
  "snapshots": [
    { "id": "...", "timestamp": 1755500000000, "content": "...", "images": { "img-1": "data:image/png;base64,..." } }
  ],
  "notes": [
    { "id": "...", "from": 0, "to": 10, "quote": "...", "orphaned": false, "body": "...", "createdAt": 1755500000000 }
  ]
}
```

`snapshots` entries are exactly `history.ts`'s existing `Snapshot`
shape; `notes` entries are exactly `types.ts`'s existing `Note` shape.
No new types — this file is just a container for data that already
exists in-memory/in IndexedDB today. `snapshots` stays capped at 50,
the same `MAX_SNAPSHOTS` limit `history.ts` already enforces locally.

## Push Flow

Extends `planPush` (`client/src/repo-sync.ts`). Today, a doc is skipped
entirely (`continue`) when its git blob sha matches the tree's current
sha at its path — i.e. "content" and "does this doc need pushing at
all" are the same check. This change decouples them: a doc's companion
history file can need pushing even when its markdown content doesn't
(e.g. a note was added with no content edit since the last push).

For every doc in the loop (not just ones whose content changed):

1. Read its local snapshots (`history.ts`'s `getHistory`, newly
   exported) and its `doc.notes`.
2. Build the companion JSON (empty `snapshots`/`notes` arrays are
   skipped entirely — a doc with no local history yet gets no
   companion file, not an empty one).
3. Compute its git blob sha (reusing the existing `gitBlobSha` helper)
   and compare against `treeShaByPath.get(historyPath)` — the same
   tree already fetched for content diffing, since `treeShaByPath` is
   built from all blob entries, not just `.md` ones.
4. If it differs (including "doesn't exist yet"), queue it.

`PushPlan` gets a new field, independent of `changes`:

```ts
historyChanges: { docId: string; historyPath: string; content: string }[];
```

`pushToRepo`'s `sendChanges` pushes these paths into the same `blobs`
array it already builds for content and image assets — one commit,
same as today.

## Pull / Fetch Flow

Not part of `pullFromRepo`/`fetchAndApply` — pulling stays exactly as
fast as it is today. Instead, fetched lazily and once per doc per
session, the first time either panel that would show this data opens
for that doc:

- **Version History** (`VersionHistory.svelte`'s `loadVersions`): when
  the active doc is repo-linked and not shared.
- **Comments panel** (`CommentsPanel.svelte`'s `loadEntries`): same
  condition, in the existing not-shared branch.

This mirrors the existing convention `fetchCommitImages` already
established for repo-commit images in the diff view: fetch on demand,
not eagerly. A small in-memory `Set<docId>` (module-level in each
component, cleared on reload) tracks which docs have already been
fetched this session, so reopening a panel doesn't refetch every time.

On a successful fetch:

- **Snapshots**: merge into local IndexedDB via a new `history.ts`
  function `mergeSnapshotsFromRepo(docId, remoteSnapshots)` — union
  with the existing local list by `id`, sort by `timestamp`, keep the
  newest 50, write back with `putHistory`. Version History's existing
  `listVersions`/`getVersionContent` calls then see the merged set
  with no further changes needed there.
- **Notes**: merge into `doc.notes` via a new `stores/docs.ts` function
  `mergeDocNotes(docId, remoteNotes)` — union by `id`, added notes
  appended, existing ones left alone, persisted the same way
  `addDocNote` already persists.

A 404 (no companion file yet — this doc has never had local-only data
pushed) is a normal empty state, not an error.

## Cleanup (Rename / Delete)

`planPush` already detects doc renames (moves the file, deletes the
old path) and `Workspace.pendingRepoDeletions` already queues deletes
for locally-removed docs. The companion file's path is derived from
the same slug as the content path and the assets folder, so it's added
to the same `renameOldPaths`/`pendingRepoDeletions` deletion checks
already in `planPush` — not a separate mechanism. A rename that moves
`old-name.md` → `new-name.md` also deletes `.mde/history/old-name.json`
and (on the next push, once local data exists there) creates
`.mde/history/new-name.json`.

## Error Handling

- IndexedDB unavailable/over quota during push's snapshot read: caught
  and treated as "no snapshots to push" — matches `maybeSnapshotVersion`'s
  existing best-effort try/catch philosophy. A push must never fail
  because local history couldn't be read.
- Fetch failure (network error, non-200) on the lazy pull side: treated
  as "nothing to merge," silently — same as `listSharedVersions`'s
  existing try/catch-empty-fallback pattern. Never blocks the panel
  from showing whatever local data already exists.

## Testing

- `repo-sync.test.ts`: `planPush` produces `historyChanges` entries
  when local snapshots/notes exist and differ from the tree; skips
  when unchanged; includes the companion path in rename/delete
  detection.
- `history.test.ts`: `mergeSnapshotsFromRepo` unions/dedupes by id,
  re-sorts, re-caps at 50.
- `docs.test.ts`: `mergeDocNotes` unions/dedupes by id.
- Live verification (browser, stubbed fetch, same pattern used
  throughout this session): seed a repo-linked doc, stub the companion
  file's contents endpoint, open Version History and the Comments
  panel, confirm merged entries appear; push, confirm the companion
  blob appears in the request payload.
