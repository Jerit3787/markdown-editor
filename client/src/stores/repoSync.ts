// Presentational state for RepoLinkModal.svelte and RepoConflictModal.svelte
// — mirrors stores/openGistModal.ts (a single open flag) and stores/gist.ts
// (a busy-label string) for the same reasons those exist: the modals need
// reactive state a plain module-level variable can't give Svelte, and
// nothing else in the app needs to reach into their internals.
import { writable } from "svelte/store";

export const repoLinkModalOpen = writable(false);
export const openRepoModalOpen = writable(false);
export const repoSyncBusyLabel = writable<string | null>(null);

export interface RepoConflictState {
  kind: "pull" | "push";
  conflicts: { docId: string; docName: string; repoPath: string }[];
  deletions: { docId: string; docName: string; repoPath: string }[];
  onResolve: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>;
}

export const repoConflictModalOpen = writable(false);
export const repoConflictState = writable<RepoConflictState | null>(null);

// Set from the MESSAGE_WORKSPACE_META frame (collab.ts) — true when the
// current shared workspace is linked to a GitHub repo. Lets a collaborator
// who has no repoLink of their own still be told sync is in play
// (DocInfoPanel.svelte). Reset to false on teardown.
export const workspaceRepoLinked = writable(false);
