# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[Semantic Versioning](https://semver.org/).

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
