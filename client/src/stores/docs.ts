// Owns the docs array + active doc id (localStorage-backed) and every
// mutation that touches them. app.ts subscribes to activeIdStore to drive
// the editor (load content, reset undo, update preview/counts) whenever it
// actually changes; collab.ts/gist.ts and the doc-list/menu-bar components
// import the action functions here directly instead of going through
// window.MDE, since none of this needs DOM/CodeMirror access.
import { get, writable } from "svelte/store";
import type { Doc, Note } from "../types";
import { showToast } from "./toast";
import { deleteHistory } from "../history";
import { confirmAction } from "./confirmDialog";
import { relocateAnchor } from "../anchor";
import { ensureUniqueName, nextAvailableName } from "../doc-naming";
import { activeWorkspaceIdStore, workspacesStore, switchWorkspace, createWorkspace, queueRepoDeletion } from "./workspaces";
import { mergeById } from "../merge-records";

const STORAGE_DOCS = "mde:docs";
const STORAGE_ACTIVE = "mde:active";

// Fixes up two things that could exist in storage from before this
// feature: duplicate names (wikilinks need exact-match resolution to
// stay unambiguous) and a missing createdAt (backfilled from
// updatedAt, the closest available approximation). Deterministic given
// the stored array's order, so re-running it on every load without
// persisting the result immediately is safe — it converges to the same
// output every time until the next real save writes it back for good.
function normalizeLoadedDocs(docs: Doc[]): Doc[] {
  const seen = new Set<string>();
  // The OLDEST workspace by createdAt, not workspacesStore[0] — that
  // array is newest-first (createWorkspace prepends), so [0] would be
  // the most recently created workspace rather than the original
  // default one a pre-workspace user's documents actually belong to.
  // Matches the same fallback-by-createdAt pattern deleteWorkspaceRecord
  // already uses in workspaces.ts.
  const fallbackWorkspaceId = [...get(workspacesStore)].sort((a, b) => a.createdAt - b.createdAt)[0]?.id ?? "";
  return docs.map((d) => {
    const name = nextAvailableName(d.name || "Untitled", seen);
    seen.add(name);
    return { ...d, name, createdAt: d.createdAt ?? d.updatedAt, workspaceId: d.workspaceId ?? fallbackWorkspaceId };
  });
}

// Set by loadDocsFromStorage (below) whenever normalizeLoadedDocs actually
// had to backfill a missing workspaceId onto at least one loaded doc.
// normalizeLoadedDocs itself stays pure/side-effect-free (it's also
// exercised in isolation from tests) — the actual persistence of that
// backfill happens once, right after docsStore is constructed below.
let neededWorkspaceBackfill = false;

function loadDocsFromStorage(): Doc[] {
  try {
    const raw = localStorage.getItem(STORAGE_DOCS);
    if (raw) {
      const parsed = JSON.parse(raw) as Doc[];
      neededWorkspaceBackfill = Array.isArray(parsed) && parsed.some((d) => !d.workspaceId);
      // Legacy documents (from before workspaces existed) with no
      // workspace to backfill onto — mde:workspaces was never set,
      // meaning this profile hasn't opened the app since workspaces
      // shipped. Create one so normalizeLoadedDocs has somewhere real to
      // backfill onto instead of silently orphaning these documents.
      if (neededWorkspaceBackfill && get(workspacesStore).length === 0) createWorkspace("My Workspace");
      return normalizeLoadedDocs(parsed);
    }
  } catch (e) { /* ignore corrupt storage */ }
  // No seeded Welcome doc — a brand-new visitor (or someone who deletes
  // every document) sees the empty state instead, same as VS Code with no
  // folder/file open.
  return [];
}

function initialActiveId(docs: Doc[]): string | null {
  const activeWorkspaceId = get(activeWorkspaceIdStore);
  const stored = localStorage.getItem(STORAGE_ACTIVE);
  const storedDoc = stored ? docs.find((d) => d.id === stored) : undefined;
  // The stored id only counts if it's still in the currently-active
  // workspace — otherwise (e.g. the last-active doc was in a workspace
  // that's now empty/switched away from) fall back to *some* doc in the
  // active workspace rather than docs[0], which could belong to any
  // workspace at all (docsStore is newest-first). Mirrors getActiveDoc()'s
  // own workspace-scoped fallback just below.
  if (storedDoc && storedDoc.workspaceId === activeWorkspaceId) return storedDoc.id;
  return docs.find((d) => d.workspaceId === activeWorkspaceId)?.id ?? null;
}

