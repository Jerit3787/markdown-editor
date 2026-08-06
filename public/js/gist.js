// GitHub integration, split across three places in the UI:
//  - #settingsMenu (behind the gear icon): just sign in/out.
//  - #fileMenu's "Publish/Update Gist" row: publish the current doc.
//  - #fileMenu's "From GitHub Gist" row: open one by URL/ID.
// Sign-in is real GitHub OAuth handled by the Worker (src/github-auth.js)
// — the access token is encrypted and kept in an HttpOnly cookie
// server-side; this script never sees it, it just calls our own
// /api/gist/* + /api/auth/github/* endpoints.
let connectedUsername = null;

// Kicked off here at module top-level — not inside init()/DOMContentLoaded
// — specifically so it's guaranteed to exist before collab.js's own
// DOMContentLoaded handler (which awaits it) runs. Deferred module scripts
// always finish their top-level code before ANY DOMContentLoaded listener
// fires, regardless of which script registered its listener first, so this
// ordering is safe where doing it inside init() was not.
window.MDE.githubSessionReady = checkSession();

document.addEventListener("DOMContentLoaded", init);

function init() {
  document.getElementById("gistSignInBtn").addEventListener("click", () => {
    window.MDE.openGithubSignInPopup();
  });
  document.getElementById("gistDisconnectBtn").addEventListener("click", () => {
    location.href = "/api/auth/github/logout";
  });
  document.getElementById("menuPublishGist").addEventListener("click", publish);
  document.getElementById("gistOpenBtn").addEventListener("click", openGist);
  document.getElementById("gistOpenInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") openGist();
  });

  document.getElementById("menuPublishSignedOut").addEventListener("click", () => {
    closeFileMenu();
    window.MDE.requireGithubSignIn("Publishing to Gist needs a connected GitHub account. Sign in to continue.");
  });

  // collab.js already claims onActiveDocChanged — chain onto it rather than
  // clobber it, since both need to react to the active doc switching.
  const existing = window.MDE.onActiveDocChanged;
  window.MDE.onActiveDocChanged = (doc) => {
    if (existing) existing(doc);
    render();
  };

  // Fired by app.js's message listener once the sign-in popup reports
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
  const signInBtn = document.getElementById("gistSignInBtn");
  const disconnectBtn = document.getElementById("gistDisconnectBtn");
  const connected = !!connectedUsername;
  signInBtn.hidden = connected;
  disconnectBtn.hidden = !connected;

  const dot = document.getElementById("gistStatusDot");
  const text = document.getElementById("gistStatusText");
  dot.className = `status-dot status-${connected ? "shared" : "idle"}`;
  text.textContent = connected ? `Signed in as ${connectedUsername}` : "Not connected";

  // Signed out: File menu shows a plain "Publish to Gist" row that opens a
  // sign-in prompt. Signed in: swap to the real Publish submenu.
  document.getElementById("menuPublishSignedOut").hidden = connected;
  document.getElementById("publishSubmenu").hidden = !connected;

  const label = document.getElementById("menuGistLabel");
  const viewLink = document.getElementById("gistViewLink");
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
  const btn = document.getElementById("menuPublishGist");
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
  } catch (err) {
    label.textContent = `Failed: ${err.message || "unknown error"}`;
  } finally {
    btn.disabled = false;
    setTimeout(render, 2000);
  }
}

async function openGist() {
  const input = document.getElementById("gistOpenInput");
  const id = parseGistId(input.value.trim());
  if (!id) return;

  const btn = document.getElementById("gistOpenBtn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Opening…";

  try {
    const res = await fetch(`/api/gist/${id}`);
    if (!res.ok) throw new Error(await errorMessage(res));
    const data = await res.json();
    const files = Object.values(data.files || {});
    const file = files.find((f) => /\.(md|markdown)$/i.test(f.filename)) || files[0];
    if (!file) throw new Error("Gist has no files");
    const content = file.truncated ? await fetchRaw(file.raw_url) : file.content;
    window.MDE.createDoc({ name: file.filename.replace(/\.(md|markdown)$/i, ""), content, gistId: data.id });
    input.value = "";
    closeFileMenu();
    btn.textContent = original;
  } catch (err) {
    btn.textContent = "Failed";
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  } finally {
    btn.disabled = false;
  }
}

async function fetchRaw(url) {
  const res = await fetch(url);
  return res.text();
}

async function errorMessage(res) {
  try {
    const data = await res.json();
    return data.message || `HTTP ${res.status}`;
  } catch (e) {
    return `HTTP ${res.status}`;
  }
}

function parseGistId(raw) {
  const match = raw.match(/([0-9a-f]{20,32})/i);
  return match ? match[1] : null;
}

function gistFilename(doc) {
  const base = (doc.name || "document").trim().replace(/[\\/:*?"<>|]+/g, "-") || "document";
  return `${base}.md`;
}
