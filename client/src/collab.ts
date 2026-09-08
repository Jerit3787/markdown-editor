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
import { Transaction } from "@codemirror/state";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import "./types";
import type { AccessRecord, Doc, Workspace } from "./types";
import { shareModalOpen, shareAccess, shareTargetName, sharePresence, identityUnverified, workspaceAccessDenied, myAccessRequestPending, requestAccessModalOpen } from "./stores/share";
import { showToast } from "./stores/toast";
import {
  getActiveDoc,
  switchDoc,
  docsStore,
  moveDocToWorkspace,
  findDocById,
  persistDocs,
  importRemoteDocs,
  syncRemoteDocContent,
  removeDocById,
  docRemovalHook,
  repoDocSyncHook,
} from "./stores/docs";
import { debounceWithFlush } from "./debounce";
import { pendingJoin } from "./stores/joinWorkspace";
import { workspacePresence } from "./stores/workspacePresence";
import {
  workspacesStore,
  switchWorkspace,
  createWorkspace,
  persistWorkspaces,
  adoptSharedWorkspace,
  previewSharedWorkspace,
  renameWorkspace,
  deleteWorkspaceRecord,
  isDefaultWorkspaceName,
  workspaceRepoLinkHook,
} from "./stores/workspaces";
import { workspaceRepoLinked } from "./stores/repoSync";
import { shareChoice } from "./stores/shareChoice";
import { EMPTY_CITATIONS } from "./mmd-citations";
import { suggestionExtensions } from "./suggestion-editor";
import { getSuggestionsMap } from "./suggestions";
import { pendingSuggestionCount } from "./stores/suggestions";
import { remoteCommentsChanged } from "./stores/commentsPanel";
import { lockToPreviewOnly, unlockViewMode } from "./stores/view";
import { enterCollabRoom, leaveCollabRoom, effectiveMode, collabIsOwner, type Mode, type Role } from "./stores/collabMode";
import { COLORS, colorForUsername } from "./user-color";
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
const MESSAGE_WORKSPACE_META = 3;
const MESSAGE_COMMENTS = 4;
const MESSAGE_WORKSPACE_DELETED = 5;
const MESSAGE_ACCESS_REQUEST = 6; // [type, username, message] — only the owner acts (a toast)
const MESSAGE_ACCESS_CHANGED = 7; // [type] — every client re-fetches /access, rejoins if its own role changed

// CV2-5 — remoteIds this session has already nudged the owner about
// ("N people waiting for edit access"). Cleared on teardownWorkspace so
// re-joining re-arms it. Module-level: init() never runs in jsdom.
const ownerNudgedRemoteIds = new Set<string>();

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
  // False only for a binding created "blank" by createDocBinding for a
  // docId the server already knows about (see joinWorkspace) — its ytext
  // starts empty and only becomes correct once the server's own sync
  // reply has been applied. A binding seeded locally (seedDocBindingFromEditor,
  // seedNewDocBinding) already holds the right content the moment it's
  // created and is marked synced immediately. bindActiveDoc awaits
  // whenSynced before attaching yCollab: see markDocSynced for why.
  synced: boolean;
  whenSynced: Promise<void>;
}

const workspaceRoom = {
  workspaceId: null as string | null,
  ws: null as WebSocket | null,
  docs: new Map<string, DocBinding>(),
  activeDocId: null as string | null,
  // This session's own resolved role for the whole connection (set once
  // in joinWorkspace, from computeMyRole's result) — role is per
  // connection, not per document (see access-role.ts's resolveRole()),
  // so this is the one correct source for "what am I allowed to do
  // here," independent of which documents happen to be bound yet. Never
  // derive a fallback role by reading some OTHER binding's own .role:
  // if no binding exists yet (or activeDocId is still null, e.g. while
  // bindActiveDoc's whenSynced await is still pending), that reads as
  // "not found" and silently defaulted to "editor" — handing a viewer
  // an editor-looking binding for a document their real role never
  // granted them write access to.
  role: null as string | null,
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
  // Tear the workspace connection down before a doc load ONLY when the
  // load is leaving the currently-connected shared workspace. Switching
  // between two documents of the *same* connected workspace must keep the
  // one socket open — handleDocChanged's own "same workspace" branch then
  // just rebinds the editor to the new doc (seeding it first if it's
  // brand-new). An unconditional teardown here — a carryover from the
  // pre-workspace era when every document was its own room — instead
  // forces a full HTTP refetch + reconnect on every in-workspace doc
  // switch and, worse, routes a just-created doc through the rejoin path
  // where its still-empty Y.Doc overwrites the freshly-typed editor
  // content. handleDocChanged still calls teardownWorkspace() itself in
  // every branch that genuinely leaves the room.
  window.MDE.onBeforeDocLoad = () => {
    const next = getActiveDoc();
    const ws = next ? get(workspacesStore).find((w) => w.id === next.workspaceId) : null;
    if (ws && ws.shared && ws.remoteId && workspaceRoom.workspaceId === ws.remoteId) return;
    teardownWorkspace();
  };
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
  docRemovalHook.onRemoved = pushWorkspaceDocDelete;
  repoDocSyncHook.onRepoDocsChanged = handleRepoDocsChanged;
  workspaceRepoLinkHook.onChanged = (wsId, linked) => pushWorkspaceRepoLinked(wsId, linked);

  setupShareUI();

  const shareUrlMatch = location.pathname.match(SHARE_PATH);
  if (shareUrlMatch) {
    history.replaceState(null, "", "/" + location.search + location.hash);
    joinSharedLink(shareUrlMatch[1]!, shareUrlMatch[2]!);
  } else {
    handleDocChanged(getActiveDoc());
  }

  // Retrying access after a Sign-in popup completes (see
  // WorkspaceAccessBanner.svelte) is just re-running the same join logic
  // that got the user into the denied state in the first place — no
  // bespoke retry path, no extra state to keep in sync. client/src/main.ts
  // imports ./collab before ./gist, so this module's init() always sets
  // onGithubAuthComplete first; gist.ts's own init() chains onto it (the
  // same pattern it already uses for onActiveDocChanged) rather than
  // overwriting it.
  window.MDE.onGithubAuthComplete = () => handleDocChanged(getActiveDoc());
}

// Live mode switching: when the user picks a different mode in
// ModeSwitcher, re-apply it to whatever document is currently bound.
// Module-level (not inside init()) so it works regardless of DOMContentLoaded
// timing — the activeDocId guard keeps it a no-op until a doc is actually
// bound, by which point window.MDE is ready. Fires immediately with the
// current value too (a harmless no-op).
effectiveMode.subscribe((mode) => {
  if (!mode || !workspaceRoom.activeDocId) return;
  const binding = workspaceRoom.docs.get(workspaceRoom.activeDocId);
  if (binding) applyEditorMode(binding, mode);
});

