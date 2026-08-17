# Link Existing Workspace Pushes + Pulls on Link — Design Spec

**TODO item 3.** Builds on the shipped GitHub Repo Sync (v1.22.0,
`docs/superpowers/specs/2026-08-17-github-repo-sync-design.md`) and
Open-Repo-as-Workspace features. Linking a workspace to a repo today
(`RepoLinkModal.svelte`'s `linkWorkspace()`) only calls
`setWorkspaceRepoLink()` — it saves the link but does nothing with the
workspace's existing documents or the repo's existing content. The user
has to remember to manually click "Push to Repo" (and "Pull from Repo",
if they also want the repo's other content) from the GitHub Repo submenu
afterward.

## Goal

Linking an existing workspace to a repo should immediately reconcile the
two: push the workspace's local documents out, then pull in anything the
repo already has that isn't one of those just-pushed docs. One action,
both directions, no manual follow-up required for the common case.

## Non-goals (deferred)

- **New progress UI.** This reuses the existing `repoSyncBusyLabel` store
  and `showToast` pattern already used by the manual Pull/Push actions.
  A richer progress modal is TODO item 5, a separate piece of work.
- **Merge/dedup logic beyond what already exists.** Path collisions
  between a local doc's assigned slug and an existing repo file are
  handled by the existing `dedupeRepoPath()` — nothing new is introduced
  here.
- **Changes to "Open repo as new workspace"** (`createWorkspaceFromRepo`
  in `repo-sync.ts`). That flow creates an empty workspace and pulls into
  it — there's nothing local to push, so it's unaffected.
- **Automatic resolution of genuine conflicts.** If the repo's tree moves
  between this flow's push and pull steps (e.g. a concurrent external
  push), any resulting conflicts/deletions route through the existing
  shared `repoConflictModal`, unchanged.

## Behavior

### The stale-metadata problem

`clearWorkspaceRepoLink()` (used by "Unlink Repo") only clears
`workspace.repoLink` — it never resets `doc.repoPath`/`repoSha`/
`repoImageShas` on the workspace's documents. If a workspace is later
linked to a *different* repo that happens to have a same-named file, the
push planner would compare the doc's stale SHA (from the old repo)
against the new repo's tree SHA at that path and incorrectly report a
push conflict, even though this is really the first sync to the new repo.

Linking a workspace must always start a clean sync relationship: every
doc's `repoPath`/`repoSha`/`repoImageShas` is cleared as part of the link
action, before anything is pushed or pulled.

### `linkWorkspaceAndSync`

New orchestrator in `client/src/repo-sync.ts`, replacing the direct
`setWorkspaceRepoLink()` call currently made by `RepoLinkModal.svelte`'s
`linkWorkspace()`:

```ts
export async function linkWorkspaceAndSync(
  workspaceId: string,
  repoLink: { owner: string; repo: string; branch: string }
): Promise<void> {
  setWorkspaceRepoLink(workspaceId, repoLink);
  clearRepoSyncMetadata(workspaceId);
  await pushToRepo(workspaceId, repoLink);
  await pullFromRepo(workspaceId, repoLink, new Set());
}
```

Steps:

1. `setWorkspaceRepoLink` — unchanged, existing function.
2. `clearRepoSyncMetadata(workspaceId)` — new function in
   `client/src/stores/docs.ts`. Strips `repoPath`, `repoSha`, and
   `repoImageShas` from every doc in the workspace. Mirrors the shape of
   the existing `removeDocsByRepoPaths`/`setDocRepoLinkById` functions in
   the same file.
3. `pushToRepo(workspaceId, repoLink)` — reused as-is, no changes. Since
   every doc now has no `repoPath` (just cleared in step 2), `planPush`
   treats every doc as new: it assigns each a deduped path
   (`dedupeRepoPath`) and pushes it. A doc with no `repoPath` can never
   produce a push conflict — `planPush` only checks the tree SHA against
   `doc.repoSha` when a `repoPath` is already set — so this step cannot
   fail with a conflict.
4. `pullFromRepo(workspaceId, repoLink, new Set())` — reused as-is. The
   tree fetched here now contains the paths just pushed in step 3, plus
   whatever else already existed in the repo. Docs matching their own
   just-pushed path are unchanged (their `repoSha` was set by step 3's
   push and matches the tree, so `planPull` skips them). Any tree entries
   with no matching local doc become new local docs — this is what pulls
   in the repo's pre-existing content.
5. If `pullFromRepo`'s plan reports conflicts or pending deletions (only
   possible if the tree moved between steps 3 and 4 — e.g. a concurrent
   external push), the caller routes them through the existing shared
   `repoConflictModal`, exactly like the manual "Pull from Repo" action
   does today.

