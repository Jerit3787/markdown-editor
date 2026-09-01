# Shared-Document Session Separation — Design Spec

## Goal

Stop an opened shared workspace from corrupting a user's own local
context: (1) a brand-new browser tab should never silently land in a
workspace someone only meant to peek at, and (2) opening a shared link
should not force an immediate, permanent commitment to keeping it.

## Root cause

"Which workspace/document is active" (`mde:activeWorkspace`, `mde:active`
in `localStorage`) is a single value shared by every tab of the app, with
no live cross-tab sync — each tab only reads it once, at page load.
Joining a shared workspace today always writes to that same shared
pointer and always permanently adds the workspace/its documents to
`localStorage`, via `JoinWorkspaceModal.svelte`'s two choices ("merge
into an existing workspace" / "add as new workspace") or `collab.ts`'s
`decideJoinTarget()` auto-adopt fast path. There is no third option to
just look without committing, and no way for the shared workspace's
activation to avoid overwriting the pointer a fresh tab will read.

## Non-goals / deferred scope

- **No general per-tab isolation for local (non-shared) workspaces.**
  Two tabs both showing the user's own real workspaces can still
  influence each other's "last active" pointer on reload, exactly as
  today — that is out of scope. This spec is about *shared* content
  specifically, matching IMPROVEMENTS.md's own framing.
- **No literal separate browser window enforcement.** Considered and
  rejected during brainstorming (see conversation) — `localStorage` is
  shared per-origin regardless of window count, so real isolation is
  only achievable via what this spec already does (skip persisting the
  ephemeral state), not via forcing a new window.
- **No changes to the live collaboration/WebSocket path.**
  `WorkspaceRoom`, `joinWorkspace`, `bindActiveDoc`, presence, and every
  server-side file are untouched — an ephemeral workspace's live sync
  behaves identically to a permanent one. This is purely a client-side
  local-persistence and join-UI concern.
- **No "restore my preview on reload" mechanism.** Reloading (or
  closing) a tab that has an ephemeral workspace active always drops it
  back to the user's last real workspace — revisiting the same share
  link starts a fresh preview. No sessionStorage-based "remember to
  rejoin" behavior.
- **No confirmation prompt when leaving/losing a preview.** Being
  disposable without ceremony is the point.

## Data model

`Workspace` (`client/src/types.ts`) gains one optional field:

```ts
export interface Workspace {
  // ...existing fields...
  // Live in workspacesStore/docsStore normally (renders everywhere:
  // sidebar, switcher, editor) but never written to localStorage —
  // persistWorkspaces()/persistDocs() filter these out at the one
  // choke point each, so no call site has to remember to skip them.
  // Sends the workspace back to being effectively local-only on
  // reload since nothing durable existed to restore it from. Cleared
  // by promoteEphemeralWorkspace(), the one way to make it permanent
  // after the fact.
  ephemeral?: boolean;
}
```

Docs don't get their own `ephemeral` field — a doc's persistence
follows its `workspaceId`'s workspace record.

## `stores/workspaces.ts` changes

- `persistWorkspacesExcluding()` (the shared choke point already used
  by `persistWorkspaces()` and `deleteWorkspaceRecord()`) filters
  `all.filter(w => !w.ephemeral)` before merging/serializing. Every
  persistence path funnels through here already, so this is the single
  place that needs to know about ephemeral workspaces at all.
- `setActiveWorkspaceId()` takes the target workspace's `ephemeral`
  flag into account: it still calls `activeWorkspaceIdStore.set(id)`
  unconditionally (so the live UI reflects it immediately), but skips
  `localStorage.setItem(STORAGE_ACTIVE_WORKSPACE, id)` when the target
  is ephemeral — the persisted "default landing workspace" a fresh tab
  reads on load is left pointing at whatever real workspace was active
  before the preview started. Switching *away* from an ephemeral
  workspace back to a real one persists normally, immediately
  restoring the invariant.
