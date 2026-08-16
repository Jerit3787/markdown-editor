// Owns workspaces + which one is active (localStorage-backed). Deliberately
// has NO dependency on docs.ts — every place that needs to coordinate "which
// workspace is active" with "which document is active" does so from the
// calling component (WorkspaceSwitcher.svelte, DocList.svelte), not from
// either store reaching into the other. docs.ts depends on this module (one
// direction only) to stamp/backfill workspaceId on documents — see its own
// comments.
import { get, writable } from "svelte/store";
import type { Workspace } from "../types";
import { showToast } from "./toast";

const STORAGE_WORKSPACES = "mde:workspaces";
const STORAGE_ACTIVE_WORKSPACE = "mde:activeWorkspace";

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// null (as opposed to []) means the key has genuinely never been set —
// the signal for "first run, seed a default workspace" below. Once a
// real value (even []) has been persisted, an empty array is respected
// as-is: the user deliberately deleted their last workspace (see
// deleteWorkspaceRecord's own comment on why that's allowed).
function loadWorkspacesFromStorage(): Workspace[] | null {
  const raw = localStorage.getItem(STORAGE_WORKSPACES);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

const storedWorkspaces = loadWorkspacesFromStorage();
// First-ever run (brand new visitor, or an existing user upgrading —
// either way nothing under STORAGE_WORKSPACES yet) always gets exactly
// one workspace to start in. docs.ts's own migration (normalizeLoadedDocs)
// backfills any pre-existing documents onto this same workspace, keyed
// off the same "was mde:docs already normalized" signal — see its
// comment for how the two stay in sync without importing each other.
const initialWorkspaces: Workspace[] =
  storedWorkspaces === null ? [{ id: uid(), name: "My Workspace", createdAt: Date.now() }] : storedWorkspaces;

export const workspacesStore = writable<Workspace[]>(initialWorkspaces);

function initialActiveWorkspaceId(workspaces: Workspace[]): string | null {
  const stored = localStorage.getItem(STORAGE_ACTIVE_WORKSPACE);
  if (stored && workspaces.find((w) => w.id === stored)) return stored;
  return workspaces[0] ? workspaces[0].id : null;
}

export const activeWorkspaceIdStore = writable<string | null>(initialActiveWorkspaceId(initialWorkspaces));

export function persistWorkspaces() {
  try {
    localStorage.setItem(STORAGE_WORKSPACES, JSON.stringify(get(workspacesStore)));
  } catch (e) {
    showToast("Couldn't save — your browser's local storage may be full", "error");
  }
}

// Persist immediately if this was a first-run seed — otherwise a visitor
// who never explicitly touches workspace UI would keep re-deriving "My
// Workspace" from `null` on every load instead of it becoming real,
// durable storage.
if (storedWorkspaces === null) persistWorkspaces();

function setActiveWorkspaceId(id: string | null) {
  activeWorkspaceIdStore.set(id);
  if (id) localStorage.setItem(STORAGE_ACTIVE_WORKSPACE, id);
  else localStorage.removeItem(STORAGE_ACTIVE_WORKSPACE);
}

export function createWorkspace(name: string): Workspace {
  const ws: Workspace = { id: uid(), name, createdAt: Date.now() };
  workspacesStore.update((all) => [ws, ...all]);
  setActiveWorkspaceId(ws.id);
  persistWorkspaces();
  return ws;
}

// Opening a shared workspace link for the first time and choosing "add as
// a new workspace" — creates a fresh local Workspace record pointed at the
// remote room, distinct from anything the user already has.
export function adoptSharedWorkspace(remoteId: string, name: string): Workspace {
  const ws: Workspace = { id: uid(), name, createdAt: Date.now(), shared: true, remoteId };
  workspacesStore.update((all) => [ws, ...all]);
  setActiveWorkspaceId(ws.id);
  persistWorkspaces();
  return ws;
}

// Opening a shared workspace link and choosing "merge into an existing
// workspace" — the chosen local workspace keeps its own id/name but
// starts pointing at the remote room too.
export function mergeSharedWorkspaceInto(workspaceId: string, remoteId: string): void {
  workspacesStore.update((all) => all.map((w) => (w.id === workspaceId ? { ...w, shared: true, remoteId } : w)));
  persistWorkspaces();
}

export function setWorkspaceRepoLink(id: string, repoLink: { owner: string; repo: string; branch: string }): void {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, repoLink } : w)));
  persistWorkspaces();
}

export function clearWorkspaceRepoLink(id: string): void {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, repoLink: undefined } : w)));
  persistWorkspaces();
}

export function renameWorkspace(id: string, name: string) {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, name: name || "Untitled workspace" } : w)));
  persistWorkspaces();
}

// Returns whether the switch actually happened (false if `id` was
// already active) — mirrors docs.ts's switchDoc(). Does NOT touch which
// document is active; the caller (WorkspaceSwitcher.svelte) calls
// docs.ts's ensureActiveDocInWorkspace() right after — see Task 3.
export function switchWorkspace(id: string): boolean {
  if (id === get(activeWorkspaceIdStore)) return false;
  setActiveWorkspaceId(id);
  return true;
}

// Does NOT delete the workspace's documents itself, and does NOT fix up
// the active document — both are the caller's job (WorkspaceSwitcher.svelte,
// Task 3), since deleting documents means calling docs.ts's
// removeDocById(), and this module can't import docs.ts (see the
// module-doc comment above).
export function deleteWorkspaceRecord(id: string) {
  const remaining = get(workspacesStore).filter((w) => w.id !== id);
  workspacesStore.set(remaining);
  persistWorkspaces();
  if (get(activeWorkspaceIdStore) === id) {
    const fallback = [...remaining].sort((a, b) => a.createdAt - b.createdAt)[0];
    setActiveWorkspaceId(fallback ? fallback.id : null);
  }
}
