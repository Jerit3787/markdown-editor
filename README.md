# Markdown Editor

A fast markdown editor with live preview, multiple documents, real-time
multi-user collaboration, GitHub sign-in with Gist publish/open, and
export to `.md`, `.html`, `.pdf`, and `.txt`. The client is
TypeScript + Svelte 5, built with Vite; the backend is a single
Cloudflare Worker (also TypeScript). Documents are saved locally in the
browser (`localStorage`); shared documents live in a Durable Object for
as long as the room is active.

## Features

- Live split-pane preview (or editor-only / preview-only), synced
  scrolling between the two
- CodeMirror 6 editor with a formatting toolbar + shortcuts
  (`Ctrl/Cmd+B`, `Ctrl/Cmd+I`, `Ctrl/Cmd+K`), GitHub-flavored markdown
  (tables, task lists, strikethrough, autolinks)
- Multiple documents in a sidebar (with a per-doc collapsible heading
  outline), autosaved as you type
- **Real-time multi-user editing** — a Google-Docs-style Share modal
  turns any document into a shared, live-collaborative room
  (viewer/reviewer/editor roles, restricted or anyone-with-the-link
  access, presence avatars, remote cursors/selections)
- **Sign in with GitHub** — publish/update the current document as a
  Gist (images pushed as real git blobs, not inlined as base64) or open
  one of your own Gists
- **Local images** — paste, drag-drop, or use the toolbar button to
  insert an image; embedded as a base64 data URI locally (2 MB max per
  image), rewritten to a real hosted image when publishing to a Gist
- Import existing `.md`/`.txt` files
- Export the current document as Markdown, standalone HTML, PDF, or
  plain text
- Light/dark theme
- Clean empty state (with quick actions to create/import a document)
  when none exist yet

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