export async function joinSharedLink(workspaceId: string, landOnDocId: string) {
  const localMatch = get(workspacesStore).find((w) => w.remoteId === workspaceId);
  const access = await fetchWorkspaceAccess(workspaceId);
  if (access.deleted) {
    if (localMatch) handleWorkspaceGone(localMatch.id);
    else workspaceAccessDenied.set("deleted");
    return;
  }
  await window.MDE.githubSessionReady;
  const username = window.MDE.githubUsername;
  const role = computeMyRole(access, username);
  if (!role) {
    workspaceAccessDenied.set(username ? "no-access" : "no-session");
    window.MDE.setReadOnly(true);
    lockToPreviewOnly();
    return;
  }
  workspaceAccessDenied.set(null);
  identityUnverified.set(isIdentityUnverified(access, username));

  if (localMatch) {
    // Already joined this remote workspace before — just switch to it.
    switchWorkspace(localMatch.id);
    switchDoc(landOnDocId);
    await joinWorkspace(workspaceId, { role, isOwner: !!username && access.owner === username });
    bindActiveDoc(landOnDocId);
    return;
  }

  const docIds = await fetchWorkspaceDocIds(workspaceId);
  const docs = await Promise.all(docIds.map((id) => fetchRemoteDocContent(workspaceId, id)));
  const validDocs = docs.filter((d): d is NonNullable<typeof d> => !!d);

  const decision = decideJoinTarget(validDocs, get(workspacesStore).length, access.workspaceName);
  if (decision.kind === "auto-permanent") {
    const ws = adoptSharedWorkspace(workspaceId, decision.workspaceName);
    importRemoteDocs(ws.id, validDocs);
    switchWorkspace(ws.id);
    switchDoc(landOnDocId);
    return;
  }
  if (decision.kind === "auto-preview") {
    const ws = previewSharedWorkspace(workspaceId, decision.workspaceName);
    importRemoteDocs(ws.id, validDocs);
    switchWorkspace(ws.id);
    switchDoc(landOnDocId);
    return;
  }

  pendingJoin.set({ remoteId: workspaceId, workspaceName: access.workspaceName || "Shared workspace", docs: validDocs, landOnDocId });
}

// Mirrors src/access-role.ts's resolveRole() — kept in sync by hand.
const ROLE_RANK: Record<string, number> = { viewer: 0, reviewer: 1, editor: 2 };
function higherRole(a: string, b: string): string {
  return (ROLE_RANK[a] ?? 0) >= (ROLE_RANK[b] ?? 0) ? a : b;
}
function computeMyRole(access: typeof DEFAULT_ACCESS, username: string | null): string | null {
  if (username && access.owner === username) return "editor";
  const invited = username ? access.invited.find((p) => p.username === username) : undefined;
  if (access.generalAccess === "anyone") {
    if (access.requireAccount && !username) return null;
    return invited ? higherRole(invited.role, access.role) : access.role;
  }
  if (!username) return null;
  return invited ? invited.role : null;
}

// True only in the one genuinely ambiguous case: there's no session at
// all (not merely a session belonging to someone else), yet the access
// record still grants a role via general access. Doesn't change what
// role is granted (computeMyRole already does the right thing here) —
// this only flags that the *reason* is unverifiable identity, not a
// deliberate permissions decision, so the UI can say so.
//
// Deliberately does NOT also check access.owner !== null: the server
// redacts `owner` to null for exactly this caller (see
// access-visibility.ts's redactAccessForOutsider, applied whenever
// authorize() itself doesn't already recognize the requester) — an
// anonymous visitor's own AccessRecord always has owner: null regardless
// of whether one is actually configured, so that check was always false
// for the real audience this function exists to catch. It's also
// unnecessary: generalAccess only ever becomes "anyone" via a PUT that
// simultaneously claims/keeps a real owner (see handleAccessRequest's PUT
// handler), so a granted role via general access already implies an
// owner exists, redacted or not.
export function isIdentityUnverified(access: typeof DEFAULT_ACCESS, username: string | null): boolean {
  return !username && access.generalAccess === "anyone";
}

// ---------- Room lifecycle ----------

function handleDocChanged(doc: any) {
  if (!doc) {
    teardownWorkspace();
    identityUnverified.set(false);
    workspaceAccessDenied.set(null);
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
      // A document created (or otherwise switched to for the first time)
      // while the workspace is already connected has no binding yet —
      // bindActiveDoc only rebinds a doc already syncing, so introduce it
      // first. The docId-multiplexed wire protocol already supports this
      // (see workspace-room.ts's isNewDoc handling); nothing on the
      // client ever triggered it for a doc created after the initial
      // join, so it silently never reached the server or any other
      // collaborator at all.
      if (!workspaceRoom.docs.has(doc.id)) {
        seedNewDocBinding(doc.id, doc, workspaceRoom.role ?? "editor");
      }
      bindActiveDoc(doc.id);
      syncShareStores();
      return;
    }
    // Deliberately doesn't reset identityUnverified here (unlike the two
    // branches below that leave shared context for good) — this branch
    // immediately re-joins the same or another shared workspace via
    // rejoinKnownWorkspace, which sets its own correct value once it
    // resolves. The initial adopt-and-switch sequence for a freshly
    // joined workspace can fire this branch more than once in quick
    // succession (switching workspace and switching doc are separate
    // reactive triggers) before the winning rejoin's awaits settle;
    // zeroing identityUnverified on every one of those redundant
    // teardowns — including ones that fire after the real rejoin already
    // set it correctly — was leaving it stuck at false. Only the branches
    // where nothing is coming to set it back need to reset it themselves.
    teardownWorkspace();
    rejoinKnownWorkspace(ws.remoteId, doc.id);
  } else if (doc.shared) {
    // Also intentionally not reset here — migrateLegacyDoc() ends by
    // adopting the migrated workspace, which triggers this same function
    // again with ws.shared && ws.remoteId now true, landing in the branch
    // above and setting the correct value there.
    teardownWorkspace();
    migrateLegacyDoc(doc.id);
  } else {
    teardownWorkspace();
    identityUnverified.set(false);
    workspaceAccessDenied.set(null);
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
  if (access.deleted) {
    const local = get(workspacesStore).find((w) => w.remoteId === remoteId);
    if (local) handleWorkspaceGone(local.id);
    else workspaceAccessDenied.set("deleted");
    return;
  }
  const role = computeMyRole(access, window.MDE.githubUsername);
  if (!role) {
    workspaceAccessDenied.set(window.MDE.githubUsername ? "no-access" : "no-session");
    window.MDE.setReadOnly(true);
    lockToPreviewOnly();
    return;
  }
  workspaceAccessDenied.set(null);
  identityUnverified.set(isIdentityUnverified(access, window.MDE.githubUsername));
  const joined = await joinWorkspace(remoteId, {
    role,
    isOwner: !!window.MDE.githubUsername && access.owner === window.MDE.githubUsername,
  });
  if (joined !== joinGeneration) return;
  currentAccess = access; // so the Share dialog / owner nudge see fresh access on open
  bindActiveDoc(docId);
  syncShareStores();
}

