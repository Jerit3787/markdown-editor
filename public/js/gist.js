// Publish/update the current document as a GitHub Gist, or open one by
// URL/ID. Auth is a personal access token (gist scope) the user pastes in
// once — no OAuth app, no backend, calls the GitHub REST API directly from
// the browser (api.github.com supports CORS for this).
const TOKEN_KEY = "mde:github_token";
const API = "https://api.github.com";

let token = localStorage.getItem(TOKEN_KEY) || null;
let username = null;

document.addEventListener("DOMContentLoaded", init);

function init() {
  const btn = document.getElementById("gistBtn");
  const menu = document.getElementById("gistMenu");

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("open");
  });
  document.addEventListener("click", () => menu.classList.remove("open"));
  menu.addEventListener("click", (e) => e.stopPropagation());

  document.getElementById("gistConnectBtn").addEventListener("click", connect);
  document.getElementById("gistDisconnectBtn").addEventListener("click", disconnect);
  document.getElementById("gistPublishBtn").addEventListener("click", publish);
  document.getElementById("gistOpenBtn").addEventListener("click", openGist);
  document.getElementById("gistTokenInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") connect();
  });
  document.getElementById("gistOpenInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") openGist();
  });

  // collab.js already claims onActiveDocChanged — chain onto it rather than
  // clobber it, since both need to react to the active doc switching.
  const existing = window.MDE.onActiveDocChanged;
  window.MDE.onActiveDocChanged = (doc) => {
    if (existing) existing(doc);
    renderStatus();
  };

  if (token) verifyToken();
  else renderStatus();
}

async function connect() {
  const input = document.getElementById("gistTokenInput");
  const value = input.value.trim();
  if (!value) return;
  token = value;
  setStatus("Connecting…", "idle");
  const ok = await verifyToken();
  if (ok) {
    localStorage.setItem(TOKEN_KEY, token);
    input.value = "";
  } else {
    token = null;
  }
}

function disconnect() {
  token = null;
  username = null;
  localStorage.removeItem(TOKEN_KEY);
  renderStatus();
}

async function verifyToken() {
  try {
    const res = await fetch(`${API}/user`, { headers: authHeaders() });
    if (!res.ok) throw new Error("Invalid token");
    const data = await res.json();
    username = data.login;
    renderStatus();
    return true;
  } catch (err) {
    username = null;
    setStatus("Invalid token", "idle");
    return false;
  }
}

function authHeaders() {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function renderStatus() {
  const tokenRow = document.getElementById("gistTokenRow");
  const tokenLink = document.getElementById("gistTokenLink");
  const publishBtn = document.getElementById("gistPublishBtn");
  const viewLink = document.getElementById("gistViewLink");
  const disconnectBtn = document.getElementById("gistDisconnectBtn");

  const connected = !!token && !!username;
  tokenRow.hidden = connected;
  tokenLink.hidden = connected;
  publishBtn.hidden = !connected;
  disconnectBtn.hidden = !connected;

  if (connected) {
    setStatus(`Connected as ${username}`, "shared");
    const doc = window.MDE.getActiveDoc();
    const hasGist = doc && doc.gistId;
    publishBtn.textContent = hasGist ? "Update Gist" : "Publish as Gist";
    viewLink.hidden = !hasGist;
    if (hasGist) viewLink.href = `https://gist.github.com/${doc.gistId}`;
  } else {
    setStatus("Not connected", "idle");
    viewLink.hidden = true;
  }
}

function setStatus(text, kind) {
  document.getElementById("gistStatusText").textContent = text;
  document.getElementById("gistStatusDot").className = `status-dot status-${kind}`;
}

async function publish() {
  const doc = window.MDE.getActiveDoc();
  if (!doc) return;
  const content = window.MDE.getEditor().getValue();
  const filename = gistFilename(doc);
  const btn = document.getElementById("gistPublishBtn");
  const wasUpdate = !!doc.gistId;
  btn.disabled = true;
  btn.textContent = wasUpdate ? "Updating…" : "Publishing…";

  try {
    let gistId = doc.gistId;
    if (gistId) {
      const res = await fetch(`${API}/gists/${gistId}`, {
        method: "PATCH",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ files: { [filename]: { content } } }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
    } else {
      const res = await fetch(`${API}/gists`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ description: doc.name || "Untitled", public: false, files: { [filename]: { content } } }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      const data = await res.json();
      gistId = data.id;
      window.MDE.setActiveDocGistId(gistId);
    }
    setStatus(wasUpdate ? "Updated ✓" : "Published ✓", "shared");
  } catch (err) {
    setStatus(err.message || "Publish failed", "idle");
  } finally {
    btn.disabled = false;
    renderStatus();
  }
}

async function openGist() {
  const input = document.getElementById("gistOpenInput");
  const id = parseGistId(input.value.trim());
  if (!id) return;

  const btn = document.getElementById("gistOpenBtn");
  btn.disabled = true;
  btn.textContent = "Opening…";

  try {
    const res = await fetch(`${API}/gists/${id}`, { headers: token ? authHeaders() : { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(await errorMessage(res));
    const data = await res.json();
    const files = Object.values(data.files || {});
    const file = files.find((f) => /\.(md|markdown)$/i.test(f.filename)) || files[0];
    if (!file) throw new Error("Gist has no files");
    const content = file.truncated ? await fetchRaw(file.raw_url) : file.content;
    window.MDE.createDoc({ name: file.filename.replace(/\.(md|markdown)$/i, ""), content, gistId: data.id });
    input.value = "";
    document.getElementById("gistMenu").classList.remove("open");
  } catch (err) {
    setStatus(err.message || "Open failed", "idle");
  } finally {
    btn.disabled = false;
    btn.textContent = "Open";
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
