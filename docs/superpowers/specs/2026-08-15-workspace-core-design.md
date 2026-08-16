# Workspace Core Design

## Context

This is the first of four planned sub-projects (workspace core → workspace
sharing → GitHub repo sync → Google Drive sync) toward letting a user share
an entire *workspace* — a named group of documents, VS Code-style — instead
of one document at a time. The other three all depend on the concept this
spec introduces existing first; none of their behavior (sharing, external
sync) is in scope here.

Today the app has no workspace concept at all: every document lives in one
flat, per-browser list (`docsStore`, `client/src/stores/docs.ts`), persisted
to `localStorage["mde:docs"]`. This spec introduces `Workspace` as a new
container documents belong to, with exactly one workspace active/visible at
a time (confirmed with the user — not a VS Code-style multi-root view).

## Goals

- A new `Workspace` concept: `{id, name, createdAt}`, no external link yet
  (Drive/GitHub linking is sub-project 3/4).
- Every `Doc` belongs to exactly one workspace (`workspaceId`).
- A workspace switcher in the sidebar: switch, create, rename, delete.
- Deleting a workspace deletes its documents too, after a confirm showing
  the count (matches how document deletion already works).
- A document can be moved to another workspace via its existing "⋮" menu.
- Existing users migrate transparently: a single default workspace
  ("My Workspace") is created on first load post-upgrade, and every
  existing document is backfilled onto it.
- Symmetric empty states: zero documents *in the active workspace* (today's
  existing empty state, now workspace-scoped) and zero *workspaces* (new —
  deleting the last workspace is allowed, same as documents can already
  reach zero).

## Non-goals

- Workspace-level sharing/collab (sub-project 2) — `collab.ts`'s existing
  per-document room join (`createDoc({ id: roomId, name: "Shared document" })`)
  keeps working exactly as today, just tagged with whatever workspace
  happens to be active when the room is joined. No new join-flow UI.
- Any external sync (Google Drive, GitHub repo — sub-projects 3/4).
- Multiple workspaces visible/open at once (explicitly declined in favor of
  VS Code single-root-style switching).
- Renaming via a modal — reuses the existing lightweight inline-input
  pattern (see `DocList.svelte`'s rename, which focuses `#docTitle`
  directly) rather than introducing a new dialog.

## Architecture

### Data model (`client/src/types.ts`)

```typescript
export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
}
```

`Doc` gains one new required field:

```typescript
export interface Doc {
  id: string;
  name: string;
  content: string;
  updatedAt: number;
  createdAt: number;
  // Which Workspace this document belongs to — every doc has exactly
  // one, see stores/workspaces.ts. Backfilled for pre-workspace docs by
  // docs.ts's normalizeLoadedDocs, same pattern as the existing
  // createdAt backfill below.
  workspaceId: string;
  images?: Record<string, string>;
  diagrams?: Record<string, string>;
  gistId?: string;
  gistFilename?: string;
  shared?: boolean;
  notes?: Note[];
}
```

### `client/src/stores/workspaces.ts` (new)

Deliberately has **no dependency on `docs.ts`** — it's a leaf module. All
coordination between "which workspace is active" and "which document is
active" is done by the caller (`WorkspaceSwitcher.svelte`), not by either
store reaching into the other. This avoids a circular import (`docs.ts`
*does* depend on `workspaces.ts`, for the reason in the next section — a
cycle the other way would break module init order).

