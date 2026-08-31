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
import { get } from "svelte/store";
import { keymap } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import "./types";
import type { AccessRecord, Doc, Workspace } from "./types";
import { shareModalOpen, shareAccess, shareTargetName, sharePresence } from "./stores/share";
import { showToast } from "./stores/toast";
import { getActiveDoc, switchDoc, docsStore, moveDocToWorkspace, findDocById, persistDocs, importRemoteDocs, syncRemoteDocContent } from "./stores/docs";
import { debounceWithFlush } from "./debounce";
import { pendingJoin } from "./stores/joinWorkspace";
import { workspacePresence } from "./stores/workspacePresence";
import { workspacesStore, switchWorkspace, createWorkspace, persistWorkspaces, adoptSharedWorkspace } from "./stores/workspaces";
import { shareChoice } from "./stores/shareChoice";
import { EMPTY_CITATIONS } from "./mmd-citations";
import { suggestionExtensions } from "./suggestion-editor";
import { getSuggestionsMap } from "./suggestions";
import { pendingSuggestionCount } from "./stores/suggestions";
import { lockToPreviewOnly, unlockViewMode } from "./stores/view";
// Share links look like /w/<workspaceId>/<docId>/<view|review|edit>
// (Google-Docs-style), not query params. The mode segment is purely
// informational for whoever's reading the link — actual access is always
// resolved server-side from the workspace's access record (see
// computeMyRole), never trusted from the URL. Defined in router.ts (not
// here) so app.ts's own replaceToRoot/replaceDocUrl can guard against
// clobbering this path before this file's DOMContentLoaded listener runs.
import { SHARE_PATH } from "./router";

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
  // The document's name — a third top-level type on the same Y.Doc as
  // ytext/imagesMap, keyed "name". Content sync got this for free the
  // moment it started riding the same MESSAGE_SYNC/Y.Doc-update wire
  // format imagesMap already used; the name is just another field on
  // it, gated editor-only by the exact same write-check the server
  // already applies to every Y.Doc update (workspace-room.ts's
  // handleMessage), same as content edits.
  metaMap: Y.Map<string>;
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

// Bumped by every teardownWorkspace() call. rejoinKnownWorkspace/joinWorkspace
// are async and fire-and-forget from handleDocChanged, so rapidly switching
// documents can start a second join before the first one's awaits resolve —
// without this, both attempts finish and race to own workspaceRoom, leaving
// one attempt's Y.Doc/Awareness bindings (and their distinct clientIDs)
// orphaned with nothing left to clean them up. Each async attempt snapshots
// this value and bails if it no longer matches after an await.
let joinGeneration = 0;

// Documents in the shared workspace whose Y.Text/images changed while
// they weren't the active document — the active document's content
// already flows into docsStore through the normal CodeMirror ->
// activeDocContent -> saveActiveDocContent pipeline, so this only ever
// tracks the ones nobody is currently looking at.
const dirtyBackgroundDocs = new Set<string>();

function markDirty(docId: string): void {
  dirtyBackgroundDocs.add(docId);
  backgroundSyncDebounce.trigger();
}

function flushDirtyBackgroundDocs(): void {
  let changed = false;
  for (const docId of dirtyBackgroundDocs) {
    // Became active while waiting to flush — the CodeMirror pipeline
    // owns it now, and its Y.Text already has the correct content
    // regardless of who reads it, so there's nothing to write here.
    if (docId === workspaceRoom.activeDocId) continue;
    const binding = workspaceRoom.docs.get(docId);
    if (!binding) continue; // workspace was torn down mid-flight
    const content = binding.ytext.toString();
    const imageEntries = Array.from(binding.imagesMap.entries());
    const images = imageEntries.length > 0 ? Object.fromEntries(imageEntries) : undefined;
    const name = binding.metaMap.get("name");
    const metadataRaw = binding.metaMap.get("metadata");
    const metadata = metadataRaw !== undefined ? JSON.parse(metadataRaw) : undefined;
    const citationsRaw = binding.metaMap.get("citations");
    const citations = citationsRaw !== undefined ? JSON.parse(citationsRaw) : undefined;
    if (syncRemoteDocContent(docId, content, images, name, metadata, citations)) changed = true;
  }
  dirtyBackgroundDocs.clear();
  if (changed) persistDocs();
}

