// Real-time multi-user editing. Loaded as a module (deferred like `defer`,
// runs after app.ts has finished its own DOMContentLoaded init) so
// window.MDE is fully populated by the time we touch it.
//
// Sharing requires a connected GitHub account (see gist.ts / src/auth.ts).
// Access control (owner / general access / invited usernames) is stored
// server-side per room (src/collab-room.ts) and enforced there — this file
// mirrors that state into the UI and does its own best-effort read-only
// enforcement (disabling CodeMirror) for a clean UX, but the server is the
// real authority: it silently drops write messages from any session that
// wasn't actually granted an editor role.
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import "./types";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const COLORS = ["#e64980", "#f76707", "#f59f00", "#40c057", "#12b886", "#228be6", "#7950f2", "#e8590c"];
const ROLE_LABELS: Record<string, string> = { viewer: "Viewer", reviewer: "Reviewer", editor: "Editor" };
const ROLE_VERBS: Record<string, string> = { viewer: "view", reviewer: "comment", editor: "edit" };
const DEFAULT_ACCESS = { owner: null as string | null, generalAccess: "restricted", role: "viewer", invited: [] as string[] };

const room = {
  id: null as string | null,
  ws: null as WebSocket | null,
  ydoc: null as Y.Doc | null,
  ytext: null as Y.Text | null,
  imagesMap: null as Y.Map<string> | null,
  awareness: null as awarenessProtocol.Awareness | null,
  reconnectTimer: null as ReturnType<typeof setTimeout> | null,
  reconnectDelay: 1000,
  lastKnownValue: "",
  applyingRemote: false,
  cursorWidgets: new Map<number, { el: HTMLElement; widget: any }>(),
  cmChangeHandler: null as any,
  cmCursorHandler: null as any,
};

let cm: CodeMirror.Editor;
// The server-side access record for the room currently shown in the Share
// modal, refreshed on open and after every change. Null until first fetched.
let currentAccess: typeof DEFAULT_ACCESS | null = null;

document.addEventListener("DOMContentLoaded", init);

function init() {
  cm = window.MDE.getEditor();
  window.MDE.onBeforeDocLoad = teardown;
  window.MDE.onActiveDocChanged = handleDocChanged;
  // Local image inserts (see app.ts's insertImageWithUpload) get mirrored
  // into the room's Yjs map so collaborators receive the image too — same
  // Y.Doc as the text, just a separate top-level type.
  window.MDE.onImageAdded = (key, dataUrl) => {
    if (room.imagesMap) room.ydoc.transact(() => room.imagesMap.set(key, dataUrl), "local");
  };

  setupShareUI();

  const shareUrlMatch = location.pathname.match(SHARE_PATH);
  if (shareUrlMatch) {
    history.replaceState(null, "", "/" + location.search + location.hash);
    joinSharedLink(shareUrlMatch[1]);
  } else {
    handleDocChanged(window.MDE.getActiveDoc());
  }
}

// Share links look like /d/<docId>/<view|review|edit> (Google-Docs-style),
// not query params. The mode segment is purely informational for whoever's
// reading the link — actual access is always resolved server-side from the
// room's access record (see computeMyRole), never trusted from the URL.
const SHARE_PATH = /^\/d\/([A-Za-z0-9_-]{1,128})\/(?:view|review|edit)$/;
const ROLE_TO_SEGMENT: Record<string, string> = { viewer: "view", reviewer: "review", editor: "edit" };

// A doc's own id doubles as its room id (see src/collab-room.ts) — a share
// link is stable the moment the doc exists, not a fresh id minted only once
// sharing is turned on.
async function joinSharedLink(roomId: string) {
  const existing = window.MDE.findDocById(roomId);
  // createDoc() already activates the new doc; switchDoc() only needed to
  // bring an already-known local copy back into view.
  if (existing) window.MDE.switchDoc(existing.id);
  else window.MDE.createDoc({ id: roomId, name: "Shared document" });

  await window.MDE.githubSessionReady;
  if (!window.MDE.githubUsername) {
    window.MDE.requireGithubSignIn("Sign in with GitHub to open this shared document.");
    return;
  }
  const access = await fetchAccess(roomId);
  const role = computeMyRole(access, window.MDE.githubUsername);
  if (!role) {
    alert("You don't have access to this document. Ask the owner to invite your GitHub username, or share a link with general access turned on.");
    return;
  }
  window.MDE.markActiveDocShared(true);
  joinRoom(roomId, { seedFromLocal: false, role });
}

