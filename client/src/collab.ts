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
import type { AccessRecord } from "./types";
import { shareModalOpen, shareAccess, shareDocName, sharePresence } from "./stores/share";
import { showToast } from "./stores/toast";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const COLORS = ["#e64980", "#f76707", "#f59f00", "#40c057", "#12b886", "#228be6", "#7950f2", "#e8590c"];
export const ROLE_LABELS: Record<string, string> = { viewer: "Viewer", reviewer: "Reviewer", editor: "Editor" };
const ROLE_VERBS: Record<string, string> = { viewer: "view", reviewer: "comment", editor: "edit" };
export const ROLE_TO_SEGMENT: Record<string, string> = { viewer: "view", reviewer: "review", editor: "edit" };
export const DEFAULT_ACCESS: AccessRecord = { owner: null, generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] };

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
  ydocUpdateHandler: null as ((update: Uint8Array, origin: unknown) => void) | null,
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

// A doc's own id doubles as its room id (see src/collab-room.ts) — a share
// link is stable the moment the doc exists, not a fresh id minted only once
// sharing is turned on.
async function joinSharedLink(roomId: string) {
  const existing = window.MDE.findDocById(roomId);
  // createDoc() already activates the new doc; switchDoc() only needed to
  // bring an already-known local copy back into view.
  if (existing) window.MDE.switchDoc(existing.id);
  else window.MDE.createDoc({ id: roomId, name: "Shared document" });

  // Checked before requiring sign-in, not after: a link with general
  // access set to "anyone" needs no account at all — only a restricted
  // (invite-only) room needs a real identity to check against the
  // invited list, which computeMyRole()'s username==null branch already
  // falls through to correctly either way.
  const access = await fetchAccess(roomId);
  await window.MDE.githubSessionReady;
  const username = window.MDE.githubUsername;
  const role = computeMyRole(access, username);
  if (!role) {
    if (!username) {
      window.MDE.requireGithubSignIn("Sign in with GitHub to open this shared document.");
    } else {
      alert("You don't have access to this document. Ask the owner to invite your GitHub username, or share a link with general access turned on.");
    }
    return;
  }
  window.MDE.markActiveDocShared(true);
  joinRoom(roomId, { seedFromLocal: false, role });
}

function computeMyRole(access: typeof DEFAULT_ACCESS, username: string | null): string | null {
  if (username && access.owner === username) return "editor";
  if (access.generalAccess === "anyone") {
    if (access.requireAccount && !username) return null;
    return access.role;
  }
  if (!username) return null;
  const invited = access.invited.find((p) => p.username === username);
  return invited ? invited.role : null;
}

// ---------- Room lifecycle ----------

function handleDocChanged(doc: any) {
  teardown();
  if (doc && doc.shared) rejoinKnownRoom(doc);
  else syncShareStores();
}

async function rejoinKnownRoom(doc: any) {
  await window.MDE.githubSessionReady;
  const access = await fetchAccess(doc.id);
  // computeMyRole's username==null branch still grants access for a
  // public ("anyone") room, so this quietly reconnects an anonymous
  // visitor's own previously-joined doc same as a signed-in one; a
  // restricted room correctly stays unreachable without a session.
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
  if (seedFromLocal) {
    pushLocalContentIntoYText(cm.getValue());
    seedImagesIntoRoom();
  } else {
    // Joining an existing room: bindEditor() just set room.lastKnownValue
    // from the brand-new empty room.ytext, but CodeMirror's actual buffer
    // may already hold this doc's content (re-opening a share link you've
    // already visited, reloading the page while on one, or the owner
    // opening their own link — findDocById in joinSharedLink finds the
    // cached local copy and loads it before this ever runs). The
    // upcoming sync response will deliver the room's real content via
    // applyDiffToCm(room.lastKnownValue, syncedContent) — if the baseline
    // still says "" while CodeMirror already shows that same content,
    // the diff inserts a second copy on top instead of a no-op, and the
    // document doubles in size. Re-baselining against what's actually in
    // the editor right now (whatever that is) makes the diff correct
    // either way: a no-op if it already matches, or the real patch if it
    // doesn't.
    room.lastKnownValue = cm.getValue();
  }

  cm.setOption("readOnly", role !== "editor");

  const username = window.MDE.githubUsername;
  const identity = username ? { name: username, color: colorForUsername(username) } : getGuestIdentity();
  room.awareness.setLocalState({ user: identity, cursor: cursorFieldFromCm(), role, username });
  room.awareness.on("update", onLocalAwarenessUpdate);

  connect();
  syncShareStores();
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
  if (room.ydoc && room.ydocUpdateHandler) room.ydoc.off("update", room.ydocUpdateHandler);
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
  room.ydocUpdateHandler = null;
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

  // Mutating room.ydoc (applyDiffToYText, seedImagesIntoRoom, the
  // onImageAdded bridge — all "local"-origin transactions) only updates
  // this client's own in-memory copy. Nothing else ever constructed and
  // sent a sync message carrying that update afterward, so collaborators
  // never received any edit made after the initial join/seed — presence
  // (awareness) broadcasts correctly (see room.awareness.on("update", ...)
  // below), but actual content never did. The server already has full
  // broadcast support for this (see handleDocUpdate in collab-room.ts) —
  // it was purely a missing client-side send.
  room.ydocUpdateHandler = (update: Uint8Array, origin: unknown) => {
    if (origin === "server") return; // don't echo back what the server just sent us
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    send(encoding.toUint8Array(encoder));
  };
  room.ydoc.on("update", room.ydocUpdateHandler);

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
    updatePresence();
  }
}

