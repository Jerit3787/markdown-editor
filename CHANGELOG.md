# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[Semantic Versioning](https://semver.org/).

## [1.26.1] - 2026-08-19

### Fixed

- **Text pulled from a GitHub commit could show up as mojibake** (em dashes, curly quotes, and accented letters turned into garbled characters) in Version History's Diff tab and anywhere else repo file content is decoded. Base64 content from GitHub's API is UTF-8, not Latin-1 — it's decoded as such now, so the corruption no longer compounds on repeated pull/push cycles either.
- **A repo-linked document's Version History Preview tab showed a broken-image icon** for images that render fine everywhere else. The preview now resolves images against the selected version's own image map instead of the live document's, which never matched a repo commit's `assets/...`-style paths.

## [1.26.0] - 2026-08-18

### Added

- **The diff view now looks like GitHub's.** Line numbers on both sides, word-level highlighting for exactly what changed within a line (not the whole line), and a Split/Unified toggle to switch between side-by-side and stacked layouts.
- **Images now render in diffs instead of showing as raw text.** A line that's just an image reference shows a before/after thumbnail comparison — for local documents, shared documents, and repo commits alike — with per-snapshot accuracy (an old version shows the image it actually had, even if it's since been replaced) and restoring a version brings its images back too.

### Fixed

- **Deleting or renaming a document in a repo-linked workspace now propagates to the repo on the next push.** Previously push only ever created or updated files — a deleted or renamed local document left an orphaned or stale file behind in the repo.
- **Pulling from a repo no longer produces a phantom diff on every re-pull of an unchanged image.** Image references were re-keyed with a fresh timestamp on every pull even when the image itself was byte-identical; the key is now derived from the image's own path, so it round-trips correctly.
- **Rapid document switching in a shared workspace could leave duplicate "who's viewing this" avatars** that lingered until the connection was evicted. Switching now cancels an in-flight join instead of letting two connections race.

## [1.25.0] - 2026-08-18

### Added

- **Each tab now has its own document.** The URL reflects whichever document is open — deep links work, and switching documents updates the URL so browser back/forward moves between them. Sidebar rows are real links too: Ctrl/Cmd-click (or middle-click) a document to open it in a genuine new tab, Google-Docs style.
- **Document Info shows a repo-linked document's real commit history** for Created/Edited, instead of local-only timestamps that reset to "just now" every time you pull an existing repo.
- **Receiving a single shared document always lands it as its own new workspace**, named after the document, with no modal to click through — for every receiver, not just someone with no workspaces yet.

### Fixed

- **Opening this app in more than one tab could silently destroy unrelated documents or workspaces.** Every save now merges with whatever's actually in local storage instead of blindly overwriting it with a possibly-stale copy.
- **The comments panel left a permanent strip of dead space beside the editor whenever it was collapsed** (most of the time) — the editor and preview now genuinely fill the full width, and the panel's open/close motion is smooth again.

## [1.24.1] - 2026-08-18

### Fixed

- **Mobile's document sidebar (the bottom sheet) slides open/closed again
  instead of snapping instantly.** An unscoped desktop-only transition
  rule was winning a CSS specificity tie against the mobile-specific one,
  silently animating a property mobile never changes.
- **The editor/preview view-selector icons no longer squash against the
  edge when the comments panel is collapsed.** They share a grid column
  with the comments panel, which now reserves a minimum width instead of
  shrinking to zero.

## [1.24.0] - 2026-08-18

### Added

- **Version History now includes the linked repo's commits, not just
  local snapshots.** Open File > Version History on a repo-linked
  document and its commits (that touched that file) appear interleaved
  with local snapshots in one chronological list, each tagged with a
  small GitHub icon.
- **Diff any version against the current document**, local snapshot or
  repo commit alike — a "Preview | Diff" toggle in Version History
  switches between the existing rendered preview and a side-by-side
  diff, with a replaced line's old and new text paired on one row.
- **Restore from a repo commit**, on both local-only and
  shared/collaborative documents — restoring is itself always undoable,
  same guarantee local-snapshot restore already had.
- **Actions that need a workspace or an open document to do anything now
  say so upfront.** New document, GitHub Repo (link/browse), Publish,
  and Export all disable with the rest of their already-gated siblings
  instead of staying clickable and erroring after the fact; the Command
  Palette hides commands that don't apply to the current state instead
  of listing them non-functionally.