const initialDocs = loadDocsFromStorage();

export const docsStore = writable<Doc[]>(initialDocs);
export const activeIdStore = writable<string | null>(initialActiveId(initialDocs));

// Persist immediately if normalizeLoadedDocs had to backfill a missing
// workspaceId onto any loaded doc — otherwise that backfill only ever
// lives in memory until some unrelated save happens to fire, which may
// never occur before a workspace-count change reshuffles which workspace
// would be picked as the fallback on the next load. persistDocs (defined
// below) is a hoisted function declaration, safe to call here.
if (neededWorkspaceBackfill) persistDocs();

// The active doc's live CodeMirror content, pushed on every editor change
// (undebounced) by app.ts's update listener — doc.content itself only
// syncs from CodeMirror on the debounced save (see saveActiveDocContent),
// which would make DocList.svelte's per-row heading outline lag ~400ms
// behind typing for whichever doc is currently open. Doubles as this
// module's read source for "what's currently in the editor buffer" so
// saveActiveDocContent doesn't need a bridge dependency back into
// app.ts/CodeMirror.
export const activeDocContent = writable("");

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function getActiveDoc(): Doc | undefined {
  const docs = get(docsStore);
  const activeId = get(activeIdStore);
  const found = docs.find((d) => d.id === activeId);
  if (found) return found;
  const activeWorkspaceId = get(activeWorkspaceIdStore);
  return docs.find((d) => d.workspaceId === activeWorkspaceId);
}

export function findDocById(id: string): Doc | undefined {
  return get(docsStore).find((d) => d.id === id);
}

// Deletion goes through this instead of persistDocs() directly: a plain
// merge can't tell "this id is missing from docsStore because another tab
// never told me about it" apart from "this id is missing because THIS tab
// just deleted it" — both look identical (absent from current, present in
// whatever's still in localStorage). Explicitly excluding deletedIds from
// the external side too means a delete always wins for this tab, instead
// of the merge resurrecting it from a pre-deletion snapshot on the very
// save that's supposed to record the deletion.
function persistDocsExcluding(deletedIds: Set<string>) {
  try {
    const raw = localStorage.getItem(STORAGE_DOCS);
    const external = raw ? (JSON.parse(raw) as Doc[]).filter((d) => !deletedIds.has(d.id)) : [];
    const merged = mergeById(get(docsStore), external);
    docsStore.set(merged);
    localStorage.setItem(STORAGE_DOCS, JSON.stringify(merged));
  } catch (e) {
    // Most commonly a full storage quota (large embedded images) — this
    // used to fail silently, leaving the in-memory doc looking "saved"
    // (the status pill doesn't know the write itself failed) while
    // nothing actually persisted.
    showToast("Couldn't save — your browser's local storage may be full", "error");
  }
}

export function persistDocs() {
  // Read fresh instead of trusting this tab's own possibly-stale copy —
  // another tab may have saved since this tab last loaded. Merging
  // (rather than overwriting) is what stops a save in one tab from
  // silently destroying a document another tab created or edited.
  persistDocsExcluding(new Set());
}

function setActiveId(id: string | null) {
  activeIdStore.set(id);
  if (id) localStorage.setItem(STORAGE_ACTIVE, id);
  else localStorage.removeItem(STORAGE_ACTIVE);
}

function updateDoc(id: string, changes: Partial<Doc>) {
  docsStore.update((docs) => docs.map((d) => (d.id === id ? { ...d, ...changes } : d)));
}

// True key-set-and-value equality regardless of insertion order — Y.Map's
// own .entries() iteration order has no guaranteed relationship to the
// order doc.images' keys were originally inserted in, so a naive
// JSON.stringify comparison could report "changed" for genuinely
// identical image sets and bump updatedAt for no real reason.
function sameImages(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const aEntries = Object.entries(a ?? {});
  const bMap = b ?? {};
  if (aEntries.length !== Object.keys(bMap).length) return false;
  return aEntries.every(([key, value]) => bMap[key] === value);
}

