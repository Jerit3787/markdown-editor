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
import { keymap } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import "./types";
import type { AccessRecord } from "./types";
import { shareModalOpen, shareAccess, shareDocName, sharePresence } from "./stores/share";
import { showToast } from "./stores/toast";
import { getActiveDoc, findDocById, createDoc, markActiveDocShared } from "./stores/docs";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_PRESENCE = 2;

const COLORS = ["#e64980", "#f76707", "#f59f00", "#40c057", "#12b886", "#228be6", "#7950f2", "#e8590c"];
export const ROLE_LABELS: Record<string, string> = { viewer: "Viewer", reviewer: "Reviewer", editor: "Editor" };
const ROLE_VERBS: Record<string, string> = { viewer: "view", reviewer: "comment", editor: "edit" };
export const ROLE_TO_SEGMENT: Record<string, string> = { viewer: "view", reviewer: "review", editor: "edit" };
export const DEFAULT_ACCESS: AccessRecord = { owner: null, generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] };

interface DocBinding {
  ydoc: Y.Doc;
  ytext: Y.Text;
  imagesMap: Y.Map<string>;
  awareness: awarenessProtocol.Awareness;
  undoManager: Y.UndoManager | null;
  ydocUpdateHandler: (update: Uint8Array, origin: unknown) => void;
  role: string;
}

const workspaceRoom = {
  workspaceId: null as string | null,
  ws: null as WebSocket | null,
  docs: new Map<string, DocBinding>(),
  activeDocId: null as string | null,
  reconnectTimer: null as ReturnType<typeof setTimeout> | null,
  reconnectDelay: 1000,
};

// The server-side access record for the room currently shown in the Share
// modal, refreshed on open and after every change. Null until first fetched.
let currentAccess: typeof DEFAULT_ACCESS | null = null;

document.addEventListener("DOMContentLoaded", init);

function init() {
  window.MDE.onBeforeDocLoad = teardownWorkspace;
  window.MDE.onActiveDocChanged = handleDocChanged;
  // Local image inserts (see app.ts's insertImageWithUpload) get mirrored
  // into the active document's Yjs map so collaborators receive the image
  // too — same Y.Doc as the text, just a separate top-level type.
  window.MDE.onImageAdded = (key, dataUrl) => {
    const binding = workspaceRoom.activeDocId ? workspaceRoom.docs.get(workspaceRoom.activeDocId) : undefined;
    if (binding) binding.ydoc.transact(() => binding.imagesMap.set(key, dataUrl), "local");
  };

  setupShareUI();

  const shareUrlMatch = location.pathname.match(SHARE_PATH);
  if (shareUrlMatch) {
    history.replaceState(null, "", "/" + location.search + location.hash);
    joinSharedLink(shareUrlMatch[1]);
  } else {
    handleDocChanged(getActiveDoc());
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
  const existing = findDocById(roomId);
  // createDoc() already activates the new doc; switchDoc() only needed to
  // bring an already-known local copy back into view.
  if (existing) window.MDE.switchDoc(existing.id);
  else createDoc({ id: roomId, name: "Shared document" });

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
  markActiveDocShared(true);
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

// Opens the one WebSocket for a whole shared workspace and creates a
// Y.Doc binding for every document currently in it — all of them start
// syncing immediately, not just whichever one ends up on screen (see
// bindActiveDoc, called separately once this resolves).
async function joinWorkspace(workspaceId: string, { role }: { role: string }): Promise<void> {
  teardownWorkspace();
  workspaceRoom.workspaceId = workspaceId;

  const docIds = await fetchWorkspaceDocIds(workspaceId);
  for (const docId of docIds) createDocBinding(docId, role);

  connectWorkspace();
}

function createDocBinding(docId: string, role: string): DocBinding {
  const existing = workspaceRoom.docs.get(docId);
  if (existing) return existing;

  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  const imagesMap = ydoc.getMap<string>("images");
  imagesMap.observe((event, tr) => {
    if (tr.origin === "local") return;
    event.changes.keys.forEach((change, key) => {
      if (change.action === "delete") return;
      const dataUrl = imagesMap.get(key);
      if (dataUrl && workspaceRoom.activeDocId === docId) window.MDE.setDocImage(key, dataUrl);
    });
  });
  const awareness = new awarenessProtocol.Awareness(ydoc);

  const ydocUpdateHandler = (update: Uint8Array, origin: unknown) => {
    if (origin === "server") return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarString(encoder, docId);
    syncProtocol.writeUpdate(encoder, update);
    send(encoding.toUint8Array(encoder));
  };
  ydoc.on("update", ydocUpdateHandler);

  const binding: DocBinding = { ydoc, ytext, imagesMap, awareness, undoManager: null, ydocUpdateHandler, role };
  workspaceRoom.docs.set(docId, binding);
  return binding;
}

// Rebinds the editor to a different document already syncing within the
// active workspace — no connection/reconnection involved, only which
// Y.Doc CodeMirror's yCollab extension is attached to.
function bindActiveDoc(docId: string): void {
  const binding = workspaceRoom.docs.get(docId);
  if (!binding) return;
  workspaceRoom.activeDocId = docId;

  const undoManager = binding.undoManager || new Y.UndoManager(binding.ytext);
  binding.undoManager = undoManager;
  window.MDE.enterCollabMode([yCollab(binding.ytext, binding.awareness, { undoManager }), keymap.of(yUndoManagerKeymap)], undoManager);
  window.MDE.setReadOnly(binding.role !== "editor");

  const username = window.MDE.githubUsername;
  const identity = username ? { name: username, color: colorForUsername(username) } : getGuestIdentity();
  binding.awareness.setLocalState({ user: identity, role: binding.role, username });
  binding.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    sendAwareness(docId, binding.awareness, added.concat(updated, removed));
    updatePresence();
  });

  sendPresence(docId);
}