- New `previewSharedWorkspace(remoteId, name)`: identical shape to
  `adoptSharedWorkspace` but sets `ephemeral: true` on the created
  record and does not call `persistWorkspaces()`.
- New `promoteEphemeralWorkspace(id)`: flips `ephemeral: false` on the
  matching record and calls `persistWorkspaces()`. Mirrors the existing
  `deleteWorkspaceRecord`/`switchWorkspace` pattern of handling only
  the workspace-side half of a cross-store operation — this module
  still has no dependency on `docs.ts` (per its own module comment),
  so the caller (the "Keep this workspace" UI action) is responsible
  for also calling `docs.ts`'s `persistDocs()` afterward to flush that
  workspace's now-no-longer-ephemeral documents.

## `stores/docs.ts` changes

- `persistDocsExcluding()` (the shared choke point already used by
  `persistDocs()` and delete/replace paths) filters out any doc whose
  `workspaceId` resolves to an ephemeral workspace, cross-referencing
  `get(workspacesStore)`. `docs.ts` already imports from
  `stores/workspaces.ts` (one-directional, per its own module comment),
  so this needs no new dependency.
- `setActiveId()` gets the same treatment as
  `setActiveWorkspaceId()`: always updates `activeIdStore`, but skips
  `localStorage.setItem(STORAGE_ACTIVE, id)` when the doc's own
  workspace is ephemeral.
- `importRemoteDocs()` is unchanged — it already just updates
  `docsStore` and calls `persistDocs()`; the new filter inside
  `persistDocsExcluding()` makes that call a no-op for an ephemeral
  workspace's documents automatically, with no special-casing needed
  at the call site.

## `collab.ts` changes

`decideJoinTarget()`'s return type splits its single `"auto"` kind into
two, distinguishing "nothing to protect" from "this would clutter an
existing library":

```ts
export type JoinDecision =
  | { kind: "auto-permanent"; workspaceName: string }
  | { kind: "auto-preview"; workspaceName: string }
  | { kind: "choice" };

export function decideJoinTarget(validDocs: { name: string }[], existingWorkspaceCount: number): JoinDecision {
  if (existingWorkspaceCount === 0) {
    // Likely the receiver's only reason for being here at all — losing
    // it on reload would be strictly worse than today's behavior, and
    // there is no existing local library to protect from clutter.
    return { kind: "auto-permanent", workspaceName: validDocs.length === 1 ? (validDocs[0]!.name || "Untitled") : "Shared workspace" };
  }
  if (validDocs.length === 1) {
    // Unambiguous (nothing meaningful to choose between merge/new), but
    // the receiver already has their own real workspaces — auto-landing
    // this permanently is exactly the clutter this spec fixes.
    return { kind: "auto-preview", workspaceName: validDocs[0]!.name || "Untitled" };
  }
  return { kind: "choice" };
}
```

`joinSharedLink()`'s `decision.kind === "auto"` branch splits to call
`adoptSharedWorkspace` (unchanged) for `"auto-permanent"` and the new
`previewSharedWorkspace` for `"auto-preview"`; both still call
`importRemoteDocs`/`switchWorkspace`/`switchDoc` exactly as today. The
`localMatch` fast path (already-joined-before) is unaffected — an
ephemeral workspace found via `remoteId` mid-session (e.g. clicking the
same share link twice in one tab) is reused in place, same as a
permanent one; a fresh tab or reload simply won't find it, since it was
never persisted, and goes through the full join flow again.

## `JoinWorkspaceModal.svelte` changes

Adds a third footer button, "Preview only", alongside the existing
"Merge in" and "Add as new workspace" — calls a new `preview()` handler
that calls `previewSharedWorkspace` + `importRemoteDocs` +
`switchWorkspace` + `switchDoc`, mirroring `addAsNew()`'s shape exactly
except for which workspace-creation function it calls. The two existing
buttons are unchanged — a user explicitly clicking "Merge in" or "Add as
new workspace" is a deliberate keep decision and stays permanent
immediately, no ephemeral intermediate step.

