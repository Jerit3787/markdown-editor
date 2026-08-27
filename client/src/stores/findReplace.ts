import { writable, get } from "svelte/store";
import { viewMode, setView } from "./view";

export type FindBarMode = "find" | "replace";

export const findBarOpen = writable<boolean>(false);
export const findBarMode = writable<FindBarMode>("find");

// Switches out of Preview-only view mode first, if needed, so the bar
// (and its match highlights) are actually visible instead of opening
// behind a hidden editor pane.
export function openFindBar(mode: FindBarMode): void {
  if (get(viewMode) === "preview") setView("split");
  findBarMode.set(mode);
  findBarOpen.set(true);
}

export function closeFindBar(): void {
  findBarOpen.set(false);
}