// CV2-5 — a MESSAGE_ACCESS_CHANGED frame landed (owner approved/denied a
// request, or edited a role). Re-fetch access; if this session's own
// resolved role changed, rejoin the room so the WebSocket reconnects at
// the new server-side role (and the mode chrome follows).
async function handleAccessChanged(local: Workspace, remoteId: string): Promise<void> {
  const hadPending = get(myAccessRequestPending);
  const access = await fetchWorkspaceAccess(remoteId);
  currentAccess = access;
  syncShareStores();
  myAccessRequestPending.set(access.myAccessRequestPending ?? false);

  const newRole = computeMyRole(access, window.MDE.githubUsername);
  if (newRole !== workspaceRoom.role) {
    if (newRole === "editor") showToast("You now have edit access", "info");
    else if (newRole) showToast("Your access to this workspace changed", "info");
    const docId = workspaceRoom.activeDocId ?? get(docsStore).find((d) => d.workspaceId === local.id)?.id;
    if (docId) {
      teardownWorkspace();
      await rejoinKnownWorkspace(remoteId, docId);
    }
    return;
  }
  if (hadPending && !(access.myAccessRequestPending ?? false)) {
    showToast("Your access request was declined", "info");
  }
}

// CV2-5 — once per session, tell an owner who just joined a workspace that
// has requests waiting from before they connected. The live path
// (MESSAGE_ACCESS_REQUEST) covers requests that arrive while they're here.
function maybeNudgeOwnerAboutRequests(remoteId: string | null): void {
  if (!remoteId || !get(collabIsOwner) || ownerNudgedRemoteIds.has(remoteId)) return;
  const n = currentAccess?.accessRequests?.length ?? 0;
  if (n === 0) return;
  ownerNudgedRemoteIds.add(remoteId);
  showToast(`${n} ${n === 1 ? "person is" : "people are"} waiting for edit access — open Share to review`, "info");
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
    // Don't seed the local workspace with the doc's own placeholder name
    // ("Shared document-5") — "Untitled workspace" at least reads as
    // rename-me. A real name arrives via applyWorkspaceMeta once the room
    // has one (the seed sets it for fresh migrations; the block at the end
    // of this function pushes one for already-migrated legacy rooms).
    const adoptName = doc.name && !isPlaceholderDocName(doc.name) ? doc.name : "Untitled workspace";
    const targetWorkspaceId = existingLocal ? existingLocal.id : adoptSharedWorkspace(workspaceId, adoptName).id;
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

    // Heal names for a legacy share whose room predates name-syncing (its
    // WorkspaceRoom.name / the doc's meta.name were never set — the seed
    // only carries a name forward when the CollabRoom's Y.Doc already had
    // one). The person triggering the migration is usually the original
    // owner opening their own old link, so their local doc.name is the
    // best source of truth we have. Editor-gated both sides: a non-editor's
    // meta write is dropped by the server, and pushWorkspaceRename's PUT is
    // 403'd — so this is a no-op for a random visitor, and a random
    // visitor's local doc.name is a placeholder anyway (guarded below).
    if (workspaceRoom.role === "editor" && doc.name && !isPlaceholderDocName(doc.name)) {
      const binding = workspaceRoom.docs.get(docId);
      if (binding && !binding.metaMap.get("name")) {
        binding.ydoc.transact(() => binding.metaMap.set("name", doc.name), "local");
      }
      // pushWorkspaceRename resolves the room id from the *local* workspace
      // record, so pass the local id, not `workspaceId` (the remote one).
      const acc = await fetchWorkspaceAccess(workspaceId);
      if (!acc.workspaceName) pushWorkspaceRename(targetWorkspaceId, doc.name);
    }
  } catch (err) {
    syncShareStores();
  }
}

