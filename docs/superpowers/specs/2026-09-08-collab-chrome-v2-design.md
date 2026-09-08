# Collaboration mode chrome v2 — disable, don't hide — design

**Status:** draft for review
**Date:** 2026-09-08
**Related backlog:** `ROADMAP.md` → Active → "Collab-mode chrome v2 — disable, don't hide" — items **CV2-1, CV2-2, CV2-3, CV2-4**. (CV2-5, the "Request access" flow, is its own spec — see Non-goals.)

## Goal

Revise how a shared-workspace collaborator's unavailable controls are presented. v1.50.0 **hid** the Edit / Format / Insert menus and the comments button in Viewing mode. This makes them — and Version History, Delete document, and Share — **visible but greyed and disabled** for the roles / modes that can't use them, matching Google Docs. A greyed control the user can see teaches the interface; a missing one is invisible.

## The governing distinction: mode vs role

Two independent signals gate chrome, and this spec keeps them separate:

| Signal | Source | Gates | Rationale |
|---|---|---|---|
| **effective mode** | `$effectiveMode` (`stores/collabMode.ts`) — the *view* the user chose | the **editing** chrome: Edit / Format / Insert menus, the comments button | An `editor` who switches to Viewing is choosing a lens; the editing tools grey while that lens is on and return when they switch back. Same as v1.50.0, just greyed not hidden. |
| **server role** | `$collabRole` (`viewer` / `reviewer` / `editor`) | the **permission** chrome: Share, Version History, Delete document | A permission, not a view. An `editor` who switches to Viewing still owns these; a `viewer` never has them regardless of mode. Matches Google Docs (a viewer/commenter has no version history, cannot delete, cannot manage sharing). |

Derived in `MenuBar.svelte` (and shared where needed):

```ts
const editingLocked = $derived($effectiveMode === "viewing" || $effectiveMode === "suggesting");
const viewingOnly    = $derived($effectiveMode === "viewing");
// viewer or reviewer in a shared workspace — never for a plain local doc or an editor
const nonEditorCollaborator = $derived(!!$collabRole && $collabRole !== "editor");
```

## Non-goals / deferred

- **CV2-5 — "Request access" flow.** A viewer/reviewer requesting a role bump, the owner approving. Needs a new `WorkspaceRoom` endpoint, pending-request storage, an owner notification channel (Share badge + a dialog row), and approve/deny UI — a request/approve *feature*, not chrome. **Its own spec, next.**
- **The editor pane in Viewing mode.** Viewing still shows preview-only (`lockToPreviewOnly()`), unchanged — that is the document view, not a "control".
- **The formatting toolbar (`#toolbar`) in Viewing mode.** Stays hidden (`{#if !$viewModeLocked}`), unchanged — a row of ~20 greyed icons is visual noise, not a discoverability aid, and Google Docs' viewing mode has no toolbar. In **Suggesting** the toolbar stays shown as today; whether its formatting buttons should grey there is a small open question below.
- **Server-side enforcement.** These are client chrome only. The server already rejects a non-editor's Y.Doc writes, version restores, and `/access` PUTs; this spec doesn't touch `authorize()`.
- **Menu keyboard-nav / focus semantics for greyed items.** A `disabled` `<button>` is skipped by the existing menu keyboard-nav naturally; no new focus-trap work.

## Background — current state (v1.50.0)

- `MenuBar.svelte`: `hidden={viewing}` on the Edit / Format / Insert `<div class="dropdown">` wrappers **and** their trigger `<button>`s (`#editMenuBtn` etc.); `hidden={viewing}` on `#menuComments`. `viewing = $effectiveMode === "viewing"`.
- `CommentsPanel.svelte` (`$effect`): `document.getElementById("commentsBtn").toggleAttribute("hidden", viewing)` + forces the panel closed; inline comment highlights are also suppressed in Viewing.
- `#menuVersionHistory`, `#menuDeleteDoc` (File menu) — gated only by `disabled={!hasActiveDoc}`, no role awareness.
- Topbar `#versionHistoryBtn` — no role awareness; `app.ts` only sets `.disabled` when there is no active doc.
- `#shareBtn` (plain HTML, click → `collab.ts` `openShareModal`) — no role awareness; `Share.svelte` renders a **read-only** dialog for a non-owner (`isReadOnly` derived) showing access + a working Copy link.
- Existing disabled styling already covers everything this spec needs: `.dropdown-menu button:…:disabled { opacity: .5; cursor: not-allowed }` (`_utilities.scss:196`), `.icon-btn:disabled { opacity: .4; cursor: not-allowed }`, `.share-pill:disabled` (`_share-workspace.scss:31`).

