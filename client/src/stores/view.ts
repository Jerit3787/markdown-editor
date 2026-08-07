import { writable } from "svelte/store";

// Mirrors app.ts's initViewToggle() closure state — written there (the
// source of truth, since it also owns main.className/localStorage/cm.refresh
// side effects), read here by MenuBar.svelte for the View menu's checkmarks
// and the expand-preview button's active state.
export type ViewMode = "editor" | "split" | "preview";
export const viewMode = writable<ViewMode>("split");