const backgroundSyncDebounce = debounceWithFlush(flushDirtyBackgroundDocs, 800);

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
  window.MDE.onDocMetadataChanged = (docId, metadata) => {
    const binding = workspaceRoom.docs.get(docId);
    if (binding) binding.ydoc.transact(() => binding.metaMap.set("metadata", JSON.stringify(metadata)), "local");
  };
  window.MDE.onDocCitationsChanged = (docId, citations) => {
    const binding = workspaceRoom.docs.get(docId);
    if (binding) binding.ydoc.transact(() => binding.metaMap.set("citations", JSON.stringify(citations)), "local");
  };
  // A rename always happens through the docTitle input, which is always
  // the active document (DocList.svelte's row "Rename" action switches
  // to the target doc first before focusing it) — but this looks the
  // binding up by id rather than assuming activeDocId regardless, same
  // as onImageAdded's own binding lookup above. Editor-only gated
  // implicitly: a non-editor's write never reaches any collaborator
  // anyway (the server drops it, see workspace-room.ts's handleMessage
  // isWrite check), it just optimistically renders locally for the
  // person doing the (rejected) rename until the next resync.
  window.MDE.onDocRenamed = (docId, name) => {
    const binding = workspaceRoom.docs.get(docId);
    if (binding) binding.ydoc.transact(() => binding.metaMap.set("name", name || "Untitled"), "local");
  };

  setupShareUI();

  const shareUrlMatch = location.pathname.match(SHARE_PATH);
  if (shareUrlMatch) {
    history.replaceState(null, "", "/" + location.search + location.hash);
    joinSharedLink(shareUrlMatch[1]!, shareUrlMatch[2]!);
  } else {
    handleDocChanged(getActiveDoc());
  }
}

async function joinSharedLink(workspaceId: string, landOnDocId: string) {
  const localMatch = get(workspacesStore).find((w) => w.remoteId === workspaceId);
  const access = await fetchWorkspaceAccess(workspaceId);
  await window.MDE.githubSessionReady;
  const username = window.MDE.githubUsername;
  const role = computeMyRole(access, username);
  if (!role) {
    if (!username) {
      window.MDE.requireGithubSignIn("Sign in with GitHub to open this shared workspace.");
    } else {
      alert("You don't have access to this workspace. Ask the owner to invite your GitHub username, or share a link with general access turned on.");
    }
    return;
  }

  if (localMatch) {
    // Already joined this remote workspace before — just switch to it.
    switchWorkspace(localMatch.id);
    switchDoc(landOnDocId);
    await joinWorkspace(workspaceId, { role });
    bindActiveDoc(landOnDocId);
    return;
  }

  const docIds = await fetchWorkspaceDocIds(workspaceId);
  const docs = await Promise.all(docIds.map((id) => fetchRemoteDocContent(workspaceId, id)));
  const validDocs = docs.filter((d): d is NonNullable<typeof d> => !!d);

  const decision = decideJoinTarget(validDocs, get(workspacesStore).length);
  if (decision.kind === "auto") {
    const ws = adoptSharedWorkspace(workspaceId, decision.workspaceName);
    importRemoteDocs(ws.id, validDocs);
    switchWorkspace(ws.id);
    switchDoc(landOnDocId);
    return;
  }

  pendingJoin.set({ remoteId: workspaceId, workspaceName: "Shared workspace", docs: validDocs, landOnDocId });
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
  if (!doc) {
    teardownWorkspace();
    syncShareStores();
    return;
  }
  const ws = get(workspacesStore).find((w) => w.id === doc.workspaceId);
  if (ws && ws.shared && ws.remoteId) {
    // Switching between documents that are BOTH in the same
    // already-connected shared workspace should just rebind the editor —
    // every document in the workspace is already syncing live over the
    // one open connection (see Task 9), so tearing it down and
    // reconnecting on every doc switch would defeat that and cause a
    // visible flicker/reconnect for every collaborator's presence too.
    if (workspaceRoom.workspaceId === ws.remoteId) {
      bindActiveDoc(doc.id);
      syncShareStores();
      return;
    }
    teardownWorkspace();
    rejoinKnownWorkspace(ws.remoteId, doc.id);
  } else if (doc.shared) {
    teardownWorkspace();
    migrateLegacyDoc(doc.id);
  } else {
    teardownWorkspace();
    syncShareStores();
  }
}

