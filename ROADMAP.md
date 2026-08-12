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

## In progress

- [ ] KaTeX / LaTeX math rendering — `$inline$` / `$$block$$`, toolbar
      button to insert a snippet
      (spec: `docs/superpowers/specs/2026-08-12-katex-math-design.md`)

## Backlog — quick wins

Small, client-side-only, drop into the existing render pipeline.

- [ ] Footnotes (`marked` already ships a footnotes extension)
- [ ] Custom CSS on export
- [ ] Focus / typewriter / zen mode
- [ ] Vim / Emacs keybindings

## Backlog — leverage what we have

Extends existing Yjs / role infrastructure rather than adding new systems.

- [ ] Version history with revert (periodic Yjs doc snapshots in Durable
      Object storage)
- [ ] Threaded comments anchored to text (natural extension of the existing
      reviewer role)
- [ ] Wikilinks + backlinks between documents
- [ ] Command palette / slash commands

## Backlog — bigger bets

New infrastructure, backend, or scope — each its own project.

- [ ] AI writing assist / chat-with-doc
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