function onLocalAwarenessUpdate({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) {
  sendAwareness(added.concat(updated, removed));
  updatePresence();
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
// Signed-in identity is the GitHub username with a color hashed from it
// (stable across devices/sessions). A public ("anyone with the link") room
// doesn't require an account at all, though — anonymous visitors get a
// random guest name + color instead, generated once per tab and reused for
// every room they join in that session (not regenerated per-join, so their
// presence avatar/cursor label stays consistent while they're around).

function colorForUsername(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length];
}

const GUEST_ADJECTIVES = ["Quiet", "Curious", "Swift", "Gentle", "Bold", "Clever", "Calm", "Bright"];
const GUEST_ANIMALS = ["Fox", "Owl", "Otter", "Falcon", "Panda", "Lynx", "Heron", "Wren"];
let guestIdentity: { name: string; color: string } | null = null;

function getGuestIdentity() {
  if (!guestIdentity) {
    const adjective = GUEST_ADJECTIVES[Math.floor(Math.random() * GUEST_ADJECTIVES.length)];
    const animal = GUEST_ANIMALS[Math.floor(Math.random() * GUEST_ANIMALS.length)];
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    guestIdentity = { name: `${adjective} ${animal}`, color };
  }
  return guestIdentity;
}

// ---------- Server access-control API ----------

async function fetchAccess(roomId: string): Promise<AccessRecord> {
  try {
    const res = await fetch(`/api/collab/${encodeURIComponent(roomId)}/access`);
    if (!res.ok) return { ...DEFAULT_ACCESS };
    return { ...DEFAULT_ACCESS, ...(await res.json()) };
  } catch (err) {
    return { ...DEFAULT_ACCESS };
  }
}

async function putAccess(roomId: string, body: unknown): Promise<AccessRecord | null> {
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
// The Share modal itself is a Svelte component (Share.svelte, mounted at
// #share-mount) — both files are plain ES modules now, so it imports the
// action functions below directly (no window.MDE bridge needed for
// same-bundle communication; that's only for reaching app.ts's IIFE).
// This file keeps ownership of room/access state and the topbar presence
// pill (#shareBtn, #presenceBar), which render outside the modal's own DOM
// subtree, and pushes everything the component needs into stores/share.ts.

export { colorForUsername };

function setupShareUI() {
  document.getElementById("shareBtn").addEventListener("click", openShareModal);
  syncShareStores();
}

export async function openShareModal() {
  await window.MDE.githubSessionReady;
  if (!window.MDE.githubUsername) {
    window.MDE.requireGithubSignIn("Sharing needs a connected GitHub account. Sign in to continue.");
    return;
  }
  shareModalOpen.set(true);
  const doc = window.MDE.getActiveDoc();
  if (doc) {
    currentAccess = await fetchAccess(doc.id);
    syncShareStores();
  }
}

export function closeShareModal() {
  shareModalOpen.set(false);
}

export type AccessMode = "restricted" | "anyone-account" | "anyone-link";

const ACCESS_MODE_TOAST: Record<AccessMode, string> = {
  restricted: "Access restricted to invited people",
  "anyone-account": "Anyone with a GitHub account and the link can now access",
  "anyone-link": "Anyone with the link can now access, no account needed",
};

// Returns false on failure so the component can revert its own optimistic
// <select> value.
export async function setAccessMode(mode: AccessMode, fallbackRole: string): Promise<boolean> {
  const doc = window.MDE.getActiveDoc();
  if (!doc) return false;
  const wantAnyone = mode !== "restricted";
  const access = await putAccess(doc.id, {
    generalAccess: wantAnyone ? "anyone" : "restricted",
    requireAccount: mode === "anyone-account",
    role: fallbackRole || (currentAccess && currentAccess.role) || "viewer",
    invited: currentAccess ? currentAccess.invited : [],
  });
  if (!access) {
    showToast("Couldn't update sharing settings", "error");
    return false;
  }
  currentAccess = access;
  window.MDE.markActiveDocShared(wantAnyone || access.invited.length > 0);
  if (wantAnyone && !room.id) joinRoom(doc.id, { seedFromLocal: true, role: "editor" });
  if (!wantAnyone) teardown();
  syncShareStores();
  showToast(ACCESS_MODE_TOAST[mode], "info");
  return true;
}

export async function setRole(role: string) {
  const doc = window.MDE.getActiveDoc();
  if (!doc || !currentAccess) return;
  const access = await putAccess(doc.id, {
    generalAccess: "anyone",
    requireAccount: currentAccess.requireAccount,
    role,
    invited: currentAccess.invited,
  });
  if (access) {
    currentAccess = access;
    syncShareStores();
    showToast(`Link access set to ${ROLE_LABELS[role] || role}`, "info");
  } else {
    showToast("Couldn't update the link's access level", "error");
  }
}

// null means "not shareable yet" (restricted with nobody invited) — the
// component keeps its Copy link button disabled in that case rather than
// calling this at all, but returning null here too avoids ever copying a
// stale/meaningless link if it somehow does.
export function buildShareLink(): string | null {
  const doc = window.MDE.getActiveDoc();
  if (!doc || !currentAccess) return null;
  const isAnyone = currentAccess.generalAccess === "anyone";
  if (!isAnyone && currentAccess.invited.length === 0) return null;
  // Invited-only (restricted) links always resolve to editor access per
  // authorize() server-side; "anyone" links carry whatever role is set.
  const segment = isAnyone ? ROLE_TO_SEGMENT[currentAccess.role] || "view" : "edit";
  return `${location.origin}/d/${encodeURIComponent(doc.id)}/${segment}`;
}

export async function addPerson(rawUsername: string) {
  const username = rawUsername.trim().replace(/^@/, "");
  if (!username) return;
  const doc = window.MDE.getActiveDoc();
  if (!doc) return;
  const existing = currentAccess ? currentAccess.invited : [];
  if (existing.some((p) => p.username === username)) return;
  const invited = [...existing, { username, role: "editor" }];
  const access = await putAccess(doc.id, {
    generalAccess: currentAccess ? currentAccess.generalAccess : "restricted",
    requireAccount: currentAccess ? currentAccess.requireAccount : false,
    role: currentAccess ? currentAccess.role : "viewer",
    invited,
  });
  if (access) {
    currentAccess = access;
    window.MDE.markActiveDocShared(true);
    // Restricted access never otherwise triggers joinRoom (only switching
    // to "anyone" does, see setAccessMode) — without this, an invited
    // person could join and authorize successfully but find the room's
    // Y.doc completely empty, since the owner's content was never seeded
    // into it. First invite on a still-unconnected doc needs to seed it,
    // same as opening general access does.
    if (!room.id) joinRoom(doc.id, { seedFromLocal: true, role: "editor" });
    syncShareStores();
    showToast(`Invited @${username}`, "success");
  } else {
    showToast("Couldn't invite that person", "error");
  }
}

export async function setInviteRole(username: string, role: string) {
  const doc = window.MDE.getActiveDoc();
  if (!doc || !currentAccess) return;
  const invited = currentAccess.invited.map((p) => (p.username === username ? { ...p, role } : p));
  const access = await putAccess(doc.id, {
    generalAccess: currentAccess.generalAccess,
    requireAccount: currentAccess.requireAccount,
    role: currentAccess.role,
    invited,
  });
  if (access) {
    currentAccess = access;
    syncShareStores();
    showToast(`@${username}'s access set to ${ROLE_LABELS[role] || role}`, "info");
  } else {
    showToast("Couldn't update that person's access", "error");
  }
}

export async function removeInvite(username: string) {
  const doc = window.MDE.getActiveDoc();
  if (!doc || !currentAccess) return;
  const invited = currentAccess.invited.filter((p) => p.username !== username);
  const access = await putAccess(doc.id, {
    generalAccess: currentAccess.generalAccess,
    requireAccount: currentAccess.requireAccount,
    role: currentAccess.role,
    invited,
  });
  if (access) {
    currentAccess = access;
    syncShareStores();
    showToast(`Removed @${username}`, "info");
  } else {
    showToast("Couldn't remove that person", "error");
  }
}

// Pushes room/access state into the Svelte stores and updates the couple
// of DOM elements that live outside the modal's own subtree.
function syncShareStores() {
  const access = currentAccess || DEFAULT_ACCESS;
  shareAccess.set(access);
  const doc = window.MDE.getActiveDoc();
  shareDocName.set((doc && doc.name) || "Untitled");
  document.getElementById("shareBtn").classList.toggle("active", !!room.id);
  updatePresence();
}

function updatePresence() {
  const bar = document.getElementById("presenceBar");
  const connected = room.awareness
    ? Array.from(room.awareness.getStates().entries()).filter(([id, s]: [number, any]) => s && s.user && id !== room.awareness.clientID)
    : [];

  if (bar) {
    bar.hidden = connected.length === 0;
    bar.innerHTML = "";
    connected.forEach(([, s]: [number, any]) => bar.appendChild(buildAvatarEl(s.user)));
  }

  sharePresence.set(connected.map(([, s]: [number, any]) => ({ name: s.user.name, color: s.user.color, username: s.username, role: s.role })));
}

function buildAvatarEl(remoteUser: { name: string; color: string }) {
  const avatar = document.createElement("span");
  avatar.className = "presence-avatar";
  avatar.style.background = remoteUser.color;
  avatar.title = remoteUser.name;
  avatar.textContent = (remoteUser.name || "?").trim().charAt(0).toUpperCase();
  return avatar;
}
