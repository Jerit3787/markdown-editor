# Roadmap & Backlog

The single planning surface for this editor: active work, feature
candidates, deferred design considerations, and the shipped log. Nothing
here is a commitment — checked items under **Shipped** are live in
production; everything else is a candidate.

Sources: a competitive analysis against 17 other markdown editors
(Typora, Obsidian, HackMD, StackEdit, Mark Text, Zettlr, iA Writer,
Notion, Bear, Joplin, HedgeDoc, Dillinger, and others, August 2026);
bugs and feature requests found through manual use; and scope explicitly
deferred while shipping other features.

## How work is sized

- **Small fix** — a one-file bug fix, a copy tweak, a config change.
  Fix it directly, landing a regression test that fails before the fix
  and passes after. No spec, no plan document.
- **Feature-sized** — anything else, including changes that look
  well-scoped in chat but touch behaviour others depend on. Full
  `brainstorm → spec → plan → ship` cycle per `CLAUDE.md` (design spec
  in `docs/superpowers/specs/`, implementation plan in
  `docs/superpowers/plans/`), each normally its own commit.

Verify an item against `CHANGELOG.md` before starting it if this file
hasn't been touched in a while.

---

## Active

### Shared-workspace correctness (2026-09) — shipped

A cluster found in a live two-browser shared-workspace pass, all now
shipped.

