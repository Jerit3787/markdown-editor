# Roadmap

Candidate features for this editor, tracked so nothing from past research or
past design decisions gets lost. Sourced from a competitive analysis against
17 other markdown editors (Typora, Obsidian, HackMD, StackEdit, Mark Text,
Zettlr, iA Writer, Notion, Bear, Joplin, HedgeDoc, Dillinger, and others,
August 2026), plus scope explicitly deferred while shipping other features.

Checked items are live in production; unchecked items are candidates, not
commitments.

## Shipped

- [x] Mermaid diagram rendering in the live preview (v1.1.0)
- [x] Dedicated full-screen diagram editor — templates, syntax reference (v1.2.0)
- [x] Diagram editor: hover-to-edit existing diagrams in place (v1.2.0)
- [x] Diagram export — Copy as SVG / Download PNG (v1.3.0)
- [x] Diagram editor pan & zoom, with reset view (v1.3.0)
- [x] Diagram editor Mermaid-aware syntax highlighting (v1.3.0)
- [x] KaTeX math rendering — `$inline$` / `$$block$$`, toolbar button to
      insert a snippet (v1.4.0)
- [x] Footnotes — `[^1]` references / `[^1]: text` definitions, toolbar
      button to insert an auto-numbered pair (v1.5.0)
- [x] Custom CSS on export — a global Settings field applied to HTML and
      PDF exports (v1.6.0)
- [x] Focus Mode — paragraph dimming, typewriter scrolling, hidden chrome,
      one combined toggle (v1.7.0)
- [x] Open Source Licenses — direct dependencies listed in the About
      modal, generated automatically at build time (v1.8.0)
- [x] Vim / Emacs keybindings — a Settings toggle, persisted, with a
      live status bar mode indicator (v1.9.0)
- [x] Command palette — global Ctrl/Cmd+Shift+P overlay (also reachable
      from the Help menu), fuzzy-searches every open document and ~35
      app commands (v1.10.0)
- [x] Slash commands — inline `/`-triggered insertion menu for block-level
      elements, anchored to the cursor (v1.11.0)
- [x] Version history with revert — automatic background snapshots for
      every document (local and shared alike), non-destructive restore
      (v1.12.0)
- [x] Threaded comments anchored to text — lightweight self-notes on
      local documents, full threaded/resolvable comments (role-gated)
      on shared ones, highlighted inline with a toggleable panel
      (v1.13.0)
- [x] Wikilinks + backlinks between documents — `[[Name]]` renders as a
      clickable/navigable preview link with `[[`-triggered autocomplete;
      document names are now enforced unique (silent `-2` suffixing,
      with a three-way Replace/Save-as/Cancel prompt only for a
      deliberate rename that collides) so link resolution is always
      unambiguous; bundled in the same release: a merged Document Info
      + Backlinks panel, and a sidebar sort-order fix (only a real
      content edit reorders the list, not merely opening a document)
      (v1.15.0)
- [x] Desktop view selector — Editor pane / Preview pane toggle buttons
      in the toolbar and View menu, sharing one toggle model; formatting
      toolbar restructured into a full-width row spanning the document
      sidenav + editor + preview, with overflowing buttons collapsing
      into a "⋮" menu instead of wrapping/scrolling (v1.16.0)
- [x] Mobile bottom sheets — the document sidenav and comments panel
      present as native-style bottom sheets on mobile (flush to the
      screen edges, dimmed backdrop + header, tap-outside/close-button
      dismissal) instead of the desktop-style overlay/side-panel
      presentation that squeezed the editor down to almost nothing on a
      phone; opening either sheet closes the other (v1.17.0)

## Backlog — quick wins

Small, client-side-only, drop into the existing render pipeline.

The quick-wins backlog is now empty — see the other tiers below.

## Backlog — leverage what we have

Extends existing Yjs / role infrastructure rather than adding new systems.

The leverage-what-we-have backlog is now empty — see the other tiers below.

## Backlog — bigger bets

New infrastructure, backend, or scope — each its own project.

- [ ] AI writing assist / chat-with-doc
- [ ] AI-generated diagrams from a text prompt (flagged as bigger-bets
      tier in the original diagram editor design doc — needs an LLM
      backend, cost/auth model)
- [ ] Plugin / extension system
- [ ] Multi-provider cloud sync (Drive, Dropbox, OneDrive)
- [ ] Slide / presentation export
- [ ] Tag system + graph view
- [ ] End-to-end encryption
- [ ] True WYSIWYG toggle
- [ ] Direct blog publishing (Blogger/WordPress)

