// GitHub integration, split across three places in the UI:
//  - #settingsMenu (behind the gear icon): just sign in/out.
//  - #fileMenu's "Publish/Update Gist" row: publish the current doc.
//  - #fileMenu's "From GitHub Gist..." row: opens #openGistModal, which
//    offers both a URL/ID paste field and (when signed in) a list of the
//    user's own gists to open with one click.
// Sign-in is real GitHub OAuth handled by the Worker (src/github-auth.ts)
// — the access token is encrypted and kept in an HttpOnly cookie
// server-side; this script never sees it, it just calls our own
// /api/gist/* + /api/auth/github/* endpoints.
import type { Doc } from "./types";
import "./types";
import { githubUsername as githubUsernameStore } from "./stores/github";
import { showToast, showProgressToast, updateProgressToast, finishProgressToast } from "./stores/toast";
import { gistBusyLabel } from "./stores/gist";
import { openGistModalOpen } from "./stores/openGistModal";
import { getActiveDoc, setActiveDocGistId, clearActiveDocGist } from "./stores/docs";
import { workspacesStore } from "./stores/workspaces";
import { chooseGistVisibility } from "./stores/gistVisibilityDialog";
import { get } from "svelte/store";

let connectedUsername: string | null = null;

// Kicked off here at module top-level — not inside init()/DOMContentLoaded
// — specifically so it's guaranteed to exist before collab.ts's own
// DOMContentLoaded handler (which awaits it) runs. Deferred module scripts
// always finish their top-level code before ANY DOMContentLoaded listener
// fires, regardless of which script registered its listener first, so this
// ordering is safe where doing it inside init() was not.
window.MDE.githubSessionReady = checkSession();
// MenuBar.svelte calls these directly (File > Publish, File > Open >
// From GitHub Gist) — it has no access to this module's closure, same
// reasoning as every other window.MDE bridge method.
window.MDE.publishGist = publish;
window.MDE.openGistPicker = openGistPicker;

document.addEventListener("DOMContentLoaded", init);

function init() {
  // collab.ts already claims onActiveDocChanged — chain onto it rather than
  // clobber it, since both need to react to the active doc switching.
  const existing = window.MDE.onActiveDocChanged;
  window.MDE.onActiveDocChanged = (doc) => {
    if (existing) existing(doc);
    render();
  };

  // Fired by app.ts's message listener once the sign-in popup reports
  // success — re-check the session in place instead of reloading the page.
  window.MDE.onGithubAuthComplete = () => {
    window.MDE.githubSessionReady = checkSession();
  };
}

async function checkSession() {
  try {
    const res = await fetch("/api/auth/github/me");
    const data = await res.json();
    connectedUsername = data.connected ? data.username : null;
  } catch (err) {
    connectedUsername = null;
  }
  render();
}

// The Publish submenu's signed-in-vs-out row, its label, and the View Gist
// link are all MenuBar.svelte's own reactive template now (derived from
// githubUsernameStore + the active doc's gistId) — this only needs to keep
// the underlying session state in sync.
function render() {
  window.MDE.githubUsername = connectedUsername;
  githubUsernameStore.set(connectedUsername);
}

// The "repo" scope this app now requests alongside "gist" (see
// src/github-auth.ts) didn't exist on a grant made before that scope was
// added — a user signed in under that older grant needs to re-authorize
// to pick up "gist" before any Gist action will work. Checked fresh on
// every action rather than cached, since the grant can also be revoked
// entirely from GitHub's side at any time. Mirrors repo-sync-ui.ts's
// hasRepoScope/requireRepoScope for the same reason on the "repo" side.
async function hasGistScope(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/github/me");
    const data = await res.json();
    return Array.isArray(data.scopes) && data.scopes.includes("gist");
  } catch (err) {
    return false;
  }
}

async function requireGistScope(): Promise<boolean> {
  if (await hasGistScope()) return true;
  window.MDE.requireGithubSignIn("Publishing to Gist needs a fresh sign-in to grant Gist access. Sign in to continue.");
  return false;
}

