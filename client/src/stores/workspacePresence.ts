import { writable } from "svelte/store";

export interface RemotePresenceEntry {
  username: string;
  color: string;
}

// Which documents (by id) each currently-connected collaborator has open,
// across the whole active shared workspace — not just the document you
// yourself have open. Populated by collab.ts's handleRemotePresence,
// cleared on every workspace teardown.
export const workspacePresence = writable<Map<string, RemotePresenceEntry[]>>(new Map());