async function rejoinKnownWorkspace(remoteId: string, docId: string) {
  // Snapshot right after the caller's own teardownWorkspace() (handleDocChanged
  // calls it immediately before this) — if a later doc switch starts its own
  // attempt before this one's awaits resolve, that later teardownWorkspace()
  // bumps joinGeneration and every check below bails instead of racing it.
  const myGeneration = joinGeneration;
  await window.MDE.githubSessionReady;
  if (myGeneration !== joinGeneration) return;
  const access = await fetchWorkspaceAccess(remoteId);
  if (myGeneration !== joinGeneration) return;
  const role = computeMyRole(access, window.MDE.githubUsername);
  if (!role) return;
  const joined = await joinWorkspace(remoteId, { role });
  if (joined !== joinGeneration) return;
  bindActiveDoc(docId);
  syncShareStores();
}

// A document still carrying the legacy per-document `shared` flag (see
// types.ts) — migrate its CollabRoom into a fresh WorkspaceRoom, adopt the
// resulting workspace locally (same shape as a fresh join, see Task 10's
// adoptSharedWorkspace), then clear the legacy flag so this never runs
// again for this document.
async function migrateLegacyDoc(docId: string) {
  try {
    const res = await fetch(`/api/collab/${encodeURIComponent(docId)}/migrate`, { method: "POST" });
    if (!res.ok) {
      syncShareStores();
      return;
    }
    const { workspaceId } = (await res.json()) as { workspaceId: string };
    const doc = findDocById(docId);
    if (!doc) return;

    const existingLocal = get(workspacesStore).find((w) => w.remoteId === workspaceId);
    const targetWorkspaceId = existingLocal ? existingLocal.id : adoptSharedWorkspace(workspaceId, doc.name || "Untitled").id;
    if (targetWorkspaceId !== doc.workspaceId) {
      // Fold this doc into the migrated workspace instead of leaving a
      // duplicate behind — the migrate endpoint already copied its
      // content server-side, so the local copy just needs to point at
      // the same workspace and drop the legacy flag.
      docsStore.update((docs) => docs.map((d) => (d.id === docId ? { ...d, workspaceId: targetWorkspaceId, shared: undefined } : d)));
      persistDocs();
    } else {
      docsStore.update((docs) => docs.map((d) => (d.id === docId ? { ...d, shared: undefined } : d)));
      persistDocs();
    }

    await rejoinKnownWorkspace(workspaceId, docId);
  } catch (err) {
    syncShareStores();
  }
}

// Opens the one WebSocket for a whole shared workspace and creates a
// Y.Doc binding for every document currently in it — all of them start
// syncing immediately, not just whichever one ends up on screen (see
// bindActiveDoc, called separately once this resolves).
//
// seedDocId: a document being shared for the very first time isn't in
// the workspace's existing doc list yet (it's fetched below), so its
// binding has to be created and pushed the current local editor content
// BEFORE connecting — the initial sync handshake then carries that
// content to the server as part of its own state vector. Seeding after
// the socket is already open would instead rely on a live "local
// update" broadcast via send(), which is silently dropped if the socket
// isn't OPEN yet (a real gap this fixes: turning on sharing previously
// created an empty room server-side and never actually sent the
// document's content, only the framing for it).
// Returns the generation number this attempt claimed (via its own
// teardownWorkspace() call below) so callers that awaited this can tell
// whether a newer attempt has since superseded it — see rejoinKnownWorkspace.
async function joinWorkspace(workspaceId: string, { role, seedDocId }: { role: string; seedDocId?: string }): Promise<number> {
  teardownWorkspace();
  const myGeneration = joinGeneration;
  workspaceRoom.workspaceId = workspaceId;

  const docIds = await fetchWorkspaceDocIds(workspaceId);
  if (myGeneration !== joinGeneration) return myGeneration; // superseded mid-fetch — leave workspaceRoom to the newer attempt

  for (const docId of docIds) createDocBinding(docId, role);

  if (seedDocId && !docIds.includes(seedDocId)) {
    createDocBinding(seedDocId, role);
    seedDocBindingFromEditor(seedDocId);
  }

  connectWorkspace();
  return myGeneration;
}