- **Shared workspaces sync every open document's live edits**, not just
  whichever one happens to be active.
- **Linking a workspace to an existing repo preserves files by name**
  instead of duplicating them into renamed copies, surfaces push
  conflicts instead of silently discarding them, and pushes a real first
  commit instead of an auto-init placeholder.
- **Mermaid diagrams and filenames survive a repo push intact.** Diagrams
  resolve to their real source before pushing instead of a bare
  reference, and filenames keep their original case and spacing instead
  of being forced to lowercase-with-hyphens.
- **Linking to a repo renames a still-default-named workspace to match
  it**, dismisses the repo picker modal immediately instead of after the
  whole sync finishes, and the GitHub Repo submenu shows time since the
  last sync.
- **The empty "No workspace yet" state offers "Open from GitHub Repo"**
  as a second way in, alongside "New workspace."

### Fixed

- **Disabled buttons across the app didn't look or act disabled.**
  Restore, several menu items, and the Share dropdown's chevron button
  could still show a hover highlight or (for one case) stay clickable
  entirely, despite doing nothing or erroring.
- **The editor and preview panes could look mismatched in width.** A
  fixed-width slot reserved for the comments panel wasted 320px even
  while collapsed; it now only holds that space while the panel is open
  or actively animating closed.
- **Closing the comments panel showed a brief glitch** — a shadow or
  sliver of the panel remained visible at the viewport's edge instead of
  disappearing cleanly.
- **Version History's Restore button now disables** when the selected
  version is already the current one, instead of staying clickable for
  a no-op restore.
- Plain `<select>` dropdowns (join-workspace, repo-conflict resolution)
  now pick up the app's theme instead of rendering with unstyled browser
  defaults.

## [1.23.0] - 2026-08-17

### Added

- **Share the whole workspace, not just one document.** The Share button
  on a document that has siblings now offers a choice — share just this
  document (the existing behavior) or the whole workspace — instead of
  always silently isolating the document into its own workspace first.
- **Open an existing GitHub repo directly as a new workspace.** File >
  Open > From GitHub Repo creates a workspace from any repo in one step
  (switching to an already-linked workspace instead of duplicating it if
  one already exists).
- **Linking an existing workspace to a repo now pushes and pulls
  automatically.** Previously this only saved the link, leaving the user
  to manually run Push then Pull afterward.
- **Document Info shows a linked repo/Gist.** The panel (File > Document
  Info) now shows a document's linked GitHub repo path or Gist, with a
  direct link to it on GitHub.
- **More readable relative dates.** Dates past yesterday now read "5d
  ago" / "2w ago" / "3mo ago" instead of jumping straight to a bare date
  — used everywhere relative dates already appeared (Document Info, File
  > Open Recent, Command Palette).
- **Progress toasts for GitHub repo sync and Gist publish.** Pushing,
  pulling, linking a workspace to a repo, opening a repo as a new
  workspace, and publishing a Gist now show a toast that updates live
  while the operation runs, instead of the only feedback being a menu
  button's own label — invisible whenever the modal that triggered the
  action is on top of that menu.
- **Move a document to a different workspace via a modal.** The doc-row
  "⋯" menu's "Move" action now opens a picker modal instead of listing
  every other workspace inline.

### Fixed

- **Confirm dialogs for delete actions (document, image, workspace) now
  name what's being deleted in the title** (`Delete "My Notes"?`) instead
  of a generic title with the name buried in the body text.
- **The Share dialog's title showed the active document's name even when
  sharing the whole workspace** — it now always reflects what's actually
  being shared.
- **Relinking a workspace to a different repo could falsely report a
  push conflict** if a doc's stale sync metadata from a previously-linked
  repo happened to match a same-named file in the new one. Linking now
  always clears that metadata first.

## [1.22.1] - 2026-08-17

### Fixed

- **The What's New carousel's screenshot left dead space instead of
  filling its slide.** It now fills the slide's full height and sits
  flush against the header and footer, matching the mobile layout's
  existing full-bleed treatment.
- **Workspace-level sharing (v1.21.0) never got a What's New entry** —
  added, with a real screenshot of the Share dialog.

## [1.22.0] - 2026-08-17

