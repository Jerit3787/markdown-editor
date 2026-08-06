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
import { showToast } from "./stores/toast";

let connectedUsername: string | null = null;

// Kicked off here at module top-level — not inside init()/DOMContentLoaded
// — specifically so it's guaranteed to exist before collab.ts's own
// DOMContentLoaded handler (which awaits it) runs. Deferred module scripts
// always finish their top-level code before ANY DOMContentLoaded listener
// fires, regardless of which script registered its listener first, so this
// ordering is safe where doing it inside init() was not.
window.MDE.githubSessionReady = checkSession();

document.addEventListener("DOMContentLoaded", init);

function init() {
  // Sign-in/disconnect buttons live in Settings.svelte now, which drives
  // them itself (window.MDE.openGithubSignInPopup() / the logout redirect)
  // — this file only needs to keep the underlying session state (below)
  // in sync via the githubUsername store, which Settings subscribes to.
  document.getElementById("menuPublishGist").addEventListener("click", publish);
  initOpenGistModal();

  document.getElementById("menuPublishSignedOut").addEventListener("click", () => {
    closeFileMenu();
    window.MDE.requireGithubSignIn("Publishing to Gist needs a connected GitHub account. Sign in to continue.");
  });

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

function render() {
  window.MDE.githubUsername = connectedUsername;
  githubUsernameStore.set(connectedUsername); // Settings.svelte's status display
  const connected = !!connectedUsername;

  // Signed out: File menu shows a plain "Publish to Gist" row that opens a
  // sign-in prompt. Signed in: swap to the real Publish submenu.
  document.getElementById("menuPublishSignedOut").hidden = connected;
  document.getElementById("publishSubmenu").hidden = !connected;

  const label = document.getElementById("menuGistLabel");
  const viewLink = document.getElementById("gistViewLink") as HTMLAnchorElement;
  const doc = window.MDE.getActiveDoc();
  const hasGist = doc && doc.gistId;
  label.textContent = hasGist ? "Update Gist" : "Publish to Gist";
  viewLink.hidden = !hasGist;
  if (hasGist) viewLink.href = `https://gist.github.com/${doc.gistId}`;
}

function closeFileMenu() {
  document.getElementById("fileMenu").classList.remove("open");
  document.querySelectorAll("#fileMenu .menu-submenu.open").forEach((sub) => {
    sub.classList.remove("open");
    sub.querySelector(".menu-submenu-trigger").classList.remove("active");
  });
}

async function publish() {
  if (!connectedUsername) {
    closeFileMenu();
    window.MDE.requireGithubSignIn("Publishing to Gist needs a connected GitHub account. Sign in to continue.");
    return;
  }
  const doc = window.MDE.getActiveDoc();
  if (!doc) return;
  // getResolvedContent() inlines images as base64 data URIs — that's the
  // only thing the plain REST API can store (files[name].content is a JSON
  // string), and it's what actually gets published as the gist's text. If
  // the doc has any images we then separately push them as real git blobs
  // (see pushImagesAndRewrite below) and PATCH the gist a second time with
  // real gist.githubusercontent.com URLs in place of the base64 data, since
  // GitHub's gist viewer can't render an <img> whose src is a huge base64
  // string embedded in the markdown text.
  const content = window.MDE.getResolvedContent();
  const rawContent = window.MDE.getEditor().getValue();
  const filename = gistFilename(doc);
  const btn = document.getElementById("menuPublishGist") as HTMLButtonElement;
  const label = document.getElementById("menuGistLabel");
  const wasUpdate = !!doc.gistId;
  btn.disabled = true;
  label.textContent = wasUpdate ? "Updating…" : "Publishing…";

  try {
    let gistId = doc.gistId;
    if (gistId) {
      const res = await fetch(`/api/gist/${gistId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: { [filename]: { content } } }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
    } else {
      const res = await fetch("/api/gist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: doc.name || "Untitled", public: false, files: { [filename]: { content } } }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json();
      gistId = data.id;
      window.MDE.setActiveDocGistId(gistId);
    }

    try {
      const rewritten = await pushImagesAndRewrite(gistId, rawContent, doc.images, label);
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

    label.textContent = wasUpdate ? "Updated ✓" : "Published ✓";
    window.MDE.refreshSaveStatus();
    showToast(wasUpdate ? "Gist updated" : "Published to Gist", "success");
  } catch (err: any) {
    label.textContent = `Failed: ${err.message || "unknown error"}`;
    showToast(`Failed to publish: ${err.message || "unknown error"}`, "error");
  } finally {
    btn.disabled = false;
    setTimeout(render, 2000);
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

// Pushes every image referenced in rawContent (that's actually in
// doc.images — plain refs like "screenshot.png") to the gist's git repo as
// a real binary file (see src/gist-images.ts), then returns rawContent
// with those refs rewritten to the real returned URLs. Pushed one at a
// time — parallel pushes to the same gist repo could race against each
// other. Returns null if there was nothing to push, so the caller can skip
// the follow-up PATCH entirely.
async function pushImagesAndRewrite(
  gistId: string,
  rawContent: string,
  images: Record<string, string> | undefined,
  label: HTMLElement
): Promise<string | null> {
  if (!images) return null;

  const refs = new Set<string>();
  for (const match of rawContent.matchAll(MARKDOWN_IMAGE_RE)) {
    if (images[match[2]]) refs.add(match[2]);
  }
  if (refs.size === 0) return null;

  const urlByRef: Record<string, string> = {};
  let done = 0;
  for (const ref of refs) {
    done++;
    label.textContent = `Publishing images (${done}/${refs.size})…`;
    const dataUrl = images[ref];
    const match = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/);
    if (!match) continue;
    const [, mime, contentBase64] = match;
    const res = await fetch(`/api/gist/${gistId}/image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: gistImageFilename(ref, extFromMime(mime)), contentBase64 }),
    });
    if (!res.ok) throw new Error(await errorMessage(res));
    const data = await res.json();
    urlByRef[ref] = data.url;
  }

  return rawContent.replace(MARKDOWN_IMAGE_RE, (match, alt, ref) => {
    const url = urlByRef[ref];
    return url ? `![${alt}](${url})` : match;
  });
}

