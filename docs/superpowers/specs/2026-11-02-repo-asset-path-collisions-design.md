# Repo sync: per-path asset and history files — design

**Date:** 2026-11-02
**Status:** Approved for implementation (follow-up to the bug-hunt batch)

## Goal

Two documents in one linked repo that share a basename (`notes.md` and
`docs/notes.md`) must never share, overwrite, or delete each other's
embedded images or local-history companion files.

## Non-goals

- Changing the `assets/` or `.mde/` namespaces, or where repo-linked docs
  live.
- Reworking Gist image publishing (separate code path).
- Renaming documents or repo files as part of this change.
- Cleaning up pre-existing corruption in repos that already pushed two
  same-basename docs (the first push after this change rewrites refs and
  sweeps the now-dead legacy folder where it is safe to do so).

## Problem

Both asset and history paths are derived from `slugFromRepoPath()` =
basename minus `.md`:

- images → `assets/<slug>/<ref>`
- history → `.mde/history/<slug>.json`

With `notes.md` and `docs/notes.md` both mapping to slug `notes`:

1. Push writes both docs' images into `assets/notes/`; an identical ref
   key (`pic.png`) clobbers the other doc's bytes.
2. Push writes both docs' history arrays into `.mde/history/notes.json`;
   the second push replaces the first's snapshots/notes.
3. Pull resolves both docs' refs against `assets/notes/`, so the clobbered
   file is what both docs receive.
4. The orphan sweep is deliberately keyed by slug across every doc, so it
   does not delete the other doc's assets — but that only avoids deletion,
   not the collision.

## Design

### Path-derived folders

The folder for a doc is its full repo path minus the `.md` extension:

```
assetFolderFor("notes.md")       === "notes"        // unchanged for root docs
assetFolderFor("docs/notes.md")  === "docs/notes"   // new
historyPathFor("docs/notes.md")  === ".mde/history/docs/notes.json"
```

Root-level docs keep exactly their old paths, so the common case produces
no churn. Nested docs migrate to nested folders on their next push (the
markdown refs are rewritten by the push itself, so the migration is
self-healing).

### Pull compatibility

`resolveImagesFromPull(content, assetFolder, blobs, legacyFolder?)`
resolves refs under both the new prefix (`assets/docs/notes/`) and, when it
differs, the legacy prefix (`assets/notes/`). A repo that hasn't been
pushed since the upgrade therefore keeps rendering its images, and the next
push rewrites them to the new prefix.

`fetchAndMergeRepoHistory(doc)` fetches the new history path, and falls
back to the legacy `.mde/history/<basename>.json` when the new one 404s.
Repeated fetches stay cached per doc as before.

### Sweeps

All sweep logic becomes path-based instead of basename-based:

- **Live ownership:** every doc's `repoPath` maps to exactly one asset
  folder and one history file. `liveAssetFolders` / claimed history paths
  cover every live doc, changed or not.
- **Orphan sweep (still-linked docs):** unchanged in spirit — blobs under a
  live doc's asset folder that the doc no longer references are deleted.
- **Dead-folder sweep (repo owned by this workspace only):** an `assets/…`
  path is dead when (a) no live doc owns its folder and (b) the tree has no
  markdown file at the path its folder maps to. This also retires a legacy
  `assets/notes/` folder after a nested `docs/notes.md` migration — unless
  a root `notes.md` still exists, in which case the folder belongs to it.
- **Deleted/renamed docs:** their old asset folder and history file are
  deleted when no live doc and no tree doc claims them (the rename's new
  paths were already written in the same push).
- **Dead history files:** `.mde/history/<path>.json` maps to `<path>.md`;
  delete it on a workspace-owned repo when neither a live doc nor the tree
  claims that markdown path. Legacy root-level files retire the same way.

Everything destructive stays gated on `sameWorkspace` (or on a path this
push itself vacated), matching the existing "never delete content we can't
prove is ours" rule.

## Error handling

- A failed legacy history fetch is a normal 404 path — no toast.
- Pull keeps unknown refs untouched (existing behavior).
- If a doc's history file exists at both the new and legacy paths, merge
  both (the merge is a union by snapshot id; notes merge by id).

## Testing

- `rewriteImagesForPush` writes to the path-derived folder; two docs with
  the same basename get different asset paths for the same ref key.
- `resolveImagesFromPull` resolves both new and legacy prefixes.
- `planPush` (unit): same-basename docs produce distinct asset/history
  paths; the legacy folder is swept after migration; a live root doc keeps
  its legacy folder.
- `historyPathFor` covers root and nested paths.
- `fetchAndMergeRepoHistory` falls back to the legacy path.
- Fake-backend integration: push two same-basename docs that both embed an
  image named `pic.png`; both blobs exist with their own bytes.

## Deferred

- Deduplicating identical images across docs.
- Migrating a repo's history files eagerly at link time.