```typescript
import { get, writable } from "svelte/store";
import type { Workspace } from "../types";
import { showToast } from "./toast";

const STORAGE_WORKSPACES = "mde:workspaces";
const STORAGE_ACTIVE_WORKSPACE = "mde:activeWorkspace";

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// null (not []) means the key has genuinely never been set — the
// signal for "first run, seed a default workspace" below. Once a real
// value (even []) has been persisted, that distinction is gone, and an
// empty array is respected as-is (the user deliberately deleted their
// last workspace — see deleteWorkspace's own comment on why that's
// allowed).
function loadWorkspacesFromStorage(): Workspace[] | null {
  const raw = localStorage.getItem(STORAGE_WORKSPACES);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

const storedWorkspaces = loadWorkspacesFromStorage();
// First-ever run (brand new visitor, or an existing user upgrading —
// either way nothing under STORAGE_WORKSPACES yet) always gets exactly
// one workspace to start in. docs.ts's own migration (see its
// normalizeLoadedDocs) backfills any pre-existing documents onto this
// same workspace using the same "was it null" check, so the two stay
// in sync without either module needing to call the other.
const initialWorkspaces: Workspace[] =
  storedWorkspaces === null ? [{ id: uid(), name: "My Workspace", createdAt: Date.now() }] : storedWorkspaces;

export const workspacesStore = writable<Workspace[]>(initialWorkspaces);

function initialActiveWorkspaceId(workspaces: Workspace[]): string | null {
  const stored = localStorage.getItem(STORAGE_ACTIVE_WORKSPACE);
  if (stored && workspaces.find((w) => w.id === stored)) return stored;
  return workspaces[0] ? workspaces[0].id : null;
}

export const activeWorkspaceIdStore = writable<string | null>(initialActiveWorkspaceId(initialWorkspaces));

export function persistWorkspaces() {
  try {
    localStorage.setItem(STORAGE_WORKSPACES, JSON.stringify(get(workspacesStore)));
  } catch (e) {
    showToast("Couldn't save — your browser's local storage may be full", "error");
  }
}

// Persist immediately if this was a first-run seed — otherwise a visitor
// who never explicitly touches workspace UI would keep re-deriving "My
// Workspace" from `null` on every load instead of it becoming real,
// durable storage.
if (storedWorkspaces === null) persistWorkspaces();

function setActiveWorkspaceId(id: string | null) {
  activeWorkspaceIdStore.set(id);
  if (id) localStorage.setItem(STORAGE_ACTIVE_WORKSPACE, id);
  else localStorage.removeItem(STORAGE_ACTIVE_WORKSPACE);
}

export function createWorkspace(name: string): Workspace {
  const ws: Workspace = { id: uid(), name, createdAt: Date.now() };
  workspacesStore.update((all) => [ws, ...all]);
  setActiveWorkspaceId(ws.id);
  persistWorkspaces();
  return ws;
}

export function renameWorkspace(id: string, name: string) {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, name: name || "Untitled workspace" } : w)));
  persistWorkspaces();
}

// Returns whether the switch actually happened (false if `id` was
// already active) — mirrors docs.ts's switchDoc(). Does NOT touch which
// document is active; the caller (WorkspaceSwitcher.svelte) calls
// docs.ts's ensureActiveDocInWorkspace() right after, keeping this
// module independent of docs.ts.
export function switchWorkspace(id: string): boolean {
  if (id === get(activeWorkspaceIdStore)) return false;
  setActiveWorkspaceId(id);
  return true;
}

// Does NOT delete the workspace's documents itself, and does NOT pick a
// new active workspace — both are the caller's job (WorkspaceSwitcher.svelte),
// since deleting documents means calling docs.ts's removeDocById(), and
// this module can't import docs.ts (see the module-doc comment above).
export function deleteWorkspaceRecord(id: string) {
  const remaining = get(workspacesStore).filter((w) => w.id !== id);
  workspacesStore.set(remaining);
  persistWorkspaces();
  if (get(activeWorkspaceIdStore) === id) {
    const fallback = [...remaining].sort((a, b) => a.createdAt - b.createdAt)[0];
    setActiveWorkspaceId(fallback ? fallback.id : null);
  }
}
```

### `client/src/stores/docs.ts` (changes)

`docs.ts` importing from `workspaces.ts` is the one allowed direction (the
reverse would cycle). Six changes, all additive:

**1. Migration in `normalizeLoadedDocs`** (runs on every load, same
deterministic-backfill pattern already used for `createdAt` — see its
existing comment):

```typescript
import { workspacesStore } from "./workspaces";

function normalizeLoadedDocs(docs: Doc[]): Doc[] {
  const seen = new Set<string>();
  // Always exists — workspaces.ts guarantees at least one workspace on
  // first-ever run, which is the only time a doc can be missing
  // workspaceId in the first place (see workspaces.ts's own comment).
  const fallbackWorkspaceId = get(workspacesStore)[0]?.id;
  return docs.map((d) => {
    const name = nextAvailableName(d.name || "Untitled", seen);
    seen.add(name);
    return {
      ...d,
      name,
      createdAt: d.createdAt ?? d.updatedAt,
      workspaceId: d.workspaceId ?? fallbackWorkspaceId ?? "",
    };
  });
}
```

