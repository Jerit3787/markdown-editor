# Architecture

## Workspaces and multi-user editing (no database)

`Workspace` is the sharing unit, not the document — a named group of
documents, one active at a time (VS Code-style). Opening the Share modal
on a workspace turns every document inside it into a shared,
live-collaborative room at once; anyone with access to the generated link
joins the same session and edits merge live via
[Yjs](https://docs.yjs.dev/) (a CRDT, wired to CodeMirror 6 through
[y-codemirror.next](https://github.com/yjs/y-codemirror.next)), so
concurrent edits from different people always converge correctly — no
locking, no "someone else is editing this" errors.

There's no database involved:

- A [Durable Object](https://developers.cloudflare.com/durable-objects/)
  (`WorkspaceRoom`, in `src/workspace-room.ts`) is created per workspace
  id. Cloudflare guarantees exactly one instance per room, so it's the
  natural place to hold every document's live Yjs document in memory,
  relay updates between connected clients over a single multiplexed
  WebSocket (one connection per workspace, not per document — every
  frame is prefixed with a `docId`), and enforce access control (owner /
  general access / invited usernames + roles) server-side.
- Three roles: **editor** (full read/write), **reviewer** (edits become
  tracked insert/delete suggestions the editor accepts, rejects, or the
  reviewer withdraws — not a direct write), **viewer** (Preview-only, no
  edit surface at all).
- The room is checkpointed to the Durable Object's own built-in storage
  (not a separate D1/SQL database) so it survives eviction between
  sessions. Version history snapshots and comment threads live there too.
- Opening a share link previews the workspace (kept only in memory, never
  written to `localStorage`) instead of always committing it to your
  sidebar — a "Keep this workspace" action promotes it, or it's simply
  gone on reload.
- If nobody has the link, nothing is shared — the document behaves
  exactly like before, saved only to your browser's `localStorage`.

`CollabRoom` (`src/collab-room.ts`) is a **legacy**, one-Durable-Object-
per-document predecessor, kept alive only so an old single-document share
link still works — opening one transparently migrates it into a fresh
`WorkspaceRoom` before any live sync attaches. New work targets
`WorkspaceRoom`; treat `CollabRoom` as migration-path-only.

## GitHub sign-in, Gists, and repo sync

"Sign in with GitHub" is a real OAuth flow handled entirely by the
Worker (`src/github-auth.ts`) — the access token is encrypted and kept
in an HttpOnly session cookie (`src/auth.ts`); the client never sees it,
only the resulting username. Once signed in you can:

- Publish the current document as a new Gist, or update the one it's
  already linked to (choosing Public or Secret at first publish — GitHub
  only accepts that choice at creation). Any images in the document are
  pushed as real binary blobs into the Gist's own git repo (via
  [isomorphic-git](https://isomorphic-git.org/) talking to GitHub's
  smart-HTTP endpoints — see `src/gist-images.ts`) and the markdown
  rewritten to reference them, since Gist's plain REST API can only
  store text.
- Open one of your own Gists (or paste a Gist URL/ID) as a new local
  document; inline base64 images in an opened Gist are converted back
  into local image refs.
- Link a workspace to a GitHub repo (`src/github-repo.ts`) and pull every
  `.md` file in it, recursively, as documents; push local changes back
  out as one commit via the Git Data API, with per-file SHA-based
  conflict detection — a file changed on both sides always prompts a
  choice, never a silent overwrite.

Sharing (the collaboration Share modal) separately requires being
signed in too, since access control is keyed by GitHub username.

## Local images

Pasting, dropping, or picking an image reads it client-side
(`FileReader`) and embeds it in the markdown as a `![](ref)` reference
resolved against the document's own image map (a
`![](data:image/...;base64,...)` URI under the hood) — nothing is
uploaded anywhere until you explicitly publish to a Gist or push to a
repo. Capped at 2 MB per image, since it counts against both
`localStorage`'s per-origin quota and, for a shared document, the size
of every sync payload sent to collaborators.

## The `window.MDE` bridge

`client/src/app.ts` owns the CodeMirror 6 instance, the DOM, and most
menu/toolbar/export logic; it publishes a contract on `window.MDE`
(typed as `MDEBridge` in `client/src/types.ts`) that `collab.ts`,
`gist.ts`, `repo-sync.ts`, and Svelte components use to reach the
editor/DOM without a circular import back into `app.ts`. Pure state (the
doc list, active doc, workspaces) lives in `client/src/stores/*.ts`
instead and is imported directly by anything that needs it — the bridge
is only for what genuinely requires `app.ts`'s closure (the live
`EditorView`, mobile-sidebar DOM state, a preview refresh).

## File structure

```
client/
  index.html            App shell — one mount point per Svelte component
  src/
    main.ts              Entry: mounts every Svelte component, imports app.ts/collab.ts/gist.ts
    app.ts                Editor (CodeMirror 6) setup, formatting commands, export, the window.MDE bridge
    collab.ts              Real-time collaboration client (Yjs + y-codemirror.next + WebSocket), Share/Join modal logic
    gist.ts                 GitHub sign-in state, Gist publish/open
    repo-sync.ts             GitHub repo link/push/pull, conflict detection
    suggestions.ts            Reviewer-role suggestion data model shared between the editor and Preview
    search.ts                 Find/replace CodeMirror extension
    wikilinks.ts               [[Wikilink]] parsing, autocomplete, backlinks
    mmd-citations.ts, mmd-metadata.ts, mmd-inline-blocks.ts
                                MultiMarkdown citations/metadata/definition-list-and-super/subscript support
    markdown-compat.ts          Flags app-only/flavor-specific syntax for the compatibility checker
    version-grouping.ts, history.ts
                                Client copy of session-grouping logic (see below) + local snapshot capture
    types.ts                  Shared types + the MDEBridge interface
    stores/                    Svelte stores — one file per piece of state (docs, workspaces, share, comments, version history, ...)
    components/                ~40 Svelte 5 components: Editor, Toolbar, MenuBar, DocList, WorkspaceSwitcher, Share, VersionHistory, CommentsPanel, DocInfoPanel, CommandPalette, DiagramEditor, and every modal
  vite.config.ts
src/
  worker.ts               Worker entry: routes /api/auth/*, /api/workspace/*, /api/collab/*, /api/gist*, /api/repo/*, else serves the built client
  workspace-room.ts        WorkspaceRoom Durable Object — the current, primary collaboration room (see above)
  collab-room.ts            Legacy per-document Durable Object, migration-path-only
  auth.ts                   Session cookie encryption/decryption
  github-auth.ts             GitHub OAuth login/callback
  github-repo.ts              Repo tree/blob/commit/push endpoints backing repo sync
  gist-images.ts               Pushes Gist images as real git blobs via isomorphic-git
  memory-fs.ts                 In-memory fs shim isomorphic-git runs against (no real filesystem in a Worker)
  version-grouping.ts           Worker copy of the session-grouping logic client/src/version-grouping.ts also has (see CLAUDE.md for why it's duplicated, not shared)
  suggestions.ts                 Server-side reviewer-suggestion reconciliation
.github/
  workflows/                  test.yml (CI), auto-tag.yml (tags master on version bump), release.yml (cuts a GitHub Release from CHANGELOG.md)
  scripts/release-helper.cjs    Builds release notes from CHANGELOG.md, backfilling any version whose own release is missing
wrangler.jsonc               Worker + assets + Durable Object config
```

## Process and shipping

Non-trivial features go through a written design spec and implementation
plan before code (`docs/superpowers/specs/` and `docs/superpowers/plans/`)
— see `CLAUDE.md` for the full process, versioning convention, and
release checklist. Merging to `master` with a version bump in
`package.json` auto-tags the commit and cuts a GitHub Release; Cloudflare
auto-deploys from `master` on every push, so merging a PR is the deploy.

## Key dependencies

- Markdown parsing: [marked](https://marked.js.org/)
- Editing: [CodeMirror 6](https://codemirror.net/), with
  [@replit/codemirror-emacs](https://github.com/replit/codemirror-emacs)
  and a Vim keymap for the optional keybinding modes
- Diagrams: [Mermaid](https://mermaid.js.org/)
- Math: [KaTeX](https://katex.org/)
- Output sanitizing: [DOMPurify](https://github.com/cure53/DOMPurify)
- PDF export: [html2pdf.js](https://github.com/eKoopmans/html2pdf.js)
- Real-time sync: [Yjs](https://docs.yjs.dev/) +
  [y-codemirror.next](https://github.com/yjs/y-codemirror.next) +
  [y-protocols](https://github.com/yjs/y-protocols), bundled
  client-side; the same Yjs/y-protocols packages run server-side inside
  the Durable Object
- Gist/repo image publishing: [isomorphic-git](https://isomorphic-git.org/)
- UI: [Svelte 5](https://svelte.dev/), bundled with [Vite](https://vite.dev/)
