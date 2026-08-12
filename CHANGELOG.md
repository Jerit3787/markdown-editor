# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[Semantic Versioning](https://semver.org/).

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