// "Shared document" / "Shared workspace" (with the -2, -3… dedupe suffix
// ensureUniqueName / decideJoinTarget may have appended) are the literal
// placeholders shown when a name is genuinely missing — never propagate
// one as if it were a real name.
function isPlaceholderDocName(name: string): boolean {
  return /^Shared document(-\d+)?$/.test(name.trim());
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
async function joinWorkspace(
  workspaceId: string,
  { role, seedDocId, isOwner = false }: { role: string; seedDocId?: string; isOwner?: boolean },
): Promise<number> {
  teardownWorkspace();
  const myGeneration = joinGeneration;
  workspaceRoom.workspaceId = workspaceId;
  workspaceRoom.role = role;
  enterCollabRoom(workspaceId, role as Role, isOwner);

  const docIds = await fetchWorkspaceDocIds(workspaceId);
  if (myGeneration !== joinGeneration) return myGeneration; // superseded mid-fetch — leave workspaceRoom to the newer attempt

  for (const docId of docIds) createDocBinding(docId, role);

  if (seedDocId && !docIds.includes(seedDocId)) {
    createDocBinding(seedDocId, role);
    seedDocBindingFromEditor(seedDocId);
    // Registered with the room only now — after the check above already
    // decided to seed, and before connectWorkspace() opens the socket.
    // Registering any earlier would make the check above see this docId
    // as already-known and skip seeding it entirely (a real regression:
    // see setAccessMode's own comment). Registering any later would leave
    // a window where the room's very first (synchronous, at-accept-time)
    // greeting back to this same connection reports a docOrder without
    // this docId yet — which applyWorkspaceMeta would read as "removed
    // elsewhere" and delete the binding this line just seeded.
    await registerDocWithRoom(workspaceId, seedDocId);
    if (myGeneration !== joinGeneration) return myGeneration; // superseded mid-register
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
  markDocSynced(docId);
}

// Introduces a document to an already-connected workspace room that never
// went through joinWorkspace()'s own initial seeding (e.g. one created,
// or switched to for the first time, after the connection was already
// established) — same idea as seedDocBindingFromEditor, but sourced from
// the plain Doc record instead of the live editor, since this doc isn't
// necessarily the one currently loaded into CodeMirror yet. Explicitly
// sends this binding's own initial sync step1 afterward: the server only
// ever learns of a docId when a message naming it arrives (see
// workspace-room.ts's isNewDoc handling), and nothing else would trigger
// that round trip for a doc introduced this way.
function seedNewDocBinding(docId: string, doc: Doc, role: string): void {
  const binding = createDocBinding(docId, role);
  binding.ydoc.transact(() => {
    if (doc.content) binding.ytext.insert(0, doc.content);
    binding.metaMap.set("name", doc.name || "Untitled");
    binding.metaMap.set("metadata", JSON.stringify(doc.metadata ?? []));
    binding.metaMap.set("citations", JSON.stringify(doc.citations ?? EMPTY_CITATIONS));
    if (doc.images) Object.entries(doc.images).forEach(([key, dataUrl]) => binding.imagesMap.set(key, dataUrl));
  }, "local");
  markDocSynced(docId);
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarString(encoder, docId);
  syncProtocol.writeSyncStep1(encoder, binding.ydoc);
  send(encoding.toUint8Array(encoder));
}

// Overwrites a synced binding's content + meta wholesale from a plain Doc
// record — used when a repo pull is authoritative for that file (a clean
// update, or a "theirs" conflict resolution). Yjs merges it as an
// ordinary local edit, so collaborators get it like any other change.
function replaceBindingContent(binding: DocBinding, doc: Doc): void {
  binding.ydoc.transact(() => {
    if (binding.ytext.length) binding.ytext.delete(0, binding.ytext.length);
    if (doc.content) binding.ytext.insert(0, doc.content);
    binding.metaMap.set("name", doc.name || "Untitled");
    binding.metaMap.set("metadata", JSON.stringify(doc.metadata ?? []));
    binding.metaMap.set("citations", JSON.stringify(doc.citations ?? EMPTY_CITATIONS));
    if (doc.images) Object.entries(doc.images).forEach(([key, dataUrl]) => binding.imagesMap.set(key, dataUrl));
  }, "local");
}

// repoDocSyncHook handler (E1): the owner just pulled from the linked repo.
// If this workspace is the connected shared room and we're its editor,
// register the pull's results with the room so applyWorkspaceMeta stops
// deleting repo docs the server never learned about.
function handleRepoDocsChanged({
  workspaceId,
  created,
  updated,
  deleted,
}: {
  workspaceId: string;
  created: string[];
  updated: string[];
  deleted: string[];
}): void {
  const ws = get(workspacesStore).find((w) => w.id === workspaceId);
  if (!ws?.remoteId || ws.remoteId !== workspaceRoom.workspaceId || workspaceRoom.role !== "editor") return;
  for (const id of created) {
    const doc = findDocById(id);
    if (doc && !workspaceRoom.docs.has(id)) seedNewDocBinding(id, doc, "editor");
  }
  for (const id of updated) {
    const binding = workspaceRoom.docs.get(id);
    const doc = findDocById(id);
    if (binding && doc) replaceBindingContent(binding, doc);
  }
  for (const id of deleted) {
    if (workspaceRoom.docs.has(id)) pushWorkspaceDocDelete(id, workspaceId);
  }
}

// Seeds a brand-new room the first time a workspace is shared — whether
// that's triggered by opening general access (setAccessMode) or by
// inviting the first person (addPerson). Both paths need the SAME thing
// and used to hand-roll it separately; addPerson's copy only ever seeded
// the active document, so inviting someone into a multi-document
// workspace silently left every sibling unregistered — and since the
// room's first workspace-meta greeting then omits those siblings from
// docOrder, this same client's applyWorkspaceMeta would read that as
// each sibling having been deleted elsewhere and remove it locally
// (real data loss). Keep this the one place that logic lives.
//
// The active doc is deliberately NOT pre-registered via registerDocWithRoom
// here: joinWorkspace's own seedDocId path only pushes this session's
// live, not-yet-synced editor content when the room doesn't already know
// the id, so pre-registering it would make that check skip the seed and
// leave the room with an empty Y.Doc for the very document being shared.
async function seedWorkspaceForFirstShare(activeDoc: Doc): Promise<void> {
  const siblings = get(docsStore).filter((d) => d.workspaceId === activeDoc.workspaceId && d.id !== activeDoc.id);
  await Promise.all(siblings.map((d) => registerDocWithRoom(activeDoc.workspaceId, d.id)));
  await joinWorkspace(activeDoc.workspaceId, { role: "editor", seedDocId: activeDoc.id, isOwner: true });
  bindActiveDoc(activeDoc.id);
  for (const sibling of siblings) seedNewDocBinding(sibling.id, sibling, "editor");

  // A freshly-created room's name is "" server-side; only a later explicit
  // rename (pushWorkspaceRename) ever set it. Without this, every
  // collaborator opening the share link fell back to decideJoinTarget's
  // literal "Shared workspace" (and applyWorkspaceMeta's `if (name)` guard
  // never healed it) — including in JoinWorkspaceModal's "<name> is shared
  // with you" copy. Push the local workspace's own name now, as part of
  // the same first-share seeding as every document's content/meta above —
  // but not a self-assigned default like "New workspace", which a joiner
  // is better off replacing with the document name / "Shared workspace".
  const localWs = get(workspacesStore).find((w) => w.id === activeDoc.workspaceId);
  if (localWs && !isDefaultWorkspaceName(localWs.name)) pushWorkspaceRename(activeDoc.workspaceId, localWs.name);
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
    if (workspaceRoom.activeDocId !== docId) return;
    pendingSuggestionCount.set(suggestionsMap.size);
    // A delete suggestion (and accepting an insert, or rejecting a
    // delete) never touches ytext — that's the point, the text stays put
    // until an editor resolves it — so CM6's own docChanged never fires
    // and app.ts's usual updatePreview() trigger (gated on
    // update.docChanged) never runs for it. The suggestions map is the
    // one thing every one of those cases does change, so refresh Preview
    // from here instead of relying on a docChanged side effect.
    //
    // Deferred to a microtask, not called synchronously: this observer
    // can fire from INSIDE an already-in-progress Y.Doc transaction
    // (recordInsertSuggestion/recordDeleteSuggestion call doc.transact()
    // themselves, synchronously, from within a CM6 updateListener that's
    // still mid-dispatch of the transaction that triggered them) — same
    // reentrancy hazard suggestionDecorationField's own observer already
    // guards against. Concretely: updatePreview()'s marked.parse/
    // DOMPurify.sanitize work is expensive enough that running it
    // synchronously here delays this same tick's Yjs update flush over
    // the WebSocket, which made the server's independent ytext-insert
    // reconciliation (WorkspaceRoom's reconcileReviewerDelta) win the
    // "two separate Yjs updates" race far more often in practice —
    // confirmed live, it turned an already-documented rare race into a
    // reliably reproducing duplicate suggestion.
    queueMicrotask(() => {
      if (workspaceRoom.activeDocId === docId) window.MDE.updatePreview?.();
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

  let resolveSynced!: () => void;
  const whenSynced = new Promise<void>((resolve) => {
    resolveSynced = resolve;
  });
  const binding: DocBinding = {
    ydoc,
    ytext,
    imagesMap,
    metaMap,
    awareness,
    undoManager: null,
    ydocUpdateHandler,
    role,
    synced: false,
    whenSynced,
  };
  bindingSyncResolvers.set(docId, resolveSynced);
  workspaceRoom.docs.set(docId, binding);
  return binding;
}

// A document another collaborator created (or first switched to) after
// this session already joined the workspace arrives here as an ordinary
// MESSAGE_SYNC frame for a docId never seen before — the server
// broadcasts every document's updates to every connected session the
// same way regardless of whether the recipient already knew about that
// document (see handleDocUpdate in workspace-room.ts). Role is per
// connection, not per document (see access-role.ts's resolveRole() and
// workspaceRoom.role's own comment), so this session's own resolved role
// applies to this newly-discovered document too.
function discoverRemoteDocBinding(docId: string): DocBinding {
  return createDocBinding(docId, workspaceRoom.role ?? "editor");
}

// Called once, immediately after the first incoming sync message has
// been applied into a freshly-discovered binding — turns it into a real
// local document so it shows up in the sidebar/doc list like any other,
// via the same import path used for every document already known when
// this session joined (see joinWorkspace's own importRemoteDocs call).
function registerDiscoveredDoc(docId: string, binding: DocBinding): void {
  if (findDocById(docId)) return;
  const localWorkspace = get(workspacesStore).find((w) => w.remoteId === workspaceRoom.workspaceId);
  if (!localWorkspace) return;
  const now = Date.now();
  importRemoteDocs(localWorkspace.id, [
    { id: docId, name: binding.metaMap.get("name") || "Untitled", content: binding.ytext.toString(), updatedAt: now, createdAt: now },
  ]);
}

// resolveSynced closures live here rather than on DocBinding itself,
// since createDocBinding's own object-literal construction above can't
// reference a method on the object it's still in the middle of building.
const bindingSyncResolvers = new Map<string, () => void>();

// Marks a binding as holding trustworthy content: either the server's own
// sync reply has been applied to it (see handleServerMessage), or it was
// populated locally, from content already known to be correct, at the
// moment it was created (seedDocBindingFromEditor, seedNewDocBinding).
// bindActiveDoc awaits this before attaching the yCollab CodeMirror
// extension — attaching it any earlier risks the exact race that caused
// live documents to duplicate their own content on every page refresh:
// yCollab's ySync plugin never reconciles the CodeMirror view against
// Y.Text on attach, it only forwards *future* Y.Text deltas into the view
// as literal inserts/deletes (see node_modules/y-codemirror.next's
// YSyncPluginValue) — so if the view already shows the document's
// last-known content (loaded from localStorage before this rejoin even
// started) and the binding's still-empty ytext then gets filled in by a
// delayed server reply, that fill-in gets forwarded into the view as a
// second, indistinguishable copy of content already there.
function markDocSynced(docId: string): void {
  const binding = workspaceRoom.docs.get(docId);
  if (!binding || binding.synced) return;
  binding.synced = true;
  bindingSyncResolvers.get(docId)?.();
  bindingSyncResolvers.delete(docId);
}

// The docId most recently passed to bindActiveDoc — used only to detect
// that a call superseded by a later one (same workspace, quick doc
// switch, no teardown/generation bump involved) should stop before
// touching shared state once its own await below resolves.
let lastRequestedActiveDocId: string | null = null;

// Rebinds the editor to a different document already syncing within the
// active workspace — no connection/reconnection involved, only which
// Y.Doc CodeMirror's yCollab extension is attached to. Async: waits for
// the binding's first real sync before wiring up yCollab (see
// markDocSynced for why attaching any earlier corrupts the document).
// Applies a collab Mode to the editor surface. Called from bindActiveDoc
// on every doc bind, and from init()'s effectiveMode subscription when the
// user switches mode mid-session. Rebuilds the editingMode compartment via
// enterCollabMode (which already reconfigures exactly that compartment) —
// no dedicated bridge method needed.
function applyEditorMode(binding: DocBinding, mode: Mode): void {
  const viewing = mode === "viewing";
  const undoManager = binding.undoManager || new Y.UndoManager(binding.ytext);
  binding.undoManager = undoManager;
  const username = window.MDE.githubUsername;
  const identity = username ? { name: username, color: colorForUsername(username) } : getGuestIdentity();
  const extensions = [yCollab(binding.ytext, binding.awareness, { undoManager }), keymap.of(yUndoManagerKeymap)];
  if (!viewing) {
    // suggestionExtensions gates its own pieces: the decoration field
    // always applies (so an editor sees/acts on suggestions); the
    // edit-interception (typing → a suggestion) applies only for
    // viewerRole "reviewer" — i.e. Suggesting mode, or an editor who
    // chose Suggesting.
    const viewerRole = mode === "suggesting" ? "reviewer" : "editor";
    extensions.push(...suggestionExtensions(binding.ydoc, identity.name, { viewerRole, viewerName: identity.name }));
  }
  window.MDE.enterCollabMode(extensions, undoManager);
  window.MDE.setReadOnly(viewing);
  if (viewing) lockToPreviewOnly();
  else unlockViewMode();
  document.body.classList.toggle("collab-viewing", viewing);
}

async function bindActiveDoc(docId: string): Promise<void> {
  const binding = workspaceRoom.docs.get(docId);
  if (!binding) return;
  lastRequestedActiveDocId = docId;
  const myGeneration = joinGeneration;
  // Captured BEFORE the await: true means this binding was seeded from
  // local content (seedDocBindingFromEditor / seedNewDocBinding both
  // markDocSynced synchronously), so the editor — not ytext — holds the
  // authoritative copy. False means a "blank" binding whose content only
  // becomes correct once the server's own sync reply lands, which is the
  // one case the ytext-wins reconcile below is actually for.
  const wasLocallySeeded = binding.synced;
  await binding.whenSynced;
  // Bail if superseded while waiting: either the whole workspace was torn
  // down and rejoined (generation bumped) or another doc switch already
  // moved past this one within the same still-connected workspace.
  if (joinGeneration !== myGeneration || lastRequestedActiveDocId !== docId) return;
  if (workspaceRoom.docs.get(docId) !== binding) return;
  workspaceRoom.activeDocId = docId;

  // yCollab's own sync plugin never reconciles the CodeMirror view against
  // Y.Text when it's attached — it only forwards *future* Y.Text deltas
  // into the view (see node_modules/y-codemirror.next's YSyncPluginValue).
  // The view at this point holds whatever content this doc's own
  // non-collab load path put there — usually already correct (the local
  // copy this same content was persisted from), but not guaranteed: a
  // collaborator joining a shared workspace for the very first time loads
  // an initial snapshot fetched over plain HTTP (fetchRemoteDocContent),
  // which can be a beat behind the room's actual live Y.Doc content by
  // the time this binding finishes its own sync above. Force the view to
  // exactly match the now-synced ytext before attaching yCollab: a no-op
  // when they already agree (the common case), a real correction
  // otherwise — either way, exactly one copy of the content ends up
  // showing, never zero and never two.
  const view = window.MDE.getEditor();
  const viewContent = view.state.doc.toString();
  const syncedContent = binding.ytext.toString();
  if (viewContent !== syncedContent) {
    if (wasLocallySeeded && syncedContent === "" && viewContent !== "") {
      // A locally-seeded doc (usually a brand-new one seeded from an empty
      // store record) that the user typed into after the seed but before
      // this bind ran — the editor holds the truth and ytext never got
      // it. Push it in, so it reaches the room instead of being wiped.
      binding.ydoc.transact(() => binding.ytext.insert(0, viewContent), "local");
    } else {
      // The blank-binding / stale-HTTP-snapshot case: the now-synced
      // ytext is authoritative, force the view to match it.
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: syncedContent },
        annotations: Transaction.addToHistory.of(false),
      });
    }
  }

  // The editor surface (read-only, suggestion-interception, view lock) is
  // now driven by the effective collab mode — the role's default, or the
  // user's ModeSwitcher pick clamped to the role ceiling — not the raw
  // role. applyEditorMode is also re-run by init()'s effectiveMode
  // subscription on a mid-session switch.
  applyEditorMode(binding, get(effectiveMode) ?? "editing");

  const username = window.MDE.githubUsername;
  const identity = username ? { name: username, color: colorForUsername(username) } : getGuestIdentity();
  // Presence still carries the TRUE role, not the self-selected mode —
  // other collaborators see "Editor" even while this person reads in
  // Viewing mode.
  binding.awareness.setLocalState({ user: identity, role: binding.role, username });
  binding.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    sendAwareness(docId, binding.awareness, added.concat(updated, removed));
    updatePresence();
  });

  pendingSuggestionCount.set(getSuggestionsMap(binding.ydoc).size);

  sendPresence(docId);
}