## Design

### CV2-1 — Edit / Format / Insert menus: open, every item greyed

**Decision (spec review):** the menu still **opens** in Viewing and Suggesting; every item inside is `disabled`. The `File`, `View`, `Help` menus are unaffected as menus (their individual items follow CV2-3/-4 / the comments rule).

`MenuBar.svelte`:

- Remove `hidden={viewing}` from the three `<div class="dropdown">` wrappers and from `#editMenuBtn` / `#formatMenuBtn` / `#insertMenuBtn`. The triggers open their dropdowns normally in every mode.
- Every action `<button>` inside those three menus gains `editingLocked` in its disable expression, e.g.
  `disabled={editingLocked || !hasActiveDoc}` (keeping the existing `!hasActiveDoc` / `gistBusy` / etc. terms).
- The `bind:this` refs (`editMenuBtn` …) are now always defined — the v1.50.0 audit note about null-checking `onMount` handlers is **reversed**: they can go back to non-optional. (Verify no `?.` was added that now hides a real bug.)

Modes: `editingLocked` is `viewing || suggesting`. A `reviewer` (whose ceiling is suggesting/viewing) therefore sees these menus greyed in both of their modes — this app has no format-as-suggestion, so that is correct. An `editor` in Editing mode sees them normally.

### CV2-1 — comments button: greyed in Viewing

- `MenuBar.svelte` `#menuComments`: `hidden={viewing}` → `disabled={viewingOnly || !hasActiveDoc}` (visible, greyed).
- `CommentsPanel.svelte` `$effect`: `toggleAttribute("hidden", viewing)` → `toggleAttribute("disabled", viewingOnly)` on `#commentsBtn`; keep forcing the panel closed and suppressing inline highlights when `viewingOnly` (a viewer has no comments access, matching Google Docs).
- Suggesting keeps full comments access (a reviewer comments) — unchanged.

### CV2-2 — Share button: disabled for a viewer / reviewer