function teardownWorkspace(): void {
  window.MDE.setReadOnly(false);
  window.MDE.exitCollabMode();
  if (workspaceRoom.reconnectTimer) {
    clearTimeout(workspaceRoom.reconnectTimer);
    workspaceRoom.reconnectTimer = null;
  }
  if (workspaceRoom.ws) {
    workspaceRoom.ws.onclose = null;
    workspaceRoom.ws.onerror = null;
    try { workspaceRoom.ws.close(); } catch (e) { /* already closed */ }
  }
  for (const binding of workspaceRoom.docs.values()) {
    binding.awareness.destroy();
    binding.ydoc.off("update", binding.ydocUpdateHandler);
    if (binding.undoManager) binding.undoManager.destroy();
    binding.ydoc.destroy();
  }
  workspaceRoom.docs.clear();
  workspaceRoom.workspaceId = null;
  workspaceRoom.ws = null;
  workspaceRoom.activeDocId = null;
  workspaceRoom.reconnectDelay = 1000;
}

// ---------- WebSocket transport (Yjs sync + awareness protocol) ----------

function connectWorkspace(): void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/workspace/${encodeURIComponent(workspaceRoom.workspaceId!)}`);
  ws.binaryType = "arraybuffer";
  workspaceRoom.ws = ws;

  ws.onopen = () => {
    workspaceRoom.reconnectDelay = 1000;
    for (const [docId, binding] of workspaceRoom.docs.entries()) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      encoding.writeVarString(encoder, docId);
      syncProtocol.writeSyncStep1(encoder, binding.ydoc);
      send(encoding.toUint8Array(encoder));
      if (binding.awareness.getLocalState() !== null) sendAwareness(docId, binding.awareness, [binding.awareness.clientID]);
    }
    if (workspaceRoom.activeDocId) sendPresence(workspaceRoom.activeDocId);
  };

  ws.onmessage = (event) => handleServerMessage(new Uint8Array(event.data as ArrayBuffer));
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => ws.close();
}

function scheduleReconnect(): void {
  if (!workspaceRoom.workspaceId || workspaceRoom.reconnectTimer) return;
  workspaceRoom.reconnectTimer = setTimeout(() => {
    workspaceRoom.reconnectTimer = null;
    connectWorkspace();
  }, workspaceRoom.reconnectDelay);
  workspaceRoom.reconnectDelay = Math.min(workspaceRoom.reconnectDelay * 1.6, 10000);
}

function handleServerMessage(data: Uint8Array): void {
  const decoder = decoding.createDecoder(data);
  const messageType = decoding.readVarUint(decoder);

  if (messageType === MESSAGE_PRESENCE) {
    const username = decoding.readVarString(decoder);
    const docId = decoding.readVarString(decoder);
    handleRemotePresence(username, docId);
    return;
  }

  const docId = decoding.readVarString(decoder);
  const binding = workspaceRoom.docs.get(docId);
  if (!binding) return;

  if (messageType === MESSAGE_SYNC) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarString(encoder, docId);
    // Baseline-measured, not a fixed byte count — the docId prefix's own
    // encoded length varies with the string, so "was a reply appended"
    // has to be measured from after it was written (see the identical
    // fix on the server side, src/workspace-room.ts).
    const baseLength = encoding.length(encoder);
    syncProtocol.readSyncMessage(decoder, encoder, binding.ydoc, "server");
    if (encoding.length(encoder) > baseLength) send(encoding.toUint8Array(encoder));
  } else if (messageType === MESSAGE_AWARENESS) {
    const update = decoding.readVarUint8Array(decoder);
    awarenessProtocol.applyAwarenessUpdate(binding.awareness, update, "server");
    if (docId === workspaceRoom.activeDocId) updatePresence();
  }
}

function handleRemotePresence(_username: string, _docId: string): void {
  // Populated in Task 13 (presence-across-files UI).
}

function sendAwareness(docId: string, awareness: awarenessProtocol.Awareness, clientIDs: number[]): void {
  if (clientIDs.length === 0) return;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarString(encoder, docId);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clientIDs));
  send(encoding.toUint8Array(encoder));
}

function sendPresence(docId: string): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_PRESENCE);
  encoding.writeVarString(encoder, "");
  encoding.writeVarString(encoder, docId);
  send(encoding.toUint8Array(encoder));
}

function send(bytes: Uint8Array) {
  // lib0's encoding.toUint8Array() types its result as Uint8Array<ArrayBufferLike>
  // (could theoretically be SharedArrayBuffer-backed); WebSocket.send()'s DOM
  // lib type wants the narrower ArrayBuffer-backed variant specifically. It's
  // always a plain ArrayBuffer at runtime here — this cast doesn't change that.
  if (workspaceRoom.ws && workspaceRoom.ws.readyState === WebSocket.OPEN) workspaceRoom.ws.send(bytes as Uint8Array<ArrayBuffer>);
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

async function fetchWorkspaceAccess(workspaceId: string): Promise<AccessRecord> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/access`);
    if (!res.ok) return { ...DEFAULT_ACCESS };
    return { ...DEFAULT_ACCESS, ...(await res.json()) };
  } catch (err) {
    return { ...DEFAULT_ACCESS };
  }
}