// Tears down one document's Yjs/awareness state and drops it from
// workspaceRoom.docs — the same cleanup teardownWorkspace() already does
// per-binding when leaving a workspace entirely, extracted so
// applyWorkspaceMeta() can do it for a single removed document without
// tearing down the whole connection.
function destroyBinding(docId: string): void {
  const binding = workspaceRoom.docs.get(docId);
  if (!binding) return;
  binding.awareness.destroy();
  binding.ydoc.off("update", binding.ydocUpdateHandler);
  if (binding.undoManager) binding.undoManager.destroy();
  binding.ydoc.destroy();
  workspaceRoom.docs.delete(docId);
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
  for (const docId of Array.from(workspaceRoom.docs.keys())) destroyBinding(docId);
  if (workspaceRoom.ws) {
    workspaceRoom.ws.onclose = null;
    workspaceRoom.ws.onerror = null;
    try {
      workspaceRoom.ws.close();
    } catch (e) {
      /* already closed */
    }
  }
  workspaceRoom.workspaceId = null;
  workspaceRoom.ws = null;
  workspaceRoom.activeDocId = null;
  workspaceRoom.role = null;
  workspaceRoom.reconnectDelay = 1000;
  workspaceRepoLinked.set(false);
  myAccessRequestPending.set(false);
  ownerNudgedRemoteIds.clear();
  requestAccessModalOpen.set(false);
  leaveCollabRoom();
}