### Added

- **GitHub repo sync.** Link a workspace to a GitHub repo from File >
  GitHub Repo — every `.md` file in the repo becomes a doc, recursively
  through the whole tree. Pull the latest from the repo, or push local
  changes back out as a single commit; embedded images push alongside
  their doc as real files and resolve back on pull. Conflicts (a file
  changed on both sides since the last sync) always prompt a per-file
  "keep mine / take theirs" choice, never a silent overwrite. Deletions
  sync both directions. Requires re-connecting your GitHub account once
  (the sign-in scope changed from `gist` to `repo` to allow this).

### Fixed

- **The topbar stayed clickable behind an open modal.** A stacking-order
  bug meant the topbar's own menus (File/Edit/View/Help, Share,
  Settings) sat visually above every dialog's backdrop, so a click meant
  for the backdrop could still reach a topbar button while a modal was
  supposedly blocking the rest of the page.
- **A non-destructive confirmation ("Move to its own workspace?" when
  sharing a document) showed a delete-warning icon.** The confirm
  dialog's icon now matches whether the action is actually destructive.

## [1.21.1] - 2026-08-17

### Fixed

- **Workspace sharing didn't seed content or sync new documents both
  ways.** Sharing a document for the first time could leave
  collaborators looking at an empty doc, and newly created documents
  inside a shared workspace only synced from collaborator to owner,
  not back — both are now fixed and covered by regression tests.
- **GitHub sign-in could fail closed on transient errors.** Logging
  out now always clears the local session even if revoking the
  GitHub OAuth grant fails, and a network blip or rate-limited
  response no longer signs you out — only a definite invalid-token
  response does.
- **Preview scrolled to the wrong place while typing.** A coordinate
  math bug double-counted the preview pane's padding, causing a
  systematic offset between the cursor's position and what the
  preview showed. Lists also now track each item individually
  instead of only the list's first line, so long lists stay in sync
  too.

## [1.21.0] - 2026-08-16

### Added

- **Workspace-level sharing.** Sharing now happens at the workspace
  level instead of one document at a time — every document inside a
  shared workspace syncs live to collaborators simultaneously, not
  just whichever one is currently open. Sharing a single document
  (from its existing Share button) moves it into its own new
  workspace first if it isn't already alone in one, then shares that.
  Opening a shared workspace link for the first time now asks whether
  to add it as a new workspace of its own or merge its documents into
  one you already have. Version history and comments keep working
  exactly as before, just re-scoped to the workspace. The doc list
  shows a small presence indicator next to whichever document each
  collaborator currently has open, across the whole workspace.
  Documents shared before this release keep working — they migrate
  to the new model automatically and transparently the next time
  anyone opens them.

## [1.20.3] - 2026-08-16

### Fixed

- **Scroll sync between editor and preview.** A prior change increasing
  the editor's own top padding (for visual balance with the preview
  pane) exposed a coordinate-space bug in the scroll-sync math: some
  conversions between CodeMirror's document-relative coordinates and
  the DOM's physical scroll position were inconsistent, causing the
  preview to lag or overshoot the editor's actual scroll position.
  Fixed at the root (a shared, consistently-applied padding offset)
  rather than patched around, and both panes now reliably reach the
  true top/bottom of the document together, not just approximately.
- **Diagram Editor and Version History are full-screen tools again**,
  not small floating dialogs — an in-progress UI pass had wrapped both
  in the shared modal component, which doesn't fit either one's layout
  (a code+preview split pane, and a list+preview split pane).
- **`marked` (the Markdown parser) upgrade to v18 actually verified.**
  The dependency had been bumped in `package.json` but never installed
  or tested — doing so surfaced a real breaking change in the library's
  custom-renderer API (images, code blocks, and links would have
  rendered blank) that's now fixed and verified against images, links,
  wikilinks, code blocks (plain and Mermaid), tables, task lists, and
  footnotes.
- Mobile comments panel positioning, animation, and layout polish;
  minor desktop layout gap and z-index fixes.

### Changed

- Dependency updates: `svelte`, `wrangler`, `@cloudflare/workers-types`,
  `@sveltejs/vite-plugin-svelte`, `isomorphic-git`, `undici`, `marked`.
  Renovate now manages dependency update PRs for this repo.

