// Presentational state for MoveToWorkspaceModal.svelte — DocList.svelte's
// doc-row "..." menu used to list every other workspace directly inline
// in the popover, which doesn't scale past a handful of workspaces. This
// just tracks which document a move is in progress for; the modal reads
// the rest (its name, its current workspace, the full workspace list)
// straight from the existing docs/workspaces stores.
import { writable } from "svelte/store";

export const moveToWorkspaceDocId = writable<string | null>(null);

export function openMoveToWorkspaceModal(docId: string): void {
  moveToWorkspaceDocId.set(docId);
}

export function closeMoveToWorkspaceModal(): void {
  moveToWorkspaceDocId.set(null);
}
