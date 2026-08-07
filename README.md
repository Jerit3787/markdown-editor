# Markdown Editor

A fast markdown editor with live preview, multiple documents, real-time multi-user collaboration, GitHub sign-in with Gist publish/open, and export to `.md`, `.html`, `.pdf`, and `.txt`. The client is TypeScript + Svelte 5, built with Vite; the backend is a single Cloudflare Worker (also TypeScript). Documents are saved locally in the browser (`localStorage`); shared documents live in a Durable Object for as long as the room is active.

## Features

- Live split-pane preview (or editor-only / preview-only), synced scrolling between the two
- CodeMirror 6 editor with a formatting toolbar + shortcuts (`Ctrl/Cmd+B`, `Ctrl/Cmd+I`, `Ctrl/Cmd+K`), GitHub-flavored markdown (tables, task lists, strikethrough, autolinks)
- Multiple documents in a sidebar (with a per-doc collapsible heading outline), autosaved as you type
- **Real-time multi-user editing** — a Google-Docs-style Share modal turns any document into a shared, live-collaborative room (viewer/reviewer/editor roles, restricted or anyone-with-the-link access, presence avatars, remote cursors/selections)
- **Sign in with GitHub** — publish/update the current document as a Gist (images pushed as real git blobs, not inlined as base64) or open one of your own Gists
- **Local images** — paste, drag-drop, or use the toolbar button to insert an image; embedded as a base64 data URI locally (2 MB max per image), rewritten to a real hosted image when publishing to a Gist
- Import existing `.md`/`.txt` files
- Export the current document as Markdown, standalone HTML, PDF, or plain text
- Light/dark theme
- VS-Code-style empty state when no documents exist yet

## Multi-user editing — how it works (no database)

