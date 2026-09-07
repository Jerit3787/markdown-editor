import { writable, derived, get, type Readable } from "svelte/store";

// The set of roles the server resolves for a shared-workspace connection
// (see access-role.ts server-side). Kept as a local closed set rather than
// importing across into server code.
export type Role = "viewer" | "reviewer" | "editor";
// The user-selectable mode — a self-imposed ceiling at or below the role.
export type Mode = "editing" | "suggesting" | "viewing";

// Modes a role permits, most-capable first (so ALLOWED[role][0] is the
// role's default mode).
const ALLOWED: Record<Role, Mode[]> = {
  editor: ["editing", "suggesting", "viewing"],
  reviewer: ["suggesting", "viewing"],
  viewer: ["viewing"],
};

const STORAGE_KEY = "mde:collabMode"; // { [remoteId]: Mode }

function loadChosen(remoteId: string | null): Mode | null {
  if (!remoteId) return null;
  try {
    return (JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, Mode>)[remoteId] ?? null;
  } catch {
    return null;
  }
}

// null ⇒ not in a shared workspace (a plain local document). No mode
// chrome; editing behaves exactly as before.
export const collabRole = writable<Role | null>(null);
// True when this session's user owns the current shared workspace — drives
// the publish gate (Plan 2) and the repo-linked signal.
export const collabIsOwner = writable(false);
// The remoteId the chosen-mode preference is keyed to.
export const collabRemoteId = writable<string | null>(null);
// The user's explicit pick for the current room, or null = "role default".
export const chosenMode = writable<Mode | null>(null);

export function setChosenMode(mode: Mode): void {
  const remoteId = get(collabRemoteId);
  const role = get(collabRole);
  if (!remoteId || !role || !ALLOWED[role].includes(mode)) return;
  chosenMode.set(mode);
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, Mode>;
    all[remoteId] = mode;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* private mode / quota — the in-memory store still drives this session */
  }
}

// Called by collab.ts once a connection's role is known.
export function enterCollabRoom(remoteId: string, role: Role, isOwner: boolean): void {
  collabRemoteId.set(remoteId);
  collabRole.set(role);
  collabIsOwner.set(isOwner);
  chosenMode.set(loadChosen(remoteId));
}

// Called by collab.ts's teardownWorkspace().
export function leaveCollabRoom(): void {
  collabRemoteId.set(null);
  collabRole.set(null);
  collabIsOwner.set(false);
  chosenMode.set(null);
}

// The mode actually in effect: the chosen mode clamped to the role
// ceiling, defaulting per role. null ⇒ not shared.
export const effectiveMode: Readable<Mode | null> = derived([collabRole, chosenMode], ([role, chosen]) => {
  if (!role) return null;
  const allowed = ALLOWED[role];
  return chosen && allowed.includes(chosen) ? chosen : allowed[0];
});

export const modesAllowed: Readable<Mode[]> = derived(collabRole, (role) => (role ? ALLOWED[role] : []));