// Pushes the currently-open editor's live content (and any local
// images) into a freshly-created, still-unconnected doc binding — same
// idea as the old single-document room's seedFromLocal, just scoped to
// one binding within the multi-doc workspace connection.
function seedDocBindingFromEditor(docId: string): void {
  const binding = workspaceRoom.docs.get(docId);
  if (!binding) return;
  const view = window.MDE.getEditor();
  const content = view.state.doc.toString();
  if (content) binding.ydoc.transact(() => binding.ytext.insert(0, content), "local");
  const doc = getActiveDoc();
  if (doc && doc.id === docId) {
    binding.ydoc.transact(() => {
      binding.metaMap.set("name", doc.name || "Untitled");
      binding.metaMap.set("metadata", JSON.stringify(doc.metadata ?? []));
      binding.metaMap.set("citations", JSON.stringify(doc.citations ?? EMPTY_CITATIONS));
      if (doc.images) Object.entries(doc.images).forEach(([key, dataUrl]) => binding.imagesMap.set(key, dataUrl));
    }, "local");
  }
}

function createDocBinding(docId: string, role: string): DocBinding {
  const existing = workspaceRoom.docs.get(docId);
  if (existing) return existing;

  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.observe(() => {
    if (docId !== workspaceRoom.activeDocId) markDirty(docId);
  });
  const imagesMap = ydoc.getMap<string>("images");
  imagesMap.observe((event, tr) => {
    if (tr.origin === "local") return;
    if (workspaceRoom.activeDocId === docId) {
      event.changes.keys.forEach((change, key) => {
        if (change.action === "delete") return;
        const dataUrl = imagesMap.get(key);
        if (dataUrl) window.MDE.setDocImage(key, dataUrl);
      });
    } else {
      markDirty(docId);
    }
  });
  const metaMap = ydoc.getMap<string>("meta");
  metaMap.observe((event, tr) => {
    if (tr.origin === "local") return;
    if (event.changes.keys.has("name")) {
      if (workspaceRoom.activeDocId === docId) {
        const name = metaMap.get("name");
        if (name !== undefined) window.MDE.setDocName(docId, name);
      } else {
        markDirty(docId);
      }
    }
    if (event.changes.keys.has("metadata")) {
      if (workspaceRoom.activeDocId === docId) {
        const raw = metaMap.get("metadata");
        if (raw !== undefined) window.MDE.setDocMetadata(docId, JSON.parse(raw));
      } else {
        markDirty(docId);
      }
    }
    if (event.changes.keys.has("citations")) {
      if (workspaceRoom.activeDocId === docId) {
        const raw = metaMap.get("citations");
        if (raw !== undefined) window.MDE.setDocCitations(docId, JSON.parse(raw));
      } else {
        markDirty(docId);
      }
    }
  });
  const suggestionsMap = getSuggestionsMap(ydoc);
  suggestionsMap.observe(() => {
    if (workspaceRoom.activeDocId === docId) pendingSuggestionCount.set(suggestionsMap.size);
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

  const binding: DocBinding = { ydoc, ytext, imagesMap, metaMap, awareness, undoManager: null, ydocUpdateHandler, role };
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
  const username = window.MDE.githubUsername;
  const identity = username ? { name: username, color: colorForUsername(username) } : getGuestIdentity();
  const extensions = [yCollab(binding.ytext, binding.awareness, { undoManager }), keymap.of(yUndoManagerKeymap)];
  if (binding.role === "reviewer" || binding.role === "editor") {
    // suggestionExtensions internally gates its own pieces by role: the
    // decoration field (so an editor can see and act on suggestions too)
    // always applies; the edit-interception pieces (typing becomes a
    // suggestion instead of a direct edit) apply only when viewerRole is
    // "reviewer". A viewer never reaches this branch — Preview-only
    // locking keeps them out of the editor surface entirely.
    extensions.push(...suggestionExtensions(binding.ydoc, identity.name, { viewerRole: binding.role, viewerName: identity.name }));
  }
  window.MDE.enterCollabMode(extensions, undoManager);
  // Only a viewer is read-only now — a reviewer has a fully live,
  // typeable surface; their edits become suggestions instead of direct
  // writes (suggestionExtensions above), not a disabled editor.
  window.MDE.setReadOnly(binding.role === "viewer");
  // A viewer gets a true look-only mode with no edit surface at all —
  // locking to Preview removes the Editor/Split panes entirely rather
  // than just disabling typing in a visible CodeMirror instance.
  if (binding.role === "viewer") {
    lockToPreviewOnly();
  } else {
    unlockViewMode();
  }

  binding.awareness.setLocalState({ user: identity, role: binding.role, username });
  binding.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    sendAwareness(docId, binding.awareness, added.concat(updated, removed));
    updatePresence();
  });

  pendingSuggestionCount.set(getSuggestionsMap(binding.ydoc).size);

  sendPresence(docId);
}

