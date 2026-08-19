import { writable } from "svelte/store";

// Mirrors viewMode's pattern — written by whichever UI toggles focus
// mode (MenuBar.svelte, CommandPalette.svelte, app.ts's mobile exit
// button and desktop Escape handler); Editor.svelte reacts to it via
// $effect to own the CodeMirror compartment / body class side effects
// as of Phase A of the editor-core migration. Not persisted to
// localStorage — always starts false on load, a session toggle rather
// than a sticky preference.
export const focusMode = writable<boolean>(false);
