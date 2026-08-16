# Open Existing Repo as New Workspace — Design Spec

Small, self-contained enhancement to the just-shipped GitHub Repo Sync
feature (v1.22.0). Not part of the workspace-pivot's numbered
sub-projects — a UX gap found after shipping, not new infrastructure.

## Problem

GitHub Repo Sync only supports linking an *already-existing* local
workspace to a repo (File > GitHub Repo > Link Workspace to Repo...).
To actually open an existing repo's notes as a new workspace today, a
user has to: create a blank workspace by hand, switch to it, open the
Link modal, pick the repo, then separately trigger a Pull. Four steps
for what should be one — "open this repo."

## Behavior

File > Open gains a new entry, **"From GitHub Repo..."**, next to the
existing "From GitHub Gist...". It opens a new modal offering the same
repo-selection UI as the existing Link modal (pick from your repos,
paste `owner/repo`, or create a new repo) — but picking a repo here
creates and opens a new workspace instead of linking whichever workspace
happens to be active.

On picking a repo (`owner`, `repo`, `branch`):

1. **Duplicate check** — if any existing local workspace already has a
   `repoLink` matching this exact `owner`/`repo`/`branch`, switch to
   that workspace instead of creating a new one. Two local workspaces
   both pointed at the same remote repo would fight each other on
   push/pull (each tracking its own, inconsistent `repoSha` per doc),
   so this case is a switch, never a duplicate create.
2. **Otherwise, create and populate a new workspace:**
   - Create a new workspace named after the repo itself (e.g. a repo
     named `notes` becomes a workspace named `notes`), deduplicated
     against existing workspace names with the same
     `nextAvailableName()` primitive `stores/docs.ts` already uses for
     document names.
   - Set that workspace's `repoLink` to the picked `owner`/`repo`/`branch`.
   - Switch the active workspace to it.
   - Immediately pull — every `.md` file in the repo becomes a doc,
     right away. This matches "Open" semantics elsewhere in the app
     (opening a Gist shows its content immediately, not just a link to
     it) rather than repo-sync's existing Link-then-separately-Pull
     two-step.
   - Since the workspace is brand new and empty, this pull can never
     hit a conflict (conflicts require a doc with local edits since its
     last sync, and nothing here has ever synced before) — no conflict
     modal is reachable on this path, only the plain creates.

## Components

- **New: `client/src/components/RepoPicker.svelte`** — the repo
  list/manual-paste/create-new-repo UI, extracted out of the existing
  `RepoLinkModal.svelte` verbatim (list your repos via `/api/repo/list`,
  paste `owner/repo`, or create via `/api/repo/create`). Takes a single
  callback prop, `onPick(owner: string, repo: string, branch: string):
  void`, and otherwise owns its own loading/busy state exactly as
  `RepoLinkModal` does today. `RepoLinkModal` and the new `OpenRepoModal`
  both render it; neither duplicates its fetch/list/create logic.
- **Modified: `client/src/components/RepoLinkModal.svelte`** — becomes a
  thin wrapper: renders `RepoPicker` inside the existing `Modal`, with
  `onPick` set to today's "link the active workspace" behavior
  (`setWorkspaceRepoLink` on `activeWorkspaceIdStore`). No behavior
  change for existing callers of this modal.
- **New: `client/src/components/OpenRepoModal.svelte`** — renders
  `RepoPicker` inside its own `Modal`, with `onPick` set to the
  duplicate-check-then-create-and-pull flow above.
- **New: `client/src/stores/repoSync.ts` addition** —
  `openRepoModalOpen: Writable<boolean>`, mirroring `repoLinkModalOpen`.
- **Modified: `client/src/repo-sync-ui.ts`** — new
  `window.MDE.openRepoModal` bridge method (mirrors
  `openRepoLinkModal`), gated behind the same `requireRepoScope()` check
  already used for every other repo-sync action.
- **Modified: `client/src/repo-sync.ts`** — new exported function,
  `createWorkspaceFromRepo(owner: string, repo: string, branch: string):
  Promise<void>`, implementing the duplicate-check/create/link/pull
  sequence. Reuses `pullFromRepo` (already exported) for the actual pull
  once the new workspace and its `repoLink` exist.
- **Modified: `client/src/components/MenuBar.svelte`** — new "From
  GitHub Repo..." button in the File > Open submenu, next to "From
  GitHub Gist...".
- **Modified: `client/index.html` / `client/src/main.ts`** — new mount
  point for `OpenRepoModal`, same pattern as every other modal.

## Error Handling

- Missing/insufficient OAuth scope: same `requireRepoScope()` gate as
  every other repo-sync action — re-auth prompt, not a raw API error.
- Pull failure after workspace creation (network error, repo
  deleted/renamed between picking and pulling): the workspace and its
  `repoLink` already exist at that point, so this fails the same way an
  ordinary manual Pull failure does today (`showToast` with the error) —
  the user ends up on a newly created, linked-but-empty workspace and
  can retry Pull from the File menu. Not rolled back: a linked empty
  workspace is a safe, recoverable state, not a corrupted one.

## Testing

- Unit tests for `createWorkspaceFromRepo`'s duplicate-detection logic
  (existing workspace with matching `repoLink` → switches, doesn't
  create) and its name-deduplication (repo name already taken by
  another workspace → suffixed).
- Manual verification in-browser: File > Open > From GitHub Repo...
  opens the picker; picking a repo with no existing link creates a
  new, named-after-the-repo workspace with content already pulled in;
  picking a repo that's already linked elsewhere switches to that
  workspace instead of creating a duplicate.