**2. `createDoc()` defaults to the active workspace** when the caller
doesn't specify one:

```typescript
import { activeWorkspaceIdStore, workspacesStore } from "./workspaces";

export function createDoc(partial?: Partial<Doc> & { id?: string; name?: string }): Doc {
  saveActiveDocContent();
  const workspaceId = get(activeWorkspaceIdStore) ?? get(workspacesStore)[0]?.id ?? "";
  const doc: Doc = Object.assign(
    { id: uid(), name: "Untitled", content: "", updatedAt: Date.now(), createdAt: Date.now(), workspaceId },
    partial
  );
  doc.name = ensureUniqueName(doc.name, get(docsStore));
  docsStore.update((docs) => [doc, ...docs]);
  setActiveId(doc.id);
  persistDocs();
  return doc;
}
```

No existing call site changes — `app.ts` (×3), `collab.ts`, and
`OpenGistModal.svelte` all keep calling `createDoc({...})` exactly as
today; the new document always lands in whatever workspace is currently
active. (For `collab.ts`'s shared-room join specifically: this is
today's behavior, unchanged — sub-project 2 is where joining a shared
*workspace* gets designed properly.)

**3. `getActiveDoc()`'s fallback must stay within the active workspace** —
today it falls back to `docs[0]` (any doc at all) when `activeIdStore`
doesn't resolve; once documents are partitioned by workspace, `docs[0]`
could belong to a different one:

```typescript
export function getActiveDoc(): Doc | undefined {
  const docs = get(docsStore);
  const activeId = get(activeIdStore);
  const found = docs.find((d) => d.id === activeId);
  if (found) return found;
  const activeWorkspaceId = get(activeWorkspaceIdStore);
  return docs.find((d) => d.workspaceId === activeWorkspaceId);
}
```

**4. `removeDocById()`'s fallback has the same bug** — deleting the active
document today falls back to `remaining[0]`, which must now be scoped to
the deleted doc's own workspace:

```typescript
export function removeDocById(id: string) {
  const removedWorkspaceId = findDocById(id)?.workspaceId;
  docsStore.update((docs) => docs.filter((d) => d.id !== id));
  if (get(activeIdStore) === id) {
    const remaining = get(docsStore).filter((d) => d.workspaceId === removedWorkspaceId);
    setActiveId(remaining[0] ? remaining[0].id : null);
  }
  persistDocs();
  void deleteHistory(id);
}
```

**5. New export, `ensureActiveDocInWorkspace`** — called by
`WorkspaceSwitcher.svelte` right after switching or deleting a workspace,
since the previously-active document may not belong to the
newly-active workspace:

```typescript
export function ensureActiveDocInWorkspace(workspaceId: string) {
  const docs = get(docsStore);
  const activeId = get(activeIdStore);
  if (docs.find((d) => d.id === activeId)?.workspaceId === workspaceId) return; // already valid
  saveActiveDocContent();
  const inWorkspace = [...docs].filter((d) => d.workspaceId === workspaceId).sort((a, b) => b.updatedAt - a.updatedAt);
  setActiveId(inWorkspace[0] ? inWorkspace[0].id : null);
}
```

**6. New export, `moveDocToWorkspace`** — the "⋮" menu action:

```typescript
export function moveDocToWorkspace(id: string, workspaceId: string) {
  updateDoc(id, { workspaceId });
  persistDocs();
}
```

> **Post-implementation note (added after the final whole-branch review,
> 2026-08-15/16):** the fallback ordering above ended up needing further
> correction beyond what's shown here — see the implementation plan and
> `CHANGELOG.md`'s `[1.20.0]` entry for the shipped, corrected behavior:
> `initialActiveId` (module-load fallback) also needed to become
> workspace-scoped; the migration's `fallbackWorkspaceId` needed to pick
> the *oldest* workspace by `createdAt` (not `[0]`, since `createWorkspace`
> prepends) and persist immediately when a backfill actually occurred;
> `switchDoc()` needed to bring the workspace along when navigating to a
> document in a different one (wikilinks, Command Palette, etc.); and
> `createDoc()`'s workspace-id fallback needed to self-heal (create a
> workspace on demand) rather than ever stamp `workspaceId: ""`. All four
> were fixed and shipped in v1.20.0 — this spec is kept as the original
> design record, not retroactively rewritten.

