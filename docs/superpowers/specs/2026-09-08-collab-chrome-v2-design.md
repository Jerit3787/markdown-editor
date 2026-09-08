# Collaboration mode chrome v2 — Google Docs parity for the non-editor experience — design

**Status:** draft for review (v2 — revised after Google Docs research)
**Date:** 2026-09-08
**Related backlog:** `ROADMAP.md` → Active → "Collab-mode chrome v2 — disable, don't hide" — items **CV2-1, CV2-2, CV2-3, CV2-4**. (CV2-5, the "Request access" flow, is its own spec — see Non-goals.)

## Goal

Bring the shared-workspace collaborator experience closer to Google Docs. v1.50.0 **hid** the editing menus and comments button in Viewing mode. This spec (a) makes unavailable controls **visible-but-greyed** rather than hidden where that aids learnability, and (b) fixes the substance — which roles actually lose which capabilities — to match Google Docs.

## Google Docs parity reference

Researched Sep 2026 (sources at the end). Google Docs has **three view modes** (Editing / Suggesting / Viewing) chosen from a top-right pill, gated by the viewer's **Drive role** (Editor / Commenter / Viewer):

| | **Editor** | **Commenter** | **Viewer** |
|---|---|---|---|
| Mode switcher | all 3 modes | Suggesting + Viewing | no switcher (Viewing only) |
| In **Suggesting** mode | full menus + toolbar **active** — every edit (incl. formatting, insert, delete) becomes a *tracked suggestion* | same | n/a |
| In **Viewing** mode | menu bar **condenses** to essentials (File with a reduced set, View, Help, plus word-count / print-preview); toolbar formatting controls **greyed/disabled**; a "Viewing" indicator | same | this is the only state |
| **Version history** | ✅ | ❌ greyed / unavailable | ❌ greyed / unavailable |
| **Make a copy / Download / Print** | ✅ | ✅ (unless owner disabled copy/print/download) | ✅ (unless owner disabled) |
| **Delete / Move to trash** | ❌ owner only | ❌ | ❌ |
| **Share button** | opens full dialog | opens dialog — sees the people-with-access list, management controls disabled, can **request** a role change from within it | opens dialog — same read-only view; also a prominent **"Request edit access"** affordance near the document title |
| **Comments** | ✅ | ✅ (add + reply) | ❌ can't see or add comments |

**Takeaways that change this spec vs. its first draft:**