async function publish() {
  if (!connectedUsername) {
    window.MDE.requireGithubSignIn("Publishing to Gist needs a connected GitHub account. Sign in to continue.");
    return;
  }
  if (!(await requireGistScope())) return;
  const doc = getActiveDoc();
  if (!doc) return;

  let isPublic = false;
  if (!doc.gistId) {
    const visibility = await chooseGistVisibility();
    if (visibility === null) return; // canceled — no gist created
    isPublic = visibility === "public";
  }
  // getResolvedContent() inlines images as base64 data URIs — that's the
  // only thing the plain REST API can store (files[name].content is a JSON
  // string), and it's what actually gets published as the gist's text. If
  // the doc has any images we then separately push them as real git blobs
  // (see pushImagesAndRewrite below) and PATCH the gist a second time with
  // real gist.githubusercontent.com URLs in place of the base64 data, since
  // GitHub's gist viewer can't render an <img> whose src is a huge base64
  // string embedded in the markdown text.
  const content = window.MDE.getResolvedContent();
  const rawContent = window.MDE.getEditor().state.doc.toString();
  const filename = gistFilename(doc);
  const wasUpdate = !!doc.gistId;
  gistBusyLabel.set(wasUpdate ? "Updating…" : "Publishing…");
  const progressToastId = showProgressToast(wasUpdate ? "Updating…" : "Publishing…");

  try {
    let gistId = doc.gistId;
    if (gistId) {
      // The files{} key must exactly match an existing filename in the
      // gist to update it in place — anything else creates a *new*
      // file instead (this is what silently left renamed documents
      // with two files in their gist: the freshly-computed name from
      // the new doc.name never matched what the gist actually had).
      // doc.gistFilename tracks what the gist currently knows this
      // file as; a real rename needs GitHub's own rename form (the
      // *old* key, with a `filename` property naming the new one).
      const knownFilename = doc.gistFilename || filename;
      const files = knownFilename !== filename ? { [knownFilename]: { filename, content } } : { [filename]: { content } };
      const res = await fetch(`/api/gist/${gistId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      if (res.status === 404) {
        // The gist was deleted outside this app — there's no other way
        // for an update to 404 here. Clear the local link rather than
        // leaving the document looking permanently (and unfixably)
        // linked to a gist that no longer exists.
        clearActiveDocGist();
        window.MDE.refreshSaveStatus();
        gistBusyLabel.set("Failed: Gist no longer exists");
        finishProgressToast(progressToastId, "That Gist no longer exists — publish again to create a new one.", "error");
        return;
      }
      if (!res.ok) throw new Error(await errorMessage(res));
      if (knownFilename !== filename) setActiveDocGistId(gistId, filename);
    } else {
      const res = await fetch("/api/gist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: doc.name || "Untitled", public: isPublic, files: { [filename]: { content } } }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json();
      gistId = data.id;
      setActiveDocGistId(gistId, filename);
    }

    try {
      const rewritten = await pushImagesAndRewrite(gistId, rawContent, doc.images, (message) => updateProgressToast(progressToastId, message));
      if (rewritten) {
        const res = await fetch(`/api/gist/${gistId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: { [filename]: { content: rewritten } } }),
        });
        if (!res.ok) throw new Error(await errorMessage(res));
      }
    } catch (imgErr: any) {
      showToast(`Gist published, but pushing images failed: ${imgErr.message || "unknown error"}`, "error");
    }

    gistBusyLabel.set(wasUpdate ? "Updated ✓" : "Published ✓");
    window.MDE.refreshSaveStatus();
    finishProgressToast(progressToastId, wasUpdate ? "Gist updated" : "Published to Gist", "success");
  } catch (err: any) {
    gistBusyLabel.set(`Failed: ${err.message || "unknown error"}`);
    finishProgressToast(progressToastId, `Failed to publish: ${err.message || "unknown error"}`, "error");
  } finally {
    setTimeout(() => gistBusyLabel.set(null), 2000);
  }
}

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

function extFromMime(mime: string): string {
  const sub = mime.split("+")[0].toLowerCase();
  return sub === "jpeg" ? "jpg" : sub;
}

function gistImageFilename(ref: string, ext: string): string {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(ref) ? ref : `${ref}.${ext}`;
}

