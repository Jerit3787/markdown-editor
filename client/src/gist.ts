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
  const content = window.MDE.getResolvedContent();
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
    const content = file.truncated ? await fetchRaw(file.raw_url) : file.content;
    const name = file.filename.replace(/\.(md|markdown)$/i, "");
    window.MDE.createDoc({ name, content, gistId: data.id });
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