This flow cannot introduce data loss: nothing local is ever deleted or
overwritten by the push step (only newly-assigned paths are written), and
the pull step only creates new docs or applies non-conflicting fast-
forward updates to the docs this same flow just pushed.

### `RepoLinkModal.svelte`

`linkWorkspace()` changes from:

```ts
function linkWorkspace(owner: string, repo: string, branch: string) {
  const workspaceId = $activeWorkspaceIdStore;
  if (!workspaceId) return;
  setWorkspaceRepoLink(workspaceId, { owner, repo, branch });
  close();
  showToast(`Linked to ${owner}/${repo}`, "success");
}
```

to:

```ts
async function linkWorkspace(owner: string, repo: string, branch: string) {
  const workspaceId = $activeWorkspaceIdStore;
  if (!workspaceId) return;
  repoSyncBusyLabel.set("Pushing…");
  try {
    await linkWorkspaceAndSync(workspaceId, { owner, repo, branch });
    close();
    showToast(`Linked to ${owner}/${repo}`, "success");
  } catch (err: any) {
    showToast(err.message || "Couldn't sync after linking", "error");
  } finally {
    repoSyncBusyLabel.set(null);
  }
}
```

`linkWorkspaceAndSync` itself flips `repoSyncBusyLabel` from
`"Pushing…"` to `"Pulling…"` between its push and pull steps (mirroring
how the existing manual Pull/Push menu actions set this same store), so
the GitHub Repo submenu's busy-state label — already wired to
`$repoSyncBusyLabel` — reflects both phases without any new UI.

`RepoPicker`'s `onPick` prop is awaited by the caller already (see the
Open-Repo-as-Workspace work), so its own busy-state UI (disabling the
picked repo's row, showing "Linking…") naturally covers this longer
push+pull duration with no changes needed in `RepoPicker.svelte`.

### Error handling

- If `pushToRepo` throws (network failure, HTTP error): the workspace is
  already linked (step 1 already ran) but nothing was pushed or pulled.
  Error toast shown; the user can retry via the ordinary "Push to Repo"
  menu action once the modal closes — this matches the spec's existing
  "link stays even if a later action fails" behavior for the manual
  actions.
- If `pushToRepo` succeeds but `pullFromRepo` throws: the push already
  landed as real commits. Error toast shown; the user's local docs are
  fully synced to the repo, they've just not yet pulled in the repo's
  other pre-existing content — retried via the ordinary "Pull from Repo"
  menu action.
- Conflicts/deletions surfaced by the pull step: existing
  `repoConflictModal` flow, unchanged.

## Testing

- Unit test for `clearRepoSyncMetadata` in `client/src/stores/docs.test.ts`
  (or wherever `docs.ts`'s other store functions are tested): a doc with
  `repoPath`/`repoSha`/`repoImageShas` set has all three cleared after
  the call; a doc in a different workspace is untouched.
- No fetch-mocked unit test for `linkWorkspaceAndSync` itself — matching
  this codebase's existing convention for this file: `pullFromRepo`,
  `pushToRepo`, and `createWorkspaceFromRepo` (all of which call `fetch`)
  have no dedicated unit tests either; only their pure planners
  (`planPull`, `planPush`, `planCreateWorkspaceFromRepo`) do.
  `linkWorkspaceAndSync` has no new planning logic of its own — it's a
  fixed sequence of already-tested pieces (`setWorkspaceRepoLink`,
  `clearRepoSyncMetadata`, `pushToRepo`, `pullFromRepo`) — so it's covered
  by manual E2E instead, consistent with those existing orchestrators.
- Manual E2E verification: link a workspace with existing docs to a repo
  that itself already has `.md` content, confirm the resulting repo state
  (workspace's docs pushed as new files, existing repo files untouched)
  and the resulting local workspace state (repo's pre-existing files now
  present as new local docs).
