# Collaboration mode chrome — design

**Status:** draft for review
**Date:** 2026-09-08
**Related backlog:** `ROADMAP.md` → Active → "Collaboration roles, focus mode & suggesting mode" — items **A1, A2, A3, A4, A5, B1, B2, C1, D6**. (D1–D5, the suggesting-mode *rendering* redesign, stay separate.)

## Goal

Give a shared-workspace collaborator a Google-Docs-style **mode switcher** (Editing / Suggesting / Viewing) whose options are bounded by their server-resolved role, and make the chosen mode drive which editing chrome is visible. Bundle in the role-based publish gate, a linked-repo/Gist signal for collaborators, and two focus-mode fixes.

## Non-goals / deferred

- **Suggesting-mode rendering redesign (D1–D5).** Right-margin cards, self-delete-removes-suggestion, per-edit threads, line-level anchoring, folding the edit action into the comment card — its own brainstorm.
- **Syncing a collaborator's chosen mode to anyone else.** Mode is a per-user, per-device UI state (like Google Docs). It never touches the server-resolved role.
- **Server-side enforcement of the publish gate.** A non-owner collaborator already has no `repoLink` (owner-local, never synced) so cannot push; Gist publish only ever creates a gist under the actor's own account. The gate is client chrome only.
- **Per-document mode.** One chosen mode per shared workspace connection, not per document.
- **Focus mode as separate toggles / persisted across loads / sentence-level dimming** — all already on the deferred list, unchanged.

## Background — current state

### Role → behaviour is rigid, and invisible to components

`collab.ts` holds `workspaceRoom.role` (a plain field on a module singleton) and `binding.role` per document. **No store exposes either reactively** — a Svelte component cannot know the current role.

`bindActiveDoc()` (`collab.ts` ~line 915) hard-maps role to behaviour:

| `binding.role` | `setReadOnly` | view lock | suggestion edit-interception |
|---|---|---|---|
| `viewer` | `true` | `lockToPreviewOnly()` — Editor/Split panes removed | — |
| `reviewer` | `false` | `unlockViewMode()` | ON (`viewerRole: "reviewer"` → typing becomes a suggestion) |
| `editor` | `false` | `unlockViewMode()` | OFF (decoration field still applied so an editor can accept/reject) |

`suggestionExtensions(doc, author, { viewerRole, viewerName })` (`suggestion-editor.ts`) internally gates: the decoration field always applies for `reviewer`/`editor`; the edit-interception pieces apply only when `viewerRole === "reviewer"`.

There is no way for an `editor` to voluntarily act as a suggester or a viewer.

### Viewer chrome today

`Toolbar.svelte` wraps its entire `#toolbar` in `{#if !$viewModeLocked}` — a viewer loses the formatting bar **and** `#sidebarToggleOut`, the only re-open control for a collapsed sidebar (C1). `MenuBar.svelte` has **no role gating at all** — Edit / Format / Insert menus and the Publish items are always shown (A1, A3). The comments button (`#commentsBtn`), panel, and inline highlights are always available (A4).

### Focus mode today

