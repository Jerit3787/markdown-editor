# Tab-Per-Document Routing — Design

**TODO item:** #23's final deferred piece — "I want a tab/window opens one document/workspace," the Google-Docs-style URL-per-document architecture. The multi-tab data-loss safety fix (`docs/superpowers/specs/2026-08-18-multi-tab-save-safety-design.md`, already merged) was deliberately shipped first so this feature builds on top of a codebase where concurrent tabs are already safe.

## Scope — Phase 1

This is a large feature; the user explicitly chose to scope this pass down to the core mechanism plus its actual payoff, deferring everything else:

**In scope:**
- The URL reflects and drives which document is active, per tab: deep links work, browser back/forward works, switching documents updates the URL.
- Sidebar document rows become real links, so Ctrl/Cmd-click or middle-click opens a document in a genuinely new browser tab — the actual "more tabs = more productivity" payoff, not just a cosmetic URL change.

**Explicitly deferred (future work, not this spec):**
- Any "this document is open in another tab" awareness/indicator UI.
- Workspace-level URLs (a URL that opens a workspace with no specific document).
- Converting other doc-switch entry points (Command Palette, "Open Recent," wikilinks) into real links with native new-tab support. They still get the URL-sync benefit for free (see Architecture), just not the Ctrl/Cmd-click-to-new-tab behavior.

## Architecture

**No routing library.** The need is one dynamic path segment with no nesting, and the codebase already hand-rolls its one existing URL pattern (`collab.ts`'s `SHARE_PATH` regex for share links). A small new module, `client/src/router.ts`, exports:
- `parseDocIdFromPath(pathname: string): string | null` — pure, unit-tested.
- `pushDocUrl(docId: string): void` — calls `history.pushState`.
- `initRouter(): void` — sets up a `popstate` listener and consumes the initial URL on load.

**URL scheme:** `/d/<docId>` — no mode suffix. `wrangler.jsonc`'s asset-serving config already anticipates this exact shape in its own comment (`/d/<docId>/edit`), but the mode segment doesn't carry meaning here: a mode (`view`/`review`/`edit`) reflects a *share link's* granted role, and these are your own local documents — you always have full access. Doc IDs (`uid()` in `docs.ts`) are already lowercase alphanumeric, safe in a path with no encoding needed. `/d/<docId>` and `/w/<workspaceId>/<docId>/<mode>` (the existing share-link pattern) are disjoint — a path matches at most one of them — so `router.ts` and `collab.ts`'s existing `SHARE_PATH` handling coexist with no ordering dependency; each simply no-ops on a path that isn't its own.

**Single integration point — `app.ts`'s existing `activeIdStore.subscribe(...)` (currently line 223).** Not `switchDoc` (see below for why that was reconsidered): this subscription already fires on *every* change to which document is active, from any source — a writable's subscriber "fires immediately with the current value AND synchronously on every future `.set()`" (per its own existing comment), which is also how it already drives loading the editor. It already tracks a `lastLoadedId`/`firstFire` guard to skip redundant re-fires for the same id; the URL push reuses that same guard, skipping the very first (synchronous, load-time) fire so it never fights with `initRouter`'s own initial-URL consumption, and only pushing on genuine subsequent changes.

This one hook covers every way the active document can change — `window.MDE.switchDoc` (used by `DocList.svelte`'s row click, `MenuBar.svelte`'s "Open Recent," and `CommandPalette.svelte`'s doc-jump command all funnel through it), *and* `stores/docs.ts`'s `ensureActiveDocInWorkspace` (used by `WorkspaceSwitcher.svelte` when switching or creating a workspace), which sets `activeIdStore` directly through a private `setActiveId()` helper, bypassing `switchDoc` entirely. Hooking into `switchDoc` instead (an earlier draft of this design) would have silently missed the workspace-switching path. Only `DocList.svelte`'s rows additionally need the anchor restructuring below, since that's the one surface getting native Ctrl/Cmd-click support in this phase.

## Deep link + fallback behavior

On load, `initRouter()` checks `location.pathname` against `/d/<docId>`. If it matches and that document exists in the locally-loaded `docsStore`: call `switchWorkspace(doc.workspaceId)` then `switchDoc(doc.id)` — the same real functions manual navigation uses, so shared/collaborative-document connection logic (already reactive to `activeIdStore` changes) "just works" with no new integration, and this now wins over the `mde:active`/`mde:activeWorkspace` localStorage fallback. If the document doesn't exist locally (stale link, or a `/d/...` URL opened in a different browser profile than the one that created it — unlike `/w/...` share links, which fetch from the server, `/d/...` only makes sense within the profile that owns the document), fall back to the same behavior as visiting bare `/`: `history.replaceState` back to `/` and let the existing localStorage-fallback logic in `docs.ts`/`workspaces.ts` pick the last-active document.

## Sidebar rows → real links

`DocList.svelte`'s rows are currently a plain `<div class="doc-row" onclick={...}>` containing sibling `<button>`s (`.doc-outline-toggle`, `.doc-menu-btn`) alongside the document icon and name. Nesting a `<button>` inside an `<a>` is invalid HTML — so this isn't a one-line `href` addition. The fix: wrap just the icon + name (the "title" portion a user actually clicks to open the document) in `<a href="/d/<id>">`, keeping `.doc-outline-toggle` and `.doc-menu-btn` as siblings within the same `.doc-row` container, not descendants of the anchor.

The anchor's click handler must distinguish a plain click from a modified one:

```ts
function onRowClick(e: MouseEvent, id: string) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser handle it natively
  e.preventDefault();
  select(id);
}
```

A plain left-click prevents the default navigation and does the existing in-tab `select(id)` (→ `window.MDE.switchDoc`). Ctrl/Cmd-click, Shift-click, and middle-click (`button !== 0`, checked via a `mousedown`/`auxclick` handler for the middle-button case, since browsers don't fire a normal `click` for the middle button) fall through to the browser's native "open link" behavior — this is what actually opens a new tab. Getting this modifier check right is the crux of the whole feature: an anchor that unconditionally calls `preventDefault()` would silently swallow every modified click into an in-tab switch, defeating the point entirely.

## Edge cases

- **The active document becoming `null`** (deleting the last document in a workspace, landing on the empty state) should `replaceState` back to `/` rather than leaving a dead `/d/<deleted-id>` entry that a "back" navigation would just bounce off of again. A real, non-null document change gets `pushState` (a genuine new location worth returning to via back/forward).
- Comments (`CommentsPanel.svelte`) and Version History (`VersionHistory.svelte`) both already read the active document reactively via `activeIdStore`/`getActiveDoc()`, re-subscribing on every switch — they need no changes.

## Testing

`parseDocIdFromPath` is a pure function — direct unit tests: matches `/d/<id>`, returns `null` for `/`, `/w/...` share links, and malformed paths.

`app.ts`'s `switchDoc` wrapper and the router's load-time/`popstate` wiring involve DOM/`history`/browser APIs without existing test infrastructure for that layer in this codebase (same boundary already established for `collab.ts`'s orchestration functions). Verified live in a browser instead: deep-linking to a document's `/d/<id>` URL loads it correctly; switching documents updates the URL and browser back/forward navigates between them; Ctrl/Cmd-click and middle-click on a sidebar row open a genuine new tab showing that document, while a plain click still switches in-tab; a `/d/<id>` URL for a nonexistent document falls back to `/` cleanly.