function teardownWorkspace(): void {
  joinGeneration++;
  // Cancels any pending debounce timer and runs the flush immediately —
  // its side effects (docsStore writes, persistDocs) happen synchronously
  // within this call even though the returned Promise resolves later, so
  // nothing pending is lost to the Y.Doc destruction below.
  backgroundSyncDebounce.flush();
  remotePresenceByUsername.clear();
  workspacePresence.set(new Map());
  window.MDE.setReadOnly(false);
  unlockViewMode();
  window.MDE.exitCollabMode();
  if (workspaceRoom.reconnectTimer) {
    clearTimeout(workspaceRoom.reconnectTimer);
    workspaceRoom.reconnectTimer = null;
  }
  // Destroy each doc's awareness (broadcasting its own "I'm leaving" state
  // update, see bindActiveDoc's awareness.on("update", ...) listener) BEFORE
  // closing the socket — send() only transmits while the socket is OPEN, so
  // closing first silently drops that broadcast almost every time, leaving
  // a phantom presence entry the server never learns to remove.
  for (const binding of workspaceRoom.docs.values()) {
    binding.awareness.destroy();
    binding.ydoc.off("update", binding.ydocUpdateHandler);
    if (binding.undoManager) binding.undoManager.destroy();
    binding.ydoc.destroy();
  }
  if (workspaceRoom.ws) {
    workspaceRoom.ws.onclose = null;
    workspaceRoom.ws.onerror = null;
    try {
      workspaceRoom.ws.close();
    } catch (e) {
      /* already closed */
    }
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

// Tracks each remote session's current doc by username (good enough for
// this indicator's purpose — the doc list shows "who", not "which of
// their possibly-multiple tabs"). An empty docId means that user has
// disconnected or is no longer viewing anything in this workspace (see
// WorkspaceRoom.handleClose's own presence broadcast on disconnect).
const remotePresenceByUsername = new Map<string, string>();

function handleRemotePresence(username: string, docId: string): void {
  if (!username) return;
  if (docId) remotePresenceByUsername.set(username, docId);
  else remotePresenceByUsername.delete(username);

  const byDoc = new Map<string, { username: string; color: string }[]>();
  for (const [name, forDocId] of remotePresenceByUsername.entries()) {
    const list = byDoc.get(forDocId) || [];
    list.push({ username: name, color: colorForUsername(name) });
    byDoc.set(forDocId, list);
  }
  workspacePresence.set(byDoc);
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

type RemoteDocPreview = { id: string; name: string; content: string; updatedAt: number; createdAt: number };

// Fetches a document's current text via a throwaway sync handshake over a
// short-lived WebSocket — there's no plain HTTP "get current content"
// endpoint (the DO only speaks the Yjs sync protocol for content), so this
// opens one, waits for the first sync reply, and closes it again. Used
// only for the one-time "download the list to show in the join prompt"
// step; the real, persistent connection is opened afterward by
// joinWorkspace once the user has actually chosen to join.
async function fetchRemoteDocContent(workspaceId: string, docId: string): Promise<RemoteDocPreview | null> {
  return new Promise((resolve) => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/workspace/${encodeURIComponent(workspaceId)}`);
    ws.binaryType = "arraybuffer";
    const scratchDoc = new Y.Doc();
    let settled = false;
    const finish = (result: RemoteDocPreview | null) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch (e) {
        /* already closed */
      }
      resolve(result);
    };
    ws.onopen = () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      encoding.writeVarString(encoder, docId);
      syncProtocol.writeSyncStep1(encoder, scratchDoc);
      ws.send(encoding.toUint8Array(encoder));
    };
    ws.onmessage = (event) => {
      const decoder = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer));
      const type = decoding.readVarUint(decoder);
      if (type !== MESSAGE_SYNC) return;
      const gotDocId = decoding.readVarString(decoder);
      if (gotDocId !== docId) return;
      syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), scratchDoc, "server");
      const now = Date.now();
      const name = scratchDoc.getMap<string>("meta").get("name") || "Shared document";
      finish({ id: docId, name, content: scratchDoc.getText("content").toString(), updatedAt: now, createdAt: now });
    };
    ws.onerror = () => finish(null);
    setTimeout(() => finish(null), 5000);
  });
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

// Exported purely for collab.test.ts's join-generation race regression
// test — not part of any real caller's public surface.
export { handleDocChanged, workspaceRoom };

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

export interface ShareDirectDecision {
  kind: "direct";
}
export interface ShareChoiceDecision {
  kind: "choice";
  docName: string;
  workspaceName: string;
  docCount: number;
}
export type ShareDecision = ShareDirectDecision | ShareChoiceDecision;

// Being already-shared always wins over sibling count: opening a second
// document in a workspace collaborators are already synced to must never
// re-trigger the isolate-into-a-new-workspace prompt (that would
// incorrectly split it back out). Only an unshared workspace with more
// than one document needs a real choice between sharing just the active
// document (today's only behavior) or the whole workspace as-is.
export function decideShareTarget(doc: Doc, docs: Doc[], workspaces: Workspace[]): ShareDecision {
  const workspace = workspaces.find((w) => w.id === doc.workspaceId);
  if (workspace?.shared) return { kind: "direct" };
  const docCount = docs.filter((d) => d.workspaceId === doc.workspaceId).length;
  if (docCount <= 1) return { kind: "direct" };
  return {
    kind: "choice",
    docName: doc.name || "Untitled",
    workspaceName: workspace?.name || "Untitled workspace",
    docCount,
  };
}

export type JoinDecision = { kind: "auto"; workspaceName: string } | { kind: "choice" };

// A single shared document is unambiguous — there's nothing to meaningfully
// choose between (merge one document into an existing workspace, or give it
// its own?) — so it always lands as its own new workspace, named after the
// document, regardless of how many workspaces the receiver already has.
// A multi-document workspace share still gets a real choice, except for a
// receiver with zero workspaces, who — per item 22 — has nothing to choose
// between either.
export function decideJoinTarget(validDocs: { name: string }[], existingWorkspaceCount: number): JoinDecision {
  if (validDocs.length === 1) return { kind: "auto", workspaceName: validDocs[0]!.name || "Untitled" };
  if (existingWorkspaceCount === 0) return { kind: "auto", workspaceName: "Shared workspace" };
  return { kind: "choice" };
}

export async function openShareModal() {
  await window.MDE.githubSessionReady;
  if (!window.MDE.githubUsername) {
    window.MDE.requireGithubSignIn("Sharing needs a connected GitHub account. Sign in to continue.");
    return;
  }
  const doc = getActiveDoc();
  if (!doc) return;

  let targetWorkspaceId = doc.workspaceId;
  const decision = decideShareTarget(doc, get(docsStore), get(workspacesStore));
  if (decision.kind === "choice") {
    const choice = await shareChoice(decision.docName, decision.workspaceName, decision.docCount);
    if (choice === "cancel") return;
    if (choice === "document") {
      const ws = createWorkspace(doc.name || "Untitled");
      moveDocToWorkspace(doc.id, ws.id);
      targetWorkspaceId = ws.id;
    }
    // choice === "workspace": targetWorkspaceId stays doc.workspaceId — share the whole workspace as-is.
  }

  shareModalOpen.set(true);
  currentAccess = await fetchWorkspaceAccess(targetWorkspaceId);
  syncShareStores();
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
  const access = await putWorkspaceAccess(doc.workspaceId, {
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
  workspacesStore.update((all) =>
    all.map((w) =>
      w.id === doc.workspaceId
        ? { ...w, shared: wantAnyone || access.invited.length > 0 || w.shared, remoteId: w.remoteId || doc.workspaceId, updatedAt: Date.now() }
        : w,
    ),
  );
  persistWorkspaces();
  if ((wantAnyone || access.invited.length > 0) && !workspaceRoom.workspaceId) {
    await joinWorkspace(doc.workspaceId, { role: "editor", seedDocId: doc.id });
    bindActiveDoc(doc.id);
  }
  if (!wantAnyone && access.invited.length === 0) teardownWorkspace();
  syncShareStores();
  showToast(ACCESS_MODE_TOAST[mode], "info");
  return true;
}

export async function setRole(role: string) {
  const doc = getActiveDoc();
  if (!doc || !currentAccess) return;
  const access = await putWorkspaceAccess(doc.workspaceId, {
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
  return `${location.origin}/w/${encodeURIComponent(doc.workspaceId)}/${encodeURIComponent(doc.id)}/${segment}`;
}

export async function addPerson(rawUsername: string) {
  const username = rawUsername.trim().replace(/^@/, "");
  if (!username) return;
  const doc = getActiveDoc();
  if (!doc) return;
  const existing = currentAccess ? currentAccess.invited : [];
  if (existing.some((p) => p.username === username)) return;
  const invited = [...existing, { username, role: "editor" }];
  const access = await putWorkspaceAccess(doc.workspaceId, {
    generalAccess: currentAccess ? currentAccess.generalAccess : "restricted",
    requireAccount: currentAccess ? currentAccess.requireAccount : false,
    role: currentAccess ? currentAccess.role : "viewer",
    invited,
  });
  if (access) {
    currentAccess = access;
    workspacesStore.update((all) =>
      all.map((w) => (w.id === doc.workspaceId ? { ...w, shared: true, remoteId: w.remoteId || doc.workspaceId, updatedAt: Date.now() } : w)),
    );
    persistWorkspaces();
    // Restricted access never otherwise triggers joinWorkspace (only
    // switching to "anyone" does, see setAccessMode) — without this, an
    // invited person could join and authorize successfully but find the
    // workspace's docs completely empty, since the owner's content was
    // never seeded into it. First invite on a still-unconnected workspace
    // needs to seed it, same as opening general access does.
    if (!workspaceRoom.workspaceId) {
      await joinWorkspace(doc.workspaceId, { role: "editor", seedDocId: doc.id });
      bindActiveDoc(doc.id);
    }
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
  const access = await putWorkspaceAccess(doc.workspaceId, {
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
  const access = await putWorkspaceAccess(doc.workspaceId, {
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
  const workspace = doc && get(workspacesStore).find((w) => w.id === doc.workspaceId);
  shareTargetName.set(workspace?.name || "Untitled workspace");
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