function initOpenGistModal() {
  const modal = document.getElementById("openGistModal");
  const closeBtn = document.getElementById("openGistModalCloseBtn");
  const openBtn = document.getElementById("gistOpenBtn") as HTMLButtonElement;
  const input = document.getElementById("gistOpenInput") as HTMLInputElement;

  document.getElementById("menuOpenGist").addEventListener("click", () => {
    closeFileMenu();
    input.value = "";
    modal.hidden = false;
    input.focus();
    loadGistList();
  });
  closeBtn.addEventListener("click", () => { modal.hidden = true; });
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });

  openBtn.addEventListener("click", () => openGistFromInput());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") openGistFromInput();
  });
}

function openGistFromInput() {
  const input = document.getElementById("gistOpenInput") as HTMLInputElement;
  const id = parseGistId(input.value.trim());
  if (!id) return;
  openGistById(id, document.getElementById("gistOpenBtn") as HTMLButtonElement);
}

// Shared by both the URL/ID field and clicking a row in "Your Gists" — btn
// is whichever control triggered it, so each entry point gets its own
// Opening…/Failed busy indicator without duplicating that logic.
async function openGistById(id: string, btn: HTMLButtonElement) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Opening…";

  try {
    const res = await fetch(`/api/gist/${id}`);
    if (!res.ok) throw new Error(await errorMessage(res));
    const data = await res.json();
    const files: any[] = Object.values(data.files || {});
    const file = files.find((f) => /\.(md|markdown)$/i.test(f.filename)) || files[0];
    if (!file) throw new Error("Gist has no files");
    const rawContent = file.truncated ? await fetchRaw(file.raw_url) : file.content;
    const name = file.filename.replace(/\.(md|markdown)$/i, "");
    const { content, images } = extractInlineImages(rawContent);
    window.MDE.createDoc({ name, content, images: Object.keys(images).length ? images : undefined, gistId: data.id });
    document.getElementById("openGistModal").hidden = true;
    btn.textContent = original;
    showToast(`Opened "${name}" from Gist`, "success");
  } catch (err) {
    btn.textContent = "Failed";
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
    showToast("Couldn't open that Gist", "error");
  } finally {
    btn.disabled = false;
  }
}

// The user's own gists, fetched fresh every time the modal opens (not
// cached — could go stale between opens, e.g. after publishing a new one
// from this same session) and filtered down to markdown-containing ones
// since a gist can hold any file type.
async function loadGistList() {
  const hint = document.getElementById("gistListHint");
  const list = document.getElementById("gistList");
  list.innerHTML = "";

  if (!connectedUsername) {
    hint.textContent = "Sign in with GitHub to see your own gists here.";
    hint.hidden = false;
    return;
  }

  hint.textContent = "Loading your gists…";
  hint.hidden = false;

  try {
    const res = await fetch("/api/gists");
    if (!res.ok) throw new Error(await errorMessage(res));
    const gists: any[] = await res.json();
    const withMd = gists.filter((g) => Object.keys(g.files || {}).some((name) => /\.(md|markdown)$/i.test(name)));
    if (withMd.length === 0) {
      hint.textContent = "No markdown gists found.";
      return;
    }
    hint.hidden = true;
    renderGistList(withMd);
  } catch (err) {
    hint.textContent = "Couldn't load your gists.";
  }
}

function renderGistList(gists: any[]) {
  const list = document.getElementById("gistList");
  list.innerHTML = "";
  gists.forEach((gist) => {
    const filenames = Object.keys(gist.files || {});
    const mdName = filenames.find((name) => /\.(md|markdown)$/i.test(name)) || filenames[0];
    const item = document.createElement("div");
    item.className = "gist-item";
    item.innerHTML = `
      <div class="gist-meta">
        <div class="gist-name">${escapeHtml(gist.description || mdName || "Untitled gist")}</div>
        <div class="gist-date">Updated ${escapeHtml(formatGistDate(gist.updated_at))}</div>
      </div>
      <button class="secondary-btn" type="button">Open</button>
    `;
    const openRowBtn = item.querySelector("button") as HTMLButtonElement;
    openRowBtn.addEventListener("click", () => openGistById(gist.id, openRowBtn));
    list.appendChild(item);
  });
}

function formatGistDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch (err) {
    return "";
  }
}

function escapeHtml(str: string) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function fetchRaw(url: string) {
  const res = await fetch(url);
  return res.text();
}

async function errorMessage(res: Response) {
  try {
    const data = await res.json();
    return data.message || `HTTP ${res.status}`;
  } catch (e) {
    return `HTTP ${res.status}`;
  }
}

function parseGistId(raw: string) {
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

function extractInlineImages(content: string): { content: string; images: Record<string, string> } {
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
