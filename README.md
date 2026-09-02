# Markdown Editor

A fast markdown editor with live preview, multiple documents organized
into workspaces, real-time multi-user collaboration (including
Google-Docs-style suggesting), GitHub sign-in with Gist and whole-repo
sync, and export to `.md`, `.html`, `.pdf`, and `.txt`. The client is
TypeScript + Svelte 5, built with Vite; the backend is a single
Cloudflare Worker (also TypeScript). Documents are saved locally in the
browser (`localStorage`) until you share their workspace, at which point
its live state moves into a Durable Object.

## Features

**Editing**

- Live split-pane preview (or editor-only / preview-only), synced
  scrolling between the two, with Focus Mode (paragraph dimming,
  typewriter scrolling, hidden chrome)
- CodeMirror 6 editor with a formatting toolbar + shortcuts, Vim/Emacs
  keybindings, GitHub-flavored markdown (tables, task lists,
  strikethrough, autolinks), MultiMarkdown definition lists and
  superscript/subscript, Mermaid diagrams (with a dedicated diagram
  editor), KaTeX math, footnotes, and citations/bibliography
- Command palette (`Ctrl/Cmd+Shift+P`) and `/`-triggered slash commands
  for inserting any block-level element
- Find and replace (`Ctrl/Cmd+F` / `Ctrl/Cmd+H`) with case/whole-word/
  regex toggles
- `[[Wikilinks]]` between documents with autocomplete, backlinks, and a
  Markdown Compatibility Checker that flags app-only or flavor-specific
  syntax before you export it elsewhere

**Organization**

- Documents grouped into named **workspaces** — switch, create, rename,
  or delete from a sidebar switcher; move a document between workspaces
- Automatic version history for every document (local and shared alike),
  grouped into collapsible editing sessions, with non-destructive restore
  and a GitHub-style diff between any two versions
- Document Info panel — metadata, citations, linked repo/Gist, and the
  compatibility checker, all editable from one place

**Collaboration**

- **Real-time multi-user editing** — share a whole workspace and every
  document inside it syncs live to collaborators at once, with presence
  avatars and remote cursors/selections
- **Suggestion-mode collaboration** (Google Docs parity) — the reviewer
  role proposes tracked insert/delete suggestions instead of editing
  directly; the document's editor accepts, rejects, or the reviewer
  withdraws them. Viewer role is Preview-only
- Threaded, resolvable comments anchored to text, with an unresolved-count
  badge
- Opening a share link previews the workspace first instead of always
  committing it to your sidebar — "Keep this workspace" if you want it

**GitHub integration**

- **Sign in with GitHub** — publish/update the current document as a
  Gist (images pushed as real git blobs, not inlined as base64, with a
  choice of Public/Secret) or open one of your own Gists
- **Whole-repo sync** — link a workspace to a GitHub repo and every
  `.md` file becomes a document; push local changes as one commit or
  pull the latest, with per-file conflict detection
- Version History shows a repo-linked document's real commit history
  alongside local snapshots

**Everything else**

- **Local images** — paste, drag-drop, or pick from already-uploaded
  images; embedded as a base64 data URI locally (2 MB max per image),
  rewritten to a real hosted image when publishing to a Gist or repo;
  replace an image's underlying file in place from its own menu
- Import existing `.md`/`.txt` files; export as Markdown, standalone
  HTML, PDF, or plain text; native print support
- Light/dark theme, a URL for every document (deep links, browser
  back/forward), and a clean empty state when none exist yet

## Quick start

```
npm install
npm run build
npm run dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for full local-dev setup,
including optional GitHub OAuth for sign-in/Gist/Share.

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) — local dev setup, how to submit
  changes
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the app works internally,
  file structure, key dependencies
- [DEPLOYMENT.md](DEPLOYMENT.md) — deploying to Cloudflare Workers
- [SECURITY.md](SECURITY.md) — reporting a vulnerability
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [CHANGELOG.md](CHANGELOG.md)
- [ROADMAP.md](ROADMAP.md)

## License

[MIT](LICENSE)