### `client/src/components/WorkspaceSwitcher.svelte` (new)

Mounted at a new `#workspace-switcher-mount` inside `#sidebarHeader` in
`index.html`, next to the existing static "Documents" label (that header
is plain HTML wired imperatively from `app.ts` today — this is the first
Svelte content to live there, following the same mount-point pattern as
`#doclist-mount` right below it).

A click-to-open popover (same interaction shape as `DocList.svelte`'s own
"⋮" row menu — outside-click closes it, no separate library): current
workspace name + chevron as the trigger; the popover lists every
workspace (click to switch), each row with inline Rename (turns the row
into a text input, commits on blur/Enter — matching `DocList.svelte`'s
existing rename-via-`#docTitle`-focus pattern rather than a new modal)
and Delete (confirms via the existing `confirmAction()`, showing the
document count), plus a "New workspace" action at the bottom that creates
one immediately and drops it straight into rename mode so it can be named
right away.

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { workspacesStore, activeWorkspaceIdStore, createWorkspace, renameWorkspace, switchWorkspace, deleteWorkspaceRecord } from "../stores/workspaces";
  import { docsStore, removeDocById, ensureActiveDocInWorkspace } from "../stores/docs";
  import { confirmAction } from "../stores/confirmDialog";

  let open = $state(false);
  let renamingId = $state<string | null>(null);
  let renameValue = $state("");

  const activeWorkspace = $derived($workspacesStore.find((w) => w.id === $activeWorkspaceIdStore));
  const docCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const d of $docsStore) counts.set(d.workspaceId, (counts.get(d.workspaceId) || 0) + 1);
    return counts;
  });

  function toggle() {
    open = !open;
  }
  function close() {
    open = false;
    renamingId = null;
  }

  function pick(id: string) {
    if (switchWorkspace(id)) ensureActiveDocInWorkspace(id);
    close();
  }

  function startCreate() {
    const ws = createWorkspace("New workspace");
    ensureActiveDocInWorkspace(ws.id); // brand new, always empty
    renamingId = ws.id;
    renameValue = ws.name;
  }

  function startRename(id: string, name: string, e: MouseEvent) {
    e.stopPropagation();
    renamingId = id;
    renameValue = name;
  }

  function commitRename() {
    if (renamingId) renameWorkspace(renamingId, renameValue.trim());
    renamingId = null;
  }

  async function remove(id: string, name: string, e: MouseEvent) {
    e.stopPropagation();
    const count = docCounts.get(id) || 0;
    const message =
      count > 0
        ? `Delete "${name}" and its ${count} document${count === 1 ? "" : "s"}? This can't be undone.`
        : `Delete "${name}"? This can't be undone.`;
    if (!(await confirmAction(message))) return;
    const docIds = $docsStore.filter((d) => d.workspaceId === id).map((d) => d.id);
    docIds.forEach(removeDocById);
    deleteWorkspaceRecord(id);
    if ($activeWorkspaceIdStore) ensureActiveDocInWorkspace($activeWorkspaceIdStore);
    close();
  }

  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (open && !(e.target as HTMLElement).closest(".workspace-switcher")) close();
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  });
</script>