// The owner deleted this shared workspace (a live MESSAGE_WORKSPACE_DELETED
// frame, or a 410 from the access fetch on reconnect / share-link open).
// Tear down the connection, then: a *mirror* of the owner's workspace is
// removed entirely (deletion is also the owner's tool for cutting off
// access) with a banner; a workspace the user *merged* a share into keeps
// its documents (their own library) and only loses the live link.
function handleWorkspaceGone(localWorkspaceId: string): void {
  const local = get(workspacesStore).find((w) => w.id === localWorkspaceId);
  teardownWorkspace();
  if (!local) return;
  if (local.mirrored) {
    // Drop the workspace record first so removeDocById's docRemovalHook
    // (pushWorkspaceDocDelete) sees no shared workspace and stays a no-op.
    const docIds = get(docsStore)
      .filter((d) => d.workspaceId === local.id)
      .map((d) => d.id);
    deleteWorkspaceRecord(local.id);
    for (const id of docIds) removeDocById(id);
    workspaceAccessDenied.set("deleted");
  } else {
    workspacesStore.update((all) => all.map((w) => (w.id === local.id ? { ...w, shared: undefined, remoteId: undefined, updatedAt: Date.now() } : w)));
    persistWorkspaces();
    showToast(`"${local.name}" is no longer shared — its owner deleted the shared workspace. Your local copy is kept.`, "info");
  }
}

