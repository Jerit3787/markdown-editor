# Workspace-Gated Actions — Design Spec

**TODO items 22 + 23 (partial — see Non-goals).** A first-time visitor no
longer gets an auto-seeded "My Workspace"; every action that implicitly
needs a workspace or an active document is now explicitly gated instead
of silently self-healing or being left clickable with no guard at all.
This also resolves the original trigger (item 22): a brand-new visitor
opening a shared link never sees the "join shared workspace" choice
screen, since they now genuinely have nothing to choose between.

## Goal

Match VS Code's "no folder open" model: a fresh install starts with zero
workspaces, not an auto-created default one. Creating a workspace becomes
a deliberate, named action — never a silent side effect of some other
action (opening a file, publishing a gist, clicking "New document").
Every action across the app that assumes a workspace or an active
document exists is audited and gated on that precondition, consistently,
rather than each one being individually (and inconsistently) safe or
unsafe today.

## Non-goals (deferred)

- **Receiver-side UX for single-document shares**, when the receiving
  user already has real workspaces of their own (TODO item 23's core
  open question — should a shared single doc land differently than a
  shared whole workspace?). This spec only removes the join dialog for
  a genuinely empty receiver; the harder design question for an
  *existing* user stays open, to be brainstormed separately.
- **A "one tab/window = one document/workspace" session model.** Named
  in item 23 as a rough idea, not a decision. This is a fundamentally
  different architecture from today's single-active-document SPA, not
  an incremental change — its own future project if pursued at all.
- **Filtering unavailable commands out of the Command Palette's list.**
  The palette calls the same underlying functions (`window.MDE.newDoc()`
  etc.) as every other entry point, so it's covered by the same
  function-level guards — a blocked command still shows a toast instead
  of silently doing nothing, it just isn't visually greyed out or hidden
  in the palette itself. Pure UX polish, not required for correctness.
- **Migrating existing users.** This only changes what a *genuinely
  empty* `localStorage` produces on first load. A user who already has
  one or more workspaces (including a stock "My Workspace" from before
  this ships) keeps them exactly as they are — nothing is deleted or
  renamed retroactively.

## Behavior

### 1. No default workspace on fresh installs

`client/src/stores/workspaces.ts`'s `initialWorkspaces`:

```ts
// Before:
const initialWorkspaces: Workspace[] =
  storedWorkspaces === null ? [{ id: uid(), name: "My Workspace", createdAt: Date.now() }] : storedWorkspaces;

// After:
const initialWorkspaces: Workspace[] = storedWorkspaces === null ? [] : storedWorkspaces;
```

The `if (storedWorkspaces === null) persistWorkspaces();` line right
below stays — it now just persists an empty array on first run instead
of a seeded one, same "make the first-run derivation durable" reasoning
as today.

The `#emptyState.no-workspace` UI (title "No workspace yet", body
"Create a workspace to start adding documents.", one "New workspace"
button) and `createDoc()`'s documented self-heal comment already exist
for exactly this state — today it's only reachable by deliberately
deleting your last workspace. This change makes it the default starting
state too, not a new UI to build.

### 2. Three-tier action gating

**Tier 1 — workspace-creating, always available, no guard needed:**
`WorkspaceSwitcher.svelte`'s `startCreate()`, the empty-state's
`#emptyNewWorkspaceBtn` handler (`app.ts`), `window.MDE.openRepoModal`
(Open GitHub Repo as Workspace), and `collab.ts`'s `joinSharedLink`
adopting a shared link. These either create a workspace directly or
their whole purpose is establishing one — they never assume one already
exists.

**Tier 2 — needs at least one workspace to exist.** Each of these gets
an explicit `get(workspacesStore).length === 0` check at its own entry
point, before doing anything else; when blocked, show
`showToast("Create a workspace first", "error")` and return without
opening any picker, modal, or file dialog:

- `app.ts`'s `createNewDoc()` (shared by the sidebar "+" button and File
  \> New document) — guard at the top of the function.
- `window.MDE.openLocalFile()` (`app.ts`, around line 2233) — guard
  before `document.getElementById("importInput").click()`, so the OS
  file picker never opens if there's nowhere to import into.
- `window.MDE.openGistPicker` (`gist.ts`) — guard before
  `openGistModalOpen.set(true)`.
- `window.MDE.openRepoLinkModal` (`repo-sync-ui.ts`) — guard before
  `repoLinkModalOpen.set(true)`, alongside the existing
  `requireRepoScope()` check already there.

