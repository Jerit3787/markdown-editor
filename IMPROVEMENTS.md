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

**Tested until v1.14.0** — items below may already be stale against
later releases; verify before starting each one.

---

## Phase 1 — Quick / low-risk fixes

Small, independent, each fixable and testable on its own.

### Editor
- [ ] Pressing Enter in the document title field saves the name and
      moves focus to the editor (currently it doesn't — or does
      something else; clarify exact current vs. desired behavior when
      picked up).
- [ ] Adding a heading (or similar block-prefix insertion) leaves the
      cursor positioned before the inserted marker instead of after
      it, forcing the user to move the cursor before typing.
- [ ] Checkbox list items render with a plain dot instead of an actual
      checkbox.
- [ ] Tab/indent key presses aren't handled in the editor at all
      (distinct from Phase 2's "tabbed space support" — this is about
      the raw Tab keypress doing nothing useful).

### Layout / sizing
- [ ] No minimum width on the document title field — when the name is
      short, there's a visible gap between the cloud (save-status)
      icon and the name.
- [ ] On desktop, the title field is slightly too small, cropping
      some text/letters.
- [ ] The preview pane's top padding/margin doesn't match its bottom,
      so the first line of text sits too close to the UI above it.
- [ ] Toolbar/tooltip ordering isn't grouped by type — re-arrange so
      related tools sit together.

### Mobile
- [ ] Focusing a cursor on mobile zooms the page and never restores
      zoom level afterward — force no-zoom-on-focus.
- [ ] In the stacked (up-down) editor/preview layout on small screens,
      scrolling is broken.
- [ ] The What's New modal should be a full-screen modal on mobile,
      navigated top-bottom rather than left-right.

### Comments
- [ ] Replying to a comment or marking one resolved is broken in
      practice (confirmed 2026-08-13) — investigate root cause; this
      shipped in v1.13.0 and needs a regression test once fixed so it
      doesn't silently break again.
- [ ] Selecting text then clicking "Add comment": once the user starts
      typing the comment body, the source text's highlight disappears.
- [ ] The "Add comment" floating button should only appear when the
      Comments panel is actually open.
- [ ] The Comments panel (currently a fixed right-hand overlay) blocks
      topbar buttons and doesn't share space with the editor/preview/
      document-list layout the way it should — it should sit alongside
      them instead of overlapping. (Partially informs Phase 3's full
      desktop redesign, which gives Comments its own permanent pane —
      but this is worth a lighter interim fix before that lands.)

### Gist / sharing
- [ ] Renaming a document and then updating its linked Gist creates a
      second Gist instead of updating the existing one in place.
- [ ] If a Gist is deleted (outside the app), the app still thinks the
      document is linked to it — no way to detect/clear the stale
      link.
- [ ] A shared document doesn't propagate a name change to other
      collaborators — if one party renames it, others don't see the
      new name.

### Images
- [ ] Some images fail to render — reproduction case:
      https://gist.github.com/Jerit3787/8343d265ba1ed4aa429dc191f9c90162
- [ ] A specific import/paste case fails to show the image at all
      (repro screenshot was attached when this was filed — get a
      fresh repro since the original attachment didn't resolve).
- [ ] The Images manager keeps listing an image even after every
      reference to it has been removed from the document.

---

## Phase 2 — Medium features

Each additive and independent enough to brainstorm → plan → ship on
its own, same process as every feature shipped this session.

- [ ] Unresolved-comment count badge on the Comments topbar icon and
      File menu entry.
- [ ] Gist management menu — permanently set a Gist public, enable/
      disable commenting on it.
- [ ] Add an "insert existing image" picker/autocomplete (browse
      already-uploaded images instead of only inserting new ones).
- [ ] Search & replace.
- [ ] More toolbar shortcuts — undo, a quick-access entry point for
      the Command Palette, similar quality-of-life additions Google
      Docs' toolbar has.
- [ ] Printing support.
- [ ] Replace an existing image's file in place (keep the same
      reference/position, swap the underlying image).
- [ ] Split the Format and Insert menu concerns apart (currently
      combined).
- [ ] MultiMarkdown syntax support.

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
- [ ] **Full UI redesign — desktop.** Restructure the chrome: logo +
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

- [ ] **Full UI redesign — mobile.** Same chrome restructuring,
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
- [ ] **Standardized modal layout.** Every modal in the app should
      follow one structure: header row (logo, title, quick action),
      scrollable content area, optional footer action row (e.g. a
      carousel's Back/Next). Currently each modal composes this
      somewhat differently.