<div class="workspace-switcher">
  <button type="button" class="workspace-switcher-trigger" onclick={toggle}>
    <span class="workspace-name">{activeWorkspace?.name ?? "No workspace"}</span>
    <svg class="icon"><use href="#icon-chevron-down"></use></svg>
  </button>
  {#if open}
    <div class="workspace-switcher-popover">
      <ul class="workspace-list">
        {#each $workspacesStore as ws (ws.id)}
          <li class:active={ws.id === $activeWorkspaceIdStore}>
            {#if renamingId === ws.id}
              <input
                class="workspace-rename-input"
                bind:value={renameValue}
                onblur={commitRename}
                onkeydown={(e) => e.key === "Enter" && commitRename()}
                onclick={(e) => e.stopPropagation()}
              />
            {:else}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="workspace-row" onclick={() => pick(ws.id)}>
                <span class="workspace-row-name">{ws.name}</span>
                <button type="button" class="icon-btn" aria-label="Rename workspace" onclick={(e) => startRename(ws.id, ws.name, e)}>
                  <svg class="icon"><use href="#icon-pencil"></use></svg>
                </button>
                <button type="button" class="icon-btn" aria-label="Delete workspace" onclick={(e) => remove(ws.id, ws.name, e)}>
                  <svg class="icon"><use href="#icon-trash-2"></use></svg>
                </button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      <button type="button" class="workspace-new-btn" onclick={startCreate}>
        <svg class="icon"><use href="#icon-plus"></use></svg> New workspace
      </button>
    </div>
  {/if}
</div>
```

Note: `remove()` duplicates the doc-id lookup + cascade loop rather than
adding yet another cross-module export — it's three lines, used in
exactly one place, and keeps `workspaces.ts` from needing to know about
`docsStore` shape beyond what's already spelled out here.

### `client/src/components/DocList.svelte` (change)

Filters to the active workspace — one line, at the top of the existing
`sorted` derived:

```typescript
import { activeWorkspaceIdStore } from "../stores/workspaces";

const sorted = $derived(
  [...$docsStore].filter((d) => d.workspaceId === $activeWorkspaceIdStore).sort((a, b) => b.updatedAt - a.updatedAt)
);
```

Everything else in the file (headings outline, rename/duplicate/delete,
mobile Documents/Headings tabs) is unchanged — it already only ever reads
from `rows`/`sorted`, which is now pre-filtered.

**"Move to workspace…"** — added to the existing "⋮" popover, a submenu
listing the other workspaces:

```svelte
<!-- inside the existing .doc-menu-popover, after Duplicate -->
{#if $workspacesStore.length > 1}
  <div class="doc-menu-submenu-label">Move to workspace</div>
  {#each $workspacesStore.filter((w) => w.id !== findDocById(menuDocId)?.workspaceId) as ws (ws.id)}
    <button type="button" onclick={() => move(menuDocId, ws.id)}>{ws.name}</button>
  {/each}
{/if}
```

```typescript
function move(id: string, workspaceId: string) {
  closeMenu();
  moveDocToWorkspace(id, workspaceId);
  // Moving the currently-open document out of the active workspace
  // needs the same fixup switching workspaces does.
  if (id === $activeIdStore) ensureActiveDocInWorkspace($activeWorkspaceIdStore ?? workspaceId);
}
```

### `client/index.html` + `app.ts` (empty states)

Two empty states now, toggled by a new class on the existing `#emptyState`
element rather than a new component:

```html
<div id="emptyState" class="empty-state" hidden>
  <div class="empty-state-inner empty-state-has-workspace">
    <!-- existing content: unchanged -->
  </div>
  <div class="empty-state-inner empty-state-no-workspace">
    <img src="/logo.svg" width="52" height="52" alt="">
    <h1>No workspace yet</h1>
    <p>Create a workspace to start adding documents.</p>
    <div class="empty-state-actions">
      <button type="button" id="emptyNewWorkspaceBtn" class="primary-btn">
        <svg class="icon"><use href="#icon-folder-plus"></use></svg> New workspace
      </button>
    </div>
  </div>
</div>
```

CSS shows exactly one `.empty-state-inner` variant at a time based on a
`no-workspace` class on the parent (`display: none` on whichever doesn't
match), mirroring how `.doclist-tabs` already toggles between its two
views. `updateMainView()` sets that class:

```typescript
function updateMainView(empty: boolean) {
  document.getElementById("emptyState").hidden = !empty;
  document.getElementById("emptyState").classList.toggle("no-workspace", get(workspacesStore).length === 0);
  // ...rest unchanged
}
```

`#emptyNewWorkspaceBtn`'s click handler creates a workspace and opens the
switcher's rename mode immediately, same as the switcher's own "New
workspace" button — both call the same `startCreate`-shaped logic, so
this is a one-line wire-up in `app.ts` calling into `createWorkspace()`
directly (no need to route through the Svelte component for this one
button, matching how `#emptyNewDocBtn` already calls `createDoc()`
directly today without going through `DocList.svelte`).

## Data flow

```
App load
  │
  ▼
workspaces.ts module init — loads/seeds workspacesStore + activeWorkspaceIdStore
  │
  ▼
docs.ts module init — loads docsStore, normalizeLoadedDocs backfills
  any doc missing workspaceId onto workspacesStore[0]
  │
  ▼
DocList.svelte renders $docsStore filtered to $activeWorkspaceIdStore
  │
  ├─► User clicks a workspace in the switcher
  │     switchWorkspace(id) → ensureActiveDocInWorkspace(id)
  │
  ├─► User creates/renames/deletes a workspace (switcher UI)
  │     createWorkspace / renameWorkspace / (removeDocById× + deleteWorkspaceRecord) → ensureActiveDocInWorkspace
  │
  └─► User moves a document (doc row "⋮" menu)
        moveDocToWorkspace(id, targetWorkspaceId) → ensureActiveDocInWorkspace if it was the active doc
```

## Error handling

- **Corrupt `mde:workspaces` JSON**: caught the same way `docs.ts`
  already handles corrupt `mde:docs` — falls back to `[]`, which (since
  the key *did* exist, just with bad content) is respected as a real
  empty state rather than re-seeding a default, consistent with treating
  `null` as the only "seed a default" signal.
- **Zero workspaces reachable only via explicit deletion**: verified this
  can never leave a document workspace-less — `deleteWorkspaceRecord` is
  only ever called after every document in that workspace has already
  been removed via `removeDocById` (see `WorkspaceSwitcher.svelte`'s
  `remove()`), so there is no path to "workspace gone, its docs still
  reference it."
- **Storage quota errors**: `persistWorkspaces()` reuses the exact same
  try/catch + toast pattern as `persistDocs()` — no new failure mode.

## Testing

Unit tests (`vitest`, following `docs.ts`'s existing untested-vs-tested
split — pure store logic gets tests, UI wiring doesn't):

- `workspaces.ts`: first-ever load seeds exactly one workspace and
  persists it immediately; a subsequent load with `mde:workspaces` set to
  `"[]"` stays empty (does not re-seed); `createWorkspace`/
  `renameWorkspace`/`switchWorkspace`/`deleteWorkspaceRecord` each do
  exactly what their name says, including `deleteWorkspaceRecord`'s
  deterministic fallback-by-`createdAt` when the active workspace is the
  one deleted.
- `docs.ts`: `normalizeLoadedDocs` backfills `workspaceId` onto legacy
  docs (missing the field) but leaves it alone on docs that already have
  one; `createDoc()` stamps the currently-active workspace when the
  caller doesn't override it; `getActiveDoc()` and `removeDocById()`'s
  fallbacks stay within the correct workspace when the naive
  `docs[0]`/`remaining[0]` choice would have picked a doc from a
  different one; `ensureActiveDocInWorkspace` picks the
  most-recently-updated doc in the target workspace, or `null` when it
  has none; `moveDocToWorkspace` reassigns `workspaceId` without
  touching any other field.

Manual live-verification (desktop + mobile, matching this project's
established Claude-in-Chrome pass): create/rename/delete workspaces from
the switcher, switch between them and confirm the doc list + editor
content follow correctly, create a document in a new workspace, move a
document to another workspace (including while it's the active
document), delete a workspace that has documents in it (confirm shows
the right count), delete the very last workspace and confirm the
no-workspace empty state appears with a working "New workspace" button,
reload the page mid-way through and confirm everything survives
(`mde:workspaces`/`mde:activeWorkspace` persisted correctly).

## Self-review

- **Placeholder scan**: none — every store function, component, and
  migration path has concrete code, not a description.
- **Internal consistency**: the one-way `docs.ts → workspaces.ts`
  dependency is maintained throughout — `workspaces.ts` never imports
  `docs.ts`; every place the two need to coordinate (switch, delete,
  move) does so from the consumer (`WorkspaceSwitcher.svelte`/
  `DocList.svelte`), not from either store reaching into the other. Two
  pre-existing bugs this design would otherwise introduce
  (`getActiveDoc()`'s and `removeDocById()`'s `docs[0]`/`remaining[0]`
  fallbacks leaking across workspaces) are identified and fixed as part
  of this same spec rather than left as follow-up debt.
- **Scope check**: one new store file, one new component, five small
  changes to `docs.ts`, two small changes to `DocList.svelte`, one new
  empty-state variant — right-sized for a single implementation plan,
  no further decomposition needed.
- **Ambiguity check**: workspace name uniqueness (none required, per the
  earlier design discussion), delete-cascade behavior, and the
  one-active-workspace-at-a-time model are all explicit, sourced from
  the user's own answers rather than assumed.