## Partial / deferred considerations

Real options that came up while designing or building a shipped feature, set
aside rather than chosen — worth reconsidering on their own if they turn out
to matter later.

- [ ] Diagram export: additional formats/options beyond SVG + PNG — JPG/WebP,
      scale factor, padding, transparent-background toggle (explicitly out
      of scope for the export feature shipped in v1.3.0)
- [ ] Math delimiters: also recognize LaTeX-native `\(...\)` / `\[...\]`
      alongside `$...$` / `$$...$$` (first pass is `$`-only; see the KaTeX
      design doc's delimiter decision)
- [ ] PNG export via a second, export-only Mermaid render pass that keeps
      HTML-label text wrapping in the interactive preview, as an alternative
      to the global `htmlLabels: false` switch — only worth it if the native
      SVG `<text>` wrapping (shipped in v1.3.0 to fix PNG export) ever
      becomes a real readability complaint
- [ ] Focus Mode as separate independently-toggleable options (dim
      paragraphs / center cursor / hide chrome as three switches) instead
      of one combined toggle — deferred for scope; reconsider if users want
      to mix and match rather than an all-or-nothing distraction-free mode
- [ ] Focus Mode forcing a full-width editor-only view (restoring the prior
      view mode on exit) instead of just hiding chrome around whatever view
      was already active — deferred so split/preview users keep their
      layout; reconsider if hiding chrome alone doesn't feel focused enough
- [ ] A dedicated math editor / formula picker UI, instead of typing raw
      LaTeX (explicitly out of scope for KaTeX rendering, shipped v1.4.0)
- [ ] Per-document custom export CSS, instead of one global override —
      considered and rejected in favor of a global setting when custom
      export CSS shipped (v1.6.0); reconsider if different documents
      turn out to need different export styling
- [ ] Live preview of custom export CSS against the in-app editor/preview
      pane — the v1.6.0 feature deliberately only affects HTML/PDF export,
      never the live preview
- [ ] A structured, form-based diagram builder (nodes/edges as data,
      picked from a palette) rather than hand-written Mermaid source —
      prototyped (`flowchart-model.ts`, cascading node removal, a toolbar
      entry point) but abandoned in favor of the code + live-preview
      diagram editor that actually shipped as v1.2.0; worth reconsidering
      if users want a no-code diagram creation path
- [ ] Diagram-type-aware syntax reference panel in the diagram editor —
      currently one static cheat-sheet regardless of which diagram type
      (flowchart, sequence, ER, ...) is being edited
- [ ] Adopt a hand-written ` ```mermaid ` fence into an editable ref on
      first edit — hover-to-edit (shipped v1.2.0) only works for diagrams
      already backed by a ref; a hand-typed fence keeps rendering but
      isn't click-to-edit
- [ ] General fenced-code-block syntax highlighting (JS, Python, etc.) in
      the main markdown editor — only the diagram editor's Mermaid code
      pane got syntax highlighting (v1.3.0), not fenced code blocks in
      the document itself
- [ ] Smooth-scroll animation for footnote jump/back-jump links — v1.5.0
      shipped with plain native anchor-link behavior only ("a first pass")
- [ ] Full-bundle-accurate open source license list (every package
      actually in the built output — 215+ once transitive dependencies
      are counted, via a tool like `rollup-plugin-license`) instead of
      just the 19 direct dependencies — deferred for readability; worth
      reconsidering if a formal compliance requirement ever needs it
- [ ] Inline-formatting slash commands (Bold/Italic/Strikethrough/Inline
      code/Link) — v1.11.0 shipped block-level insertions only, at the
      user's explicit request; inline formatting stays toolbar- and
      Command-Palette-only for now
- [ ] Custom/user-defined slash commands — v1.11.0's 14 entries are a
      fixed, built-in list
- [ ] Text diff / change-highlighting between versions in Version
      History — v1.12.0 shipped full-content read-only preview only, no
      line-by-line comparison UI
- [ ] Manually-named version checkpoints ("save version now") — v1.12.0's
      history is fully automatic (throttled background snapshots); a
      manual save action was considered and explicitly deferred
- [ ] Age-based (rather than count-based) version retention — v1.12.0
      caps at the 50 most recent snapshots per document regardless of
      how old they are, not a calendar window
- [ ] Custom/user-defined Command Palette commands — v1.10.0 ships a
      fixed list matching what's already reachable via menus/toolbar
- [ ] Recent-commands / frequency-based ranking in the Command Palette —
      v1.10.0 uses pure fuzzy-match ranking only, no usage-history
      learning or persistence
- [ ] Cross-session persistence of the Command Palette's last query or
      selection — v1.10.0 always opens fresh
- [ ] A custom keybinding remapping UI for Vim/Emacs mode — v1.9.0 ships
      each package's stock default keymap only (both expose a JS API for
      remapping, just no in-app UI for it)
- [ ] Per-document Vim/Emacs keybinding preference — v1.9.0 is one global
      Settings choice, matching every other preference in this app
- [ ] Visual customization of the Vim-mode status bar indicator's
      position or format — v1.9.0 ships one fixed presentation
- [ ] Pixel-perfect / sub-block scroll interpolation in synced scrolling
      — the line-mapped sync-scroll fix snaps to block boundaries, which
      solved the reported problem; finer interpolation *within* a tall
      block is a possible future refinement
- [ ] Embedded license text (full MIT/MPL/Apache body) per package in
      the Open Source Licenses list — v1.8.0 shows just the identifier
      and a repository link, not the full license text for all 19
      dependencies
- [ ] Configurable Focus Mode dimming granularity (sentence vs.
      paragraph vs. off, as iA Writer offers) — v1.7.0 is paragraph-level
      only, the common default across editors that have this feature
- [ ] Focus Mode persisted across page loads — v1.7.0 is a session
      toggle that always starts off, not a sticky preference like theme
      or custom export CSS
- [ ] Per-reply comment deletion — v1.13.0's delete removes an entire
      note/thread only, not one reply within a thread
- [ ] Real-time push of new comments/replies over the existing
      collaboration WebSocket — v1.13.0 uses request/response HTTP
      (matching Version History's endpoints) with refetch-on-open, not a
      new sync-protocol message type; worth reconsidering if comments
      turn out to need the same live-ness as text/cursor sync
- [ ] Comment notifications (email or in-app) — no notification
      infrastructure exists in this app today; out of scope for v1.13.0
- [ ] Slide transition animation in the What's New carousel — v1.14.0
      swaps slides instantly, no animation
- [ ] An authoring/editing UI for What's New entries — v1.14.0 entries
      are added directly to `whats-new-entries.ts` as a manual step per
      release, same as CHANGELOG/ROADMAP updates already are
- [ ] Wikilink rename cascade — v1.15.0 renaming a document never
      rewrites `[[OldName]]` references inside other documents; they
      become "missing" links instead until fixed by hand
- [ ] Case-insensitive wikilink matching — v1.15.0 is exact-match only,
      the same simplicity tradeoff that motivated enforcing unique
      names in the first place
- [ ] Wikilink aliasing (`[[Name|Display Text]]`) — v1.15.0 supports
      only plain `[[Name]]`
- [ ] A "create new document" entry inline in the `[[` autocomplete
      popup — v1.15.0's popup only lists existing documents; creating
      a new one is still only reachable by typing a new name and
      closing `]]` by hand, or clicking a rendered "missing" link
- [ ] Toolbar button reordering/grouping by type — v1.16.0's overflow
      menu collapses whichever buttons don't fit in DOM order; it
      doesn't group related tools together first (needs a proposed
      grouping to react to, same reason this was deferred back in the
      original Phase 1 pass)
- [ ] Pinning the view selector visible while only the formatting
      buttons scroll on mobile — v1.16.0's mobile toolbar scrolls (or
      overflows into "⋮") as one unit; the selector isn't pinned
      separately
- [ ] Tabbed document/headings switcher on mobile — v1.17.0 shipped the
      bottom-sheet document sidenav/comments half of the mobile
      redesign mockup; the tabbed switcher is the remaining piece
- [ ] Swipe-to-dismiss for the mobile bottom sheets — v1.17.0 only
      supports tap-outside/close-button dismissal; a drag gesture is
      real new complexity (touch tracking, momentum, follow-the-finger
      animation) with no precedent elsewhere in this app, deferred
      unless tap-to-dismiss proves insufficient in practice
- [ ] Slide-up entrance animation for the mobile comments sheet —
      v1.17.0's sidenav sheet animates (reusing its existing
      slide-transition mechanism), but comments appears/disappears
      instantly since it's conditionally rendered rather than a
      persistent node; animating it would mean adopting a Svelte
      transition for just this one case
