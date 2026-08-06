// Real-time multi-user editing. Loaded as a module (deferred like `defer`,
// runs after app.js has finished its own DOMContentLoaded init) so
// window.MDE is fully populated by the time we touch it.
import * as Y from "https://esm.sh/yjs@13.6.18";
import * as syncProtocol from "https://esm.sh/y-protocols@1.0.6/sync?deps=yjs@13.6.18";
import * as awarenessProtocol from "https://esm.sh/y-protocols@1.0.6/awareness?deps=yjs@13.6.18";
import * as encoding from "https://esm.sh/lib0@0.2.99/encoding";
import * as decoding from "https://esm.sh/lib0@0.2.99/decoding";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const USER_STORAGE_KEY = "mde:user";
const COLORS = ["#e64980", "#f76707", "#f59f00", "#40c057", "#12b886", "#228be6", "#7950f2", "#e8590c"];

const room = {
  id: null,
  ws: null,
  ydoc: null,
  ytext: null,
  awareness: null,
  reconnectTimer: null,
  reconnectDelay: 1000,
  lastKnownValue: "",
  applyingRemote: false,
  cursorWidgets: new Map(),
  cmChangeHandler: null,
  cmCursorHandler: null,
};

let cm = null;
let user = restoreUser();

document.addEventListener("DOMContentLoaded", init);

function init() {
  cm = window.MDE.getEditor();
  window.MDE.onBeforeDocLoad = teardown;
  window.MDE.onActiveDocChanged = handleDocChanged;

  setupShareUI();

  const params = new URLSearchParams(location.search);
  const urlRoom = params.get("room");
  if (urlRoom) {
    history.replaceState(null, "", location.pathname + location.hash);
    const existing = window.MDE.findDocByRoomId(urlRoom);
    if (existing) {
      window.MDE.switchDoc(existing.id);
    } else {
      window.MDE.createDoc({ name: "Shared document", roomId: urlRoom });
    }
  } else {
    handleDocChanged(window.MDE.getActiveDoc());
  }
}

// ---------- Room lifecycle ----------

function handleDocChanged(doc) {
  teardown();
  if (doc && doc.roomId) joinRoom(doc.roomId, { seedFromLocal: false });
  else renderShareUI();
}

function joinRoom(roomId, { seedFromLocal }) {
  teardown();
  room.id = roomId;
  room.ydoc = new Y.Doc();
  room.ytext = room.ydoc.getText("content");
  room.awareness = new awarenessProtocol.Awareness(room.ydoc);

  bindEditor();
  if (seedFromLocal) pushLocalContentIntoYText(cm.getValue());

  room.awareness.setLocalState({ user, cursor: cursorFieldFromCm() });
  room.awareness.on("update", onLocalAwarenessUpdate);

  connect();
  renderShareUI();
}