// Pushes every image referenced in rawContent to the gist's git repo as a
// real binary file (see src/gist-images.ts), then returns rawContent with
// those references rewritten to the real returned URLs. Two kinds of
// image source can appear in the markdown:
//  - a short ref resolved against doc.images (the normal case — paste or
//    drop an image and it's stored there, referenced as `![x](key)`)
//  - a literal `data:image/...;base64,...` URI already inline in the text
//    itself — documents saved before the ref system existed, or markdown
//    pasted in by hand, never went through that conversion, so this has
//    to catch them directly rather than assuming every image is a ref.
// Pushed one at a time — parallel pushes to the same gist repo could race
// against each other. Returns null if there was nothing to push, so the
// caller can skip the follow-up PATCH entirely.
async function pushImagesAndRewrite(
  gistId: string,
  rawContent: string,
  images: Record<string, string> | undefined,
  onProgress?: (message: string) => void,
): Promise<string | null> {
  const sources = new Map<string, string>(); // markdown src text -> data URI to push
  for (const match of rawContent.matchAll(MARKDOWN_IMAGE_RE)) {
    const src = match[2];
    if (images && images[src]) {
      sources.set(src, images[src]);
    } else if (/^data:image\//.test(src)) {
      sources.set(src, src);
    }
  }
  if (sources.size === 0) return null;

  const urlBySource: Record<string, string> = {};
  let done = 0;
  let counter = 0;
  for (const [src, dataUrl] of sources) {
    done++;
    const message = `Publishing images (${done}/${sources.size})…`;
    gistBusyLabel.set(message);
    onProgress?.(message);
    const match = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/);
    if (!match) continue;
    const [, mime, contentBase64] = match;
    const filename = src.startsWith("data:") ? `image-${++counter}.${extFromMime(mime)}` : gistImageFilename(src, extFromMime(mime));
    const res = await fetch(`/api/gist/${gistId}/image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, contentBase64 }),
    });
    if (!res.ok) throw new Error(await errorMessage(res));
    const data = await res.json();
    urlBySource[src] = data.url;
  }

  return rawContent.replace(MARKDOWN_IMAGE_RE, (match, alt, src) => {
    const url = urlBySource[src];
    return url ? `![${alt}](${url})` : match;
  });
}

// File > Open > From GitHub Gist... (MenuBar.svelte) — the modal itself
// (OpenGistModal.svelte) owns its own list-loading, so this just opens it.
// Guarded here (not just via a disabled menu item) so any other trigger
// of window.MDE.openGistPicker() is covered too, same reasoning as
// app.ts's createNewDoc/openLocalFile guards.
function openGistPicker() {
  if (get(workspacesStore).length === 0) {
    showToast("Create a workspace first", "error");
    return;
  }
  openGistModalOpen.set(true);
}

export function formatGistDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch (err) {
    return "";
  }
}

export async function fetchRaw(url: string) {
  const res = await fetch(url);
  return res.text();
}

// GitHub's own proxied errors (gist create/update/get) come back as JSON
// with a "message" field, but this app's own validation errors (e.g.
// gist-images.ts's 400s) are plain text — res.json() throws on those and
// used to fall straight through to a bare "HTTP 400"/"HTTP 404", silently
// discarding whatever specific reason the server actually gave. Reading
// the body as text first (bodies can only be consumed once, so this can't
// also try res.json() after) and attempting JSON.parse on it ourselves
// gets the best of both: GitHub's "message" field when there is one, the
// raw text otherwise, and only a bare "HTTP {status}" when the body is
// truly empty.
export async function errorMessage(res: Response) {
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (data && typeof data.message === "string" && data.message) return data.message;
  } catch (e) {
    // not JSON — fall through to the raw text below
  }
  return text || `HTTP ${res.status}`;
}

export function parseGistId(raw: string) {
  const match = raw.match(/([0-9a-f]{20,32})/i);
  return match ? match[1] : null;
}

function gistFilename(doc: Doc) {
  const base = (doc.name || "document").trim().replace(/[\\/:*?"<>|]+/g, "-") || "document";
  return `${base}.md`;
}

// A gist opened here might carry full base64 data URIs inline (e.g. it
// was published from a doc created before the image-ref system existed,
// or just pasted in by hand) — every other document in this app keeps
// image data out of the markdown text itself, referencing it by a short
// key resolved against doc.images instead (see resolveImageRefs in
// app.ts). Reconvert on the way in so newly-opened gists match that
// convention rather than carrying raw base64 in the editor buffer.
const INLINE_IMAGE_RE = /!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\)/g;

export function extractInlineImages(content: string): { content: string; images: Record<string, string> } {
  const images: Record<string, string> = {};
  let counter = 0;
  const newContent = content.replace(INLINE_IMAGE_RE, (match, alt, dataUrl) => {
    counter++;
    const ref = `img-${Date.now().toString(36)}-${counter}`;
    images[ref] = dataUrl;
    return `![${alt}](${ref})`;
  });
  return { content: newContent, images };
}
