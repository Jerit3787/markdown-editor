# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[Semantic Versioning](https://semver.org/).

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
