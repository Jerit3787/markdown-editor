# Improvements Backlog

Tracks bugs and feature requests found through manual use, organized
into phases so work can proceed in manageable, independently-shippable
chunks instead of one undifferentiated list. Each phase is roughly
ordered by risk/size: Phase 1 items are small and independent enough to
fix directly with a regression test; Phase 2 items are medium,
additive features that each deserve their own brainstorm → plan → ship
cycle (matching this project's established process); Phase 3 items are
large enough that each is its own project.

**Process note:** every bug fix in Phase 1 should land with a
regression test that fails before the fix and passes after — several
of these (the comment-highlight-while-typing bug, the gist rename
duplication) are exactly the kind of regression that's cheap to prevent
with a test and expensive to rediscover by hand later.

**Current through v1.41.1** — verify against CHANGELOG.md before
starting an item if it's been a while since this was last updated.

---

## Phase 1 — Quick / low-risk fixes

Small, independent, each fixable and testable on its own. Everything
from the original pass has shipped (v1.15.0-fixes, 2026-08-13) except
the two items still listed below — see CHANGELOG.md for the full list
of what was fixed, including the real root causes found along the way
(a filename-sanitization bug was why images "couldn't be imported,"
not a rendering bug; a Gist API filename-matching bug was why renaming

- updating created a duplicate file, not a publish bug).

### Comments

- [ ] Replying to a comment or marking one resolved is broken in
      practice (confirmed 2026-08-13) — reviewed the full path (server
      routes, HTTP handlers, client fetch wrappers, panel UI) against
      the original design and found no defect; the server-side logic
      already has passing tests. Needs a fresh repro with specifics
      (exact steps, and whether it's a network error, a UI freeze, or
      a silent no-op) — couldn't reproduce blind, and this needs a
      real shared document with two GitHub-authenticated roles
      interacting to test properly.

### Layout / sizing

- [x] Toolbar/tooltip ordering isn't grouped by type. (Shipped v1.40.4 —
      the intended v1.40.3 never landed as its own commit on master
      before v1.40.4's bump superseded it.) The trailing insert cluster
      (link/image/table/hr/diagram/math/footnote/command-palette) was
      one ungrouped run of 9 buttons; re-grouped into media/reference
      insert, structural insert, and notation insert, with Command
      Palette set apart at the end since it isn't a content-insertion
      command.

### Mobile / collab layout (reported live with screenshots)

- [x] Share dialog's "Anyone with the link" label truncated mid-word on
      mobile Safari. (Shipped v1.41.1.) The width reserved for the
      native dropdown's arrow was tuned against desktop Chromium's
      narrower arrow chrome; widened the buffer and added a
      text-overflow ellipsis as a fallback.
- [x] The View menu dropdown could overflow off the right edge of the
      screen on mobile. (Shipped v1.41.1.) Every menu-bar dropdown used
      to hardcode which single item anchored to the right instead of the
      left, so it broke again the moment a different menu's dropdown
      grew wide enough to overflow — replaced with a runtime check that
      flips any dropdown to right-anchor only when it would actually
      overflow the viewport.
- [x] The workspace switcher's "Preview" badge could push past the
      sidebar's edge. (Shipped v1.41.1.) The Svelte-mounted wrapper
      around the switcher was missing the `display: contents` every
      other Svelte mount point in the app already has, so the
      switcher's own flex-shrink/ellipsis styling was never actually
      reachable.

---

## Phase 2 — Medium features

Each additive and independent enough to brainstorm → plan → ship on
its own, same process as every feature shipped this session.

- [x] Unresolved-comment count badge on the Comments topbar icon and
      File menu entry. (Shipped v1.30.0.)
- [x] Gist management menu. (Shipped v1.34.0 as a one-time
      public/secret choice at first publish — GitHub's API doesn't
      support changing an existing gist's visibility or toggling
      comments at all, so neither of those two original asks was
      buildable; see the design spec's feasibility finding.)
- [x] Add an "insert existing image" picker/autocomplete (browse
      already-uploaded images instead of only inserting new ones).
      (Shipped v1.32.0.)
- [x] Search & replace. (Shipped v1.29.0.)
- [x] More toolbar shortcuts — undo, a quick-access entry point for
      the Command Palette. (Shipped v1.31.0.)
- [x] Printing support. (Shipped v1.33.0.)
- [x] Replace an existing image's file in place (keep the same
      reference/position, swap the underlying image). (Shipped v1.32.0.)
- [x] Split the Format and Insert menu concerns apart. (Shipped
      v1.37.0.) Bold/Italic/Strikethrough moved into a new Format menu;
      Insert Link/Insert Image/Manage Images moved into a new Insert
      menu — pure relocation out of the overloaded Edit menu, no
      command or shortcut changes.
- [x] MultiMarkdown syntax support. (Shipped v1.36.0 as definition lists,
      superscript/subscript, and a structured document-metadata field —
      round-trips as a real Key: Value block on import/export. Citations
      & bibliography split off as its own separate, still-open item below.)
- [x] **Citations & bibliography.** (Shipped v1.37.0.) `[@key]`/`[#key]`
      citations resolve against a bibliography, with three independent
      per-document settings — marker syntax, bibliography source (typed
      text or a structured Document Info UI), and display style (numbered
      or inline author-year, the latter requiring structured storage).
- [x] Markdown compatibility checker. (Shipped v1.35.0 as a
      Document Info panel row flagging app-only and flavor-specific
      syntax. "Support all flavors of Markdown" was descoped — it's a
      separate, much larger effort that overlaps the MultiMarkdown
      syntax support item above, shipped in v1.36.0.)
- [x] **Shared document name sync.** (Shipped v1.28.0.) The name now
      lives in a `meta` Y.Map on the same per-document Y.Doc as
      `ytext`/`imagesMap` — the same pattern imagesMap already
      established, so it rides the existing sync/persistence wiring
      with no new message type. Gated the same way content edits
      already are (editor-only, enforced server-side); a
      collaborator's rename reapplies the app's global-uniqueness
      rule (silent `-2` suffix on collision) before it lands locally,
      same as `importRemoteDocs`.

---

## Phase 3 — Bigger bets

Large enough that each deserves its own full design cycle; not
sequenced relative to each other yet.

- [x] **Smart version-history grouping.** (Shipped v1.37.0.) 30-second
      capture instead of 5-minute, with sessions computed purely from
      timestamps (a 30-minute gap starts a new one) — a closed
      session's intermediate snapshots collapse to its final state,
      shown as collapsible rows in Version History. Diff view now
      compares any two selected entries, not just a version against
      the live document.
- [x] **Shared-document session separation.** (Shipped v1.41.1 — the
      intended v1.41.0 never landed as its own commit on master before
      v1.41.1's bugfixes were bundled into the same PR and superseded
      it.) Opening a share link now previews the workspace (never persisted)
      instead of always permanently committing it — a "Preview" badge
      and "Keep this workspace" action in the switcher, plus a "Preview
      only" option in the join-choice modal. A receiver with zero
      workspaces of their own still lands directly and permanently,
      since there's nothing to protect from clutter and losing their
      only workspace on reload would be worse than today.
- [x] **Suggestion-mode collaboration** (Google Docs parity). (Shipped
      v1.39.0.) Reviewer role becomes a suggester; edits become tracked
      insert/delete suggestions an editor can accept, reject, or the
      reviewer can withdraw. Viewer mode now hides the editor entirely
      (Preview-only, no visible edit surface) — comment permissions were
      left unchanged, matching each role's existing comment access.
- [x] **Full UI redesign — desktop.** (Shipped v1.16.0, plus earlier
      topbar work.) Restructure the chrome: logo +
      document name + sync icon + comment/history/share actions on
      one row, menu buttons below, toolset bar with a VS-Code-style
      view selector, then a four-pane row (document sidenav / editor /
      preview / comment sidenav), bottom status bar.

  <table>
      <tbody>
          <tr>
              <td rowspan=2>Logo</td>
              <td>Document name</td>
              <td>Sync Icon</td>
              <td rowspan=2>comment history share etc.</td>
          </tr>
        <tr>
              <td colspan=2>menu buttons (file, etc)</td>
        </tr>
        <tr>
          <td colspan=3>toolset bar</td>
          <td>view selector like vscode</td>
        </tr>
        <tr>
          <td>document sidenav</td>
          <td>editor</td>
          <td>preview</td>
          <td>comment sidenav</td>
        </tr>
        <tr>
          <td colspan=4>bottom bar</td>
        </tr>
      </tbody>
  </table>

- [x] **Full UI redesign — mobile.** (Shipped v1.17.0 + v1.18.0.) Same chrome restructuring,
      stacked layout (editor above preview, not side-by-side), with
      the document sidenav and comments panel moving into bottom-sheet
      modals, and a tabbed document/headings switcher for faster
      navigation on small screens.

  <table>
      <tbody>
          <tr>
              <td>Logo</td>
              <td>Document name</td>
              <td>Sync Icon</td>
              <td>comment history share etc.</td>
          </tr>
        <tr>
              <td colspan=4>menu buttons (file, etc)</td>
        </tr>
        <tr>
          <td colspan=3>toolset bar</td>
          <td>view selector like vscode</td>
        </tr>
        <tr>
          <td colspan=4>editor</td>
        </tr>
        <tr>
          <td colspan=4>preview</td>
        </tr>
        <tr>
          <td colspan=4>bottom bar</td>
        </tr>
      </tbody>
  </table>

  Document sidenav and comments move to a bottom-sheet modal on
  mobile. Use a tabbed document/headings switcher (older-style tabs)
  to help with quicker navigation in the smaller space.

- [x] **Standardized modal layout — Phase 1.** (Shipped v1.19.0.) Every
      modal in the app should follow one structure: header row (logo,
      title, quick action), scrollable content area, optional footer
      action row (e.g. a carousel's Back/Next). Currently each modal
      composes this somewhat differently.
- [x] **Standardized modal layout — Phase 2.** (Shipped v1.19.2.)
      Converted What's New to the shared `Modal` component too. Version
      History, the Comments mobile sheet, Command Palette, and the
      Diagram Editor's header are intentionally left as-is — see
      ROADMAP.md.
- [x] **Workspace core.** (Shipped v1.20.0.) First of four sub-projects
      toward workspace-level sharing (see ROADMAP.md) — the `Workspace`
      container itself, purely local: create/switch/rename/delete,
      documents scoped and movable between workspaces, transparent
      migration for existing users.