**Decision (spec review):** fully disabled — a viewer/reviewer cannot open the Share dialog at all (they accept the loss of the read-only Copy-link view; that path returns in CV2-5's request-access flow).

- New paired hook or a small `$effect` (in `MenuBar.svelte`, which is always mounted, or a 3-line effect in `Share.svelte`): `document.getElementById("shareBtn").toggleAttribute("disabled", nonEditorCollaborator)` and the same on `#shareDropdownBtn`. Must compose with `app.ts:435`'s existing `.disabled = empty` (no active doc) — use a combined predicate, not a blind toggle, so re-enabling on doc-present doesn't clobber the role gate. Cleanest: move the `#shareBtn` disabled logic to one place that reads both `empty` and `nonEditorCollaborator`.
- Defense in depth: `collab.ts` `openShareModal()` returns early when `workspaceRoom.role` is `viewer` / `reviewer` (the button is best-effort UI).
- A non-owner **editor** is unchanged — Share still opens the existing read-only dialog (they can't change sharing but can see access / copy the link). Only viewer/reviewer lose the button.
- `.share-pill:disabled` already styles it; confirm the greyed pill still reads correctly against `--accent-dim`.

### CV2-3 / CV2-4 — Version History & Delete document: greyed for a viewer / reviewer

Gated on **role**, not mode — an editor in Viewing keeps both.

- `MenuBar.svelte`:
  - `#menuVersionHistory`: `disabled={nonEditorCollaborator || !hasActiveDoc}`
  - `#menuDeleteDoc`: `disabled={nonEditorCollaborator || !hasActiveDoc}`
- Topbar `#versionHistoryBtn`: a `$effect` (in `MenuBar.svelte` or `VersionHistory.svelte`, whichever is always mounted — `VersionHistory.svelte` is) `toggleAttribute("disabled", nonEditorCollaborator)`, composed with `app.ts:438`'s no-doc disable the same way as `#shareBtn`.
- Defense in depth: `VersionHistory.svelte`'s `open()` and the delete path already no-op without an editor role server-side; add a client early-return in `open()` for `viewer`/`reviewer` so a stale button can't open an empty panel.
- There is no standalone Delete button in the topbar — the File-menu item is the only entry point.

### Styling

Almost nothing new. Audit:

- `.dropdown-menu button:disabled` — exists (`_utilities.scss:196`). Applies to every greyed menu item automatically.
- `.icon-btn:disabled` — exists. Covers `#versionHistoryBtn`, `#commentsBtn`.
- `.share-pill:disabled` — exists. Covers `#shareBtn` / `#shareDropdownBtn`.
- One addition: a greyed **menu trigger** is NOT wanted here (the triggers stay active so the dropdown opens), so no `.menubar-btn:disabled` rule is needed. If a future need arises it's out of scope.
- `title=` / tooltip on a greyed control (why it's greyed) — deferred to UI-5 (hover tooltip chips) / the accessibility pass; a plain `title` attr may be added opportunistically but is not required here.

### Data flow

```
$effectiveMode ──▶ editingLocked / viewingOnly ──▶ MenuBar: Edit/Format/Insert items `disabled`
                                               └─▶ CommentsPanel $effect: #commentsBtn `disabled` (viewingOnly)
$collabRole ─────▶ nonEditorCollaborator ──────▶ MenuBar: #menuVersionHistory / #menuDeleteDoc `disabled`
                                            ├─▶ VersionHistory $effect: #versionHistoryBtn `disabled`
                                            └─▶ Share $effect: #shareBtn / #shareDropdownBtn `disabled`
                                                 + collab.ts openShareModal() early-return
```

Both stores already exist and are already reactive (v1.50.0). No new store, no new bridge method, no server change.

## Testing

| Area | Test | File |
|---|---|---|
| CV2-1 menus | In `effectiveMode` viewing/suggesting the Edit/Format/Insert triggers still open their dropdown, every item is `disabled`; in editing they're enabled; File/View/Help triggers unaffected | `tests/client/src/components/MenuBar.test.ts` (extend — the v1.50.0 "hidden" assertions become "disabled") |
| CV2-1 comments | `#menuComments` disabled in viewing, enabled in suggesting/editing; `CommentsPanel` sets `#commentsBtn` `disabled` (not `hidden`) in viewing and closes the panel | `tests/client/src/components/MenuBar.test.ts`, `CommentsPanel.test.ts` (extend) |
| CV2-2 Share | `#shareBtn` / `#shareDropdownBtn` get `disabled` for a `viewer` / `reviewer` session, not for `editor` / owner / local; `openShareModal()` early-returns for viewer/reviewer; composes with the no-active-doc disable | `tests/client/src/components/MenuBar.test.ts` or a Share effect test, `tests/client/src/collab.test.ts` (extend the "collab-mode role publishing" describe) |
| CV2-3/4 | `#menuVersionHistory` / `#menuDeleteDoc` / `#versionHistoryBtn` disabled for viewer/reviewer, enabled for editor (incl. editor-in-Viewing), owner, local; `VersionHistory.open()` early-returns for viewer/reviewer | `tests/client/src/components/MenuBar.test.ts`, `VersionHistory` test, `collab.test.ts` |
| e2e | A shared-workspace collaborator at `viewer` sees: Format menu opens with greyed items, Share button greyed & inert, Version History greyed; switching an `editor` to Viewing greys the menus but leaves Version History / Share / Delete active | `tests/e2e/collab/mode-switcher.spec.ts` (extend) |

## Rollout

User-facing → **minor bump**. `CHANGELOG.md` `### Changed` ("controls you can't use as a viewer/suggester are now greyed out instead of hidden, so the interface stays learnable"). One `whats-new-entries.ts` entry ("A Clearer View-Only Mode" — category "Collaboration") with a real screenshot: a `viewer` session with the Format menu open showing greyed items and a greyed Share button. `docs/TEST-COVERAGE.md` — update the v1.50.0 COLLAB rows (COLLAB-55/56) from "hidden" to "disabled" and add rows for the Share / version-history / delete gates. `ROADMAP.md` — move CV2-1..4 to shipped; CV2-5 stays as its own pending item.

## Open questions

1. **Toolbar formatting buttons in Suggesting mode.** Today the `#toolbar` is fully shown for a reviewer in Suggesting. Should its formatting buttons (Bold / Italic / lists / link / image / …) grey out there, consistent with the Format/Insert menus greying? Leaning **yes** for consistency, but it's a separate visible surface and this app's format-in-suggesting behaviour is itself unspecified (a D1–D5 concern). Could defer to the suggesting-mode redesign.
2. **Non-owner editor + Share.** This spec keeps the read-only Share dialog for a non-owner *editor* (only viewer/reviewer lose the button). Confirm that's the intent, vs. greying Share for every non-owner.
