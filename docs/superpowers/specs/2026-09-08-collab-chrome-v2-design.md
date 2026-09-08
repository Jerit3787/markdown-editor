# Collaboration mode chrome v2 — Google Docs parity for the non-editor experience — design

**Status:** ready for implementation-plan
**Date:** 2026-09-08
**Related backlog:** `ROADMAP.md` → Active → "Collab-mode chrome v2" — items **CV2-1, CV2-2, CV2-3, CV2-4**. (CV2-5, "Request access", is its own spec — see Non-goals.)

## Goal

Make the shared-workspace collaborator chrome behave like Google Docs, verified by a live walk-through of three real shared docs (viewer / commenter / editor links) in Sep 2026. **The effective mode is the primary gate; role only decides which modes are reachable, plus the Share button.** v1.50.0 handled the Viewing-mode *hiding* correctly for the editing menus but gated Version History and the comments button by the wrong signal and hid the Edit menu wholesale where Google condenses it.

## What Google Docs does (observed)

Walked a view-only link, a comment link, and an edit link, switching the editor through all three modes and opening File / Edit / View / Format in each state.

| Effective mode | Menu bar | Toolbar | Comments | **Version history** | Share (as editor) |
|---|---|---|---|---|---|
| **Editing** | full (File Edit View Insert Format Tools Extensions Help) | full | ✅ | ✅ | ✅ enabled |
| **Suggesting** | full | full; a few *structural* Format items greyed (Columns / Table / Image / Borders) | ✅ | **❌ greyed** | ✅ enabled |
| **Viewing** | **condensed** — Insert & Format menus **gone**; Edit reduced to *Copy* + *Select all*; File keeps its items but **greys** the unavailable ones (Make a copy, Share, Email, Rename, Move to bin, **Version history**, Details); View keeps *Mode* & *Comments* **greyed** | **gone entirely** | ❌ | **❌ greyed** | **❌ greyed & inert** |

Role layered on top:

- **Viewer** — stuck in Viewing, no mode switcher (*View ▸ Mode* greyed). A prominent **"Request edit access"** pill top-right, left of the avatar. Share button = greyed, **inert** status indicator; hovering shows the current link-access description.
- **Commenter** — mode switcher offers **Suggesting + Viewing**. In Suggesting: full menu bar + toolbar (formatting → tracked suggestion). Share button same greyed/inert.
- **Editor** — all three modes. Mode-switcher dropdown = three rows, each **icon + name + one-line description**: ✏️ *Editing* "Edit document directly" / 📝 *Suggesting* "Edits become suggestions" / 👁 *Viewing* "Read or print final document". Collapsed control = icon + caret (name shown when there's room).

**Takeaways:**

1. **Version history is Editing-mode-only.** Greyed in Suggesting *and* Viewing, for *every role* — an editor who picks Suggesting loses the entry until switching back. A mode lens, not a permission.
2. **The Viewing menu bar condenses** as a **hybrid**: a menu that would be entirely dead (Format, Insert) is *dropped*; a menu that is only partly dead (File, Edit, View) is *kept, with its unusable items greyed*.
3. **The Share button is greyed & inert in Viewing and for viewer/commenter.** An editor keeps it in Editing + Suggesting.
4. **The toolbar is gone in Viewing** — this app already does that (`{#if !$viewModeLocked}`). No change.
5. **Comments** available in Editing + Suggesting, gone in Viewing — v1.50.0 already gates this on `viewing` (just switch button hide → greyed).

## Decisions (all: follow Google Docs)

| # | Decision |
|---|---|
| **D-mode** | Every gate below keys off **`$effectiveMode`**. Role (`$collabRole`) only clamps `modesAllowed` (already, v1.50.0) and the Share button. |
| **D-editmenu** | Viewing → the **Edit** menu stays visible but **condensed**: keep `#menuFind` + `#menuCopy` (read-only-safe); **hide** `#menuUndo`, `#menuRedo`, `#menuFindReplace`, `#menuCut`, `#menuPaste` and the now-empty dividers. **Format & Insert** menus stay **hidden** in Viewing (v1.50.0 — Google drops them). *Supersedes the earlier "open with every item greyed" answer.* |
| **D-comments** | Viewing → `#commentsBtn` and `#menuComments` **greyed** (was: hidden); panel forced closed, inline highlights suppressed — unchanged from v1.50.0 otherwise. |
| **D-vh** | Version history (`#versionHistoryBtn`, `#menuVersionHistory`) **greyed unless `$effectiveMode === "editing"`** — greyed in Suggesting and Viewing for *everyone*, including an editor. |
| **D-share** | Share button (`#shareBtn`, `#shareDropdownBtn`) **greyed & inert** when `viewing` **or** `nonEditorCollaborator`. Editor keeps it in Editing + Suggesting. Greyed button retains a `title=` describing current access (Google shows this on hover). CV2-5's "Request edit access" attaches to the `nonEditorCollaborator` greyed state. |
| **D-delete** | Delete document (`#menuDeleteDoc`) **greyed unless `(isOwner or plain-local) AND $effectiveMode === "editing"`** — matches Google's owner-only "Move to bin", available only in Editing. This tightens today's behaviour for a **non-owner editor** (who can currently delete a shared doc) — intentional, per "follow Google". |
| **D-modedesc** | `ModeSwitcher.svelte`'s dropdown rows gain Google's one-line descriptions ("Edit document directly" / "Edits become suggestions" / "Read or print final document"). |
| **D-viewmenu** | No `View ▸ Mode` submenu is added — the topbar `ModeSwitcher` is this app's equivalent of Google's top-right switcher. (Google also has `View ▸ Mode`; not worth duplicating.) |

Predicates (derived in `MenuBar.svelte`, shared where needed):

```ts
const mode = $derived($effectiveMode);            // "editing" | "suggesting" | "viewing" | null
const viewing     = $derived(mode === "viewing");
const editingMode = $derived(mode === "editing" || mode == null);        // null = plain local doc
const nonEditorCollaborator = $derived(!!$collabRole && $collabRole !== "editor");
const canDeleteDoc = $derived((!$collabRole || $collabIsOwner) && editingMode);
```

No new store, bridge method, or server change — `$effectiveMode`, `$collabRole`, `$collabIsOwner` are already reactive from v1.50.0.

## Non-goals / deferred

- **CV2-5 — "Request access" flow.** A `WorkspaceRoom` endpoint, pending-request storage, owner notification, approve/deny UI, and Google's two surfacing points (a "Request edit access" pill near the title for viewers; a request field in the Share dialog for commenters). **Its own spec, next.** This spec leaves the hook: the Share button greyed for a `nonEditorCollaborator` is where the affordance attaches.
- **Format-as-suggestion** — Format/Insert actually producing suggestions in Suggesting mode. D1–D5.
- **Structural-item greying inside Format in Suggesting** (Google greys Table/Image/Columns/Borders for a commenter). This app's Insert menu is small and different — skip unless it falls out naturally.
- **The editor pane / preview-only in Viewing** — unchanged.
- **Owner-controlled download/print/copy restriction** — not a feature here.
- **Server-side enforcement** — `authorize()` already covers non-editor writes / restores / access-PUTs; add only the client-side backstops noted below.

## Background — current state (v1.50.0)

- `MenuBar.svelte`: `hidden={viewing}` on the Edit / Format / Insert `<div class="dropdown">` wrappers + triggers; `hidden={viewing}` on `#menuComments`. `viewing = $effectiveMode === "viewing"`.
- `CommentsPanel.svelte` `$effect`: `#commentsBtn.toggleAttribute("hidden", viewing)` + panel forced closed; inline highlights suppressed in Viewing.
- `#menuVersionHistory`, `#menuDeleteDoc` — `disabled={!hasActiveDoc}` only.
- `#versionHistoryBtn` / `#shareBtn` — `app.ts:438` / `app.ts:435` set `.disabled` only when no active doc.
- `ModeSwitcher.svelte` — dropdown rows show icon + name only.
- `:disabled` styling exists: `.dropdown-menu button:…:disabled { opacity:.5; cursor:not-allowed }` (`_utilities.scss:196`), `.icon-btn:disabled { opacity:.4 }` (`_utilities.scss:101`), `.share-pill:disabled` (`_share-workspace.scss:31`).

## Design

### CV2-1a — Edit menu condensed in Viewing (D-editmenu)

`MenuBar.svelte`, the Edit `<div class="dropdown">` (line ~230):

- Remove `hidden={viewing}` from the wrapper and `#editMenuBtn` — the menu opens in every mode.
- `#menuUndo`, `#menuRedo`, `#menuFindReplace`, `#menuCut`, `#menuPaste`: add `hidden={viewing}`. Wrap the dividers at lines 235 and 238 so an all-hidden group leaves no stray rule (simplest: `hidden={viewing}` on the divider between Redo and Find, and on the divider between Find-and-Replace and Cut).
- `#menuFind`, `#menuCopy`: unchanged (`disabled={!hasActiveDoc}`).
- **Format & Insert** wrappers + triggers: keep `hidden={viewing}` (v1.50.0).
- `editMenuBtn`'s `bind:this` is always defined again — restore non-optional access in `MenuBar`'s `onMount` handlers and re-verify the v1.50.0 null-check audit (Format/Insert refs stay conditionally-undefined, unchanged).

### CV2-1b — comments button + panel greyed in Viewing (D-comments)

- `MenuBar.svelte` `#menuComments`: `hidden={viewing}` → `disabled={viewing || !hasActiveDoc}`.
- `CommentsPanel.svelte` `$effect`: `toggleAttribute("hidden", viewing)` → `toggleAttribute("disabled", viewing)` on `#commentsBtn`; keep forcing `commentsPanelOpen.set(false)` and suppressing inline highlights when `viewing`.
- Suggesting unaffected.

### CV2-2 — Share button greyed & inert (D-share)

- Consolidate the `#shareBtn` / `#shareDropdownBtn` disabled logic in one always-mounted place (move `app.ts:435`'s no-active-doc toggle into a `MenuBar.svelte` `$effect`, or a tiny dedicated effect): `disabled = noActiveDoc || viewing || nonEditorCollaborator`.
- `collab.ts openShareModal()` early-returns when `get(effectiveMode) === "viewing"` or `workspaceRoom.role` is `viewer` / `reviewer` (best-effort backstop).
- Set `title` on `#shareBtn` to the current access description when greyed (reuse `Share.svelte`'s existing access-summary text; interim until UI-5's tooltip chips).
- `.share-pill:disabled` already styles it — confirm the greyed pill reads acceptably against `--accent-dim`.
- Editor in Editing / Suggesting, owner, and plain-local-doc: Share unchanged (opens the dialog — read-only for a non-owner editor, full for an owner).

### CV2-3 — Version history greyed unless Editing mode (D-vh)

- `MenuBar.svelte` `#menuVersionHistory`: `disabled={!editingMode || !hasActiveDoc}`.
- `#versionHistoryBtn` (topbar): an always-mounted `$effect` in `VersionHistory.svelte` sets `disabled` from `!editingMode`, composed with `app.ts:438`'s no-active-doc term (move that term into the same effect so neither clobbers the other).
- `VersionHistory.svelte` `open()` early-returns when `get(effectiveMode) != null && get(effectiveMode) !== "editing"` (a plain local doc — `effectiveMode == null` — still opens).
- Net: a `viewer`/`reviewer` never sees it enabled; an `editor` sees it only in Editing mode; a plain local doc is unchanged.

### CV2-4 — Delete document greyed unless owner + Editing mode (D-delete)

- `MenuBar.svelte` `#menuDeleteDoc`: `disabled={!canDeleteDoc || !hasActiveDoc}` where `canDeleteDoc = (!$collabRole || $collabIsOwner) && editingMode`.
- Backstop: `deleteDoc` already routes through the workspace room for a shared doc; no client early-return strictly required, but add one in the `onclick` guard for symmetry.
- No topbar Delete control.

### CV2 (D-modedesc) — ModeSwitcher descriptions

- `ModeSwitcher.svelte`: add a `DESCRIPTIONS` map — `editing: "Edit document directly"`, `suggesting: "Edits become suggestions"`, `viewing: "Read or print final document"` — rendered as a secondary line under each dropdown row's label (small `.mode-switcher-desc` style, muted). Collapsed button unchanged (icon + caret / label — UI-4 handles the label-drop).

### Styling

Audit only — every state is covered by an existing `:disabled` rule. One small addition: `.mode-switcher-menu .mode-switcher-desc { font-size: 12px; color: var(--text-dim); }` (or the repo's equivalent tokens).

### Data flow

```
$effectiveMode ─▶ viewing ──▶ MenuBar: Edit condensed (Find/Copy only), Format/Insert hidden, #menuComments disabled
                          ├─▶ CommentsPanel $effect: #commentsBtn disabled + panel closed + highlights off
                          └─▶ Share effect: #shareBtn / #shareDropdownBtn disabled (+ openShareModal early-return)
               ─▶ !editing ─▶ MenuBar: #menuVersionHistory disabled
                          └─▶ VersionHistory $effect: #versionHistoryBtn disabled + open() early-return
$collabRole / $collabIsOwner ─▶ nonEditorCollaborator ─▶ Share effect: (also) #shareBtn disabled + CV2-5 hook
                             └─▶ canDeleteDoc ─▶ MenuBar: #menuDeleteDoc disabled
```

## Testing

| Area | Test | File |
|---|---|---|
| CV2-1a | Viewing → `#editMenuBtn` opens; `#menuFind` + `#menuCopy` enabled, `#menuUndo`/`#menuRedo`/`#menuFindReplace`/`#menuCut`/`#menuPaste` `hidden`; Editing + Suggesting → all shown & enabled; Format/Insert `hidden` only in Viewing | `tests/client/src/components/MenuBar.test.ts` (extend — some v1.50.0 "hidden" cases change) |
| CV2-1b | `#menuComments` `disabled` (not `hidden`) in Viewing; `CommentsPanel` sets `#commentsBtn` `disabled` + closes panel in Viewing; Suggesting unaffected | `MenuBar.test.ts`, `CommentsPanel.test.ts` |
| CV2-2 | `#shareBtn`/`#shareDropdownBtn` `disabled` when `viewing` OR `nonEditorCollaborator`; enabled for an editor in editing/suggesting, an owner, and a plain local doc; `openShareModal()` early-returns; composes with no-active-doc; greyed button has a `title` | `MenuBar.test.ts` / Share effect test, `tests/client/src/collab.test.ts` |
| CV2-3 | `#menuVersionHistory` / `#versionHistoryBtn` `disabled` unless `effectiveMode === "editing"` — incl. greyed for an editor in Suggesting/Viewing; enabled for a plain local doc; `open()` early-returns | `MenuBar.test.ts`, `VersionHistory` test, `collab.test.ts` |
| CV2-4 | `#menuDeleteDoc` `disabled` for viewer / reviewer / non-owner editor / any non-Editing mode; enabled for owner-in-Editing and plain local doc | `MenuBar.test.ts`, `collab.test.ts` |
| D-modedesc | `ModeSwitcher` dropdown renders the three descriptions | `tests/client/src/components/ModeSwitcher.test.ts` |
| e2e | `viewer` collaborator: Edit menu opens condensed, Version History greyed, Share greyed & inert, comments greyed. `editor` → Suggesting: menus full, Version History greyed, comments live, Share enabled. `editor` → Viewing: Edit condensed, Format/Insert gone, Version History + Share + comments greyed | `tests/e2e/collab/mode-switcher.spec.ts` (extend) |

## Rollout

User-facing → **minor bump**. `CHANGELOG.md` `### Changed` ("view-only and suggesting modes now track Google Docs: version history is an editing-mode tool, the Edit menu keeps Find and Copy instead of vanishing, Share and comments grey out for people who can't use them, and deleting a document is the owner's call"). One `whats-new-entries.ts` entry ("A Clearer View-Only Mode" — "Collaboration") with a real screenshot (a viewer session: Edit menu open and condensed, Version History + Share greyed). `docs/TEST-COVERAGE.md` — update COLLAB-55/56 + add Share / version-history / delete rows. `ROADMAP.md` — CV2-1..4 → shipped; CV2-5 stays pending.

## Sources

Primary: live walk-through (Sep 2026) of three shared Google Docs — view-only, comment, and edit links — switching the editor between Editing / Suggesting / Viewing and opening File / Edit / View / Format in each state.

Secondary:
- [Switch view mode — Google Docs Editors Help](https://support.google.com/docs/answer/14917995)
- [Can't edit a file / Request edit access — Google Docs Editors Help](https://support.google.com/docs/answer/6239515)
- [Who can see version history — Google Docs Editors Community](https://support.google.com/docs/thread/4361422/who-can-see-version-history-and-how-far-does-it-go-back)
- [Can commenters see edit history? — CLRN](https://www.clrn.org/can-commenters-see-edit-history-on-google-docs/)
