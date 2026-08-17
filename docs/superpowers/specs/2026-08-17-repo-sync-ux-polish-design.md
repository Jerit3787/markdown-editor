# Repo-Sync UX Polish — Design Spec

**TODO items 6, 15, 18, 20.** Four small, independent improvements/bugs in
the same functional area (repo linking and its surrounding UI), bundled
into one spec since each is small on its own. Root causes for 15 and 20
confirmed via `superpowers:systematic-debugging`; 6 and 18 are new
behavior, designed directly.

## Goal

Linking a workspace to a repo picks up a sensible name automatically when
the workspace hasn't been named yet; picking a repo to open closes its
modal immediately instead of sitting on top of the progress toast; the
GitHub Repo submenu shows how long it's been since the workspace last
synced; and every dropdown in the app gets consistent, themed styling
instead of some rendering as bare unstyled `<select>` elements.

## Behavior

### 1. Auto-rename a still-default-named workspace on link (item 6)

`linkWorkspaceAndSync` (`client/src/repo-sync.ts`) checks the workspace's
current name as its first step. If it's still exactly `"New workspace"`
— the literal default both workspace-creation entry points
(`WorkspaceSwitcher.svelte`'s `startCreate`, the empty state's `New
workspace` button) use before the user renames it — it's renamed to the
repo's bare name, deduped against other workspace names the same way
`createWorkspaceFromRepo`'s `planCreateWorkspaceFromRepo` already does
(via `nextAvailableName`, from `./doc-naming`). Any other name (the user
already customized it) is left untouched. This only affects linking an
*existing* workspace — a workspace created via "Open GitHub Repo as
Workspace" is already named after the repo by the time it exists.

### 2. Close the picker modal immediately, not after the pull (item 15)

Both `OpenRepoModal.svelte`'s `pickRepo` and `RepoLinkModal.svelte`'s
`linkWorkspace` currently await their entire operation
(`createWorkspaceFromRepo` / `linkWorkspaceAndSync`) before calling
`close()` — the modal stays open the whole time, its own busy-button
state competing with the separate global progress toast for attention.
Both move `close()` to run immediately once the user has picked a repo,
before the `await`. `RepoLinkModal.svelte`'s existing conflict-modal
logic (opening `repoConflictModalOpen` after the operation resolves)
still works correctly once `close()` has already run — the two modals
aren't shown at the same time regardless of ordering, since
`close()` only ever hides `RepoLinkModal` itself.

### 3. Show time since last sync (item 18)

`Workspace` (`client/src/types.ts`) gains `repoLastSyncedAt?: number`.
`stores/workspaces.ts` gains `setWorkspaceLastSynced(id: string,
timestamp: number): void`, and `clearWorkspaceRepoLink` additionally
clears this field (meaningless without a link). `repo-sync.ts`'s
`pushToRepo` and `pullFromRepo` both call
`setWorkspaceLastSynced(workspaceId, Date.now())` right before returning
on success — unconditionally, even when there was nothing to actually
push or pull, since a no-op sync still means "checked, up to date."
`MenuBar.svelte`'s GitHub Repo submenu shows it as a small relative-time
label (reusing the existing `formatRelativeTime` from `./relative-time`)
directly under the `owner/repo` section label, above the Pull/Push
buttons.

### 4. Consistent dropdown styling (item 20)

`JoinWorkspaceModal.svelte`'s merge-target `<select>` and
`RepoConflictModal.svelte`'s per-conflict resolution `<select>` are both
bare, unclassed native selects — the only form-control baseline rule in
`style.css` (`.modal-field input { ... }`) is scoped to `input`, and
neither select is wrapped in a `.modal-field`. One new generic rule in
`style.css`, targeting any plain `<select>` except the two Share-specific
classes that already have bespoke styling, fixes both at once with no
markup changes at either call site.

## Non-goals (deferred)

- **Retroactively renaming workspaces already linked before this ships.**
  The auto-rename only runs as part of `linkWorkspaceAndSync`'s own flow
  — an already-linked workspace's name is untouched regardless of what
  it's currently named.
- **Separate last-pushed vs. last-pulled timestamps.** One combined
  `repoLastSyncedAt`, updated by either operation — matches how most git
  UIs show a single "last synced" state rather than two independent
  clocks.
- **A "syncing…" live-updating countdown or auto-refresh of the relative
  time label.** It renders once per Svelte reactivity pass (workspace
  store update, submenu open) like every other relative-time display in
  this app (`DocList`, `CommandPalette`, `DocInfoPanel`) — no new
  polling/interval infrastructure.

## Error handling

`setWorkspaceLastSynced` is a plain store update — no new failure modes.
It's only ever called after `pushToRepo`/`pullFromRepo` have already
succeeded (past any `throw`), so a failed sync never updates the
timestamp, correctly leaving the last *successful* sync time in place.
The item 6 rename check is a simple string comparison with no failure
mode.

## Testing

- `stores/workspaces.test.ts`: `setWorkspaceLastSynced` sets the field on
  the matching workspace, leaves others untouched (mirrors the existing
  `setWorkspaceRepoLink` test's pattern); `clearWorkspaceRepoLink` also
  clears `repoLastSyncedAt`.
- `repo-sync.test.ts`: a new `linkWorkspaceAndSync` test confirms a
  workspace named exactly `"New workspace"` gets renamed to the repo's
  name after linking; a new test confirms a custom-named workspace's name
  is untouched. `pushToRepo`/`pullFromRepo`'s existing
  `linkWorkspaceAndSync`-driven tests gain an assertion that
  `repoLastSyncedAt` is set after a successful sync.
- No automated coverage for `OpenRepoModal.svelte`/`RepoLinkModal.svelte`'s
  close-timing change or the CSS styling change — matches this
  codebase's established precedent (no Svelte component tests, no visual
  regression tests). Manual verification: pick a repo to open and confirm
  the modal closes immediately (progress toast is the only thing left on
  screen); link an existing default-named workspace to a repo and confirm
  its name changes to the repo's name in the sidebar; link an
  already-custom-named workspace and confirm its name is unchanged; after
  a push or pull, open File > GitHub Repo and confirm a relative-time
  label appears under the repo name; open the merge-workspace dropdown
  (via a shared-link join with an existing workspace present) and the
  repo-conflict resolution dropdown and confirm both are visually
  consistent with the rest of the app's inputs.