## [1.20.2] - 2026-08-16

### Fixed

- **UI Polish.** Fixed the dynamic empty state title in the Open Gist modal to accurately reflect loading and error states instead of defaulting to "No gists". Upgraded the Version History and Document Headings (TOC) sidebars to use the new global empty state layout.

## [1.20.1] - 2026-08-16

### Fixed

- **UI Polish.** Refined empty states across all modals and sidebars (Settings, Document Info, Images, Command Palette, Open Gist, Comments) with a unified, visually balanced layout featuring centered icons and prominent titles.
- **Confirm Dialogs.** Upgraded confirmation dialogs to use descriptive header titles (e.g., "Delete Document?") instead of a generic "Confirm", backed by the new empty state body format and a trash can icon.
- **GitHub Auth Flow.** Added a direct "Sign in with GitHub" button to the empty state of the Open Gist modal, completely wiring it to authenticate and reload gists automatically without closing the modal.

## [1.20.0] - 2026-08-16

### Added

- **Workspaces.** Documents now live inside a named workspace — create,
  switch, rename, and delete workspaces from a new switcher in the
  sidebar header (one active at a time). Existing documents migrate
  transparently onto a default "My Workspace." A document can be moved
  to another workspace from its "⋮" menu. Deleting a workspace deletes
  its documents too, after a confirmation showing the count. This is
  purely local for now — the first step toward sharing an entire
  workspace with collaborators, not just one document at a time.

## [1.19.2] - 2026-08-15

### Added

- Modal header now has a bottom border separating it from the body,
  matching the footer's existing top border.

### Changed

- What's New now uses the shared `Modal` component (Standardized modal
  layout — Phase 2), closing out the modal-standardization work.

### Fixed

- On mobile, What's New's screenshot floated inset from the modal's
  edges instead of filling the width edge-to-edge like a proper hero
  image.

## [1.19.1] - 2026-08-14

### Added

- Modal hints ("?" button) now show as a small click-to-open popover
  anchored to the button, dismissing on outside click or Escape,
  instead of inserting a paragraph into the modal body.

### Fixed

- The comments panel rendered in the wrong place on desktop (not as a
  right-side column) — its Svelte mount wrapper was missing
  `display: contents`, so its `grid-area` assignment was silently
  ignored.
- The About modal used the app name and version as its own dialog
  title; it's "About" again, with "Markdown Editor" + version restored
  as a heading in the body next to the logo.
- No way to exit Focus Mode on mobile — the View menu's toggle lives
  in `#topbar`, which Focus Mode itself hides, and mobile has no
  Escape key. Added a small floating exit button, mobile-only.
- Two modal hints no longer matched actual behavior: Settings claimed
  GitHub sign-in "only affects Publish to Gist" (it also gates Share);
  Insert Link claimed leaving Text blank inserts "the URL on its own"
  (it always inserts `[link text](url)`, defaulting the text).

## [1.19.0] - 2026-08-14

### Added

- A shared `Modal` component now backs every simple dialog in the app
  (Sign in, Insert link, Images manager, Open from GitHub Gist,
  Keyboard Shortcuts, About, Terms, Privacy, Open Source Licenses,
  Settings, Document info, Rename collision, Share) — one consistent
  header (icon-only close button, title, optional quick-action link) /
  scrollable body / optional footer structure, replacing 13 different
  hand-rolled variants.
- A reusable `ConfirmDialog`, replacing both native `window.confirm()`
  popups in the app (deleting a document, deleting an image) with a
  styled dialog matching the rest of the UI.

### Fixed

- Long-content modals (Open Source Licenses, Keyboard Shortcuts,
  Settings) used to scroll the title and Close button away along with
  the content — only the body scrolls now, header and footer stay
  pinned.
- File/Edit/View/Help dropdown menus rendered behind the mobile
  formatting toolbar instead of above it (`#topbar` and `#toolbar` had
  landed on the same z-index).
- Version History's list and preview panes squeezed into an unreadable
  two-column layout on mobile — now stacks list above preview.

## [1.18.0] - 2026-08-14

### Added

- Mobile document sheet: a "Documents"/"Headings" tab bar replaces the
  per-row expandable outline — Headings shows the active document's
  full outline at the top level instead of nested under one row at a
  time, the remaining piece of the mobile redesign mockup. Desktop is
  unchanged; the tab bar and this behavior are mobile-only.