## `WorkspaceSwitcher.svelte` changes

- The trigger button shows a small "Preview" badge next to the
  workspace name whenever `activeWorkspace?.ephemeral` is true.
- The popover gains a "Keep this workspace" row, shown only when the
  active workspace is ephemeral, above the workspace list. Clicking it
  calls `promoteEphemeralWorkspace(id)` then `persistDocs()` (imported
  from `stores/docs.ts`, which this component already imports from).
- The existing per-row list, rename, and delete behavior needs no
  changes — an ephemeral workspace renders and can be renamed/deleted
  exactly like any other; `persistWorkspacesExcluding`'s existing
  id-based filtering already handles "deleting something that was
  never persisted" correctly with no special case.

## Error handling / edge cases

- **Switching between two ephemeral workspaces in the same tab** (e.g.
  previewing one share link, then another): each `setActiveWorkspaceId`
  call still skips persistence, so the tab's real "default landing
  workspace" in `localStorage` is never touched by either — it still
  points at whatever real workspace was active before the first
  preview began.
- **Promoting, then later deleting.** Once `promoteEphemeralWorkspace`
  clears the flag, the workspace is indistinguishable from one adopted
  via the existing permanent paths — `deleteWorkspaceRecord` behaves
  exactly as it does for any other workspace today.
- **A doc moved from a real workspace into an ephemeral one** (via the
  existing move-to-workspace flow) starts being excluded from
  persistence going forward, the same as any doc that already lived
  there — no special-casing needed in `MoveToWorkspaceModal.svelte`.
- **Zero-workspace receiver who later creates more workspaces and then
  reuses an old share link**: `decideJoinTarget` is evaluated fresh on
  every join attempt from `existingWorkspaceCount` at that moment, so
  this naturally transitions from `auto-permanent` to `auto-preview`
  behavior as their own library grows — no migration/versioning needed
  for existing users' already-adopted workspaces (those already have
  `ephemeral` unset/`undefined`, which is falsy and behaves as
  permanent).

## Testing

- `tests/client/src/collab.test.ts`: of the six existing
  `decideJoinTarget` cases, five currently return `kind: "auto"`; update
  the two whose `existingWorkspaceCount > 0` (both single-doc shares) to
  expect `"auto-preview"`, and the other three (all
  `existingWorkspaceCount === 0`) to expect `"auto-permanent"`. The
  sixth case (`kind: "choice"`, multi-doc with existing workspaces) is
  unchanged.
- `tests/client/src/stores/workspaces.test.ts` (existing file): add
  tests for `previewSharedWorkspace` (created workspace has
  `ephemeral: true`, active id updates, `localStorage` untouched),
  `promoteEphemeralWorkspace` (flag cleared, now persisted), and
  `persistWorkspacesExcluding`'s ephemeral filtering (an ephemeral
  workspace never appears in a freshly-parsed `localStorage` snapshot
  after a persist call).
- `tests/client/src/stores/docs.test.ts` (existing file): unit test that a
  doc belonging to an ephemeral workspace is excluded from a
  `persistDocs()` snapshot, and included once its workspace is
  promoted.
- `tests/client/src/components/JoinWorkspaceModal.test.ts` (new,
  `components` Vitest project): mounts the real component with a
  multi-document `pendingJoin` state, asserts all three buttons render,
  and that clicking "Preview only" results in an ephemeral workspace
  becoming active without a `localStorage` write.
- `tests/e2e/collab/`: a new spec exercising the real end-to-end
  guarantee against a live `WorkspaceRoom` — join a shared workspace as
  a second (non-owner) browser context, confirm it becomes active,
  reload that context and confirm it's gone (back to no workspace or
  whatever was there before); separately, join, click "Keep this
  workspace", reload, and confirm it's still there.

## Versioning

User-facing behavior change (new modal option, new switcher badge/
action, and a real fix to reported friction) → minor version bump with
its own What's New entry (category: Collaboration).
