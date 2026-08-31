import { writable } from "svelte/store";

// Pending-suggestion count for the currently active document only — same
// scoping as stores/commentsPanel.ts's unresolvedCommentCount (never a
// cross-document/workspace total). A local (never-shared) document has no
// suggestion concept at all, so this stays 0 for it.
export const pendingSuggestionCount = writable(0);