### Fixed

- Tapping a heading in the new Headings tab didn't close the mobile
  sheet — it always targets the already-active document, so the
  existing jump-to-line function's sheet-closing side effect (tied to
  actually switching documents) never fired for it.
- The Headings tab's own selection persisted across closing and
  reopening the sheet instead of always resetting to "Documents" —
  the sheet's open/closed state is a CSS transform, not conditional
  rendering, so the component backing it never remounts.
- The mobile sheets' dimming backdrops popped in/out instantly while
  the sheet itself and the header's dim overlay both faded smoothly —
  neither backdrop's visibility mechanism (the `hidden` attribute;
  conditional Svelte rendering) could be CSS-transitioned. Both now
  stay mounted and fade via an opacity class instead.
- The mobile document sheet flashed fully open on every page load
  before immediately sliding shut — the collapse only happened once a
  deferred module script ran, well after the browser's first paint. A
  blocking inline script now applies the collapsed state synchronously
  during HTML parsing, before anything renders.

## [1.17.1] - 2026-08-14

### Fixed

- A document row's "..." menu (Rename/Duplicate/Delete) could render
  partially or fully off-screen on the mobile bottom sheet, making
  Delete unreachable for rows near the sheet's bottom edge — two
  compounding bugs: the sheet's own slide animation gave it a
  `transform`, which silently broke the menu's fixed positioning
  (containing-block change), and the menu never checked whether it
  would overflow the bottom of the screen in the first place. It now
  positions correctly and flips to open above the row when there isn't
  room below.

## [1.17.0] - 2026-08-14

### Added

- The document sidenav and comments panel now present as native-style
  bottom sheets on mobile: flush to the screen's left/right/bottom
  edges with rounded top corners, a dimmed backdrop (the header dims
  too, while staying tappable), and tap-outside or the existing close
  button to dismiss. Opening either sheet closes the other, since two
  stacked sheets would otherwise collide.

### Fixed

- Comments had no mobile-specific layout at all before this — it used
  the same 320px desktop side panel, which squeezed the editor down to
  almost nothing on a phone whenever comments were open.
- Document title text was still getting clipped on mobile specifically
  — a leftover mobile-only override on the width-measuring mirror
  element assumed the title field also shrank to 16px there, which it
  never actually did once bumped to 18px.

## [1.16.0] - 2026-08-14

### Added

- View selector: two independent Editor pane / Preview pane toggle
  buttons in the toolbar (and matching entries in the View menu),
  replacing the old three-way Editor/Split/Preview switch — both on =
  split view, matching the original desktop layout mockup.
- The formatting toolbar collapses buttons that don't fit into a
  Google Docs-style "⋮" overflow menu instead of wrapping to a 2nd line
  or scrolling horizontally.

### Changed

- Desktop layout restructured to match the original mockup: the
  formatting toolbar now spans the document sidenav + editor + preview
  as one row (not just editor+preview), with the view selector in its
  own column aligned above the comment sidenav — both stay in sync via
  a shared CSS grid instead of two independently-sized rows.
- Topbar: the logo and the comments/history/share/settings cluster
  each span both header rows, the File/Edit/View/Help menu bar aligns
  under the document title instead of the logo, and the divider line
  between the two header rows is gone — all matching Google Docs'
  actual header layout more closely than the original approximation.
- The document sidenav toggle is now a single always-visible button
  with an active/inactive state, instead of two separate buttons
  swapping visibility depending on whether the sidenav is collapsed.

### Fixed

- Document title text (e.g. "Welcome", shown when no document is open)
  was getting clipped — the hidden mirror element used to measure the
  title field's width had drifted out of sync with the field's actual
  font/padding.
- Buttons and inputs across the app were rendering in the browser's
  default form-control font instead of the app's intended font — form
  controls don't inherit page font-family by default, and nothing had
  told them to.
- The document-sidenav toggle and toolbar overflow buttons were
  visibly bigger, and inconsistently spaced against their neighbors,
  than every other toolbar button — they shared a fixed-size class used
  elsewhere in the app instead of sizing like their actual neighbors.

## [1.15.5] - 2026-08-13

### Fixed

