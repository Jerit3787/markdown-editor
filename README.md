# Markdown Editor

A fast markdown editor with live preview, multiple documents, real-time multi-user collaboration, and export to `.md`, `.html`, `.pdf`, and `.txt`. No build step for the app itself — plain HTML/CSS/JS, served and synced by a single Cloudflare Worker. Documents are saved locally in the browser (`localStorage`); shared documents also live in a Durable Object for as long as the room is active.

## Features

- Live split-pane preview (or editor-only / preview-only)
- Formatting toolbar + shortcuts (`Ctrl/Cmd+B`, `Ctrl/Cmd+I`, `Ctrl/Cmd+K`)
- Multiple documents in a sidebar, autosaved as you type
- **Real-time multi-user editing** — click the 👥 button to turn any document into a shared, live-collaborative one and send the link
- Import existing `.md`/`.txt` files
- Export the current document as Markdown, standalone HTML, PDF, or plain text
- Light/dark theme

## Multi-user editing — how it works (no database)

Click the 👥 **Share** button to turn the current document into a collaboration room. Anyone who opens the generated link joins the same session and edits merge live via [Yjs](https://docs.yjs.dev/) (a CRDT), so concurrent edits from different people always converge correctly — no locking, no "someone else is editing this" errors.

There's no database involved:

- A [Durable Object](https://developers.cloudflare.com/durable-objects/) (`CollabRoom`, in `src/collab-room.js`) is created per room name. Cloudflare guarantees exactly one instance per room, so it's the natural place to hold that room's Yjs document in memory and relay updates between connected clients over WebSockets.
- The room is checkpointed to the Durable Object's own built-in key-value storage (not a separate D1/SQL database) so it survives eviction between sessions.
- If nobody has the link, nothing is shared — the document behaves exactly like before, saved only to your browser's `localStorage`.

## Run locally

```
npm install
npm run dev
```

This runs `wrangler dev`, which serves the static site and the collaboration Durable Object together, matching production. (Opening `public/index.html` directly still works for everything except live collaboration, which needs the Worker.)

## Deploy to Cloudflare Workers

Durable Objects only run on Workers (not static-only Cloudflare Pages), so the whole app — static assets and the collaboration backend — deploys as one Worker:

```
npm install
npx wrangler login   # first time only
npm run deploy
```

That's it — `wrangler.jsonc` already declares the static assets binding and the `CollabRoom` Durable Object migration, so `wrangler deploy` provisions both.

## File structure

```
public/
  index.html      Main page/layout
  css/style.css   Styling (light + dark themes)
  js/app.js       Editor logic, document management, export
  js/collab.js    Real-time collaboration client (Yjs + WebSocket)
src/
  worker.js       Worker entry: routes /api/collab/* to the Durable Object, else serves public/
  collab-room.js  CollabRoom Durable Object: Yjs sync/awareness relay + persistence
wrangler.jsonc    Worker + assets + Durable Object config
```

## Notes

- Markdown parsing: [marked](https://marked.js.org/)
- Editing: [CodeMirror 5](https://codemirror.net/5/)
- Output sanitizing: [DOMPurify](https://github.com/cure53/DOMPurify)
- PDF export: [html2pdf.js](https://github.com/eKoopmans/html2pdf.js)
- Real-time sync: [Yjs](https://docs.yjs.dev/) + [y-protocols](https://github.com/yjs/y-protocols), loaded client-side from esm.sh; same packages run server-side inside the Durable Object

CodeMirror/marked/DOMPurify/html2pdf load from cdnjs — an internet connection is required the first time each is fetched (browsers cache them after). The collaboration libraries load from esm.sh the same way.