function computeMyRole(access: typeof DEFAULT_ACCESS, username: string | null): string | null {
  if (!username) return null;
  if (access.owner === username) return "editor";
  if (access.generalAccess === "anyone") return access.role;
  if (access.invited.includes(username)) return "editor";
  return null;
}

// ---------- Room lifecycle ----------

function handleDocChanged(doc: any) {
  teardown();
  if (doc && doc.shared) rejoinKnownRoom(doc);
  else renderShareUI();
}

async function rejoinKnownRoom(doc: any) {
  await window.MDE.githubSessionReady;
  if (!window.MDE.githubUsername) return; // can't reconnect without a session; modal will prompt if they try to share
  const access = await fetchAccess(doc.id);
  const role = computeMyRole(access, window.MDE.githubUsername);
  if (!role) return;
  joinRoom(doc.id, { seedFromLocal: false, role });
}

function joinRoom(roomId: string, { seedFromLocal, role }: { seedFromLocal: boolean; role: string }) {
  teardown();
  room.id = roomId;
  room.ydoc = new Y.Doc();
  room.ytext = room.ydoc.getText("content");
  room.imagesMap = room.ydoc.getMap("images");
  room.imagesMap.observe((event, tr) => {
    if (tr.origin === "local") return;
    event.changes.keys.forEach((change, key) => {
      if (change.action === "delete") return;
      const dataUrl = room.imagesMap.get(key);
      if (dataUrl) window.MDE.setDocImage(key, dataUrl);
    });
  });
  room.awareness = new awarenessProtocol.Awareness(room.ydoc);

  bindEditor();
  if (seedFromLocal) pushLocalContentIntoYText(cm.getValue());
  if (seedFromLocal) seedImagesIntoRoom();

  cm.setOption("readOnly", role !== "editor");

  const username = window.MDE.githubUsername;
  const identity = { name: username, color: colorForUsername(username) };
  room.awareness.setLocalState({ user: identity, cursor: cursorFieldFromCm(), role, username });
  room.awareness.on("update", onLocalAwarenessUpdate);

  connect();
  renderShareUI();
}

function teardown() {
  cm.setOption("readOnly", false);
  if (room.reconnectTimer) {
    clearTimeout(room.reconnectTimer);
    room.reconnectTimer = null;
  }
  if (room.ws) {
    room.ws.onclose = null;
    room.ws.onerror = null;
    try { room.ws.close(); } catch (e) { /* already closed */ }
  }
  if (room.awareness) room.awareness.destroy();
  if (room.ydoc) room.ydoc.destroy();
  if (room.ytext && room.cmChangeHandler) cm.off("change", room.cmChangeHandler);
  if (room.cmCursorHandler) cm.off("cursorActivity", room.cmCursorHandler);
  for (const entry of room.cursorWidgets.values()) entry.widget.clear();
  room.cursorWidgets.clear();

  room.id = null;
  room.ws = null;
  room.ydoc = null;
  room.ytext = null;
  room.imagesMap = null;
  room.awareness = null;
  room.reconnectDelay = 1000;
  room.lastKnownValue = "";
  room.cmChangeHandler = null;
  room.cmCursorHandler = null;
}

// ---------- CodeMirror <-> Y.Text binding ----------
// Diff-based rather than translating CodeMirror's changeObj chain into fine
// grained ops: CM5 changeObj positions are only valid against the
// intermediate document state at the time each chained change applied,
// which cm.indexFromPos can't reconstruct after the fact. Comparing full
// text before/after and trimming the common prefix/suffix sidesteps that
// entirely and is cheap at markdown-document sizes.