- **F1 / F2 / F5 — workspace name resolves to "Shared workspace" on a
  share link** (and the placeholder leaking into the merge/separate join
  prompt, and a single-file share naming the joiner's workspace after the
  file). **Shipped v1.48.9** (PR #175): push the name on first share,
  self-heal for an already-connected editor, `decideJoinTarget` prefers
  the real remote name, a self-assigned default ("New workspace") is
  deliberately not propagated.
- **E1 — sidebar rows missing in a workspace that is both repo-synced
  and shared.** repo-sync created docs the `WorkspaceRoom` never knew
  about, so `applyWorkspaceMeta()` deleted every repo-pulled doc and the
  next pull re-created them with fresh ids (churn → stale-id clicks).
  **Shipped v1.49.0**: a `repoDocSyncHook` seam registers the owner's
  pull results with the room (create → `seedNewDocBinding`, update →
  wholesale content replace, delete → `pushWorkspaceDocDelete`). Repo
  sync stays owner-only.
- **F3 — no warning when deleting a shared workspace.** **Shipped
  v1.49.0**: role-aware confirm copy — owner ("revokes access for
  everyone"), a collaborator dropping a mirror ("removes your local
  copy"), a merger ("stays available to its owner").
- **F4 — a deleted shared workspace stayed reachable via its link.**
  **Shipped v1.49.0**: `DELETE /api/workspace/:id` (owner-only) sets a
  persisted `deleted` tombstone, broadcasts `MESSAGE_WORKSPACE_DELETED`,
  closes all sessions; every route on a deleted room → `410`.
  Collaborators lose a `mirrored` copy entirely (with a "deleted by its
  owner" banner), a `merged` workspace only loses its live link.

Spec: `docs/superpowers/specs/2026-09-08-shared-workspace-composition-lifecycle-design.md`.
**Deferred** (spec Non-goals): multi-party repo sync (per-user tokens,
concurrent-pull races); soft-delete / undo for workspace deletion;
export-before-delete prompt for a collaborator losing a mirror.

### Collaboration roles, focus mode & suggesting mode

Found in a manual pass over a shared/viewed workspace, benchmarked
against Google Docs' Editing / Suggesting / Viewing modes (its top-right
mode switcher, right-margin suggestion cards, and Viewing mode hiding
comments and the suggestion UI entirely).

Roles today: owner → `editor`; link role or per-invite → `viewer` /
`reviewer` (suggester) / `editor`. `authorize()` resolves it server-side;
`collab.ts` mirrors it into the UI.

**Groups A / B / C + D6 — shipped v1.50.0** (spec
`docs/superpowers/specs/2026-09-08-collaboration-mode-chrome-design.md`,
plans 1–3, PR #180):

- **D6 / A3 / A4 / C1** — `stores/collabMode.ts` mode model (`collabRole`
  ceiling + per-`remoteId` `chosenMode`, derived `effectiveMode` clamped
  to role), `ModeSwitcher.svelte` next to Share, `applyEditorMode` keyed
  off `effectiveMode`. Viewing hides the Edit / Format / Insert menus,
  the comments panel + button + highlights, and the editor pane, and adds
  a floating sidebar re-open button (`#viewingSidebarBtn`).
- **A1 / A2** — Publish to Gist and GitHub Repo sync are **owner-only**
  (`publishHidden = !!$collabRole && !$collabIsOwner` — non-owner editors
  lose them too).
- **A5** — `repoLinked` trailing varuint on `MESSAGE_WORKSPACE_META` +
  `PUT /meta {repoLinked}`; `workspaceRepoLinked` store drives a
  read-only "Synced to a GitHub repo, managed by the workspace owner" row
  in Document Info for non-owner collaborators.
- **B1** — `#focusHint` desktop exit affordance: a pill that slides down
  from the top edge on entry and on a top-of-viewport `mousemove`,
  auto-hides on idle, click or Esc to exit. Mobile keeps
  `#focusModeExitBtn`.
- **B2** — focus-mode paragraph dimming now extends to the preview pane
  (`focusActiveLines` store ← `Editor.svelte`; `preview-focus-dim.ts`
  `applyFocusDim` toggles `.focus-dim` on preview blocks outside the
  active paragraph, reusing the `data-line` tags).

**Deferred** (spec Non-goals): syncing the chosen mode between
collaborators (it's a local view preference); per-document mode (mode is
per-workspace-session); focus mode as separate editor/preview toggles,
persisting focus mode across reloads, or sentence-level dimming.

**Group D — suggesting-mode redesign** (its own brainstorm — NOT in v1.50.0)

- **D1** — Inline suggestion rendering looks cramped/broken. Move to a
  Google-Docs-style right-margin card model.
- **D2** — Deleting your own just-inserted suggested text should remove
  the suggestion (and its card) entirely, not leave an "added X then
  deleted X" pair.
- **D3** — Every edit should be its own message thread.
- **D4** _(needs brainstorm)_ — Granularity. Google Docs splits
  aggressively on whitespace and produces card spam. Anchor a suggestion
  to a line/span rather than per-character, without losing independent
  accept/reject.
- **D5** — The standalone "edit" icon on suggestions is unclear. Fold
  suggestion actions into the comment-thread UI (Google Docs merges
  suggestion + comment into one card).
- **D6** — mode switcher. **Shipped v1.50.0** (see above).

**Shape:** D1–D5 are a separate suggesting-mode redesign, the largest
piece — its own brainstorm. D2 overlaps with the "just-inserted delete"
regression; D4 needs its own granularity decision before a plan.

### Preview links & wikilinks

- **G1** — A markdown link `[text](target)` whose `target` isn't a URL
  (a bare doc name / relative path) renders as `<domain>/d/<target>` and
  navigates nowhere. It should resolve to the matching document, or show
  a "that document doesn't exist" affordance.
- **G2** — An unresolved wikilink shows raw `[Name](wikilink:Name)` text
  in the preview — seen even for `[[Name]]` inside an inline code span
  (the `[[…]]` → `[…](wikilink:…)` rewrite runs over code spans it should
  skip, and the renderer prints the unknown scheme literally). Wikilink
  rewriting must respect code spans / fences, and an unresolved wikilink
  needs a real rendered "unresolved link" state, never leaked
  `wikilink:` syntax.

Small cluster in `wikilinks.ts` / `wikilink-rewrite.ts` / the preview
renderer. Needs a repro pass; likely Phase-1-sized.

### Google-Docs-style top bar & version history (2026-09-08)

Cosmetic/chrome pass, benchmarked against Google Docs, reported with
screenshots. A `feedback_topbar_sizing_locked` note previously froze
topbar sizing/colour to commit `08065f4` — the user has now explicitly
authorised the shape/avatar changes below; keep the locked **sizes**
(40px buttons) and **accent colours**, change only border-radius and add
the avatar.

- **UI-1 — topbar icon buttons should be circular** (`border-radius: 50%`
  + a circular grey hover/press fill), like Google Docs' comments /
  version-history / call buttons. `.icon-btn` base is `border-radius: 6px`
  today (`_utilities.scss:75`); in `#topbarActionsCol` it's already
  40×40. "Application-wide" per the request — audit non-topbar
  `.icon-btn` uses (toolbar overflow, share-workspace rows, menu bar) so
  a global circle doesn't break a rectangular context; may need to scope
  to `#topbarActionsCol .icon-btn` + wherever else reads right.
- **UI-2 — signed-in GitHub avatar in the topbar.** Today sign-in state
  shows only in Settings + `SignedOutIndicator.svelte`
  (`#signed-out-indicator-mount`, in the sidebar footer). Add the user's
  GitHub avatar as the last topbar item: fills the whole 40px circle
  (image `object-fit: cover`, no padding), hover shows the username
  (title or a toggletip). Needs the avatar URL — `githubUsername` is in
  `stores/github.ts`; the auth `/me` response may already carry an avatar
  URL, else derive `https://github.com/<user>.png`.
- **UI-3 — Version History redesign toward the Google Docs layout.**
  `VersionHistory.svelte` (534 lines) already has a right-rail list with
  per-version author avatars, session grouping, a diff toggle and a
  "Highlight changes" style. Gap vs. Google Docs: date-header grouping
  ("Today" / "August"), "Current version" label, the collapse/expand
  disclosure per group, the named-vs-anonymous distinction. Assess
  against the current component; likely Phase-1-sized, possibly its own
  spec if it's a real restructure.
- **UI-4 — compact mode switcher.** `ModeSwitcher.svelte` (shipped
  v1.50.0) shows the current mode's icon **plus its text label**
  ("Editing" / "Suggesting" / "Viewing") plus a chevron. Google Docs
  shows just an outlined mode glyph + a dropdown caret (no label) as a
  circular/pill control. Drop the `.mode-switcher-label` span (keep it in
  the open dropdown's menu items), leave icon + chevron; adjust
  `_topbar.scss`'s `.mode-switcher-btn` width/padding. Small — a copy/CSS
  tweak, fold into the UI-1 pass.

### Other open bugs

- **Comment reply / resolve reported broken in practice** (2026-08-13).
  A full review of the path (server routes, HTTP handlers, client fetch
  wrappers, panel UI) found no defect and the server logic has passing
  tests. Needs a fresh repro with specifics — exact steps, and whether
  it's a network error, a UI freeze, or a silent no-op — against a real
  shared document with two GitHub-authenticated roles.

---

## Feature backlog — bigger bets

New infrastructure, backend, or scope — each its own project.

- [ ] **Google Drive sync** — sub-project 4 of the workspace pivot
      (Workspace core, workspace-level sharing, and GitHub repo sync
      already shipped). Same idea as GitHub repo sync, but Drive is a
      separate OAuth provider/API from scratch, and adds "open markdown
      from Drive" (Picker import) and "save markdown to Drive" (per-file
      export). **In progress** on `feat/google-drive-sync` — plan 1 of 5
      (connection + open-from-Drive) is up as a PR, currently paused
      while the shared-workspace bugs above are worked. Supersedes the
      earlier "multi-provider cloud sync (Drive, Dropbox, OneDrive)"
      idea — scoped to Drive only, since Dropbox/OneDrive were never
      actually requested.
- [ ] AI writing assist / chat-with-doc
- [ ] AI-generated diagrams from a text prompt (flagged bigger-bets tier
      in the original diagram editor design doc — needs an LLM backend,
      cost/auth model)
- [ ] Plugin / extension system
- [ ] Slide / presentation export
- [ ] Tag system + graph view
- [ ] End-to-end encryption
- [ ] True WYSIWYG toggle
- [ ] Direct blog publishing (Blogger/WordPress)

---

## Deferred considerations

Real options that came up while designing or building a shipped feature,
set aside rather than chosen — worth reconsidering on their own if they
turn out to matter later.

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
      solved the reported problem; finer interpolation _within_ a tall
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
- [ ] Case-insensitive wikilink matching — v1.15.0 is exact-match only,
      the same simplicity tradeoff that motivated enforcing unique
      names in the first place
- [ ] Wikilink aliasing (`[[Name|Display Text]]`) — v1.15.0 supports
      only plain `[[Name]]`
- [ ] A "create new document" entry inline in the `[[` autocomplete
      popup — v1.15.0's popup only lists existing documents; creating
      a new one is still only reachable by typing a new name and
      closing `]]` by hand, or clicking a rendered "missing" link
- [ ] Pinning the view selector visible while only the formatting
      buttons scroll on mobile — v1.16.0's mobile toolbar scrolls (or
      overflows into "⋮") as one unit; the selector isn't pinned
      separately
- [ ] Persisting which Documents/Headings tab was last open across
      mobile sheet close/reopen — v1.18.0 always resets to "Documents"
      on open (deliberate, matching Focus Mode's existing
      stateless-by-default precedent), not a technical limitation
- [ ] Editing/reordering headings from the mobile Headings tab —
      v1.18.0 is read-only navigation only, same as the desktop
      per-row outline it replaces there
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
- [ ] Standardized modal layout — Version History, the mobile Comments
      sheet, Command Palette, and the Diagram Editor's header each keep
      their own hand-built structure rather than the shared `Modal`
      component — explicitly left out of Phase 2: none of the four is a
      centered-box-with-backdrop dialog the way Modal assumes, so
      converting them would mean fighting their own layouts rather than
      simplifying them
- [ ] Tab-bar support in `Modal` (built in Phase 1, unused so far) has
      no real consumer yet — no modal in the app currently needs
      internal sub-sections
- [ ] Fine-grained per-document roles within one shared workspace (e.g.
      "editor on doc A, viewer on doc B" for the same person) — explicitly
      out of scope for workspace-level sharing (v1.21.0); one role per
      person applies uniformly to every document in the workspace
- [ ] A dedicated conflict-resolution UI for name collisions when
      merging a shared workspace into an existing one — v1.21.0 reuses
      the existing rename-on-collision flow instead; reconsider if users
      want to see/choose which side wins per document rather than an
      automatic silent-suffix rename
- [ ] Continuous/automatic GitHub repo sync — v1.22.0 is explicit
      pull/push only (like the Gist flow), not a background process
- [ ] Subfolder-scoped or non-recursive GitHub repo linking — v1.22.0
      always maps a linked workspace to the whole repo tree on a chosen
      branch, recursively; no way to link to just a subfolder
- [ ] Automatic conflict resolution when a repo's tree moves between a
      link-and-sync's push and pull steps (e.g. a concurrent external
      push) — v1.23.0 still always routes any such conflict through the
      existing shared conflict-resolution modal
- [ ] Sync-status detail (e.g. last-synced time) in Document Info's
      "Synced to" section — v1.23.0 shows only the linked repo path /
      Gist, not how recently it was last pushed or pulled
- [ ] Real per-file progress during a GitHub repo push — v1.23.0's
      progress toast shows a static file count computed before sending,
      not a live increment, since the push protocol sends every blob in
      one atomic request
- [ ] Progress feedback during repo-sync conflict resolution — v1.23.0's
      progress toasts cover only the initial push/pull/publish
      operation; the conflict-resolution modal's own "Applying…" button
      state is the only in-progress feedback during that step today

---

## Shipped

The list below is the canonical feature history through **v1.41.1**.
**v1.42.0 onward is in `CHANGELOG.md`** — including the wikilink rename
cascade (v1.42.0), the test-coverage catalogue effort (v1.48.x, now
314/314 covered), Google Docs suggesting polish, the What's New
screenshot guard (v1.48.8), and shared-workspace name propagation
(v1.48.9).

The earlier `TODO.md` (a workspace/repo-sync punch list) and
`IMPROVEMENTS.md` (Phase 1–3 bugs and small features) tracked work that
has all shipped — see `CHANGELOG.md` and git history for specifics,
including the real root causes found along the way (a
filename-sanitization bug behind "images can't be imported"; a Gist API
filename-matching bug behind rename-creates-a-duplicate; a
comment-highlight-while-typing regression).

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
      unambiguous; bundled in the same release: a merged Document Info +
      Backlinks panel, and a sidebar sort-order fix (only a real
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
- [x] Mobile document/headings tabbed switcher — a "Documents"/"Headings"
      tab bar replaces the per-row expandable outline on mobile, showing
      the active document's full outline at the top level instead of
      nested under one row at a time; the last piece of the mobile
      redesign mockup. Desktop unchanged (v1.18.0)
- [x] Standardized modal layout — Phase 1 — a shared `Modal` component
      (icon-only close button, text-link quick action, scrollable body
      pinned between header/footer) now backs all 13 simple dialogs
      (Sign in, Insert link, Images manager, Open from GitHub Gist,
      Keyboard Shortcuts, About, Terms, Privacy, Licenses, Settings,
      Document info, Rename collision, Share), replacing 13 different
      hand-rolled variants; also replaces both native `window.confirm()`
      popups (delete document, delete image) with a matching
      `ConfirmDialog` (v1.19.0)
- [x] Standardized modal layout — Phase 2 — converted What's New to the
      shared `Modal` component too; scoped narrower than originally
      planned after investigation showed Version History, the Comments
      panel, Command Palette, and the Diagram Editor aren't structurally
      dialogs (no backdrop/centered-box presentation) and forcing them
      into `Modal` would fight their own layouts rather than simplify
      them — left as-is, see the Deferred considerations list (v1.19.2)
- [x] **Workspace core.** First of four planned sub-projects toward
      sharing a whole _workspace_ (a named group of documents) instead
      of one document at a time. Introduces `Workspace` as a real
      container documents belong to: create/switch/rename/delete
      workspaces from a new switcher in the sidebar header, one active
      at a time (VS Code-style, not multi-root); documents filter to
      the active workspace; a document can be moved between workspaces;
      existing users migrate transparently onto a default "My
      Workspace." Purely local — no sharing or external sync yet (v1.20.0)
- [x] **Workspace-level sharing.** Second sub-project. Sharing now
      happens at the workspace level instead of one document at a
      time — every document inside a shared workspace syncs live to
      collaborators simultaneously. Sharing a single document moves it
      into its own workspace first, then shares that. Opening a shared
      workspace link for the first time asks whether to add it as a
      new workspace or merge into one you already have (v1.21.0)
- [x] **GitHub repo sync.** Third sub-project. Link a workspace to a
      GitHub repo (`repo` OAuth scope), pull its `.md` files in as
      docs (recursively, whole tree), and push local changes back out
      as one atomic commit via the Git Data API. Per-file SHA-based
      conflict detection — a changed-on-both-sides file always prompts
      "keep mine / take theirs," never silently resolved (v1.22.0)
- [x] **Share the whole workspace, not just one document.** The Share
      button on a document with siblings now offers a choice — share
      just this document (unchanged behavior) or the whole workspace —
      instead of always silently isolating the document into its own
      workspace first (v1.23.0)
- [x] **Open an existing GitHub repo directly as a new workspace, and
      link-then-sync an existing one automatically.** File > Open >
      From GitHub Repo creates a workspace from any repo in one step,
      switching to an already-linked workspace instead of duplicating
      it; linking an _existing_ workspace to a repo now immediately
      pushes its local docs out and pulls in whatever the repo already
      has (v1.23.0)
- [x] **Document info and progress transparency.** The Document Info
      panel now shows a document's linked GitHub repo/Gist with a
      direct link, and relative dates read "5d ago" / "2w ago" /
      "3mo ago" instead of jumping straight to a bare date past
      yesterday; GitHub repo push/pull and Gist publish now show a
      live-updating progress toast (v1.23.0)
- [x] **Version History meets repo commits, and workspace-gated actions.**
      Version History now interleaves a repo-linked document's actual
      GitHub commits with local snapshots in one chronological list, with
      a Preview/Diff toggle and undoable restore from either a commit or a
      snapshot; linking to an existing repo preserves filenames instead of
      duplicating them, surfaces push conflicts instead of discarding
      them, and Mermaid diagrams/filenames survive a push intact. Actions
      that need a workspace or open document (New document, GitHub Repo,
      Publish, Export) now disable upfront instead of erroring after the
      fact, and shared workspaces sync every open document's edits, not
      just the active one (v1.24.0)
- [x] **A URL for every document.** Each tab's URL now reflects whichever
      document is open — deep links and browser back/forward work, and
      Ctrl/Cmd-click (or middle-click) a sidebar row to open it in a
      genuine new tab. Receiving a single shared document always lands it
      as its own new workspace, for every receiver. Also fixed: opening
      the app in more than one tab could silently destroy unrelated
      documents or workspaces, since every save now merges with local
      storage's actual current contents instead of blindly overwriting it
      (v1.25.0)
- [x] **GitHub-style diff view, with images.** The diff view now has line
      numbers on both sides, word-level highlighting for exactly what
      changed within a line, and a Split/Unified toggle — for local
      documents, shared documents, and repo commits alike. A line that's
      just an image reference renders as a before/after thumbnail
      comparison instead of raw text, with per-snapshot accuracy (v1.26.0)
- [x] **Portable local history.** Version History snapshots and personal
      notes on a repo-linked document now travel with the repo instead of
      staying stuck on whichever device created them (v1.27.0)
- [x] **Shared document names sync live.** Renaming a shared document now
      shows up for every collaborator immediately, riding the same live
      connection as content and images (v1.28.0)
- [x] **Search and replace.** Ctrl/Cmd+F opens a find bar with a live
      match count and case/whole-word/regex toggles; Ctrl/Cmd+H expands
      it into Replace and Replace All (v1.29.0)
- [x] **Unresolved-comment count badge** on the Comments topbar icon and
      File menu entry (v1.30.0)
- [x] **Undo/Redo and Command Palette toolbar buttons** (v1.31.0)
- [x] **Insert an existing image, or replace one in place** — a picker of
      every image already in the document, plus a per-image Replace
      action (v1.32.0)
- [x] **Printing support** — a chrome-free print layout via the File menu
      and Command Palette (v1.33.0)
- [x] **Choose Gist visibility** — Public or Secret, chosen at creation
      (GitHub can't change it later) (v1.34.0)
- [x] **Markdown compatibility checker** — a Document Info row flagging
      app-only and flavor-specific syntax, click to jump to it (v1.35.0)
- [x] **MultiMarkdown syntax support** — definition lists,
      superscript/subscript, and a round-tripping `Key: Value` metadata
      section (v1.36.0)
- [x] **Citations & bibliography, split Format/Insert menus, smart
      version-history grouping** — `[@key]`/`[#key]` citations against a
      bibliography (numbered or author-year); Bold/Italic/Strikethrough
      and Insert Link/Image/Manage Images moved into their own Format and
      Insert menus; Version History groups continuous edits into
      collapsible sessions and can diff any two entries (v1.37.0)
- [x] **Document Info edit modal** — Document Info is now a read-only
      summary with an Edit button opening a dedicated modal for name,
      metadata, and citation settings (v1.38.0)
- [x] **Suggestion-mode collaboration** (Google Docs parity) — the
      reviewer role proposes tracked insert/delete suggestions an editor
      can accept/reject or the reviewer can withdraw; viewer role is
      Preview-only with no edit surface (v1.39.0)
- [x] **Categorized What's New** — reopening it starts at a category
      index instead of a long stepper (v1.40.0)
- [x] **Toolbar grouping by type** — the trailing insert cluster
      re-grouped into media/reference, structural, and notation insert,
      with Command Palette set apart (v1.40.4)
- [x] **Shared-document session separation** — opening a share link now
      previews the workspace (never persisted) instead of always
      committing it — a "Preview" badge and "Keep this workspace" action,
      plus a "Preview only" join option. A receiver with zero workspaces
      still lands permanently (v1.41.1)