// Writes a shared workspace's background (non-active) document content
// back into docsStore. Called by collab.ts for every document in a
// shared workspace that isn't the one currently open — the active
// document's content already flows through activeDocContent ->
// saveActiveDocContent instead, so this only ever runs for documents the
// user isn't looking at right now. Mirrors saveActiveDocContent's "don't
// bump updatedAt unless something actually changed" rule: a collaborator
// really editing a document is a real modification and should bump it
// the same way a local edit would, but reconnecting/resyncing identical
// content must not.
export function syncRemoteDocContent(id: string, content: string, images: Record<string, string> | undefined): boolean {
  const doc = findDocById(id);
  if (!doc) return false;
  const contentChanged = content !== doc.content;
  const imagesChanged = !sameImages(images, doc.images);
  if (!contentChanged && !imagesChanged) return false;
  updateDoc(id, { content, images, updatedAt: Date.now() });
  return true;
}

// Flushes the live editor buffer into the active doc's content, without
// touching the editor or any save-status UI — callers that need the
// visible status pill updated do that themselves afterward (see app.ts's
// saveNow()), since this module has no DOM access.
export function saveActiveDocContent() {
  const doc = getActiveDoc();
  if (!doc) return;
  const content = get(activeDocContent);
  // Merely opening/switching away from a document with no pending edit
  // must not bump updatedAt — it should only ever reflect a real
  // modification. switchDoc() calls this on every switch regardless of
  // whether anything actually changed, so this check is what makes that
  // distinction instead of the debounced-save path. Same rule
  // syncRemoteDocContent (below) applies for remote/collaborator edits.
  if (content === doc.content) return;
  updateDoc(doc.id, { content, updatedAt: Date.now() });
  persistDocs();
}

export function createDoc(partial?: Partial<Doc> & { id?: string; name?: string }): Doc {
  saveActiveDocContent();
  // Every real entry point (sidebar "+", File > New, import-from-device,
  // Open-from-Gist, Link Workspace to Repo) now guards against zero
  // workspaces before ever calling this — see app.ts's createNewDoc/
  // openLocalFile, gist.ts's openGistPicker, repo-sync-ui.ts's
  // openRepoLinkModal. This fallback should be unreachable in normal
  // operation; it's kept as a defensive last resort so a missed guard
  // produces a usable workspace instead of silently stamping "" — which
  // DocList's `d.workspaceId === $activeWorkspaceIdStore` filter can
  // never match, orphaning the doc invisibly.
  let workspaceId = get(activeWorkspaceIdStore) ?? get(workspacesStore)[0]?.id;
  if (!workspaceId) workspaceId = createWorkspace("My Workspace").id;
  const doc: Doc = Object.assign(
    { id: uid(), name: "Untitled", content: "", updatedAt: Date.now(), createdAt: Date.now(), workspaceId },
    partial
  );
  doc.name = ensureUniqueName(doc.name, get(docsStore));
  docsStore.update((docs) => [doc, ...docs]);
  setActiveId(doc.id);
  persistDocs();
  return doc;
}

// Merges a shared workspace's document list into a local workspace —
// used both by the "merge into an existing workspace" join choice and by
// "add as a new workspace" (against the freshly-created empty workspace).
// Name collisions go through the same silent-suffix primitive used
// everywhere else in the app (create/rename/duplicate) rather than new
// conflict-resolution UI, per the design spec's Non-goals — and, like
// every other caller of that primitive (createDoc, findCollidingDoc),
// checked against every document in the app, not just this workspace's:
// document names are a global-uniqueness invariant here, not a
// per-workspace one.
export function importRemoteDocs(workspaceId: string, remoteDocs: Pick<Doc, "id" | "name" | "content" | "updatedAt" | "createdAt">[]): void {
  docsStore.update((docs) => {
    const seen = new Set(docs.map((d) => d.name));
    const added = remoteDocs.map((rd) => {
      const name = nextAvailableName(rd.name || "Untitled", seen);
      seen.add(name);
      return { ...rd, name, workspaceId, shared: undefined } as Doc;
    });
    return [...added, ...docs];
  });
  persistDocs();
}