function teardown() {
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

  room.cmChangeHandler = (instance, changeObj) => {
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

function pushLocalContentIntoYText(value) {
  applyDiffToYText(room.lastKnownValue, value);
  room.lastKnownValue = value;
}

function applyDiffToYText(oldVal, newVal) {
  const [start, oldEnd, newEnd] = diffRange(oldVal, newVal);
  room.ydoc.transact(() => {
    if (oldEnd > start) room.ytext.delete(start, oldEnd - start);
    if (newEnd > start) room.ytext.insert(start, newVal.slice(start, newEnd));
  }, "local");
}

function applyDiffToCm(oldVal, newVal) {
  const [start, oldEnd, newEnd] = diffRange(oldVal, newVal);
  const from = cm.posFromIndex(start);
  const to = cm.posFromIndex(oldEnd);
  cm.replaceRange(newVal.slice(start, newEnd), from, to, "yjs");
}

function diffRange(a, b) {
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
  states.forEach((state, clientID) => {
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

function buildCursorEl(remoteUser) {
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
    setStatus("connected");
    if (room.awareness.getLocalState() !== null) {
      sendAwareness([room.awareness.clientID]);
    }
  };

  ws.onmessage = (event) => handleServerMessage(new Uint8Array(event.data));

  ws.onclose = () => {
    setStatus("reconnecting");
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

function handleServerMessage(data) {
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

function onLocalAwarenessUpdate({ added, updated, removed }) {
  sendAwareness(added.concat(updated, removed));
  renderPresence();
  renderRemoteCursors();
}

function sendAwareness(clientIDs) {
  if (!room.awareness || clientIDs.length === 0) return;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, clientIDs));
  send(encoding.toUint8Array(encoder));
}

function send(bytes) {
  if (room.ws && room.ws.readyState === WebSocket.OPEN) room.ws.send(bytes);
}

// ---------- User identity ----------

function restoreUser() {
  try {
    const raw = localStorage.getItem(USER_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore corrupt storage */ }
  const fresh = { name: `Guest ${Math.floor(Math.random() * 900 + 100)}`, color: COLORS[Math.floor(Math.random() * COLORS.length)] };
  localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(fresh));
  return fresh;
}

function setUserName(name) {
  user = { ...user, name: name || user.name };
  localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
  if (room.awareness) room.awareness.setLocalStateField("user", user);
}

// ---------- UI ----------

function setupShareUI() {
  const shareBtn = document.getElementById("shareBtn");
  const shareMenu = document.getElementById("shareMenu");
  const startBtn = document.getElementById("startShareBtn");
  const stopBtn = document.getElementById("stopShareBtn");
  const copyBtn = document.getElementById("copyShareLink");
  const nameInput = document.getElementById("collabNameInput");

  nameInput.value = user.name;

  shareBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    shareMenu.classList.toggle("open");
  });
  document.addEventListener("click", () => shareMenu.classList.remove("open"));
  shareMenu.addEventListener("click", (e) => e.stopPropagation());

  startBtn.addEventListener("click", () => {
    const roomId = genRoomId();
    window.MDE.setActiveDocRoomId(roomId);
    joinRoom(roomId, { seedFromLocal: true });
  });

  stopBtn.addEventListener("click", () => {
    window.MDE.clearActiveDocRoomId();
    teardown();
    renderShareUI();
  });

  copyBtn.addEventListener("click", () => {
    const input = document.getElementById("shareLinkInput");
    input.select();
    navigator.clipboard.writeText(input.value).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
    });
  });

  nameInput.addEventListener("change", () => setUserName(nameInput.value.trim()));

  renderShareUI();
}

function setStatus(status) {
  const dot = document.getElementById("collabStatusDot");
  const text = document.getElementById("collabStatusText");
  if (!dot || !text) return;
  dot.className = `status-dot status-${status}`;
  text.textContent = { connected: "Live", reconnecting: "Reconnecting…", shared: "Shared" }[status] || "Not shared";
}

function renderShareUI() {
  const linkRow = document.getElementById("shareLinkRow");
  const linkInput = document.getElementById("shareLinkInput");
  const startBtn = document.getElementById("startShareBtn");
  const stopBtn = document.getElementById("stopShareBtn");
  const shareBtn = document.getElementById("shareBtn");

  const active = !!room.id;
  linkRow.hidden = !active;
  startBtn.hidden = active;
  stopBtn.hidden = !active;
  shareBtn.classList.toggle("active", active);

  if (active) {
    linkInput.value = `${location.origin}${location.pathname}?room=${encodeURIComponent(room.id)}`;
    setStatus("shared");
  } else {
    setStatus("idle");
  }
  renderPresence();
}

function renderPresence() {
  const bar = document.getElementById("presenceBar");
  if (!bar) return;
  if (!room.awareness) {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  const states = Array.from(room.awareness.getStates().entries()).filter(([, s]) => s && s.user);
  bar.hidden = states.length === 0;
  bar.innerHTML = "";
  states.forEach(([clientID, state]) => {
    const isMe = clientID === room.awareness.clientID;
    const avatar = document.createElement("span");
    avatar.className = "presence-avatar";
    avatar.style.background = state.user.color;
    avatar.title = isMe ? `${state.user.name} (you)` : state.user.name;
    avatar.textContent = (state.user.name || "?").trim().charAt(0).toUpperCase();
    bar.appendChild(avatar);
  });
}

function genRoomId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 14);
}