// Applies an incoming MESSAGE_WORKSPACE_META frame: mirrors the sharer's
// real workspace name onto our local copy (matched by remoteId), and
// removes any local document whose id is no longer in the room's
// docOrder — the workspace-level counterpart to how a document's own
// name/content already sync. Runs on every frame, including the one-time
// greeting a freshly-opened connection gets (see WorkspaceRoom.handleSession),
// so a stale local cache never has more than the same brief window every
// other synced field already tolerates before the first real frame lands.
function applyWorkspaceMeta(remoteWorkspaceId: string, name: string, docOrder: string[], repoLinked: boolean): void {
  const local = get(workspacesStore).find((w) => w.remoteId === remoteWorkspaceId);
  if (!local) return;
  workspaceRepoLinked.set(repoLinked);
  if (name) {
    renameWorkspace(local.id, name);
  } else if (!isDefaultWorkspaceName(local.name) && workspaceRoom.role === "editor") {
    // Self-heal a workspace shared before first-share started pushing its
    // name (seedWorkspaceForFirstShare): the room still reports name ""
    // here, so contribute this editor's local name (unless it's a
    // self-assigned default). The server then broadcasts it back as a
    // non-empty frame and every session — this one included — takes the
    // renameWorkspace branch above and settles. A non-editor's PUT would
    // just 403, so the role guard skips the pointless request.
    pushWorkspaceRename(local.id, local.name);
  }
  const orderSet = new Set(docOrder);
  for (const doc of get(docsStore).filter((d) => d.workspaceId === local.id)) {
    if (!orderSet.has(doc.id)) {
      destroyBinding(doc.id);
      removeDocById(doc.id);
    }
  }
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

  if (messageType === MESSAGE_WORKSPACE_META) {
    const name = decoding.readVarString(decoder);
    const count = decoding.readVarUint(decoder);
    const docOrder: string[] = [];
    for (let i = 0; i < count; i++) docOrder.push(decoding.readVarString(decoder));
    // Trailing field — guard the read so an old-server frame without it
    // just defaults to false rather than throwing.
    const repoLinked = decoding.hasContent(decoder) ? decoding.readVarUint(decoder) === 1 : false;
    if (workspaceRoom.workspaceId) applyWorkspaceMeta(workspaceRoom.workspaceId, name, docOrder, repoLinked);
    return;
  }

  if (messageType === MESSAGE_WORKSPACE_DELETED) {
    const remoteId = workspaceRoom.workspaceId;
    const local = remoteId ? get(workspacesStore).find((w) => w.remoteId === remoteId) : null;
    if (local) handleWorkspaceGone(local.id);
    else teardownWorkspace();
    return;
  }

  if (messageType === MESSAGE_ACCESS_REQUEST) {
    const username = decoding.readVarString(decoder);
    decoding.readVarString(decoder); // message — not surfaced in the toast
    if (get(collabIsOwner)) showToast(`${username} requested edit access`, "info");
    return;
  }

  if (messageType === MESSAGE_ACCESS_CHANGED) {
    const remoteId = workspaceRoom.workspaceId;
    const local = remoteId ? get(workspacesStore).find((w) => w.remoteId === remoteId) : null;
    if (local && remoteId) void handleAccessChanged(local, remoteId);
    return;
  }

  const docId = decoding.readVarString(decoder);

  if (messageType === MESSAGE_COMMENTS) {
    // Another collaborator changed this document's comment threads — poke
    // CommentsPanel.svelte to refetch (it decides whether docId is the one
    // currently open). No binding needed; comments aren't in the Y.Doc.
    remoteCommentsChanged.update((s) => ({ docId, n: s.n + 1 }));
    return;
  }

  // A MESSAGE_SYNC frame for a docId we've never seen before means
  // another collaborator created (or first switched to) that document
  // after this session already joined the workspace — see
  // discoverRemoteDocBinding's own comment for why the server always
  // broadcasts this regardless of recipient awareness. A bare
  // MESSAGE_AWARENESS frame for an unrecognized docId is still dropped
  // below: awareness carries no document content to seed a binding
  // with, and the real MESSAGE_SYNC frame introducing the document
  // always arrives too (from that same broadcast), so nothing is lost
  // by waiting for it.
  const isNewToUs = messageType === MESSAGE_SYNC && !workspaceRoom.docs.has(docId);
  const binding = isNewToUs ? discoverRemoteDocBinding(docId) : workspaceRoom.docs.get(docId);
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
    const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, binding.ydoc, "server");
    if (encoding.length(encoder) > baseLength) send(encoding.toUint8Array(encoder));
    // A docId discovered just now is only ever introduced by a
    // content-bearing broadcast (see discoverRemoteDocBinding's own
    // comment) — never the room's own step1 greeting, which only ever
    // targets docs already known at connection time — so this always
    // has real content to import by the time it runs.
    if (isNewToUs) registerDiscoveredDoc(docId, binding);
    // The room's DO always greets a freshly-opened socket with its OWN
    // sync step1 for every doc it already knows about (see
    // WorkspaceRoom.handleSession) — sent unconditionally, before it's
    // even seen this client's own step1. That greeting is what a
    // rejoining client's very first received MESSAGE_SYNC frame usually
    // is: a step1 carries no content, readSyncMessage only writes a
    // reply into `encoder` above (this client's own, still-empty, state)
    // and never touches binding.ydoc. The room's actual content arrives
    // one message later, as its reply to THIS client's own step1 (a
    // step2) or, in principle, a plain update. Treating "any message
    // received" as synced — rather than gating on the message actually
    // being content-bearing — let bindActiveDoc attach yCollab before
    // the real content had arrived, so that next, content-bearing
    // message got forwarded into a CodeMirror view that already showed
    // that same content locally, doubling it. See markDocSynced.
    if (syncMessageType !== syncProtocol.messageYjsSyncStep1) markDocSynced(docId);
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

