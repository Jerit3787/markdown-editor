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

**Tested until v1.15.0** — items below may already be stale against
later releases; verify before starting each one.

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

- [ ] Toolbar/tooltip ordering isn't grouped by type — re-arrange so
      related tools sit together. (Deferred: needs an actual proposed
      grouping to react to, not a guess at what "by type" means here.)

---

## Phase 2 — Medium features

Each additive and independent enough to brainstorm → plan → ship on
its own, same process as every feature shipped this session.

- [x] Unresolved-comment count badge on the Comments topbar icon and
      File menu entry. (Shipped v1.30.0.)
- [ ] Gist management menu — permanently set a Gist public, enable/
      disable commenting on it.
- [ ] Add an "insert existing image" picker/autocomplete (browse
      already-uploaded images instead of only inserting new ones).
- [x] Search & replace. (Shipped v1.29.0.)
- [ ] More toolbar shortcuts — undo, a quick-access entry point for
      the Command Palette, similar quality-of-life additions Google
      Docs' toolbar has.
- [ ] Printing support.
- [ ] Replace an existing image's file in place (keep the same
      reference/position, swap the underlying image).
- [ ] Split the Format and Insert menu concerns apart (currently
      combined).
- [ ] MultiMarkdown syntax support.
- [ ] Support all flavors of Markdown (CommonMark, GFM, MultiMarkdown,
      etc.) and add a Markdown compatibility checker under the
      Document Info panel — flag syntax that's flavor-specific or
      won't render the same elsewhere.
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

- [ ] **Smart version-history grouping.** Replace (or augment) the
      current time-window-based snapshotting with dynamic grouping
      closer to Google Docs' behavior: continuous edits within a
      session collapse into one entry, a real gap starts a new one,
      and small in-between changes nest under the session they
      belong to. Needs its own grouping algorithm design. Bundle in
      diff display between versions (already tracked as a deferred
      consideration from the original Version History feature).
- [ ] **Shared-document session separation.** A shared document is
      currently treated like any local document in the same window/
      session. Evaluate: either keep that, or make an opened shared
      document exclusive to its own window/session (local documents
      would need a separate window). Also relevant prep work if
      folder/repo sync is ever built.
- [ ] **Suggestion-mode collaboration** (Google Docs parity). Reviewer
      role becomes "suggester" — edits become suggestions the
      document's editor can approve (merge into the document) or
      reject (discard), rather than committing directly. Needs its
      own review of Google Docs' actual UX for this. Bundle in:
      viewer mode should fully hide the editor (no visible edit
      surface, comment-only), and a broader pass over collaboration-
      role behavior generally.
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