- iOS zoom-on-focus (v1.15.1) only covered the editor and title field
  — every other text field (comment drafts/replies, modal fields,
  the command palette) still triggered it. Now covers every text
  field in the app generically.

### Changed

- What's New's screenshot is bigger — it looked small even after
  fixing the crop.

## [1.15.4] - 2026-08-13

### Fixed

- What's New screenshots were forced into a fixed square and cropped
  if the source image wasn't already square. Now sized to each
  image's own natural aspect ratio instead.

## [1.15.3] - 2026-08-13

### Fixed

- Double-tapping anywhere on mobile triggered iOS Safari's default
  zoom gesture, which left the app's layout visibly broken (it wasn't
  built to handle an arbitrary zoomed-in state). Disabled double-tap
  -zoom specifically; pinch-to-zoom is untouched.

## [1.15.2] - 2026-08-13

### Changed

- Document Info moved out of the topbar into the File menu only, and
  now shows a full timestamp alongside its relative time ("Today" /
  "13 Aug 2026, 8:45 PM").
- The Comments panel now pushes the editor/preview narrower when
  opened instead of floating on top of them, and the topbar icon
  toggles it open/closed (previously only opened it) with an active
  state while open.

### Fixed

- Every modal in the app (including What's New's full-screen mobile
  layout) was rendering underneath the topbar instead of above it — a
  regression from v1.15.1's Comments-panel topbar fix.
- The rename-collision prompt (Replace/Save as/Cancel) had no way to
  dismiss it by clicking outside, unlike every other modal in the app.

## [1.15.1] - 2026-08-13

### Fixed

- Pasted/dropped images whose filename contained a space (nearly all
  of them — e.g. macOS's default "Screenshot ... at H.MM.SS PM.png"
  naming) never rendered, in the preview or on export. The generated
  reference embedded that space directly into `![alt](ref)` markdown
  syntax, which isn't valid without escaping, so it silently fell back
  to rendering as literal text instead of an image.
- Renaming a document and then updating its linked Gist created a
  second file in the gist instead of updating the existing one —
  GitHub's Gist API only updates a file in place when the request's
  filename key exactly matches an existing one.
- If a linked Gist was deleted outside the app, it stayed showing as
  linked indefinitely with no way to clear it.
- Tab now indents in the editor instead of doing nothing.
- The cursor landed *before* an inserted heading/list/quote marker
  instead of after it when applied to an empty line.
- Checkbox list items showed a bullet dot next to the checkbox.
- The document title field's minimum width left a visible gap before
  the save-status icon on short names; pressing Enter there now
  commits the rename and moves focus to the editor.
- The text-selection highlight disappeared the moment you started
  typing a comment on it.
- The floating "Add comment" button could appear even with the
  Comments panel closed, and the open panel itself could cover the
  topbar's own buttons.
- The Images manager gave no indication when a still-listed image's
  reference had been removed from the document.
- Three mobile-specific issues: Safari zooming in on focusing the
  title field or editor and never zooming back out, the stacked
  editor/preview layout's scroll area getting clipped by `100vh` not
  accounting for the browser's own chrome, and the What's New modal
  cramming a fixed-width screenshot beside its text instead of using
  the full screen.

## [1.15.0] - 2026-08-13

### Added

- Wikilinks — type `[[Document Name]]` (autocompleted as you type) to
  link between documents. It renders as a clickable link in the
  preview: click to jump to that document, or create it if it doesn't
  exist yet.
- A merged Document Info panel (new topbar icon and File-menu entry)
  showing when a document was created/last edited, its word/character
  count, and which other documents link to it.

### Changed

- Document names are now enforced unique — creating or duplicating a
  document that would collide gets a silent `-2`, `-3`, ... suffix.
  Renaming a document to an existing name prompts to Replace the other
  document, Save as a suffixed name, or Cancel.
- Opening or switching to a document no longer moves it to the top of
  the sidebar — only an actual edit does.

### Fixed

- The Help menu's "What's New" entry silently did nothing once you'd
  already seen the latest update — it only ever computed what's still
  unseen, which is empty right after any release announcement closes.
  It now always reopens the full list on demand, while the automatic
  on-load popup still only surfaces what's actually new.

## [1.14.0] - 2026-08-13

### Changed