`Editor.svelte`'s `focusDimField` marks `.cm-dimmed-line` on every editor line outside the cursor's blank-line-delimited paragraph (`focus-mode.ts`'s `activeParagraphRange`). `#focusModeExitBtn` exists but its CSS shows it **only under `@media (max-width: 780px)`** — **desktop has no exit affordance but the Escape key** (B1). The preview pane is never dimmed (B2).

### `MESSAGE_WORKSPACE_META`

`[type, name, docCount, ...docIds]` — a docId-less broadcast/greeting frame (`workspace-room.ts`'s `encodeWorkspaceMeta`, `collab.ts`'s `applyWorkspaceMeta`). This is where A5's `repoLinked` bool rides.

## Design

### 1. `stores/collabMode.ts` — the reactive model

```ts
import { writable, derived, get } from "svelte/store";

// The client already works in plain strings for role (collab.ts's
// workspaceRoom.role is `string`); define the closed set here rather than
// reaching across into server code (src/access-role.ts).
export type Role = "viewer" | "reviewer" | "editor";
export type Mode = "editing" | "suggesting" | "viewing";

// The server-resolved role for the current shared-workspace connection.
// null ⇒ not in a shared workspace (a plain local document) — no mode
// chrome, editing behaves exactly as it does today.
export const collabRole = writable<Role | null>(null);

// True when this session's user owns the current shared workspace.
// Drives the publish gate (A1/A2) and A5. false when local or a
// non-owner collaborator.
export const collabIsOwner = writable(false);

// What the ceiling role permits, in descending order.
const ALLOWED: Record<Role, Mode[]> = {
  editor: ["editing", "suggesting", "viewing"],
  reviewer: ["suggesting", "viewing"],
  viewer: ["viewing"],
};

const STORAGE_KEY = "mde:collabMode"; // { [remoteId]: Mode }

function loadChosen(remoteId: string | null): Mode | null {
  if (!remoteId) return null;
  try {
    return (JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, Mode>)[remoteId] ?? null;
  } catch {
    return null;
  }
}

// The remoteId the chosen-mode preference is keyed to — set by collab.ts
// alongside collabRole.
export const collabRemoteId = writable<string | null>(null);

// The user's explicit pick for the current room, or null = "use the
// role's default".
export const chosenMode = writable<Mode | null>(null);

export function setChosenMode(mode: Mode): void {
  const remoteId = get(collabRemoteId);
  const role = get(collabRole);
  if (!remoteId || !role || !ALLOWED[role].includes(mode)) return;
  chosenMode.set(mode);
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, Mode>;
    all[remoteId] = mode;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* private mode / quota — the in-memory store still works this session */
  }
}

// Called by collab.ts when a connection is established / torn down.
export function enterCollabRoom(remoteId: string, role: Role, isOwner: boolean): void {
  collabRemoteId.set(remoteId);
  collabRole.set(role);
  collabIsOwner.set(isOwner);
  chosenMode.set(loadChosen(remoteId));
}
export function leaveCollabRoom(): void {
  collabRemoteId.set(null);
  collabRole.set(null);
  collabIsOwner.set(false);
  chosenMode.set(null);
}

// The mode actually in effect: the chosen mode clamped to the role
// ceiling, defaulting per role. null ⇒ not shared.
export const effectiveMode = derived([collabRole, chosenMode], ([role, chosen]): Mode | null => {
  if (!role) return null;
  const allowed = ALLOWED[role];
  if (chosen && allowed.includes(chosen)) return chosen;
  return allowed[0]; // editor→editing, reviewer→suggesting, viewer→viewing
});

export const modesAllowed = derived(collabRole, (role): Mode[] => (role ? ALLOWED[role] : []));
```

### 2. `collab.ts` wiring

- `joinWorkspace` / `rejoinKnownWorkspace` / `joinSharedLink`, once `role` and `access` are known: `enterCollabRoom(remoteId, role, access.owner === window.MDE.githubUsername && !!window.MDE.githubUsername)`.
- `teardownWorkspace()`: `leaveCollabRoom()`.
- `bindActiveDoc()` stops keying off `binding.role` for the mode-dependent bits. Extract them into `applyEditorMode(binding, mode)`:

```ts
function applyEditorMode(binding: DocBinding, mode: Mode): void {
  const suggesting = mode === "suggesting";
  const viewing = mode === "viewing";
  // suggestionExtensions still needs role for its own internal gate; pass
  // the *effective* mode's role-equivalent so an editor-in-suggesting
  // gets edit-interception too.
  const viewerRole = viewing ? "viewer" : suggesting ? "reviewer" : "editor";
  // reconfigure the editor's collab compartment with the right extensions
  window.MDE.reconfigureCollabMode({
    readOnly: viewing,
    suggestionExtensions:
      viewing ? [] : suggestionExtensions(binding.ydoc, identity.name, { viewerRole, viewerName: identity.name }),
  });
  if (viewing) lockToPreviewOnly();
  else unlockViewMode();
}
```

`window.MDE.reconfigureCollabMode` is a new bridge method `Editor.svelte` implements by reconfiguring its existing `editingModeCompartment` + `readOnlyCompartment` (both already exist — see `Editor.svelte` line ~37). `bindActiveDoc` calls `applyEditorMode(binding, get(effectiveMode)!)` where it currently does the `binding.role` branch.

- A module-level `effectiveMode.subscribe(...)` in `collab.ts`'s `init()` re-runs `applyEditorMode` on the **active** binding whenever the mode changes mid-session (guard: only when `workspaceRoom.activeDocId` and a binding exist). This is what makes the switcher live.

- `binding.awareness.setLocalState({ ..., role: binding.role, ... })` stays keyed on the true `binding.role` (presence shows the real role, not the self-selected mode) — unchanged.

### 3. `ModeSwitcher.svelte` (D6)

New component mounted in the topbar actions, before the Share group (`#topbarActionsCol .topbar-actions` in `index.html`, a new `<div id="mode-switcher-mount">`).

- **Rendered only when `$collabRole !== null`.** For a plain local document it does not exist.
- A dropdown button showing the current `$effectiveMode` (icon + label: "Editing" ✎ / "Suggesting" 💬-✎ / "Viewing" 👁). Opens to `$modesAllowed`, each row calls `setChosenMode(m)`. A single-option role (`viewer`) still renders the button (shows "Viewing") but the dropdown is inert / not shown.
- Uses the app's existing `.dropdown` / `.dropdown-menu` markup + `window.MDE.closeAllDropdowns` coordination, same as `MenuBar`.
- The standalone `#suggestionsBtn` topbar pencil is **removed** — its pending-suggestion count (`pendingSuggestionCount`) moves to a small badge on the ModeSwitcher button when `$effectiveMode !== "editing"` and count > 0. (Addresses D5's "what is the edit icon" for this scope; the full merge-into-comment-card is D-series.)

### 4. Mode-driven chrome

**A3 — hide Edit / Format / Insert menus.** `MenuBar.svelte`: wrap those three `<div class="dropdown">` blocks in `{#if $effectiveMode !== "viewing"}`. Care: their `bind:this` refs (`editMenuBtn`, `formatMenuBtn`, …) become `undefined` when hidden — MenuBar's own keyboard-nav / outside-click logic must null-check (audit `onMount` handlers). The `File`, `View`, `Help` menus stay (a viewer still exports, prints, opens Help).

**A4 — no comments in Viewing.** `import { effectiveMode }`:
- `#commentsBtn` in `index.html` is owned by `app.ts` — add `app.ts` logic (or a tiny Svelte wrapper) to `hidden` it and force `commentsPanelOpen.set(false)` when `$effectiveMode === "viewing"`.
- `MenuBar`'s `#menuComments` → `{#if $effectiveMode !== "viewing"}`.
- The inline comment highlight decorations (in `comments.ts` / the editor) — suppress when viewing. Simplest: `CommentsPanel` / the highlight extension already react to `commentsPanelOpen` + the thread list; add an `effectiveMode === "viewing"` guard where the highlight decoration set is built.

**C1 — floating sidebar button in Viewing.** New `#viewingSidebarBtn` in `index.html` (a fixed-position circular button, bottom-left, like `#focusModeExitBtn`'s mobile styling), `hidden` unless `$effectiveMode === "viewing"` **and** `#sidebar` has `.collapsed`. Click → `app.ts`'s existing `toggleSidebar()`. Wired in `app.ts` next to `#focusModeExitBtn`.

### 5. Publish gate (A1 + A2)

`MenuBar.svelte`, `import { collabRole, collabIsOwner }`:
- `#menuPublishSignedOut`, the Publish submenu (`#publishSubmenu`), and the GitHub Repo submenu → wrap in `{#if !$collabRole || $collabIsOwner}`.
- Net effect: a plain local document — unchanged. A shared workspace — only the owner sees Publish / repo actions. Viewer/reviewer/editor non-owners: gone.
- The topbar `#saveStatusRepoLink` / `#saveStatusGistLink` (owned by `app.ts`) already only render when the doc actually has a `gistId` / the workspace a `repoLink` — a non-owner has neither, so no change needed there.

### 6. A5 — linked-repo/Gist signal for collaborators

The owner knows their repo/Gist link locally; a collaborator has neither. Propagate one bit:

- **Server:** `encodeWorkspaceMeta()` gains a trailing `repoLinked` varuint (0/1). Sourced from a new `this.repoLinked` bool on `WorkspaceRoom`, set by a new `PUT /api/workspace/:id/meta` field (`{ repoLinked: boolean }`) the owner's `repo-sync.ts` calls on link / unlink. Persisted like `name`.
- **Client:** `applyWorkspaceMeta` reads the extra bool → a `workspaceRepoLinked` store. `DocInfoPanel.svelte` shows a read-only **"Synced to a GitHub repo (managed by the owner)"** row when `$workspaceRepoLinked && !$collabIsOwner`. The owner's own richer repo UI is unchanged.
- **Wire-compat:** older clients decoding the frame simply stop reading before the new bool — a trailing field is safe (the decoder doesn't over-read). New client against an old server: the field is absent → `readVarUint` would throw, so guard with `decoder` remaining-length check, defaulting to `false`.
- **Gist:** out of scope for A5's first pass — a shared *workspace* isn't Gist-linked (individual docs are, and doc-level Gist state isn't synced). Note it as a follow-up; the row copy says "GitHub repo" specifically.

### 7. Focus mode

**B1 — desktop exit affordance.** A top hover-toast, not a persistent bar:
- New `#focusHint` element in `index.html`: `position: fixed; top: 0; left: 50%; transform: translate(-50%, -100%)` (off-screen up), a pill reading **"Focus mode — press Esc or click to exit"** with the `#icon-x`. `transition: transform .18s`.
- `app.ts`, gated on `body.focus-mode`: a `mousemove` listener shows it (`transform: translate(-50%, 0)`) while the pointer Y < 48px, and a 2.5s idle timer hides it again. Also show it once for ~2s right when focus mode is entered (discovery). Click → `focusMode.set(false)`.
- The existing mobile `#focusModeExitBtn` is unchanged (mobile has no pointer hover; keep the always-visible button there).

**B2 — dim the preview too.**
- `scroll-sync.ts` already computes `computeBlockLineStarts(raw)` — the editor line number each preview top-level block starts at, in document order, parallel to the preview's rendered block children.
- New: when focus mode is on, on every editor selection change, compute `activeParagraphRange` → its start line → find which preview block index that line falls in (the last `blockLineStarts[i] <= startLine`) → add a `.focus-dim` class to every preview block child except that one; remove on focus-mode exit.
- Lives in `Preview.svelte` (or a small `preview-focus-dim.ts`), subscribing to `focusMode` + an editor-selection signal. The editor already emits selection changes app.ts consumes for scroll-sync; reuse that path (a `focusActiveLine` store, or extend the existing sync-scroll cursor signal).
- `.focus-dim { opacity: .35; transition: opacity .15s; }` in the preview stylesheet, mirroring `.cm-dimmed-line`.

## Data flow — switching to Viewing mid-session

```
User clicks ModeSwitcher → "Viewing"
  └─ setChosenMode("viewing")  → chosenMode store + localStorage[remoteId]
       └─ effectiveMode (derived) recomputes → "viewing"
            ├─ collab.ts effectiveMode.subscribe → applyEditorMode(activeBinding, "viewing")
            │     ├─ window.MDE.reconfigureCollabMode({ readOnly: true, suggestionExtensions: [] })
            │     └─ lockToPreviewOnly()   → #body.mode-preview, editor pane removed
            ├─ MenuBar: {#if $effectiveMode !== "viewing"} → Edit/Format/Insert unmount
            ├─ app.ts: #commentsBtn hidden, commentsPanelOpen → false
            ├─ comment highlight extension: decoration set → empty
            └─ #viewingSidebarBtn: eligible to show (if sidebar collapsed)
```

Switching back to Editing reverses each step (`unlockViewMode()`, menus remount, comments button returns).

## Error handling / edge cases

| Situation | Behaviour |
|---|---|
| `localStorage` unavailable (private mode) | `setChosenMode` catch — in-memory `chosenMode` still drives the session; nothing persists |
| Chosen mode in storage exceeds the current role (link downgraded from editor to viewer between visits) | `effectiveMode` clamps to `viewing`; the stale `chosenMode` is ignored (and overwritten next time the user picks) |
| Role resolves after the first `bindActiveDoc` (async) | `collabRole` starts `null` → `effectiveMode` `null` → editing behaves locally until `enterCollabRoom` fires, then the `effectiveMode.subscribe` re-applies. Same brief window every other synced field tolerates. |
| A5 bool from an old server (frame ends early) | decoder remaining-length guard → `repoLinked` defaults `false`, no row shown |
| Focus hint + a real toast overlapping at top of screen | `#focusHint` `z-index` below the toast container; they don't collide functionally |
| Viewer on desktop with the sidebar already open | `#viewingSidebarBtn` stays `hidden` (only shows when `.collapsed`) |

## Testing

**Unit (`tests/client/src/stores/collabMode.test.ts`):**
- `effectiveMode` clamps per role; defaults per role; honours a valid `chosenMode`; ignores an out-of-ceiling one.
- `setChosenMode` rejects a mode above the ceiling, persists a valid one keyed by `remoteId`, round-trips from `loadChosen`.
- `enterCollabRoom` / `leaveCollabRoom` reset cleanly.

**Unit (`tests/client/src/collab.test.ts`):**
- Joining as `editor` → `collabRole` `"editor"`, `collabIsOwner` reflects `access.owner`.
- `effectiveMode` change → `window.MDE.reconfigureCollabMode` called with the right `readOnly` / extension shape (stub the bridge method).
- `teardownWorkspace` → `leaveCollabRoom` (stores back to `null`).

**Component:**
- `ModeSwitcher.test.ts` — not rendered when `collabRole` is `null`; shows exactly the role's allowed modes; a click calls `setChosenMode`; the pending-suggestion badge shows only outside Editing.
- `MenuBar.test.ts` (extend) — Edit/Format/Insert hidden when `effectiveMode === "viewing"`, present otherwise; Publish/repo items hidden for a non-owner shared session, shown for owner and for local.
- `DocInfoPanel.test.ts` (extend) — the "Synced to a GitHub repo" row shows for a non-owner when `workspaceRepoLinked`, not for the owner.

**Server (`tests/src/workspace-room.test.ts`):**
- `PUT /meta { repoLinked: true }` (owner) persists + the next `encodeWorkspaceMeta` frame carries the bool; non-owner → 403.

**E2E (`tests/e2e/collab/`):**
- A reviewer switches to Viewing → editor pane gone, comments button gone, Format menu gone; switches back → all return.
- An editor collaborator (non-owner) does not see Publish to Gist / GitHub Repo in the File menu; the owner does.

**E2E (`tests/e2e/local/focus-mode.spec.ts`, extend):**
- Desktop: entering focus mode flashes the hint; moving the pointer to the top shows it; clicking it exits.
- Split view: with focus mode on, preview blocks outside the active paragraph get `.focus-dim`.

## Rollout / versioning

User-facing → **minor bump** (`1.50.0`). `CHANGELOG.md` `### Added` (mode switcher) + `### Changed` (viewer chrome, publish gating) + `### Fixed` (focus-mode desktop exit). One `whats-new-entries.ts` entry with a real screenshot (the mode switcher open, showing Editing/Suggesting/Viewing).

**Three implementation plans on one branch (`feat/collab-mode-chrome`), one release:**
1. **Mode model + switcher + mode-driven chrome** — `stores/collabMode.ts`, `collab.ts` wiring + `applyEditorMode` + `reconfigureCollabMode` bridge, `ModeSwitcher.svelte`, A3 / A4 / C1.
2. **Publish gate + linked-repo signal** — A1 / A2 in `MenuBar`; A5 server meta bool + `DocInfoPanel` row.
3. **Focus mode** — B1 hover-hint, B2 preview dimming.

Split at those boundaries if a plan runs long. Plan 1 is the load-bearing one; 2 and 3 are independent of each other.
