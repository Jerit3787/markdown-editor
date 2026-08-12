import { writable } from "svelte/store";

export interface SlashMenuState {
  open: boolean;
  query: string;
  triggerPos: number;
  coords: { left: number; bottom: number } | null;
}

// Written by app.ts's slash-trigger StateField + sync listener whenever
// it changes, read by SlashMenu.svelte for what to render and where —
// the same bridge shape focusMode/viewMode already use between
// CodeMirror-side state and Svelte-rendered UI.
export const slashMenu = writable<SlashMenuState>({ open: false, query: "", triggerPos: 0, coords: null });