`stores/docs.ts`'s `createDoc()` loses its self-heal fallback as the
*primary* mechanism — since every caller now guards before calling it,
the fallback line becomes unreachable in normal operation. It stays in
the code as a defensive last resort (documented as "should be
unreachable — every caller guards first; kept so a missed guard produces
a usable workspace instead of an orphaned document") rather than being
deleted outright, since an orphaned `workspaceId: undefined` doc is a
real, silent-data-loss failure mode worth guarding against even if every
known caller is covered today.

**Tier 3 — needs an active document.** `MenuBar.svelte` gains one
derived value, `const hasActiveDoc = $derived(!!activeDoc);`, bound as
`disabled={!hasActiveDoc}` on every File-menu item below "Open Recent"
except the "GitHub Repo" submenu's own workspace-level actions (which
are Tier 2, not Tier 3 — they operate on the active *workspace*, not the
active *document*) — so: Publish/Update Gist, Export's four items,
Comments, Version history, Document info, Delete document — plus every
button in the Edit menu (Undo, Redo, Cut, Copy, Paste, Bold, Italic,
Strikethrough, Insert Link, Insert Image, Manage Images). This is purely
additive `disabled` bindings on already-existing buttons — no new
function-level guards needed here, since Tier 3 is about disabling
controls that would otherwise act on a `null` active document, not about
preventing an unsafe state transition the way Tier 1/2 are.

`DocList.svelte`'s per-row menu (Rename/Duplicate/Move/Delete) and
`WorkspaceSwitcher.svelte`'s per-row actions (rename/delete a workspace)
need no changes — both can only be triggered on a row that's already
rendered, so they're safely gated by the list simply being empty when
there's nothing to act on. Same reasoning already applies today to
wikilink auto-create (`app.ts`'s `initWikilinkNavigation`): it's a click
handler on the rendered preview pane, which can't exist without an
already-open document — structurally unreachable from a no-document
state, no guard needed.

### 3. Join-flow simplification

`collab.ts`'s `joinSharedLink` currently ends with:

```ts
const docIds = await fetchWorkspaceDocIds(workspaceId);
const docs = await Promise.all(docIds.map((id) => fetchRemoteDocContent(workspaceId, id)));
pendingJoin.set({ remoteId: workspaceId, workspaceName: "Shared workspace", docs: docs.filter((d): d is NonNullable<typeof d> => !!d), landOnDocId });
```

The inline filter becomes a named `validDocs`, now shared by two
branches instead of used once:

```ts
const docIds = await fetchWorkspaceDocIds(workspaceId);
const docs = await Promise.all(docIds.map((id) => fetchRemoteDocContent(workspaceId, id)));
const validDocs = docs.filter((d): d is NonNullable<typeof d> => !!d);

if (get(workspacesStore).length === 0) {
  const ws = adoptSharedWorkspace(workspaceId, "Shared workspace");
  importRemoteDocs(ws.id, validDocs);
  switchWorkspace(ws.id);
  switchDoc(landOnDocId);
  return;
}
pendingJoin.set({ remoteId: workspaceId, workspaceName: "Shared workspace", docs: validDocs, landOnDocId });
```

No workspace to compare against, so there's no dialog to show — this is
now just Tier 1's "adopt as new" path, reached automatically instead of
via a user choice. An existing user with any workspace(s) of their own
still sees the same `JoinWorkspaceModal` as today, unchanged.

## Error handling

Every Tier 2 block shows the same toast, `"Create a workspace first"`,
`type: "error"` — consistent wording across all four entry points rather
than a bespoke message per action. Tier 3's `disabled` buttons give no
separate error feedback (matches how `shareBtn`/`commentsBtn`/
`versionHistoryBtn` already behave today — a disabled button doesn't
need an additional click-time message).

## Testing

- `stores/workspaces.test.ts`: a fresh `loadWorkspacesFromStorage()` (no
  `mde:workspaces` key set) produces an empty `workspacesStore`, not a
  seeded "My Workspace" — and that this persists immediately (matches
  the existing `if (storedWorkspaces === null) persistWorkspaces();`
  behavior, now persisting `[]` instead of a seeded array).
- `stores/docs.test.ts`: `createDoc()` called with zero workspaces still
  produces a doc with a real `workspaceId` (the defensive fallback),
  proving the safety net works even though no normal caller should ever
  reach it.
- No automated test for the Tier 2 entry-point guards themselves or the
  Tier 3 `disabled` bindings — this codebase has no Svelte component
  tests (established precedent from this session's earlier work); manual
  verification: with zero workspaces, confirm each Tier 2 action (sidebar
  "+", File > New, Open from device, Open from GitHub Gist, Link
  Workspace to Repo) shows the error toast and takes no further action,
  and that Tier 1 actions (New workspace, Open GitHub Repo as Workspace)
  still work normally. With a workspace but no active document (e.g.
  after deleting the last doc), confirm every Tier 3 menu item is
  visibly disabled.
- Manual verification for the join-flow: open a shared link with
  genuinely empty `localStorage` — confirm no dialog appears and the
  shared workspace becomes the only workspace, landing on the linked
  document. Open the same link again from a profile that already has a
  workspace — confirm `JoinWorkspaceModal` still appears as today.