// Returns whether the switch actually happened (false if `id` was already
// active) — callers with extra UI to run only on a real switch (e.g.
// collapsing the sidebar on mobile) branch on this instead of duplicating
// the guard themselves.
//
// This is the single choke point for cross-workspace document navigation
// (wikilink resolution/autocomplete, Command Palette, File > Recent,
// backlinks panel, shared-link join, etc. — every one of them ends up
// calling this, directly or via window.MDE.switchDoc). None of those
// callers know or care which workspace their target document lives in,
// so if it's not in the currently-active workspace, follow it there first
// — otherwise activeId and activeWorkspaceId end up desynchronized (the
// editor shows the doc, but the sidebar/switcher still show the old
// workspace, whose doc list filters the newly-active doc out entirely).
export function switchDoc(id: string): boolean {
  if (id === get(activeIdStore)) return false;
  saveActiveDocContent();
  const target = findDocById(id);
  if (target && target.workspaceId !== get(activeWorkspaceIdStore)) switchWorkspace(target.workspaceId);
  setActiveId(id);
  return true;
}

// Non-confirming delete primitive — shared by deleteDoc() (which
// confirms first) and RenameCollisionModal.svelte's Replace action
// (where the modal itself is already the confirmation). Exported so
// that component can call it directly.
export function removeDocById(id: string) {
  const removedDoc = findDocById(id);
  const removedWorkspaceId = removedDoc?.workspaceId;
  // The doc is about to be gone for good — this is the last moment
  // anything knows what repo file it used to correspond to, so queue it
  // now for repo-sync.ts's planPush to delete on the next push.
  if (removedDoc?.repoPath && removedWorkspaceId) queueRepoDeletion(removedWorkspaceId, removedDoc.repoPath);
  docsStore.update((docs) => docs.filter((d) => d.id !== id));
  // Deleting the last remaining doc leaves docs empty and activeId null —
  // the reactive editor subscription shows the empty state rather than
  // force-creating a placeholder "Untitled" doc.
  if (get(activeIdStore) === id) {
    const remaining = get(docsStore).filter((d) => d.workspaceId === removedWorkspaceId);
    setActiveId(remaining[0] ? remaining[0].id : null);
  }
  persistDocsExcluding(new Set([id]));
  void deleteHistory(id);
}

export async function deleteDoc(id: string): Promise<Doc | undefined> {
  const doc = findDocById(id);
  if (!doc) return undefined;
  if (!(await confirmAction(`Delete "${doc.name || "Untitled"}"?`, "This can't be undone."))) return undefined;
  removeDocById(id);
  showToast(`Deleted "${doc.name || "Untitled"}"`, "success");
  return doc;
}

// Used by app.ts's docTitle blur handler to decide whether a
// deliberate rename needs RenameCollisionModal instead of committing
// directly.
export function findCollidingDoc(id: string, name: string): Doc | undefined {
  return get(docsStore).find((d) => d.id !== id && d.name === name);
}

// Doc-row "..." menu action (DocList.svelte) — not a rename/edit, a full
// copy, same as Google Docs' tab context menu's "Duplicate".
export function duplicateDoc(id: string): Doc | undefined {
  if (!findDocById(id)) return undefined;
  saveActiveDocContent();
  const source = findDocById(id)!; // re-read: saveActiveDocContent may have just updated it
  const name = ensureUniqueName(`${source.name || "Untitled"} (copy)`, get(docsStore));
  const copy: Doc = { ...source, id: uid(), name, updatedAt: Date.now(), createdAt: Date.now() };
  // A duplicate is a fresh, unshared, unpublished document — it must not
  // carry over the room/gist identity of the doc it was copied from.
  delete copy.shared;
  delete copy.gistId;
  docsStore.update((docs) => [copy, ...docs]);
  setActiveId(copy.id);
  persistDocs();
  showToast(`Duplicated as "${copy.name}"`, "success");
  return copy;
}

// Not persisted immediately — the debounced autosave (app.ts's
// scheduleSave, triggered by the same input handler that calls this)
// picks it up along with content, same as before this doc-state move.
export function renameDoc(id: string, name: string) {
  updateDoc(id, { name: name || "Untitled" });
}

