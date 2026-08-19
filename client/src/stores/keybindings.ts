// Single owner of keybinding-mode persistence — Editor.svelte reacts to
// this store via $effect to reconfigure the live CodeMirror compartment;
// Settings.svelte writes to it directly via setKeybindingMode(). Before
// this store existed, app.ts owned the localStorage key AND
// Settings.svelte separately duplicated it as its own local component
// state — a two-owners-for-one-value situation this store fixes by
// giving it exactly one owner, same shape as stores/workspaces.ts's own
// relationship to its localStorage keys.
import { writable } from "svelte/store";

export type KeybindingMode = "normal" | "vim" | "emacs";

const STORAGE_KEYBINDINGS = "mde:keybindings";

function loadKeybindingMode(): KeybindingMode {
  const raw = localStorage.getItem(STORAGE_KEYBINDINGS);
  return raw === "vim" || raw === "emacs" ? raw : "normal";
}

export const keybindingMode = writable<KeybindingMode>(loadKeybindingMode());

export function setKeybindingMode(mode: KeybindingMode): void {
  localStorage.setItem(STORAGE_KEYBINDINGS, mode);
  keybindingMode.set(mode);
}
