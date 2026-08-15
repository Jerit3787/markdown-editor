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
import { activeWorkspaceIdStore, workspacesStore } from "./workspaces";

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
  // Always exists — workspaces.ts guarantees at least one workspace on
  // first-ever run, which is the only time a doc can be missing
  // workspaceId in the first place (see workspaces.ts's own comment).
  const fallbackWorkspaceId = get(workspacesStore)[0]?.id ?? "";
  return docs.map((d) => {
    const name = nextAvailableName(d.name || "Untitled", seen);
    seen.add(name);
    return { ...d, name, createdAt: d.createdAt ?? d.updatedAt, workspaceId: d.workspaceId ?? fallbackWorkspaceId };
  });
}

function loadDocsFromStorage(): Doc[] {
  try {
    const raw = localStorage.getItem(STORAGE_DOCS);
    if (raw) return normalizeLoadedDocs(JSON.parse(raw));
  } catch (e) { /* ignore corrupt storage */ }
  // No seeded Welcome doc — a brand-new visitor (or someone who deletes
  // every document) sees the empty state instead, same as VS Code with no
  // folder/file open.
  return [];
}

function initialActiveId(docs: Doc[]): string | null {
  const stored = localStorage.getItem(STORAGE_ACTIVE);
  if (stored && docs.find((d) => d.id === stored)) return stored;
  return docs[0] ? docs[0].id : null;
}

const initialDocs = loadDocsFromStorage();

export const docsStore = writable<Doc[]>(initialDocs);
export const activeIdStore = writable<string | null>(initialActiveId(initialDocs));
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

export function persistDocs() {
  try {
    localStorage.setItem(STORAGE_DOCS, JSON.stringify(get(docsStore)));
  } catch (e) {
    // Most commonly a full storage quota (large embedded images) — this
    // used to fail silently, leaving the in-memory doc looking "saved"
    // (the status pill doesn't know the write itself failed) while
    // nothing actually persisted.
    showToast("Couldn't save — your browser's local storage may be full", "error");
  }
}

function setActiveId(id: string | null) {
  activeIdStore.set(id);
  if (id) localStorage.setItem(STORAGE_ACTIVE, id);
  else localStorage.removeItem(STORAGE_ACTIVE);
}

function updateDoc(id: string, changes: Partial<Doc>) {
  docsStore.update((docs) => docs.map((d) => (d.id === id ? { ...d, ...changes } : d)));
}

// Flushes the live editor buffer into the active doc's content, without
// touching the editor or any save-status UI — callers that need the
// visible status pill updated do that themselves afterward (see app.ts's
// saveNow()), since this module has no DOM access.
export function saveActiveDocContent() {
  const doc = getActiveDoc();
  if (!doc) return;
  const content = get(activeDocContent);
  // Merely opening/switching away from a document with no pending
  // edit must not bump updatedAt — DocList.svelte sorts by it, and
  // navigation alone shouldn't reorder the sidebar (only a real edit
  // should). switchDoc() calls this on every switch regardless of
  // whether anything actually changed, so this check is what makes
  // that distinction instead of the debounced-save path.
  if (content === doc.content) return;
  updateDoc(doc.id, { content, updatedAt: Date.now() });
  persistDocs();
}

export function createDoc(partial?: Partial<Doc> & { id?: string; name?: string }): Doc {
  saveActiveDocContent();
  const workspaceId = get(activeWorkspaceIdStore) ?? get(workspacesStore)[0]?.id ?? "";
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

// Returns whether the switch actually happened (false if `id` was already
// active) — callers with extra UI to run only on a real switch (e.g.
// collapsing the sidebar on mobile) branch on this instead of duplicating
// the guard themselves.
export function switchDoc(id: string): boolean {
  if (id === get(activeIdStore)) return false;
  saveActiveDocContent();
  setActiveId(id);
  return true;
}

// Non-confirming delete primitive — shared by deleteDoc() (which
// confirms first) and RenameCollisionModal.svelte's Replace action
// (where the modal itself is already the confirmation). Exported so
// that component can call it directly.
export function removeDocById(id: string) {
  const removedWorkspaceId = findDocById(id)?.workspaceId;
  docsStore.update((docs) => docs.filter((d) => d.id !== id));
  // Deleting the last remaining doc leaves docs empty and activeId null —
  // the reactive editor subscription shows the empty state rather than
  // force-creating a placeholder "Untitled" doc.
  if (get(activeIdStore) === id) {
    const remaining = get(docsStore).filter((d) => d.workspaceId === removedWorkspaceId);
    setActiveId(remaining[0] ? remaining[0].id : null);
  }
  persistDocs();
  void deleteHistory(id);
}

export async function deleteDoc(id: string): Promise<Doc | undefined> {
  const doc = findDocById(id);
  if (!doc) return undefined;
  if (!(await confirmAction(`Delete "${doc.name}"? This can't be undone.`))) return undefined;
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