// The doc's own id doubles as its collab room id (see collab.ts) — this
// just tracks locally whether the doc has ever been shared, so
// switching to/loading it knows whether to attempt rejoining the room.
export function markActiveDocShared(shared: boolean): Doc | undefined {
  const doc = getActiveDoc();
  if (!doc) return undefined;
  updateDoc(doc.id, { shared: shared || undefined, updatedAt: Date.now() });
  persistDocs();
  return findDocById(doc.id);
}

// filename is the exact name the gist itself knows this file by —
// callers (gist.ts) must keep passing the same value back on every
// subsequent update unless they've deliberately renamed the gist file
// itself (see gistFilename's own comment in types.ts for why).
export function setActiveDocGistId(gistId: string, filename: string): Doc | undefined {
  const doc = getActiveDoc();
  if (!doc) return undefined;
  updateDoc(doc.id, { gistId, gistFilename: filename, updatedAt: Date.now() });
  persistDocs();
  return findDocById(doc.id);
}

// Called when a gist operation 404s — the gist was deleted outside
// this app (there's no other way for it to stop existing), and
// without this the app kept treating the document as linked forever,
// with no way to notice or clear it short of editing localStorage by
// hand.
export function clearActiveDocGist(): Doc | undefined {
  const doc = getActiveDoc();
  if (!doc) return undefined;
  updateDoc(doc.id, { gistId: undefined, gistFilename: undefined });
  persistDocs();
  return findDocById(doc.id);
}

export function setDocImage(key: string, dataUrl: string) {
  const doc = getActiveDoc();
  if (!doc) return;
  updateDoc(doc.id, { images: { ...(doc.images || {}), [key]: dataUrl } });
  persistDocs();
}

// Full replace, not a per-key merge (setDocImage's behavior) — used when
// restoring a historical version, which must leave the doc's images
// looking exactly like that version did, not layer its images on top of
// whatever the doc currently has.
export function replaceDocImages(docId: string, images: Record<string, string> | undefined) {
  updateDoc(docId, { images });
  persistDocs();
}

export function deleteDocImage(key: string) {
  const doc = getActiveDoc();
  if (!doc || !doc.images) return;
  const images = { ...doc.images };
  delete images[key];
  updateDoc(doc.id, { images });
  persistDocs();
}

export function setDocDiagram(key: string, code: string) {
  const doc = getActiveDoc();
  if (!doc) return;
  updateDoc(doc.id, { diagrams: { ...(doc.diagrams || {}), [key]: code } });
  persistDocs();
}

export function deleteDocDiagram(key: string) {
  const doc = getActiveDoc();
  if (!doc || !doc.diagrams) return;
  const diagrams = { ...doc.diagrams };
  delete diagrams[key];
  updateDoc(doc.id, { diagrams });
  persistDocs();
}

export function addDocNote(from: number, to: number, quote: string, body: string): Note | undefined {
  const doc = getActiveDoc();
  if (!doc) return undefined;
  const note: Note = { id: uid(), from, to, quote, orphaned: false, body, createdAt: Date.now() };
  updateDoc(doc.id, { notes: [...(doc.notes || []), note] });
  persistDocs();
  return note;
}

export function deleteDocNote(noteId: string) {
  const doc = getActiveDoc();
  if (!doc || !doc.notes) return;
  updateDoc(doc.id, { notes: doc.notes.filter((n) => n.id !== noteId) });
  persistDocs();
}

// Merges a repo-linked doc's companion history file (fetched by
// repo-history-sync.ts) into this device's notes — union by id, added
// notes appended, existing ones left untouched. A note's from/to/quote
// gets relocated at display time (CommentsPanel.svelte already calls
// relocateAnchor on every render), so a merged note needs no special
// position handling here.
export function mergeDocNotes(docId: string, remoteNotes: Note[]): void {
  const doc = findDocById(docId);
  if (!doc) return;
  const existingIds = new Set((doc.notes || []).map((n) => n.id));
  const toAdd = remoteNotes.filter((n) => !existingIds.has(n.id));
  if (toAdd.length === 0) return;
  updateDoc(docId, { notes: [...(doc.notes || []), ...toAdd] });
  persistDocs();
}

