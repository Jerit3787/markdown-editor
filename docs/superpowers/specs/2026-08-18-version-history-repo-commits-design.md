# Version History Repo Commits — Design Spec

**TODO item 8, Phase 2 of 2.** Phase 1 (`docs/superpowers/specs/2026-08-18-repo-commit-diff-design.md`)
added a standalone "Repo info" panel for browsing a linked repo's commit
history and diffing a document's content between two arbitrary commits.
This phase folds that capability into the existing Version History
overlay instead of keeping it separate, and removes the standalone panel
entirely.

## Goal

Version History becomes the single place to see, diff, and restore a
document's history — both local IndexedDB snapshots and (for a
repo-linked document) the repo commits that touched that document's file
— merged into one chronological list. Every entry can be previewed,
diffed against the document's current live content, and restored.

## Behavior

### 1. Merged history list

`VersionHistory.svelte`'s list currently comes from local snapshots only
(`listVersions`/`listSharedVersions`). It gains a second source: for a
document with a `repoPath` whose workspace has a `repoLink`, it also
fetches commits that touched that specific file, via Phase 1's
`handleRepoCommits` endpoint extended with an optional `path` query
param (forwarded to GitHub's own native `?path=` filter on the commits
API — not something Phase 1 needed, since it browsed the whole repo).
Only the first page (30 commits) is fetched — no "Load more" for the
commit portion in this phase; a single file's history realistically
almost never exceeds that (see Non-goals).

Each entry is one of:

```ts
interface LocalEntry {
  kind: "local";
  id: string; // snapshot id
  timestamp: number;
}
interface CommitEntry {
  kind: "commit";
  id: string; // commit sha
  timestamp: number;
  message: string; // first line only, matching Phase 1's firstLine()
  author: string;
  html_url: string;
}
```

Local and commit entries merge into one list sorted by `timestamp`
descending — the same list the UI already renders, just from two
sources now instead of one.

### 2. Selection, preview, and diff