function bindEditor() {
  room.lastKnownValue = room.ytext.toString();

  room.ytext.observe((event, tr) => {
    if (tr.origin === "local") return;
    const newValue = room.ytext.toString();
    room.applyingRemote = true;
    cm.operation(() => applyDiffToCm(room.lastKnownValue, newValue));
    room.lastKnownValue = newValue;
    room.applyingRemote = false;
    renderRemoteCursors();
  });

  room.cmChangeHandler = (instance: CodeMirror.Editor, changeObj: CodeMirror.EditorChange) => {
    if (room.applyingRemote || changeObj.origin === "setValue") return;
    const newValue = cm.getValue();
    if (newValue === room.lastKnownValue) return;
    applyDiffToYText(room.lastKnownValue, newValue);
    room.lastKnownValue = newValue;
  };
  cm.on("change", room.cmChangeHandler);

  room.cmCursorHandler = () => {
    if (room.awareness) room.awareness.setLocalStateField("cursor", cursorFieldFromCm());
  };
  cm.on("cursorActivity", room.cmCursorHandler);
}

function pushLocalContentIntoYText(value: string) {
  applyDiffToYText(room.lastKnownValue, value);
  room.lastKnownValue = value;
}

function seedImagesIntoRoom() {
  const doc = window.MDE.getActiveDoc();
  if (!doc || !doc.images) return;
  room.ydoc.transact(() => {
    Object.entries(doc.images).forEach(([key, dataUrl]) => room.imagesMap.set(key, dataUrl));
  }, "local");
}

function applyDiffToYText(oldVal: string, newVal: string) {
  const [start, oldEnd, newEnd] = diffRange(oldVal, newVal);
  room.ydoc.transact(() => {
    if (oldEnd > start) room.ytext.delete(start, oldEnd - start);
    if (newEnd > start) room.ytext.insert(start, newVal.slice(start, newEnd));
  }, "local");
}

function applyDiffToCm(oldVal: string, newVal: string) {
  const [start, oldEnd, newEnd] = diffRange(oldVal, newVal);
  const from = cm.posFromIndex(start);
  const to = cm.posFromIndex(oldEnd);
  cm.replaceRange(newVal.slice(start, newEnd), from, to, "yjs");
}

function diffRange(a: string, b: string): [number, number, number] {
  let start = 0;
  const minLen = Math.min(a.length, b.length);
  while (start < minLen && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a.charCodeAt(aEnd - 1) === b.charCodeAt(bEnd - 1)) {
    aEnd--;
    bEnd--;
  }
  return [start, aEnd, bEnd];
}

function cursorFieldFromCm() {
  return { index: cm.indexFromPos(cm.getCursor()) };
}

// ---------- Remote cursor rendering ----------

function renderRemoteCursors() {
  if (!room.awareness) return;
  const states = room.awareness.getStates();
  const seen = new Set();
  states.forEach((state: any, clientID: number) => {
    if (clientID === room.awareness.clientID) return;
    if (!state || !state.cursor || !state.user) return;
    seen.add(clientID);
    const pos = cm.posFromIndex(Math.min(state.cursor.index, room.ytext.length));
    let entry = room.cursorWidgets.get(clientID);
    if (!entry) {
      const el = buildCursorEl(state.user);
      entry = { el, widget: cm.setBookmark(pos, { widget: el, insertLeft: true }) };
      room.cursorWidgets.set(clientID, entry);
    } else {
      entry.widget.clear();
      entry.widget = cm.setBookmark(pos, { widget: entry.el, insertLeft: true });
    }
  });
  for (const [clientID, entry] of room.cursorWidgets) {
    if (!seen.has(clientID)) {
      entry.widget.clear();
      room.cursorWidgets.delete(clientID);
    }
  }
}

function buildCursorEl(remoteUser: { name: string; color: string }) {
  const el = document.createElement("span");
  el.className = "remote-cursor";
  el.style.borderColor = remoteUser.color;
  const label = document.createElement("span");
  label.className = "remote-cursor-label";
  label.textContent = remoteUser.name;
  label.style.background = remoteUser.color;
  el.appendChild(label);
  return el;
}

