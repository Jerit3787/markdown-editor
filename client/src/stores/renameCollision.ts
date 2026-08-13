import { writable } from "svelte/store";

export interface RenameCollisionState {
  docId: string;
  pendingName: string;
  previousName: string;
  collidingDocId: string;
}

// Set by app.ts's docTitle blur handler when a deliberate rename
// collides with another document's name; cleared by
// RenameCollisionModal.svelte once the user picks Replace/Save as/
// Cancel.
export const renameCollision = writable<RenameCollisionState | null>(null);
