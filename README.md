# Markdown Editor

A fast markdown editor with live preview, multiple documents, real-time multi-user collaboration, and export to `.md`, `.html`, `.pdf`, and `.txt`. No build step for the app itself — plain HTML/CSS/JS, served and synced by a single Cloudflare Worker. Documents are saved locally in the browser (`localStorage`); shared documents also live in a Durable Object for as long as the room is active.

## Features

- Live split-pane preview (or editor-only / preview-only)
- Formatting toolbar + shortcuts (`Ctrl/Cmd+B`, `Ctrl/Cmd+I`, `Ctrl/Cmd+K`)
- Multiple documents in a sidebar, autosaved as you type
- **Real-time multi-user editing** — click the 👥 button to turn any document into a shared, live-collaborative one and send the link
- **Local images** — paste, drag-drop, or use the toolbar 🖼 button to insert an image; it uploads to R2 and a `![](url)` reference is inserted
- Import existing `.md`/`.txt` files
- Export the current document as Markdown, standalone HTML, PDF, or plain text
- Light/dark theme

## Multi-user editing — how it works (no database)

Click the 👥 **Share** button to turn the current document into a collaboration room. Anyone who opens the generated link joins the same session and edits merge live via [Yjs](https://docs.yjs.dev/) (a CRDT), so concurrent edits from different people always converge correctly — no locking, no "someone else is editing this" errors.

There's no database involved:

- A [Durable Object](https://developers.cloudflare.com/durable-objects/) (`CollabRoom`, in `src/collab-room.js`) is created per room name. Cloudflare guarantees exactly one instance per room, so it's the natural place to hold that room's Yjs document in memory and relay updates between connected clients over WebSockets.
- The room is checkpointed to the Durable Object's own built-in key-value storage (not a separate D1/SQL database) so it survives eviction between sessions.
- If nobody has the link, nothing is shared — the document behaves exactly like before, saved only to your browser's `localStorage`.

## Local images

Pasting, dropping, or picking an image uploads it to an R2 bucket (`markdown-editor-images`) via `POST /api/images`, and the editor inserts a `![](/api/images/...)` reference — no data URIs bloating the document (which matters once a document is also being synced live to collaborators). `GET /api/images/:key` serves it back with a long-lived immutable cache header and is fronted by Cloudflare's edge cache, so repeat views rarely hit R2 at all.

There's no auth on this app, so uploads are gated by `ImageQuota` (`src/image-quota.js`), a single Durable Object that enforces, independent of anything the UI does:

- Only `image/png|jpeg|gif|webp|avif`, ≤ 8 MB per file (SVG is rejected — it can carry `<script>`)
- ≤ 20 uploads per IP per hour
- A hard 3 GiB total-storage cap across the whole bucket, comfortably inside R2's 10 GB/month free tier

Once the cap is hit uploads fail with a clear error until you free up space (or raise `MAX_TOTAL_BYTES`) — the bucket cannot silently grow into a bill.

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
  worker.js         Worker entry: routes /api/collab/* and /api/images/*, else serves public/
  collab-room.js    CollabRoom Durable Object: Yjs sync/awareness relay + persistence
  images.js         Image upload (POST /api/images) and serve (GET /api/images/:key) handlers
  image-quota.js    ImageQuota Durable Object: per-IP rate limit + global storage cap
wrangler.jsonc    Worker + assets + Durable Object + R2 bucket config
```

## Notes

- Markdown parsing: [marked](https://marked.js.org/)
- Editing: [CodeMirror 5](https://codemirror.net/5/)
- Output sanitizing: [DOMPurify](https://github.com/cure53/DOMPurify)
- PDF export: [html2pdf.js](https://github.com/eKoopmans/html2pdf.js)
- Real-time sync: [Yjs](https://docs.yjs.dev/) + [y-protocols](https://github.com/yjs/y-protocols), loaded client-side from esm.sh; same packages run server-side inside the Durable Object

CodeMirror/marked/DOMPurify/html2pdf load from cdnjs — an internet connection is required the first time each is fetched (browsers cache them after). The collaboration libraries load from esm.sh the same way.