// ---------- WebSocket transport (Yjs sync + awareness protocol) ----------

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/collab/${encodeURIComponent(room.id)}`);
  ws.binaryType = "arraybuffer";
  room.ws = ws;

  ws.onopen = () => {
    room.reconnectDelay = 1000;
    // Replying to the server's own step1 (below, in handleServerMessage)
    // only tells the SERVER what it's missing from us — it never delivers
    // the server's content back to us. We have to independently request it
    // by sending our own step1, or a freshly-joining client with an empty
    // local doc would never receive any pre-existing room content.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.ydoc);
    send(encoding.toUint8Array(encoder));

    if (room.awareness.getLocalState() !== null) {
      sendAwareness([room.awareness.clientID]);
    }
  };

  ws.onmessage = (event) => handleServerMessage(new Uint8Array(event.data as ArrayBuffer));

  ws.onclose = () => {
    scheduleReconnect();
  };
  ws.onerror = () => ws.close();
}

function scheduleReconnect() {
  if (!room.id || room.reconnectTimer) return;
  room.reconnectTimer = setTimeout(() => {
    room.reconnectTimer = null;
    connect();
  }, room.reconnectDelay);
  room.reconnectDelay = Math.min(room.reconnectDelay * 1.6, 10000);
}

function handleServerMessage(data: Uint8Array) {
  const decoder = decoding.createDecoder(data);
  const messageType = decoding.readVarUint(decoder);

  if (messageType === MESSAGE_SYNC) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.readSyncMessage(decoder, encoder, room.ydoc, "server");
    if (encoding.length(encoder) > 1) send(encoding.toUint8Array(encoder));
  } else if (messageType === MESSAGE_AWARENESS) {
    const update = decoding.readVarUint8Array(decoder);
    awarenessProtocol.applyAwarenessUpdate(room.awareness, update, "server");
    renderRemoteCursors();
    renderPresence();
  }
}

function onLocalAwarenessUpdate({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) {
  sendAwareness(added.concat(updated, removed));
  renderPresence();
  renderRemoteCursors();
}

function sendAwareness(clientIDs: number[]) {
  if (!room.awareness || clientIDs.length === 0) return;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, clientIDs));
  send(encoding.toUint8Array(encoder));
}

function send(bytes: Uint8Array) {
  // lib0's encoding.toUint8Array() types its result as Uint8Array<ArrayBufferLike>
  // (could theoretically be SharedArrayBuffer-backed); WebSocket.send()'s DOM
  // lib type wants the narrower ArrayBuffer-backed variant specifically. It's
  // always a plain ArrayBuffer at runtime here — this cast doesn't change that.
  if (room.ws && room.ws.readyState === WebSocket.OPEN) room.ws.send(bytes as Uint8Array<ArrayBuffer>);
}

// ---------- User identity ----------
// Sharing requires a GitHub account, so collab identity is just the signed
// -in username with a color hashed from it (stable across devices/sessions
// — no per-browser random guest name to manage anymore).

function colorForUsername(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length];
}

// ---------- Server access-control API ----------

async function fetchAccess(roomId: string): Promise<typeof DEFAULT_ACCESS> {
  try {
    const res = await fetch(`/api/collab/${encodeURIComponent(roomId)}/access`);
    if (!res.ok) return { ...DEFAULT_ACCESS };
    return { ...DEFAULT_ACCESS, ...(await res.json()) };
  } catch (err) {
    return { ...DEFAULT_ACCESS };
  }
}

async function putAccess(roomId: string, body: unknown): Promise<typeof DEFAULT_ACCESS | null> {
  try {
    const res = await fetch(`/api/collab/${encodeURIComponent(roomId)}/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return { ...DEFAULT_ACCESS, ...(await res.json()) };
  } catch (err) {
    return null;
  }
}

// ---------- UI ----------