async function fetchWorkspaceAccess(workspaceId: string): Promise<AccessRecord> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/access`);
    // 410 Gone — the owner deleted the workspace (WorkspaceRoom's `deleted`
    // tombstone). The status is the only signal; the body is a plain string.
    if (res.status === 410) return { ...DEFAULT_ACCESS, deleted: true };
    if (!res.ok) return { ...DEFAULT_ACCESS };
    return { ...DEFAULT_ACCESS, ...(await res.json()) };
  } catch (err) {
    return { ...DEFAULT_ACCESS };
  }
}

// The collaboration room's id for a given local workspace id. A workspace
// this session JOINED has a local id distinct from the room's id — the two
// only coincide for the workspace's original owner, and only once their
// first share has claimed the room (before that, remoteId is undefined and
// the local id IS the id the room will be keyed by, so the ?? fallback is
// correct). Same resolution as wikilink-rename-cascade.ts and, since
// PR #159, CommentsPanel / VersionHistory.
function shareRoomId(workspaceId: string): string {
  const ws = get(workspacesStore).find((w) => w.id === workspaceId);
  return ws?.remoteId ?? workspaceId;
}

export function pushWorkspaceRename(workspaceId: string, name: string): void {
  const ws = get(workspacesStore).find((w) => w.id === workspaceId);
  if (!ws || !ws.shared || !ws.remoteId) return;
  void fetch(`/api/workspace/${encodeURIComponent(ws.remoteId)}/meta`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

// The owner just linked / unlinked the shared workspace's repo — tell the
// room so collaborators (who have no repoLink of their own) can be shown
// that sync is in play. Same shape / gate as pushWorkspaceRename; wired
// via workspaceRepoLinkHook so stores/workspaces.ts needn't import this.
export function pushWorkspaceRepoLinked(workspaceId: string, linked: boolean): void {
  const ws = get(workspacesStore).find((w) => w.id === workspaceId);
  if (!ws || !ws.shared || !ws.remoteId) return;
  void fetch(`/api/workspace/${encodeURIComponent(ws.remoteId)}/meta`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoLinked: linked }),
  });
}

export function pushWorkspaceDocDelete(docId: string, workspaceId: string): void {
  const ws = get(workspacesStore).find((w) => w.id === workspaceId);
  if (!ws || !ws.shared || !ws.remoteId) return;
  // Destroy this session's own binding immediately rather than waiting
  // for the broadcast echo — the deleting session may not even be
  // currently connected via WS (renaming/deleting works regardless, see
  // this feature's "Why HTTP, not WS" design note), and stores/docs.ts's
  // own removeDocById() already dropped the local Doc by the time any
  // echo could arrive anyway.
  destroyBinding(docId);
  void fetch(`/api/workspace/${encodeURIComponent(ws.remoteId)}/docs?docId=${encodeURIComponent(docId)}`, { method: "DELETE" });
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

// Registers a docId with the room over plain HTTP, ahead of ever opening
// the WebSocket. A brand-new room's very first connection is greeted with
// its current docIds synchronously, at accept time — before this client
// has had any chance to introduce itself over the socket at all (its own
// sync-step1 burst only goes out once the socket's own onopen fires,
// which is strictly later). Without this, that first greeting's docOrder
// would still be missing every document that's about to be shared, and
// this same client's own incoming MESSAGE_WORKSPACE_META handling
// (applyWorkspaceMeta) would read that as every one of them having just
// been deleted. Best-effort: on failure, the doc's own step1 sync frame
// still registers it once the socket opens — just without this guard
// against that first-greeting race.
async function registerDocWithRoom(workspaceId: string, docId: string): Promise<void> {
  try {
    await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/docs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docId }),
    });
  } catch (err) {
    /* best-effort, see comment above */
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
      const syncType = syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), scratchDoc, "server");
      // WorkspaceRoom.handleSession greets every new connection with its
      // own SyncStep1 for each document — a frame that asks for *our*
      // state and carries none of the document's own. Finishing on it
      // hands back an empty scratchDoc, i.e. the "Shared document"
      // fallback name and empty content, even for a fully-populated
      // document. Wait for the SyncStep2 reply to our own step1 (or a
      // later Update, or a step1 that only arrives after real state has
      // already landed) before resolving.
      const hasState = !!scratchDoc.getMap<string>("meta").get("name") || scratchDoc.getText("content").length > 0;
      if (syncType === syncProtocol.messageYjsSyncStep1 && !hasState) return;
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

// Exported purely for collab.test.ts's regression tests (the
// join-generation race, and that teardownWorkspace() no longer resets
// identityUnverified — see bb938d9 / COLLAB-31) — not part of any real
// caller's public surface.
export { handleDocChanged, workspaceRoom, teardownWorkspace, handleRepoDocsChanged };

function setupShareUI() {
  // CV2-5 — a viewer/reviewer's greyed Share button is their entry point
  // for "Request edit access" instead of the (owner-only) Share dialog.
  document.getElementById("shareBtn").addEventListener("click", () => {
    if (workspaceRoom.role === "viewer" || workspaceRoom.role === "reviewer") {
      if (get(myAccessRequestPending)) {
        showToast("Your access request is still pending", "info");
        return;
      }
      requestAccessModalOpen.set(true);
      return;
    }
    void openShareModal();
  });

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
        currentAccess = await fetchWorkspaceAccess(shareRoomId(doc.workspaceId));
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

export type JoinDecision = { kind: "auto-permanent"; workspaceName: string } | { kind: "auto-preview"; workspaceName: string } | { kind: "choice" };

// A single shared document is unambiguous — there's nothing meaningful to
// choose between (merge it into an existing workspace, or give it its
// own?). It lands permanently only when the receiver has no workspaces of
// their own — likely their only reason for being here at all, so losing
// it on reload would be worse than today's behavior, and there's no
// existing local library to protect. Otherwise it previews first:
// auto-committing into an existing library is exactly the clutter this
// was built to avoid. A multi-document workspace share gets a real choice
// (including a Preview option — see JoinWorkspaceModal.svelte), except for
// a receiver with zero workspaces, who has nothing to choose between
// either and lands permanently the same way as the single-doc case.
//
// The workspace's real name (remoteWorkspaceName) always wins when the
// room has one — a single-doc share still names the adopted workspace
// after the workspace, not the file. The single-file-name fallback is
// only for a room with no name of its own (a legacy share, or one made
// before first-share pushed the name).
export function decideJoinTarget(validDocs: { name: string }[], existingWorkspaceCount: number, remoteWorkspaceName?: string): JoinDecision {
  const fallbackName = validDocs.length === 1 ? validDocs[0]!.name || "Untitled" : "Shared workspace";
  const workspaceName = remoteWorkspaceName || fallbackName;
  if (existingWorkspaceCount === 0) return { kind: "auto-permanent", workspaceName };
  if (validDocs.length === 1) return { kind: "auto-preview", workspaceName };
  return { kind: "choice" };
}

export async function openShareModal() {
  // CV2-2 backstop — the #shareBtn is greyed in Viewing mode and for a
  // viewer/reviewer (Share.svelte's $effect), but guard here too so a
  // stale click / programmatic call can't open the dialog.
  if (get(effectiveMode) === "viewing" || workspaceRoom.role === "viewer" || workspaceRoom.role === "reviewer") return;
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
  currentAccess = await fetchWorkspaceAccess(shareRoomId(targetWorkspaceId));
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
  const access = await putWorkspaceAccess(shareRoomId(doc.workspaceId), {
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
    // First share of this workspace — seed the new room with every
    // document in it, not just the active one. See the helper's comment.
    await seedWorkspaceForFirstShare(doc);
  }
  if (!wantAnyone && access.invited.length === 0) teardownWorkspace();
  syncShareStores();
  showToast(ACCESS_MODE_TOAST[mode], "info");
  return true;
}

export async function setRole(role: string) {
  const doc = getActiveDoc();
  if (!doc || !currentAccess) return;
  const access = await putWorkspaceAccess(shareRoomId(doc.workspaceId), {
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
  return `${location.origin}/w/${encodeURIComponent(shareRoomId(doc.workspaceId))}/${encodeURIComponent(doc.id)}/${segment}`;
}

// ---------- CV2-5 access-request wrappers ----------
// Thin fetch helpers so the Svelte components don't build URLs — same
// pattern as addPerson / removeInvite.

export async function requestAccessFromOwner(remoteId: string, message: string): Promise<boolean> {
  const res = await fetch(`/api/workspace/${encodeURIComponent(remoteId)}/access-request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (res.ok) myAccessRequestPending.set(true);
  return res.ok;
}

async function respondToAccessRequest(remoteId: string, username: string, body: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`/api/workspace/${encodeURIComponent(remoteId)}/access-request/${encodeURIComponent(username)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    currentAccess = await fetchWorkspaceAccess(remoteId);
    syncShareStores();
  }
  return res.ok;
}

export function approveAccessRequest(remoteId: string, username: string, role: string): Promise<boolean> {
  return respondToAccessRequest(remoteId, username, { action: "approve", role });
}

export function denyAccessRequest(remoteId: string, username: string): Promise<boolean> {
  return respondToAccessRequest(remoteId, username, { action: "deny" });
}

export async function addPerson(rawUsername: string) {
  const username = rawUsername.trim().replace(/^@/, "");
  if (!username) return;
  const doc = getActiveDoc();
  if (!doc) return;
  const existing = currentAccess ? currentAccess.invited : [];
  if (existing.some((p) => p.username === username)) return;
  const invited = [...existing, { username, role: "editor" }];
  const access = await putWorkspaceAccess(shareRoomId(doc.workspaceId), {
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
    // needs to seed it, same as opening general access does — and the
    // same way: every document in the workspace, not just the active one.
    if (!workspaceRoom.workspaceId) {
      await seedWorkspaceForFirstShare(doc);
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
  const access = await putWorkspaceAccess(shareRoomId(doc.workspaceId), {
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
  const access = await putWorkspaceAccess(shareRoomId(doc.workspaceId), {
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
  maybeNudgeOwnerAboutRequests(workspaceRoom.workspaceId);
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
