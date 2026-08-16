import { writable } from "svelte/store";

export interface PendingJoin {
  remoteId: string;
  workspaceName: string;
  docs: { id: string; name: string; content: string; updatedAt: number; createdAt: number }[];
  landOnDocId: string;
}

// Set by collab.ts's joinSharedLink when a /w/<workspaceId>/<docId>/<mode>
// link resolves to a remoteId this browser hasn't seen before — cleared by
// JoinWorkspaceModal.svelte once the user picks "new" or "merge".
export const pendingJoin = writable<PendingJoin | null>(null);
