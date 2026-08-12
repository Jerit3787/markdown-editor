import { writable } from "svelte/store";

// Mirrors viewMode's pattern — written in app.ts (the source of truth,
// since it also owns the CodeMirror compartment / body class side
// effects), read here by MenuBar.svelte for the View menu's checkmark.
// Not persisted to localStorage — always starts false on load, a
// session toggle rather than a sticky preference.
export const focusMode = writable<boolean>(false);
