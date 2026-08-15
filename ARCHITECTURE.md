# Architecture

## Multi-user editing (no database)

Open the Share modal to turn the current document into a collaboration
room. Anyone with access to the generated link joins the same session
and edits merge live via [Yjs](https://docs.yjs.dev/) (a CRDT, wired to
CodeMirror 6 through [y-codemirror.next](https://github.com/yjs/y-codemirror.next)),
so concurrent edits from different people always converge correctly —
no locking, no "someone else is editing this" errors.

There's no database involved:

- A [Durable Object](https://developers.cloudflare.com/durable-objects/)
  (`CollabRoom`, in `src/collab-room.ts`) is created per room name (the
  document's own id). Cloudflare guarantees exactly one instance per
  room, so it's the natural place to hold that room's Yjs document in
  memory, relay updates between connected clients over WebSockets, and
  enforce access control (owner / general access / invited usernames +
  roles) server-side.
- The room is checkpointed to the Durable Object's own built-in storage
  (not a separate D1/SQL database) so it survives eviction between
  sessions.
- If nobody has the link, nothing is shared — the document behaves
  exactly like before, saved only to your browser's `localStorage`.

## GitHub sign-in and Gists

"Sign in with GitHub" is a real OAuth flow handled entirely by the
Worker (`src/github-auth.ts`) — the access token is encrypted and kept
in an HttpOnly session cookie (`src/auth.ts`); the client never sees it,
only the resulting username. Once signed in you can:

- Publish the current document as a new Gist, or update the one it's
  already linked to
- Any images in the document are pushed as real binary blobs into the
  Gist's own git repo (via [isomorphic-git](https://isomorphic-git.org/)
  talking to GitHub's smart-HTTP endpoints — see `src/gist-images.ts`)
  and the markdown rewritten to reference them, since Gist's plain REST
  API can only store text
- Open one of your own Gists (or paste a Gist URL/ID) as a new local
  document; inline base64 images in an opened Gist are converted back
  into local image refs

Sharing (the collaboration Share modal) separately requires being
signed in too, since access control is keyed by GitHub username.

## Local images

Pasting, dropping, or picking an image reads it client-side
(`FileReader`) and embeds it in the markdown as a `![](ref)` reference
resolved against the document's own image map (a
`![](data:image/...;base64,...)` URI under the hood) — nothing is
uploaded anywhere until you explicitly publish to a Gist. Capped at
2 MB per image, since it counts against both `localStorage`'s
per-origin quota and, for a shared document, the size of every sync
payload sent to collaborators.

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

## Key dependencies

- Markdown parsing: [marked](https://marked.js.org/)
- Editing: [CodeMirror 6](https://codemirror.net/)
- Output sanitizing: [DOMPurify](https://github.com/cure53/DOMPurify)
- PDF export: [html2pdf.js](https://github.com/eKoopmans/html2pdf.js)
- Real-time sync: [Yjs](https://docs.yjs.dev/) + [y-codemirror.next](https://github.com/yjs/y-codemirror.next) + [y-protocols](https://github.com/yjs/y-protocols), bundled client-side; the same Yjs/y-protocols packages run server-side inside the Durable Object
- Gist image publishing: [isomorphic-git](https://isomorphic-git.org/)
- UI: [Svelte 5](https://svelte.dev/), bundled with [Vite](https://vite.dev/)
