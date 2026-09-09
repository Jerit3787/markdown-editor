import { writable } from "svelte/store";

export const commentsPanelOpen = writable(false);

// Unresolved comment-thread count for the currently active document only
// (never a cross-document/workspace total — nothing else in the app
// aggregates comments beyond the active doc, see CommentsPanel.svelte's
// own loadEntries()). Local (never-shared) documents use plain Notes,
// which have no resolved/unresolved concept at all, so this stays 0 for
// them — only shared documents' real comment threads count here.
export const unresolvedCommentCount = writable(0);
