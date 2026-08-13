import { writable } from "svelte/store";

export interface CommentDraftState {
  visible: boolean;
  from: number;
  to: number;
  coords: { left: number; bottom: number } | null;
}

// Written by app.ts's commentDraftSyncListener whenever the editor
// selection changes, read by CommentsPanel.svelte to position the
// floating "Add comment" button — the same CodeMirror-state-to-Svelte
// bridge shape slashMenu/focusMode already use.
export const commentDraft = writable<CommentDraftState>({ visible: false, from: 0, to: 0, coords: null });
