// Owns the docs array + active doc id (localStorage-backed) and every
// mutation that touches them. app.ts subscribes to activeIdStore to drive
// the editor (load content, reset undo, update preview/counts) whenever it
// actually changes; collab.ts/gist.ts and the doc-list/menu-bar components
// import the action functions here directly instead of going through
// window.MDE, since none of this needs DOM/CodeMirror access.
import { get, writable } from "svelte/store";
import type { Doc } from "../types";
import { showToast } from "./toast";

const STORAGE_DOCS = "mde:docs";
const STORAGE_ACTIVE = "mde:active";

function loadDocsFromStorage(): Doc[] {
  try {
    const raw = localStorage.getItem(STORAGE_DOCS);
    if (raw) return JSON.parse(raw);
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
  return docs.find((d) => d.id === activeId) || docs[0];
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
  updateDoc(doc.id, { content: get(activeDocContent), updatedAt: Date.now() });
  persistDocs();
}

export function createDoc(partial?: Partial<Doc> & { id?: string; name?: string }): Doc {
  saveActiveDocContent();
  const doc: Doc = Object.assign({ id: uid(), name: "Untitled", content: "", updatedAt: Date.now() }, partial);
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

export function deleteDoc(id: string): Doc | undefined {
  const doc = findDocById(id);
  if (!doc) return undefined;
  if (!confirm(`Delete "${doc.name}"? This can't be undone.`)) return undefined;
  docsStore.update((docs) => docs.filter((d) => d.id !== id));
  // Deleting the last remaining doc leaves docs empty and activeId null —
  // the reactive editor subscription shows the empty state rather than
  // force-creating a placeholder "Untitled" doc.
  if (get(activeIdStore) === id) {
    const remaining = get(docsStore);
    setActiveId(remaining[0] ? remaining[0].id : null);
  }
  persistDocs();
  showToast(`Deleted "${doc.name || "Untitled"}"`, "success");
  return doc;
}

// Doc-row "..." menu action (DocList.svelte) — not a rename/edit, a full
// copy, same as Google Docs' tab context menu's "Duplicate".
export function duplicateDoc(id: string): Doc | undefined {
  if (!findDocById(id)) return undefined;
  saveActiveDocContent();
  const source = findDocById(id)!; // re-read: saveActiveDocContent may have just updated it
  const copy: Doc = { ...source, id: uid(), name: `${source.name || "Untitled"} (copy)`, updatedAt: Date.now() };
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

export function setActiveDocGistId(gistId: string): Doc | undefined {
  const doc = getActiveDoc();
  if (!doc) return undefined;
  updateDoc(doc.id, { gistId, updatedAt: Date.now() });
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