- What's New is now a data-driven, missed-updates carousel instead of a
  single screen listing everything at once. It shows only the entries
  newer than what you've already seen (just the newest for a first-time
  visitor), one at a time with Prev/Next and a screenshot per entry.

## [1.13.0] - 2026-08-13

### Added

- Threaded comments — select any text and click "Add comment" to anchor
  a note to it. On a document you haven't shared, it's a lightweight
  personal note; on a shared document, it's a full discussion thread
  with replies and resolve/reopen, gated by role (viewers can read,
  reviewers and editors can comment). Anchors track live edits and
  survive reloads by relocating their quoted text. Open the panel from
  File > Comments or the new speech-bubble icon next to Version History.

## [1.12.0] - 2026-08-13

### Added

- Version history with revert — every document, local or shared, now
  builds up automatic background snapshots as you edit (throttled to at
  most one every 5 minutes, capped at 50 per document). Open it from
  File > Version History or the new clock icon next to Share; select any
  past version to preview it read-only, then restore it — nothing in
  history is ever deleted by a restore, so a restore is itself undoable
  by restoring whatever was current before it.

## [1.11.0] - 2026-08-13

### Added

- Slash commands — type `/` at the start of an empty line to open an
  inline menu of block-level insertions (headings, blockquote, code
  block, lists, task list, table, horizontal rule, image, math,
  footnote, diagram), fuzzy-filterable and keyboard-navigable, anchored
  directly under the cursor.

## [1.10.0] - 2026-08-13

### Added

- Command Palette — press Ctrl/Cmd+Shift+P (or use the new Help menu
  entry) to open a searchable overlay that fuzzy-filters across every
  open document and ~35 app commands (formatting, file operations,
  export, view toggles, editing, help), keyboard-navigable end to end.

### Fixed

- The diagram editor's Export button (Copy as SVG / Download PNG) never
  actually opened its menu — a missing event-propagation guard let a
  global "close open dropdowns" listener strip the menu open state the
  instant it was set.

## [1.9.0] - 2026-08-13

### Added

- Vim and Emacs keybinding modes — a new Editor section in Settings lets
  you switch between Normal, Vim, and Emacs editing, persisted across
  sessions. A status bar indicator shows the current Vim mode
  (NORMAL/INSERT/VISUAL/...) live, or a static "EMACS" label in Emacs
  mode.

## [1.8.0] - 2026-08-13

### Added

- Open Source Licenses — a new entry in the About modal listing every
  direct dependency's name, version, and license, linked to its
  repository where available. Generated automatically from what's
  actually installed at build time, so it can never go stale.

## [1.7.0] - 2026-08-13

### Added

- Focus Mode — a new View menu toggle (exits on Escape) that dims every
  paragraph except the one you're editing, keeps your cursor's line
  vertically centered as you type (typewriter scrolling), and hides the
  toolbar, sidebar, menu bar, and status bar, without changing whatever
  view mode (editor/split/preview) you were already in.

## [1.6.1] - 2026-08-12

### Fixed

- Custom export CSS's `</style` escaping (added in v1.6.0 to stop the
  field from being able to break out of its `<style>` tag in an HTML
  export) only matched a literal lowercase `</style`. HTML end tags are
  matched case-insensitively, so a variant like `</STYLE>` could still
  close the tag early and let arbitrary markup follow it in the
  exported file. The check is now case-insensitive.

## [1.6.0] - 2026-08-12

### Added

- Custom CSS on export — a new field in Settings lets you write CSS that
  applies to HTML and PDF exports, overriding the built-in styling. The
  live preview is unaffected.

## [1.5.0] - 2026-08-12

### Added

- GFM footnote support — `[^1]` inline references and `[^1]: text`
  definitions, rendered as bare superscript markers with a collected
  "Footnotes" section at the document's end regardless of where each
  definition was typed, plus a toolbar button to insert an auto-numbered
  reference + definition pair.

## [1.4.5] - 2026-08-12

### Fixed

- Sync scroll now interpolates using each side's own rendered pixel
  height for a block, not its source line count — a long paragraph
  that wraps into many editor rows previously reported the same single
  line number throughout, so the preview stayed frozen at its start
  while scrolling through it, then any short paragraph right after got
  almost no share of the editor's scroll range and flew by in an
  instant.

## [1.4.4] - 2026-08-12

### Fixed