Open the Share modal to turn the current document into a collaboration room. Anyone with access to the generated link joins the same session and edits merge live via [Yjs](https://docs.yjs.dev/) (a CRDT, wired to CodeMirror 6 through [y-codemirror.next](https://github.com/yjs/y-codemirror.next)), so concurrent edits from different people always converge correctly — no locking, no "someone else is editing this" errors.

There's no database involved:

- A [Durable Object](https://developers.cloudflare.com/durable-objects/) (`CollabRoom`, in `src/collab-room.ts`) is created per room name (the document's own id). Cloudflare guarantees exactly one instance per room, so it's the natural place to hold that room's Yjs document in memory, relay updates between connected clients over WebSockets, and enforce access control (owner / general access / invited usernames + roles) server-side.
- The room is checkpointed to the Durable Object's own built-in storage (not a separate D1/SQL database) so it survives eviction between sessions.
- If nobody has the link, nothing is shared — the document behaves exactly like before, saved only to your browser's `localStorage`.

## GitHub sign-in and Gists

"Sign in with GitHub" is a real OAuth flow handled entirely by the Worker (`src/github-auth.ts`) — the access token is encrypted and kept in an HttpOnly session cookie (`src/auth.ts`); the client never sees it, only the resulting username. Once signed in you can:

- Publish the current document as a new Gist, or update the one it's already linked to
- Any images in the document are pushed as real binary blobs into the Gist's own git repo (via [isomorphic-git](https://isomorphic-git.org/) talking to GitHub's smart-HTTP endpoints — see `src/gist-images.ts`) and the markdown rewritten to reference them, since Gist's plain REST API can only store text
- Open one of your own Gists (or paste a Gist URL/ID) as a new local document; inline base64 images in an opened Gist are converted back into local image refs

Sharing (the collaboration Share modal) separately requires being signed in too, since access control is keyed by GitHub username.

## Local images

Pasting, dropping, or picking an image reads it client-side (`FileReader`) and embeds it in the markdown as a `![](ref)` reference resolved against the document's own image map (a `![](data:image/...;base64,...)` URI under the hood) — nothing is uploaded anywhere until you explicitly publish to a Gist. Capped at 2 MB per image, since it counts against both `localStorage`'s per-origin quota and, for a shared document, the size of every sync payload sent to collaborators.

## Run locally

```
npm install
npm run build
npm run dev
```

`npm run dev` runs `wrangler dev`, which serves whatever's currently in `client/dist` alongside the collaboration/auth/Gist Worker, matching production — it does **not** rebuild the client on its own, so re-run `npm run build` after client-side changes (or run `vite build --config client/vite.config.ts --watch` in a second terminal). GitHub sign-in and Gist publishing need a real OAuth App (see below); everything else (editing, local multi-doc, export, sharing between two tabs on the same machine) works without one.

For fast client-only iteration without the Worker (no collaboration/auth/Gist endpoints), `npm run dev:client` runs a plain Vite dev server instead.

### GitHub OAuth App (optional, for sign-in/Gist/Share)

Create an OAuth App at GitHub → Settings → Developer settings → OAuth Apps, with callback URL `http://127.0.0.1:8787/api/auth/github/callback` for local dev (or your deployed domain's equivalent in production). Then:

- `GITHUB_CLIENT_ID` is a plain (non-secret) var, already set in `wrangler.jsonc`
- `GITHUB_CLIENT_SECRET` and `SESSION_SECRET` (any random string, used to encrypt the session cookie) are Worker secrets — for local dev put them in a git-ignored `.dev.vars` file:
  ```
  GITHUB_CLIENT_SECRET=...
  SESSION_SECRET=...
  ```
  and for production, `npx wrangler secret put GITHUB_CLIENT_SECRET` / `npx wrangler secret put SESSION_SECRET`.

## Deploy to Cloudflare Workers

Durable Objects only run on Workers (not static-only Cloudflare Pages), so the whole app — the built client and the collaboration/auth/Gist backend — deploys as one Worker:

```
npm install
npx wrangler login   # first time only
npm run deploy
```

That's it — `npm run deploy` builds the client (`vite build`) then runs `wrangler deploy`, which reads `wrangler.jsonc`'s static-assets binding and `CollabRoom` Durable Object migration and provisions both.

## File structure

```
client/
  index.html            App shell (mount points for each Svelte component)
  src/
    main.ts             Entry: mounts every Svelte component, imports app.ts/collab.ts/gist.ts
    app.ts               Editor (CodeMirror 6), document CRUD orchestration, export, menus/modals
    collab.ts             Real-time collaboration client (Yjs + y-codemirror.next + WebSocket), Share modal logic
    gist.ts                GitHub sign-in state, Gist publish/open
    types.ts               Shared types + the window.MDE bridge interface (app.ts <-> collab.ts/gist.ts/components)
    stores/                Svelte stores: docs (the doc list + active doc — the source of truth for document state), share, gist, github, toast, view
    components/            Svelte 5 components: Editor, Toolbar, MenuBar, DocList, Share, Settings, Toast
  vite.config.ts
src/
  worker.ts               Worker entry: routes /api/auth/*, /api/collab/*, /api/gist/*, else serves the built client
  collab-room.ts           CollabRoom Durable Object: Yjs sync/awareness relay, access control, persistence
  auth.ts                  Session cookie encryption/decryption
  github-auth.ts           GitHub OAuth login/callback
  gist-images.ts           Pushes Gist images as real git blobs via isomorphic-git
  memory-fs.ts             In-memory fs shim isomorphic-git runs against (no real filesystem in a Worker)
wrangler.jsonc             Worker + assets + Durable Object config
```

## Notes

- Markdown parsing: [marked](https://marked.js.org/)
- Editing: [CodeMirror 6](https://codemirror.net/)
- Output sanitizing: [DOMPurify](https://github.com/cure53/DOMPurify)
- PDF export: [html2pdf.js](https://github.com/eKoopmans/html2pdf.js)
- Real-time sync: [Yjs](https://docs.yjs.dev/) + [y-codemirror.next](https://github.com/yjs/y-codemirror.next) + [y-protocols](https://github.com/yjs/y-protocols), bundled client-side; the same Yjs/y-protocols packages run server-side inside the Durable Object
- Gist image publishing: [isomorphic-git](https://isomorphic-git.org/)
- UI: [Svelte 5](https://svelte.dev/), bundled with [Vite](https://vite.dev/)