Selecting any entry (local or commit) fetches its content — local via
the existing `getVersionContent`/`getSharedVersionContent`, commit via
Phase 1's `handleRepoFileAtRef` (`GET
/api/repo/:owner/:repo/contents/:path?ref=:sha`, same inline
fetch-and-base64-decode pattern Phase 1 already established, now living
directly in `VersionHistory.svelte` since the panel that used to own it
is being removed).

The right pane gains a "Preview | Diff" toggle:

- **Preview** (existing behavior, unchanged): `renderVersionPreview`
  renders the selected entry's content into the existing preview `div`,
  regardless of whether it's a local snapshot or a commit.
- **Diff** (new): `DiffView.svelte` (from Phase 1, unmodified — it only
  ever took two plain strings) renders the selected entry's content
  against the document's *current live* content, read from the existing
  `activeDocContent` store (already kept in sync with the live editor
  buffer, per `DocInfoPanel.svelte`'s own use of it) — not just the
  newest snapshot, so the diff is accurate even for unsaved-to-snapshot
  edits.

Switching the toggle while an entry is already selected re-renders from
the already-fetched content — no re-fetch.

### 3. Restore

Local entries keep their existing restore paths exactly as they are
today: `restoreLocalVersion` for local-only documents, `restoreSharedVersion`
for shared/collaborative documents (looks up a pre-existing snapshot by
id server-side, applies it through the Yjs doc, propagates via the
normal sync channel).

Restoring a **commit** entry is new, and splits the same way local
restore already does:

- **Local-only document:** the commit's content (already fetched for
  preview/diff) gets dispatched into the editor the same way local
  restore already does (`cm.dispatch({ changes: { from: 0, to:
  cm.state.doc.length, insert: content } })`), then recorded as a new
  local snapshot for undo-safety. `history.ts`'s existing internal
  `appendSnapshot` helper is exposed as a small named wrapper,
  `restoreLocalVersionContent(docId, content)`, rather than exported
  raw — keeping the same "restore is itself undoable" guarantee local
  snapshot restore already has.
- **Shared/collaborative document:** the existing shared-restore
  endpoint (`workspace-room.ts`'s `handleVersionRestoreRequest`) only
  accepts a pre-existing snapshot `versionId` — there's no such id for a
  commit fetched fresh from GitHub. A sibling endpoint, `POST
  /api/workspace/:id/docs/:id/versions/restore-content` with `{content}`
  in the body, does the same `editor`-role check, the same
  `docRoom.doc.transact()` replace, and the same `forceSnapshot()` call
  as the existing handler — just skipping the snapshot lookup since the
  content arrives directly. `history.ts` gains a matching client-side
  `restoreSharedVersionContent(workspaceId, docId, content): Promise<boolean>`,
  mirroring `restoreSharedVersion`'s own shape.

The existing "disable Restore when already current" check (item 19)
extends unchanged: disabled whenever the selected entry is the merged
list's overall most-recent entry (`selectedId === versions[0]?.id`),
regardless of whether that entry is local or a commit.

### 4. Removing the standalone Repo Info panel

`RepoInfoPanel.svelte`, `client/src/stores/repoInfoPanel.ts`, the
`window.MDE.openRepoInfoPanel` bridge function and its `MDEBridge`
declaration, the "Repo info" `MenuBar.svelte` entry, and its mount
point in `index.html`/`main.ts` are all deleted. Whole-repo commit
browsing independent of any single document is no longer available
anywhere in the app after this (confirmed acceptable — see Non-goals).

## Non-goals (deferred)

- **Whole-repo commit browsing**, not scoped to one document. This was
  Phase 1's own scope; it's explicitly given up with the panel's
  removal.
- **"Load more" pagination for the commit portion of the merged list.**
  A single file's commit history realistically almost never exceeds 30
  entries; if it ever does, only the most recent 30 show. Revisit only
  if this turns out to matter in practice.
- **Diffing two arbitrary historical entries against each other**
  (commit-vs-commit, snapshot-vs-snapshot, or commit-vs-snapshot).
  Every diff in this phase is against the document's *current* live
  content only.
- **Deriving document created/modified dates from commit data.** That's
  item 16, still separately deferred, unaffected by this phase.

## Error handling

If a commit's content fails to load (404, network error), `selectVersion`
leaves `selectedContent` undefined and shows a toast
(`showToast("Couldn't load this version's content", "error")`,
matching this app's established pattern) rather than rendering a blank
preview/diff. The Restore button already disables whenever no version
is selected, so an unset `selectedContent` can't be restored.

If the commit-fetch for the merged list itself fails (e.g. the repo
link is stale or GitHub is unreachable), the commit portion is simply
omitted — the list falls back to local-only entries rather than
blocking the whole overlay.

## Testing

- `src/github-repo.test.ts`: `handleRepoCommits` with a `path` argument
  constructs the upstream URL with `&path=` included; without it,
  behaves exactly as today (regression check for Phase 1's existing
  tests).
- `src/workspace-room.test.ts`: the new restore-content endpoint
  returns 401/403 per the same auth/role rules as the existing restore
  endpoint; on success, replaces the Yjs doc's content and returns a
  new snapshot record with the posted content.
- No new Svelte component tests for `VersionHistory.svelte` — matches
  this codebase's established precedent (no Svelte component tests
  anywhere in this app).
- Manual verification: open Version History on a repo-linked, non-shared
  document with real commit history — confirm local snapshots and
  commits interleave correctly by time, each labeled distinctly; select
  a commit, toggle Preview/Diff, confirm both render correctly; restore
  from a commit and confirm the editor updates and a new local snapshot
  is recorded. Repeat restore-from-commit on a shared/collaborative
  document and confirm it propagates to a second connected client.
  Confirm the standalone Repo Info panel and its "Repo info" menu entry
  are gone from File > GitHub Repo.