async function putWorkspaceAccess(workspaceId: string, body: unknown): Promise<AccessRecord | null> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/access`, {
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

async function fetchWorkspaceDocIds(workspaceId: string): Promise<string[]> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/docs`);
    if (!res.ok) return [];
    return (await res.json()) as string[];
  } catch (err) {
    return [];
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
  
  const dropdownBtn = document.getElementById("shareDropdownBtn");
  const dropdownMenu = document.getElementById("shareDropdownMenu");
  const copyBtn = document.getElementById("shareCopyLinkBtn");

  dropdownBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const isOpen = dropdownMenu.classList.contains("open");
    
    // Close other dropdowns if we had a central registry, but here we just toggle this one
    if (!isOpen) {
      dropdownMenu.classList.add("open");
      dropdownBtn.setAttribute("aria-expanded", "true");
      
      const doc = getActiveDoc();
      if (doc) {
        // Fetch access to display correct label in dropdown
        currentAccess = await fetchAccess(doc.id);
        const titleEl = document.getElementById("shareAccessTitle");
        const descEl = document.getElementById("shareAccessDesc");
        
        if (currentAccess.generalAccess === "anyone") {
          if (currentAccess.requireAccount) {
            titleEl.textContent = "Anyone with an account";
            descEl.textContent = "Anyone with a GitHub account and the link can access.";
          } else {
            titleEl.textContent = "Anyone with the link";
            descEl.textContent = "Anyone who has the link can access. No sign-in required.";
          }
        } else {
          titleEl.textContent = "Restricted";
          descEl.textContent = "Only people with access can open with the link.";
        }
      }
    } else {
      dropdownMenu.classList.remove("open");
      dropdownBtn.setAttribute("aria-expanded", "false");
    }
  });

  copyBtn?.addEventListener("click", async () => {
    const link = buildShareLink();
    if (link) {
      await navigator.clipboard.writeText(link);
      showToast("Link copied to clipboard", "success");
    } else {
      showToast("Document must be shared first", "error");
    }
    dropdownMenu.classList.remove("open");
    dropdownBtn.setAttribute("aria-expanded", "false");
  });

  document.addEventListener("click", (e) => {
    if (dropdownMenu?.classList.contains("open") && !dropdownBtn.contains(e.target as Node) && !dropdownMenu.contains(e.target as Node)) {
      dropdownMenu.classList.remove("open");
      dropdownBtn.setAttribute("aria-expanded", "false");
    }
  });

  syncShareStores();
}

export async function openShareModal() {
  await window.MDE.githubSessionReady;
  if (!window.MDE.githubUsername) {
    window.MDE.requireGithubSignIn("Sharing needs a connected GitHub account. Sign in to continue.");
    return;
  }
  shareModalOpen.set(true);
  const doc = getActiveDoc();
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
  const doc = getActiveDoc();
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
  markActiveDocShared(wantAnyone || access.invited.length > 0);
  if (wantAnyone && !room.id) joinRoom(doc.id, { seedFromLocal: true, role: "editor" });
  if (!wantAnyone) teardown();
  syncShareStores();
  showToast(ACCESS_MODE_TOAST[mode], "info");
  return true;
}

export async function setRole(role: string) {
  const doc = getActiveDoc();
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
  const doc = getActiveDoc();
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
  const doc = getActiveDoc();
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
    markActiveDocShared(true);
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
  const doc = getActiveDoc();
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
  const doc = getActiveDoc();
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
  const doc = getActiveDoc();
  shareDocName.set((doc && doc.name) || "Untitled");
  document.getElementById("shareBtn").classList.toggle("active", !!workspaceRoom.workspaceId);
  document.getElementById("shareDropdownBtn")?.classList.toggle("active", !!workspaceRoom.workspaceId);
  updatePresence();
}

function updatePresence() {
  const bar = document.getElementById("presenceBar");
  const activeAwareness = workspaceRoom.activeDocId ? workspaceRoom.docs.get(workspaceRoom.activeDocId)?.awareness : undefined;
  const connected = activeAwareness
    ? Array.from(activeAwareness.getStates().entries()).filter(([id, s]: [number, any]) => s && s.user && id !== activeAwareness.clientID)
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
