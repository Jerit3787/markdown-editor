# Collaboration mode chrome v2 — Google Docs parity for the non-editor experience — design

**Status:** draft for review (v3 — revised after a live walk-through of Google Docs)
**Date:** 2026-09-08
**Related backlog:** `ROADMAP.md` → Active → "Collab-mode chrome v2" — items **CV2-1, CV2-2, CV2-3, CV2-4**. (CV2-5, "Request access", is its own spec — see Non-goals.)

## Goal

Bring the shared-workspace collaborator chrome in line with how Google Docs actually behaves, verified by walking three real shared docs (viewer / commenter / editor links) in Sep 2026. The headline correction: **the effective mode is the primary gate; role only decides which modes you can pick.** v1.50.0 got the *hiding* mostly right for Viewing but gated Version History and the comments button by the wrong thing.

## What Google Docs actually does (observed)

Walked a view-only link, a comment link, and an edit link, and switched the editor between all three modes.

| Effective mode | Menu bar | Toolbar | Comments | **Version history** | Share button (as an editor) |
|---|---|---|---|---|---|
| **Editing** | full (File Edit View Insert Format Tools Extensions Help) | full | ✅ | ✅ | ✅ enabled |
| **Suggesting** | full | full (a few *structural* items greyed: Columns / Table / Image / Borders — can't be a suggestion) | ✅ | **❌ greyed** | ✅ enabled |
| **Viewing** | **condensed** — Insert & Format menus **gone**; Edit reduced to *Copy* + *Select all*; File keeps its items but **greys** the unavailable ones (Make a copy, Share, Email, Rename, Move to bin, **Version history**, Details); View keeps *Mode* & *Comments* **greyed** | **gone entirely** | ❌ | **❌ greyed** | **❌ greyed** |

Role differences layered on top:

- **Viewer:** stuck in Viewing (no mode switcher — *View ▸ Mode* is greyed). A prominent **"Request edit access"** pill sits top-right, left of the avatar. The Share button is a greyed, **inert** status indicator (hover shows the current link-access description as a tooltip).
- **Commenter:** mode switcher offers **Suggesting + Viewing**. In Suggesting they get the full menu bar + toolbar (formatting becomes a tracked suggestion). Share button same inert/greyed state.
- **Editor:** all three modes. Mode switcher dropdown = three rows, each **icon + name + one-line description**: ✏️ *Editing* "Edit document directly" / 📝 *Suggesting* "Edits become suggestions" / 👁 *Viewing* "Read or print final document". Collapsed control = icon + caret (label shown when the toolbar has room).

**Key takeaways:**

1. **Version history is Editing-mode-only.** Greyed in Suggesting *and* Viewing, for *everyone* — an editor who picks Suggesting loses the menu entry until they switch back. Not a permission, a mode lens.
2. **The Viewing menu bar condenses** — Insert & Format disappear (they'd be 100% dead), Edit collapses to the two read-only items, and the *remaining* menus (File, View) keep their items but grey the unusable ones. This is a **hybrid**: drop a menu that would be entirely greyed; grey items inside a menu that is only partly greyed.
3. **The Share button is greyed/inert in Viewing mode and for viewers/commenters.** An editor keeps it in Editing + Suggesting. (This matches the user's *original* CV2-2 instinct — v2 of this spec was wrong to recommend reverting it.)
4. **The toolbar is gone in Viewing** — this app already does that (`{#if !$viewModeLocked}`). ✅ no change.
5. **Comments** available in Editing + Suggesting, gone in Viewing. v1.50.0 already gates the button/panel/highlights on `viewing`. ✅ (just change hide → the button greys; panel + highlights still suppressed).

## The gating model

Everything keys off **`$effectiveMode`**, plus one role predicate for Share and Delete:

```ts
const mode = $derived($effectiveMode);                 // "editing" | "suggesting" | "viewing" | null
const viewing   = $derived(mode === "viewing");
const editingMode = $derived(mode === "editing" || mode == null); // null = plain local doc
const nonEditorCollaborator = $derived(!!$collabRole && $collabRole !== "editor"); // viewer / reviewer
```

| Control | Disabled / hidden when |
|---|---|
| Edit / Format / Insert menus | `viewing` — **hidden** (Format/Insert) or **greyed-open** (Edit); see CV2-1 |
| Comments button (`#commentsBtn`, `#menuComments`) | `viewing` — greyed (button) / disabled (menu item); panel forced closed, highlights off |
| **Version history** (`#versionHistoryBtn`, `#menuVersionHistory`) | **`!editingMode`** — greyed in Suggesting *and* Viewing, for every role |
| Share button (`#shareBtn`, `#shareDropdownBtn`) | `viewing || nonEditorCollaborator` — greyed & inert |
| Delete document (`#menuDeleteDoc`) | `nonEditorCollaborator` (Open Question: also `!editingMode`, and/or owner-only) |
| Mode switcher options | already role-clamped by `modesAllowed` (v1.50.0) — unchanged |

No new store, bridge method, or server change — `$effectiveMode` and `$collabRole` are already reactive from v1.50.0.

## Non-goals / deferred

- **CV2-5 — "Request access" flow.** A `WorkspaceRoom` endpoint, pending-request storage, owner notification, approve/deny UI, and the two surfacing points Google uses (a "Request edit access" pill near the title for viewers; a request field inside the Share dialog for commenters). **Its own spec, next.** This spec should leave a hook: when the Share button is greyed for a `nonEditorCollaborator`, that's where CV2-5's "request access" affordance will attach.
- **Format-as-suggestion** — making Format/Insert actually produce suggestions in Suggesting mode (Google does; this app doesn't yet). D1–D5.
- **The editor pane / preview-only in Viewing** — unchanged.
- **Structural-item greying inside the Format menu in Suggesting** (Google greys Table/Image/Columns/Borders for a commenter). This app's Insert menu is small and different; skip unless it falls out naturally.
- **Owner-controlled download/print/copy restriction** — not a feature here.
- **Server-side enforcement** — `authorize()` already covers it.

## Background — current state (v1.50.0)

- `MenuBar.svelte`: `hidden={viewing}` on the Edit / Format / Insert `<div class="dropdown">` wrappers + their triggers; `hidden={viewing}` on `#menuComments`. `viewing = $effectiveMode === "viewing"`.
- `CommentsPanel.svelte` `$effect`: `#commentsBtn.toggleAttribute("hidden", viewing)` + panel forced closed; inline highlights suppressed in Viewing.
- `#menuVersionHistory`, `#menuDeleteDoc` — only `disabled={!hasActiveDoc}`.
- `#versionHistoryBtn` / `#shareBtn` — `app.ts:438` / `app.ts:435` set `.disabled` only when there is no active doc.
- `Share.svelte` — already renders a read-only dialog for a non-owner (`isReadOnly`).
- `:disabled` styling already exists: `.dropdown-menu button:…:disabled { opacity:.5; cursor:not-allowed }` (`_utilities.scss:196`), `.icon-btn:disabled { opacity:.4 }` (`_utilities.scss:101`), `.share-pill:disabled` (`_share-workspace.scss:31`).

## Design

### CV2-1 — Viewing menu bar: match Google's hybrid condense

**Recommendation:** keep v1.50.0's behaviour for **Format & Insert** (hidden in Viewing — Google drops them too), and for the **Edit** menu switch from hidden to **greyed-open** so the two read-only items (Find, Copy — this app has no "Select all" menu item) stay reachable and the rest grey. Net change from v1.50.0 is small.

`MenuBar.svelte`:

- **Format, Insert** `<div class="dropdown">` + triggers: keep `hidden={viewing}`.
- **Edit** `<div class="dropdown">` + `#editMenuBtn`: remove `hidden={viewing}` — the menu opens in Viewing. Grey the editing items (`#menuUndo`, `#menuRedo`, `#menuFindReplace`, `#menuCut`, `#menuPaste`) with `disabled={viewing || !hasActiveDoc}`; leave `#menuFind` and `#menuCopy` enabled (`disabled={!hasActiveDoc}` only).
- `bind:this` refs for Format/Insert stay conditionally-undefined (unchanged from v1.50.0); `editMenuBtn` becomes always-defined again — restore its non-optional handler access and re-verify the v1.50.0 audit note.

*(If the user prefers "grey everything, hide nothing" for full learnability, the alternative is: un-hide Format & Insert too and grey every item. Recorded, not recommended — Google drops them, and a 100%-greyed menu is noise.)*

### CV2-1 — comments button + panel: greyed in Viewing (not hidden)

- `MenuBar.svelte` `#menuComments`: `hidden={viewing}` → `disabled={viewing || !hasActiveDoc}`.
- `CommentsPanel.svelte` `$effect`: `toggleAttribute("hidden", viewing)` → `toggleAttribute("disabled", viewing)` on `#commentsBtn`; keep forcing the panel closed and suppressing inline highlights in Viewing.
- Suggesting keeps full comments — unchanged.

### CV2-2 — Share button: greyed & inert in Viewing, and for a viewer / reviewer

Matches Google (and the user's original instinct).

- An always-mounted `$effect` (in `MenuBar.svelte`, or move `app.ts:435`'s logic there) sets `#shareBtn` / `#shareDropdownBtn` `disabled` from **`viewing || nonEditorCollaborator`**, composed with the existing no-active-doc predicate — one place computes all three terms so none clobbers another.
- `collab.ts openShareModal()` early-returns when `workspaceRoom.role` is `viewer`/`reviewer` **or** the effective mode is `viewing` (best-effort UI backstop).
- **Editor in Editing or Suggesting → Share stays enabled** (opens today's dialog — read-only if they're a non-owner, full if owner). Only Viewing mode, or a viewer/reviewer role, greys it.
- The greyed button keeps its **hover tooltip** describing current access (Google does this) — nice-to-have, can lean on the UI-5 tooltip work; a plain `title=` is an acceptable interim.
- **CV2-5 hook:** the greyed-for-`nonEditorCollaborator` state is where "Request edit access" will live.
- `.share-pill:disabled` already styles it.

### CV2-3 — Version History: greyed unless effective mode is Editing

**Corrected from v2** (was "role-gated; editor-in-Viewing keeps it"). Google greys it in Suggesting *and* Viewing for everyone.

- `MenuBar.svelte` `#menuVersionHistory`: `disabled={!editingMode || !hasActiveDoc}`.
- `#versionHistoryBtn` (topbar): always-mounted `$effect` (`VersionHistory.svelte` is always mounted) sets `disabled` from `!editingMode`, composed with `app.ts:438`'s no-doc predicate.
- `VersionHistory.svelte` `open()` early-returns when `!editingMode`.
- Result: a `viewer`/`reviewer` never sees it enabled (their modes are viewing/suggesting); an `editor` sees it only while in Editing mode. Exactly Google.

### CV2-4 — Delete document: greyed for a viewer / reviewer

- `MenuBar.svelte` `#menuDeleteDoc`: `disabled={nonEditorCollaborator || !hasActiveDoc}`.
- Google is stricter (greyed in Suggesting/Viewing for editors too — "Move to bin" was greyed in every non-Editing state I saw, and is owner-only anyway). **Open Question:** match that with `!editingMode`, and/or gate to `collabIsOwner`.
- No topbar Delete control.

### Styling

Audit only:

- `.dropdown-menu button:disabled` — covers every greyed menu item.
- `.icon-btn:disabled` — covers `#versionHistoryBtn`, `#commentsBtn`.
- `.share-pill:disabled` — covers `#shareBtn` / `#shareDropdownBtn`.
- Menu **triggers** that stay open (Edit) don't need a `:disabled` rule.
- Greyed-control tooltips — lean on UI-5 / a11y pass; `title=` interim is fine.

### Data flow

```
$effectiveMode ─▶ viewing ──▶ MenuBar: Edit greyed-open (Format/Insert stay hidden), #menuComments disabled
                          ├─▶ CommentsPanel $effect: #commentsBtn disabled + panel closed + highlights off
                          └─▶ Share $effect: #shareBtn / #shareDropdownBtn disabled
               ─▶ !editing ─▶ MenuBar: #menuVersionHistory disabled
                          └─▶ VersionHistory $effect: #versionHistoryBtn disabled + open() early-return
$collabRole ───▶ nonEditorCollaborator ─▶ MenuBar: #menuDeleteDoc disabled
                                       └─▶ Share $effect: (also) #shareBtn disabled  + CV2-5 hook
```

## Testing

| Area | Test | File |
|---|---|---|
| CV2-1 Edit menu | Viewing → `#editMenuBtn` still opens; `#menuUndo`/`#menuRedo`/`#menuFindReplace`/`#menuCut`/`#menuPaste` `disabled`, `#menuFind`/`#menuCopy` enabled; Suggesting + Editing → all enabled. Format/Insert still `hidden` in Viewing | `tests/client/src/components/MenuBar.test.ts` (extend — some v1.50.0 "hidden" cases become "disabled") |
| CV2-1 comments | `#menuComments` disabled (not hidden) in Viewing; `CommentsPanel` sets `#commentsBtn` `disabled` + closes panel in Viewing; Suggesting unaffected | `MenuBar.test.ts`, `CommentsPanel.test.ts` |
| CV2-2 Share | `#shareBtn`/`#shareDropdownBtn` `disabled` when `viewing` OR `nonEditorCollaborator`; enabled for an editor in editing/suggesting, for the owner, and for a plain local doc; `openShareModal()` early-returns in those cases; composes with no-active-doc | `MenuBar.test.ts` / a Share effect test, `tests/client/src/collab.test.ts` |
| CV2-3 | `#menuVersionHistory` / `#versionHistoryBtn` `disabled` unless `effectiveMode === "editing"` — incl. greyed for an *editor* who switched to Suggesting/Viewing; `open()` early-returns; enabled for a plain local doc | `MenuBar.test.ts`, `VersionHistory` test, `collab.test.ts` |
| CV2-4 | `#menuDeleteDoc` `disabled` for viewer/reviewer, enabled for editor / owner / local | `MenuBar.test.ts` |
| e2e | `viewer` collaborator: Edit menu opens greyed, Version History greyed, Share greyed & inert, comments button greyed. `editor` → Suggesting: menus full, but Version History greyed and comments live. `editor` → Viewing: Edit greyed-open, Format/Insert gone, Version History + Share + comments all greyed | `tests/e2e/collab/mode-switcher.spec.ts` (extend) |

## Rollout

User-facing → **minor bump**. `CHANGELOG.md` `### Changed` ("view-only and suggesting modes now match Google Docs more closely — version history is an editing-mode tool, the Edit menu greys its editing items rather than vanishing, and Share / comments grey out for people who can't use them"). One `whats-new-entries.ts` entry ("A Clearer View-Only Mode" — "Collaboration") with a real screenshot (a viewer session: Edit menu open with greyed items, Version History + Share greyed). `docs/TEST-COVERAGE.md` — update COLLAB-55/56, add Share / version-history / delete rows. `ROADMAP.md` — CV2-1..4 → shipped; CV2-5 stays pending.

## Open questions

1. **CV2-1 Edit menu.** Recommend: Format/Insert stay hidden in Viewing (Google drops them), Edit becomes greyed-open (keeps Find/Copy reachable). Accept, or grey-open all three for maximum learnability?
2. **CV2-4 Delete.** Match Google fully — grey Delete in Suggesting/Viewing for editors too (`!editingMode`) and/or gate to the owner? Or keep it simple (viewer/reviewer only)?
3. **Version history for a reviewer, ever.** Confirmed correct that it's greyed for them in all their modes (their ceiling is Suggesting, and VH is Editing-only). No action — just confirming the model.
4. **Mode switcher rows.** Google's dropdown shows icon + name + a one-line description per mode. This app's `ModeSwitcher` shows icon + name only. Add the descriptions (small copy change), or leave for UI-4's compaction pass?

## Sources

Primary: live walk-through (Sep 2026) of three shared Google Docs — view-only, comment, and edit links — including switching the editor between Editing / Suggesting / Viewing and opening File / Edit / View / Format menus in each state.

Secondary:
- [Switch view mode — Google Docs Editors Help](https://support.google.com/docs/answer/14917995)
- [Can't edit a file / Request edit access — Google Docs Editors Help](https://support.google.com/docs/answer/6239515)
- [Who can see version history — Google Docs Editors Community](https://support.google.com/docs/thread/4361422/who-can-see-version-history-and-how-far-does-it-go-back)
- [Can commenters see edit history? — CLRN](https://www.clrn.org/can-commenters-see-edit-history-on-google-docs/)