function setupShareUI() {
  const shareBtn = document.getElementById("shareBtn");
  const shareModal = document.getElementById("shareModal");
  const accessSelect = document.getElementById("shareAccessSelect") as HTMLSelectElement;
  const roleSelect = document.getElementById("shareRoleSelect") as HTMLSelectElement;
  const copyBtn = document.getElementById("copyShareLink");
  const addPeopleInput = document.getElementById("shareAddPeopleInput") as HTMLInputElement;

  shareBtn.addEventListener("click", async () => {
    await window.MDE.githubSessionReady;
    if (!window.MDE.githubUsername) {
      window.MDE.requireGithubSignIn("Sharing needs a connected GitHub account. Sign in to continue.");
      return;
    }
    shareModal.hidden = false;
    updateOwnerAvatar();
    const doc = window.MDE.getActiveDoc();
    if (doc) {
      currentAccess = await fetchAccess(doc.id);
      renderShareUI();
    }
  });
  document.getElementById("shareModalCloseBtn").addEventListener("click", () => {
    shareModal.hidden = true;
  });
  shareModal.addEventListener("click", (e) => {
    if (e.target === shareModal) shareModal.hidden = true;
  });

  accessSelect.addEventListener("change", async () => {
    const doc = window.MDE.getActiveDoc();
    if (!doc) return;
    const wantAnyone = accessSelect.value === "anyone";
    const access = await putAccess(doc.id, {
      generalAccess: wantAnyone ? "anyone" : "restricted",
      role: roleSelect.value || (currentAccess && currentAccess.role) || "viewer",
      invited: currentAccess ? currentAccess.invited : [],
    });
    if (!access) {
      accessSelect.value = wantAnyone ? "restricted" : "anyone"; // revert on failure
      return;
    }
    currentAccess = access;
    window.MDE.markActiveDocShared(wantAnyone || access.invited.length > 0);
    if (wantAnyone && !room.id) joinRoom(doc.id, { seedFromLocal: true, role: "editor" });
    if (!wantAnyone) teardown();
    renderShareUI();
  });

  roleSelect.addEventListener("change", async () => {
    const doc = window.MDE.getActiveDoc();
    if (!doc || !currentAccess) return;
    const access = await putAccess(doc.id, {
      generalAccess: "anyone",
      role: roleSelect.value,
      invited: currentAccess.invited,
    });
    if (access) {
      currentAccess = access;
      renderShareUI();
    }
  });

  const copyBtnLabel = copyBtn.querySelector("span") || copyBtn;
  copyBtn.addEventListener("click", () => {
    const doc = window.MDE.getActiveDoc();
    if (!doc || !currentAccess) return;
    const isAnyone = currentAccess.generalAccess === "anyone";
    if (!isAnyone && currentAccess.invited.length === 0) return;
    // Invited-only (restricted) links always resolve to editor access per
    // authorize() server-side; "anyone" links carry whatever role is set.
    const segment = isAnyone ? ROLE_TO_SEGMENT[currentAccess.role] || "view" : "edit";
    const link = `${location.origin}/d/${encodeURIComponent(doc.id)}/${segment}`;
    navigator.clipboard.writeText(link).then(() => {
      const original = copyBtnLabel.textContent;
      copyBtnLabel.textContent = "Copied!";
      setTimeout(() => (copyBtnLabel.textContent = original), 1200);
    });
  });

  addPeopleInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const username = addPeopleInput.value.trim().replace(/^@/, "");
    if (!username) return;
    const doc = window.MDE.getActiveDoc();
    if (!doc) return;
    const invited = [...new Set([...(currentAccess ? currentAccess.invited : []), username])];
    const access = await putAccess(doc.id, {
      generalAccess: currentAccess ? currentAccess.generalAccess : "restricted",
      role: currentAccess ? currentAccess.role : "viewer",
      invited,
    });
    if (access) {
      currentAccess = access;
      window.MDE.markActiveDocShared(true);
      addPeopleInput.value = "";
      renderShareUI();
    }
  });

  renderShareUI();
}

function renderShareUI() {
  const accessSelect = document.getElementById("shareAccessSelect") as HTMLSelectElement;
  const roleSelect = document.getElementById("shareRoleSelect") as HTMLSelectElement;
  const copyBtn = document.getElementById("copyShareLink");
  const shareBtn = document.getElementById("shareBtn");
  const docNameSpan = document.getElementById("shareModalDocName");
  const row = document.getElementById("shareAccessRow");
  const iconUse = document.getElementById("shareAccessIconUse");
  const hint = document.getElementById("shareAccessHint");

  const access = currentAccess || DEFAULT_ACCESS;
  const isAnyone = access.generalAccess === "anyone";

  accessSelect.value = isAnyone ? "anyone" : "restricted";
  roleSelect.hidden = !isAnyone;
  if (isAnyone) roleSelect.value = access.role;
  // A link is meaningful once the room is shared in any capacity — either
  // open to anyone, or restricted but with at least one invited person.
  copyBtn.hidden = !isAnyone && access.invited.length === 0;
  shareBtn.classList.toggle("active", !!room.id);

  row.classList.toggle("active", isAnyone);
  iconUse.setAttribute("href", isAnyone ? "#icon-globe" : "#icon-lock");
  hint.textContent = isAnyone
    ? `Anyone on the internet with this link can ${ROLE_VERBS[access.role] || "edit"}`
    : "Only people with access can open with the link";

  const doc = window.MDE.getActiveDoc();
  if (docNameSpan) docNameSpan.textContent = (doc && doc.name) || "Untitled";

  renderPresence();
}