- Scrolling through the interior of a tall block (a long code fence, a
  big list) no longer looks stuck at the block's start on the other
  side — sync scroll now interpolates proportionally within a block's
  own line/pixel range, not just snapping to its top.

## [1.4.3] - 2026-08-12

### Fixed

- Scrolling either the editor or preview all the way to the end no longer
  leaves the other pane short of its own end — both now recognize "at the
  true end" and mirror it directly, instead of only snapping to the top
  of the last block, which could fall noticeably short once that block
  didn't exactly fill the remaining viewport height.

## [1.4.2] - 2026-08-12

### Fixed

- The preview now also follows the cursor while typing or navigating,
  not just when you scroll — v1.4.1's line-mapped sync only reacted to
  explicit scroll events, so editing a line already visible in the
  editor's viewport never brought its corresponding preview block into
  view, even when a tall diagram or image had pushed it far out of
  sight. Only scrolls the preview when the current block isn't already
  visible, so it doesn't jump around on every keystroke.

## [1.4.1] - 2026-08-12

### Fixed

- Synced scrolling between the editor and preview no longer desyncs on
  documents with a tall Mermaid diagram or large image — it now maps each
  preview block to the source line it was rendered from and snaps to the
  matching block, instead of matching raw scroll percentage (which broke
  down badly once one block's rendered height was very disproportionate
  to how many source lines it represented).

## [1.4.0] - 2026-08-12

### Added

- KaTeX math rendering in the live preview and exports — `$inline$` and
  `$$block$$` LaTeX, loaded lazily so documents without math pay no extra
  cost, plus a toolbar button to insert a math snippet.

### Fixed

- Mermaid diagrams no longer flash back to their raw source text on every
  keystroke anywhere in the document — an already-rendered, unchanged
  diagram is now preserved instead of being regenerated.
- Exported standalone HTML files with math now include KaTeX's stylesheet,
  so the math renders correctly instead of appearing unstyled.

## [1.3.0] - 2026-08-12

### Added

- Export a diagram as SVG (copied to the clipboard) or PNG (downloaded) from
  the diagram editor's new Export menu.
- Pan and zoom on the diagram editor's preview — scroll to zoom, drag to
  pan, with a "Reset view" button to snap back to the original position.
- Mermaid-aware syntax highlighting in the diagram editor's code pane,
  covering all seven supported diagram types.

### Fixed

- Diagram text now renders as native SVG rather than embedded HTML labels,
  fixing a browser security restriction that silently broke PNG export for
  every diagram.

## [1.2.0] - 2026-08-12

### Added

- Dedicated full-screen diagram editor — build a Mermaid diagram (any
  diagram type) in a proper code + live-preview workspace, with starter
  templates (flowchart, sequence, class, state, ER, Gantt, pie) and a
  collapsible syntax reference, opened from a new toolbar button.
- Hover over any diagram already in the document to reveal an Edit button
  that reopens it in the same editor, pre-loaded with its current source.
- Diagrams are stored by reference (mirroring how pasted images already
  work) — editing a diagram never touches the surrounding document text,
  and exporting or publishing to a Gist always resolves refs back to real,
  portable Mermaid syntax.

## [1.1.0] - 2026-08-12

### Added

- Mermaid diagram rendering in the live preview — fenced ` ```mermaid ` code
  blocks render as flowcharts/diagrams instead of plain code, matching the
  document's light/dark theme and updating as you type.
- Per-diagram error isolation — invalid Mermaid syntax shows an inline error
  on that one diagram without affecting the rest of the preview.
- `mermaid` loads lazily (dynamic import), only for documents that actually
  contain a diagram — no cost for documents that don't use one.

### Changed

- HTML, PDF, and plain-text export now wait for any in-flight diagram
  render to finish before reading the preview, so a diagram pasted
  immediately before exporting is captured rendered rather than as raw
  source.

## [1.0.0] - 2026-08-07

Initial release. See [README](README.md) for the full feature set as of
this release: live split-pane preview, CodeMirror 6 editing with GFM
support, multi-document sidebar, real-time multi-user collaboration
(Yjs-based, with viewer/reviewer/editor roles), GitHub sign-in with
Gist publish/open, local image support, import/export to Markdown,
HTML, PDF, and plain text, and light/dark theming.