// Called from app.ts's saveNow() for documents that have never been
// shared — keeps stored positions from drifting too far out of date, so
// relocateAnchor's ambiguous-quote tiebreak stays accurate over many
// edits. The active document's *displayed* anchor positions are always
// recomputed fresh via relocateAnchor() wherever they're shown (see
// CommentsPanel.svelte), so this is a background-accuracy refresh, not
// something the UI depends on for correctness.
export function refreshDocNoteAnchors(content: string) {
  const doc = getActiveDoc();
  if (!doc || !doc.notes || doc.notes.length === 0) return;
  const notes = doc.notes.map((n) => {
    const relocated = relocateAnchor(content, n);
    if (!relocated) return { ...n, orphaned: true };
    return { ...n, from: relocated.from, to: relocated.to, orphaned: false };
  });
  updateDoc(doc.id, { notes });
  persistDocs();
}

// Called after switching/deleting the active workspace (see
// WorkspaceSwitcher.svelte) or moving the active document out of its
// workspace (see DocList.svelte) — the previously-active document may
// not belong to the target workspace, in which case fall back to that
// workspace's own most-recently-updated document, or the empty state
// (null) if it has none. No-op if the active doc already belongs there.
export function ensureActiveDocInWorkspace(workspaceId: string) {
  const docs = get(docsStore);
  const activeId = get(activeIdStore);
  if (docs.find((d) => d.id === activeId)?.workspaceId === workspaceId) return;
  saveActiveDocContent();
  const inWorkspace = [...docs].filter((d) => d.workspaceId === workspaceId).sort((a, b) => b.updatedAt - a.updatedAt);
  setActiveId(inWorkspace[0] ? inWorkspace[0].id : null);
}

// Doc-row "..." menu action (DocList.svelte) — moves a document to a
// different workspace in place.
export function moveDocToWorkspace(id: string, workspaceId: string) {
  updateDoc(id, { workspaceId });
  persistDocs();
}

export function docsInWorkspace(workspaceId: string): Doc[] {
  return get(docsStore).filter((d) => d.workspaceId === workspaceId);
}

export function upsertDocFromRepo(
  workspaceId: string,
  repoPath: string,
  data: {
    name: string;
    content: string;
    images?: Record<string, string>;
    diagrams?: Record<string, string>;
    repoSha: string;
    repoImageShas?: Record<string, string>;
  }
): void {
  const existing = docsInWorkspace(workspaceId).find((d) => d.repoPath === repoPath);
  if (existing) {
    updateDoc(existing.id, {
      content: data.content,
      images: data.images,
      diagrams: data.diagrams,
      repoSha: data.repoSha,
      repoImageShas: data.repoImageShas,
      updatedAt: Date.now(),
    });
  } else {
    const doc: Doc = {
      id: uid(),
      name: data.name,
      content: data.content,
      images: data.images,
      diagrams: data.diagrams,
      updatedAt: Date.now(),
      createdAt: Date.now(),
      workspaceId,
      repoPath,
      repoSha: data.repoSha,
      repoImageShas: data.repoImageShas,
    };
    doc.name = ensureUniqueName(doc.name, get(docsStore));
    docsStore.update((docs) => [doc, ...docs]);
  }
  persistDocs();
}

export function removeDocsByRepoPaths(workspaceId: string, repoPaths: string[]): void {
  const paths = new Set(repoPaths);
  const toRemove = docsInWorkspace(workspaceId).filter((d) => d.repoPath && paths.has(d.repoPath));
  for (const doc of toRemove) removeDocById(doc.id);
}

export function setDocRepoLinkById(id: string, repoPath: string, repoSha: string, repoImageShas: Record<string, string> | undefined): void {
  updateDoc(id, { repoPath, repoSha, repoImageShas });
  persistDocs();
}

// Called by linkWorkspaceAndSync (repo-sync.ts) whenever a workspace is
// freshly linked — a workspace previously linked to a *different* repo
// could still carry repoPath/repoSha values from that old repo, and
// comparing those stale SHAs against the new repo's tree would produce a
// false push conflict on what's really a first sync to the new repo.
export function clearRepoSyncMetadata(workspaceId: string): void {
  for (const doc of docsInWorkspace(workspaceId)) {
    updateDoc(doc.id, { repoPath: undefined, repoSha: undefined, repoImageShas: undefined });
  }
  persistDocs();
}
