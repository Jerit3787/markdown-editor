import { writable } from "svelte/store";

export interface WikilinkMenuState {
  open: boolean;
  query: string;
  triggerPos: number;
  coords: { left: number; bottom: number } | null;
}

// Written by app.ts's wikilink-trigger StateField + sync listener
// whenever it changes, read by WikilinkMenu.svelte — same bridge shape
// slashMenu already uses.
export const wikilinkMenu = writable<WikilinkMenuState>({ open: false, query: "", triggerPos: 0, coords: null });