function renderPresence() {
  const bar = document.getElementById("presenceBar");
  const list = document.getElementById("sharePeopleList");

  updateOwnerAvatar();
  if (list) list.querySelectorAll(".share-person:not(.share-person-owner)").forEach((el) => el.remove());

  const connected = room.awareness
    ? Array.from(room.awareness.getStates().entries()).filter(([id, s]: [number, any]) => s && s.user && id !== room.awareness.clientID)
    : [];
  const connectedUsernames = new Set(connected.map(([, s]: [number, any]) => s.username).filter(Boolean));

  if (bar) {
    bar.hidden = connected.length === 0;
    bar.innerHTML = "";
    connected.forEach(([, s]: [number, any]) => bar.appendChild(buildAvatarEl(s.user)));
  }

  if (!list) return;
  connected.forEach(([, s]: [number, any]) => {
    list.appendChild(buildPersonRow(s.user.name, s.user.color, ROLE_LABELS[s.role] || "Editor"));
  });
  const access = currentAccess || DEFAULT_ACCESS;
  access.invited.forEach((username) => {
    if (connectedUsernames.has(username)) return;
    list.appendChild(buildPersonRow(username, null, "Invited", username));
  });
}

function buildPersonRow(name: string, color: string | null, roleLabel: string, removableUsername?: string) {
  const row = document.createElement("div");
  row.className = "share-person";
  const avatar = document.createElement("span");
  avatar.className = "presence-avatar";
  avatar.style.background = color || "var(--text-dim)";
  avatar.textContent = (name || "?").trim().charAt(0).toUpperCase();
  row.appendChild(avatar);
  const nameEl = document.createElement("span");
  nameEl.className = "share-person-name";
  nameEl.textContent = name;
  row.appendChild(nameEl);
  if (removableUsername) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "share-person-remove";
    removeBtn.setAttribute("aria-label", `Remove ${removableUsername}`);
    removeBtn.innerHTML = '<svg class="icon"><use href="#icon-x"></use></svg>';
    removeBtn.addEventListener("click", () => removeInvite(removableUsername));
    row.appendChild(removeBtn);
  }
  const role = document.createElement("span");
  role.className = "share-person-role";
  role.textContent = roleLabel;
  row.appendChild(role);
  return row;
}

async function removeInvite(username: string) {
  const doc = window.MDE.getActiveDoc();
  if (!doc || !currentAccess) return;
  const invited = currentAccess.invited.filter((u) => u !== username);
  const access = await putAccess(doc.id, {
    generalAccess: currentAccess.generalAccess,
    role: currentAccess.role,
    invited,
  });
  if (access) {
    currentAccess = access;
    renderShareUI();
  }
}

function updateOwnerAvatar() {
  const el = document.getElementById("ownerAvatar");
  const nameEl = document.getElementById("ownerName");
  if (!el) return;
  const username = window.MDE.githubUsername;
  el.style.background = username ? colorForUsername(username) : "var(--text-dim)";
  el.textContent = username ? username.charAt(0).toUpperCase() : "?";
  if (nameEl) nameEl.textContent = username || "Not signed in";
}

function buildAvatarEl(remoteUser: { name: string; color: string }) {
  const avatar = document.createElement("span");
  avatar.className = "presence-avatar";
  avatar.style.background = remoteUser.color;
  avatar.title = remoteUser.name;
  avatar.textContent = (remoteUser.name || "?").trim().charAt(0).toUpperCase();
  return avatar;
}