1. **Suggesting mode does NOT grey the editing menus in Google Docs** — formatting/insert/delete all work and become suggestions. This app has no format-as-suggestion yet (text-only suggestions), so true parity is blocked on the D1–D5 redesign. → the editing-menu gate is **Viewing-only** here; Suggesting is left alone (see Open Questions for the interim).
2. **Google *condenses* the menu bar in Viewing**, it doesn't show Edit/Format/Insert greyed. The user's stated preference ("grey + keep visible, helps the user learn the interface") is a **deliberate divergence** — kept, but flagged.
3. **Google keeps the Share button working for viewers/commenters** (read-only dialog + request path). Fully disabling it (first-draft decision) diverges and removes a real capability. → **recommend reverting to: Share stays clickable, opens the existing read-only dialog.**
4. **Version history greyed for Commenter + Viewer** — matches this spec. ✅
5. **Delete is owner-only in Google** (editors can't either). This spec greys it for viewer/reviewer; whether to also gate non-owner editors is a separate call (Open Questions).

## The governing distinction: mode vs role

| Signal | Source | Gates | Why |
|---|---|---|---|
| **effective mode** | `$effectiveMode` (`stores/collabMode.ts`) | the **editing** chrome: Edit / Format / Insert menus, comments button | An `editor` who picks Viewing is choosing a lens — greyed while on, restored on switch back. |
| **server role** | `$collabRole` (`viewer` / `reviewer` / `editor`) | the **permission** chrome: Share, Version History, Delete | A permission, not a view — an `editor`-in-Viewing keeps these; a `viewer` never has them. |

```ts
const viewingMode = $derived($effectiveMode === "viewing");
// viewer or reviewer in a shared workspace — never a plain local doc or an editor
const nonEditorCollaborator = $derived(!!$collabRole && $collabRole !== "editor");
```

(Note: no `editingLocked = viewing || suggesting` — Suggesting is deliberately not gated here, per parity takeaway 1.)

## Non-goals / deferred

- **CV2-5 — "Request access" flow.** The viewer/reviewer → owner role-request path. Needs a `WorkspaceRoom` endpoint, pending-request storage, an owner notification channel, and approve/deny UI. Google surfaces it two ways (a "Request edit access" affordance near the title for viewers; a request field inside the Share dialog for commenters) — CV2-5 should do both. **Its own spec, next.**
- **Format-as-suggestion.** Making the Format / Insert menus actually produce suggestions in Suggesting mode — D1–D5 (suggesting-mode redesign).
- **The editor pane in Viewing.** Preview-only (`lockToPreviewOnly()`), unchanged.
- **Owner-controlled copy/print/download restriction** (Google's "disable downloading for viewers"). Not a feature this app has; out of scope.
- **Server-side enforcement.** `authorize()` already rejects non-editor writes / restores / access-PUTs; unchanged.

## Background — current state (v1.50.0)

- `MenuBar.svelte`: `hidden={viewing}` on the Edit / Format / Insert `<div class="dropdown">` wrappers **and** their trigger `<button>`s; `hidden={viewing}` on `#menuComments`. `viewing = $effectiveMode === "viewing"`.
- `CommentsPanel.svelte` (`$effect`): `#commentsBtn.toggleAttribute("hidden", viewing)` + forces the panel closed; inline highlights suppressed in Viewing.
- `#menuVersionHistory`, `#menuDeleteDoc` — only `disabled={!hasActiveDoc}`, no role awareness.
- Topbar `#versionHistoryBtn` — no role awareness; `app.ts:438` sets `.disabled` only when no active doc. Same pattern for `#shareBtn` at `app.ts:435`.
- `#shareBtn` (plain HTML) → `collab.ts` `openShareModal`. `Share.svelte` already renders a **read-only** dialog for a non-owner (`isReadOnly` derived) — people-with-access list, greyed controls, working Copy link.
- Existing `:disabled` styling covers every case: `.dropdown-menu button:…:disabled { opacity:.5; cursor:not-allowed }` (`_utilities.scss:196`), `.icon-btn:disabled { opacity:.4 }` (`_utilities.scss:101`), `.share-pill:disabled` (`_share-workspace.scss:31`).

## Design

### CV2-1a — Edit / Format / Insert menus: open, every item greyed — in Viewing only

`MenuBar.svelte`:

- Remove `hidden={viewing}` from the three `<div class="dropdown">` wrappers and their trigger `<button>`s (`#editMenuBtn` / `#formatMenuBtn` / `#insertMenuBtn`). Triggers open their dropdowns in every mode.
- Each action `<button>` inside those three menus adds `viewingMode` to its disable expression: `disabled={viewingMode || !hasActiveDoc}` (keeping existing `gistBusy` / etc. terms).
- The `bind:this` refs are always defined again — the v1.50.0 null-check audit note is **reversed**; restore non-optional access and verify no `?.` now masks a real bug.
- **Suggesting mode: unchanged.** Menus fully active (parity takeaway 1). The interim gap — formatting doesn't yet produce a suggestion — is noted in Open Questions and owned by D1–D5.

Divergence from Google (which condenses the menu bar in Viewing): deliberate, per the user's "keep it visible and greyed" preference.

### CV2-1b — comments button + panel: greyed in Viewing

- `MenuBar.svelte` `#menuComments`: `hidden={viewing}` → `disabled={viewingMode || !hasActiveDoc}`.
- `CommentsPanel.svelte` `$effect`: `toggleAttribute("hidden", viewing)` → `toggleAttribute("disabled", viewingMode)` on `#commentsBtn`; keep forcing the panel closed and suppressing inline highlights when `viewingMode` (a viewer has no comments in Google Docs).
- Suggesting keeps full comments access — unchanged.

### CV2-2 — Share button: stays clickable, opens the read-only dialog (revised)

**Revised recommendation (was: fully disable):** match Google — the Share button stays enabled for a viewer/reviewer and opens the **existing read-only dialog** (`Share.svelte`'s `isReadOnly` path: people-with-access list, greyed management controls, working Copy link). This:

- keeps parity with Google (viewers/commenters can open Share and see access);
- preserves a real capability (see who has access, copy the link);
- is the natural host for CV2-5's in-dialog "request access" field.

So **CV2-2 becomes: no button gating; instead, tighten the read-only dialog** — audit `Share.svelte` so *every* mutating control is `disabled` under `isReadOnly` (spot-check: the access-mode `<select>`, per-person role `<select>`s, remove buttons, add-people input, the general-link role `<select>` — most already are), and make the dialog's copy for a non-owner explicit ("You can view who has access. Only the owner can change sharing."). `isReadOnly` currently keys off `access.owner !== $githubUsername`; confirm it also holds for an anonymous (not-signed-in) link viewer.

If the user still wants Share fully hidden/disabled for viewer/reviewer, that path is: `#shareBtn`/`#shareDropdownBtn` get `disabled` via an always-mounted `$effect` composed with `app.ts:435`'s no-doc predicate, plus a `collab.ts openShareModal()` early-return. Recorded here but **not recommended**.

### CV2-3 — Version History: greyed for a viewer / reviewer

Gated on **role** (matches Google — Commenter + Viewer both lose it).

- `MenuBar.svelte` `#menuVersionHistory`: `disabled={nonEditorCollaborator || !hasActiveDoc}`.
- Topbar `#versionHistoryBtn`: an always-mounted `$effect` (`VersionHistory.svelte` is always mounted) sets `disabled` from `nonEditorCollaborator`, **composed** with `app.ts:438`'s no-doc predicate — move that predicate into one place that reads both, so neither clobbers the other.
- Defense in depth: `VersionHistory.svelte` `open()` early-returns for `viewer` / `reviewer`.

### CV2-4 — Delete document: greyed for a viewer / reviewer

- `MenuBar.svelte` `#menuDeleteDoc`: `disabled={nonEditorCollaborator || !hasActiveDoc}`.
- No topbar Delete control exists.
- Google is stricter (owner-only). Whether to also grey Delete for a **non-owner editor** is an Open Question — this spec's default leaves it available to them (consistent with an editor being able to change workspace structure elsewhere in this app).

### Styling

Audit only — no new rules expected:

- `.dropdown-menu button:disabled` — covers every greyed menu item.
- `.icon-btn:disabled` — covers `#versionHistoryBtn`, `#commentsBtn`.
- Menu **triggers** stay active (dropdown opens) → no `.menubar-btn:disabled` rule needed.
- Greyed-control tooltips ("why is this greyed") — deferred to UI-5 / the accessibility pass; an opportunistic `title=` is fine but not required.

### Data flow

```
$effectiveMode ─▶ viewingMode ─▶ MenuBar: Edit/Format/Insert items `disabled`, #menuComments `disabled`
                             └─▶ CommentsPanel $effect: #commentsBtn `disabled` + panel closed + highlights off
$collabRole ────▶ nonEditorCollaborator ─▶ MenuBar: #menuVersionHistory / #menuDeleteDoc `disabled`
                                        └─▶ VersionHistory $effect: #versionHistoryBtn `disabled`
                                             + open() early-return
Share: no button gate — Share.svelte isReadOnly path tightened + copy clarified
```

No new store, bridge method, or server change — `$effectiveMode` and `$collabRole` are already reactive from v1.50.0.

## Testing

| Area | Test | File |
|---|---|---|
| CV2-1a | Viewing → Edit/Format/Insert triggers still open, every item `disabled`; editing + **suggesting** → items enabled; File/View/Help unaffected | `tests/client/src/components/MenuBar.test.ts` (v1.50.0 "hidden" assertions → "disabled", and add the suggesting-still-enabled case) |
| CV2-1b | `#menuComments` disabled in Viewing only; `CommentsPanel` sets `#commentsBtn` `disabled` (not `hidden`) + closes panel in Viewing; Suggesting unaffected | `MenuBar.test.ts`, `CommentsPanel.test.ts` |
| CV2-2 | `Share.svelte` under `isReadOnly`: every mutating control `disabled`; non-owner copy string present; anon link-viewer also `isReadOnly`. Share button NOT disabled for viewer/reviewer | `tests/client/src/components/Share.test.ts` (extend) |
| CV2-3/4 | `#menuVersionHistory` / `#menuDeleteDoc` / `#versionHistoryBtn` disabled for viewer + reviewer, enabled for editor (incl. editor-in-Viewing) / owner / local; `VersionHistory.open()` early-returns for viewer/reviewer | `MenuBar.test.ts`, `VersionHistory` test, `tests/client/src/collab.test.ts` |
| e2e | A `viewer` collaborator: Format menu opens greyed, Version History greyed, Share opens the read-only dialog; an `editor` switched to Viewing: menus greyed but Version History / Share / Delete still active | `tests/e2e/collab/mode-switcher.spec.ts` (extend) |

## Rollout

User-facing → **minor bump**. `CHANGELOG.md` `### Changed` ("controls a viewer/suggester can't use are greyed instead of hidden; viewers and suggesters can open Share to see who has access and copy the link; version history and delete are correctly unavailable to them"). One `whats-new-entries.ts` entry ("A Clearer View-Only Mode" — "Collaboration") with a real screenshot (a viewer session, Format menu open with greyed items). `docs/TEST-COVERAGE.md` — update COLLAB-55/56 from "hidden"→"disabled" + add Share / version-history / delete rows. `ROADMAP.md` — CV2-1..4 → shipped; CV2-5 stays pending.

## Open questions

1. **CV2-2 direction.** Recommend **reverting** the first-draft "fully disable Share" to "Share stays clickable → read-only dialog" (Google parity + keeps copy-link / access visibility + hosts CV2-5's request field). Confirm, or keep it fully disabled.
2. **Suggesting-mode editing menus.** Google keeps them fully active (format → suggestion); this app can't yet. Options: (a) leave active as this spec does, gap tracked in D1–D5; (b) grey Format + Insert (not Edit) in Suggesting as an interim, with a tooltip. Leaning (a).
3. **Delete for a non-owner editor.** Google is owner-only. This spec greys Delete for viewer/reviewer only. Also gate non-owner editors (full Google parity), or leave as-is?
4. **Menu bar in Viewing: condense vs. greyed-open.** Google condenses (Edit/Format/Insert gone, File reduced). This spec keeps them visible+greyed per the user's earlier preference. Keep the divergence, or move toward Google's condensed bar?

## Sources

- [Switch view mode — Google Docs Editors Help](https://support.google.com/docs/answer/14917995)
- [Can't edit a file (Request edit access) — Google Docs Editors Help](https://support.google.com/docs/answer/6239515)
- [Share files from Google Drive — Google Docs Editors Help](https://support.google.com/docs/answer/2494822)
- [Learn more about access to Google files — Google Drive Help](https://support.google.com/drive/answer/16722399)
- [Can commenters see edit history on Google Docs? — CLRN](https://www.clrn.org/can-commenters-see-edit-history-on-google-docs/)
- [Who can see version history — Google Docs Editors Community](https://support.google.com/docs/thread/4361422/who-can-see-version-history-and-how-far-does-it-go-back)
- [How to track changes in Google Docs — PCWorld](https://www.pcworld.com/article/606677/how-to-track-changes-in-google-docs.html)
- [How to make a Google Doc view only — How-To Geek](https://www.howtogeek.com/752615/how-to-make-a-google-doc-view-only/)
