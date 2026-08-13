import { writable, get } from "svelte/store";

// Mirrors app.ts's initViewToggle() closure state — written there (the
// source of truth, since it also owns main.className/localStorage/cm.refresh
// side effects), read here by MenuBar.svelte for the View menu's
// checkmarks and by Toolbar.svelte for the view-selector buttons'
// active state.
export type ViewMode = "editor" | "split" | "preview";
export const viewMode = writable<ViewMode>("split");

export function isEditorOn(mode: ViewMode): boolean {
  return mode !== "preview";
}
export function isPreviewOn(mode: ViewMode): boolean {
  return mode !== "editor";
}

// Toggling the only pane that's currently on is a no-op — there's
// always at least one pane visible, never both hidden at once. Past
// that guard, exactly one case remains each way: this pane was on (so
// the other must be too, i.e. split) and is turning off, leaving the
// other pane alone; or this pane was off (so the other was on alone)
// and is turning on, which is always "split".
export function toggleEditorPane(): void {
  const mode = get(viewMode);
  if (isEditorOn(mode) && !isPreviewOn(mode)) return;
  window.MDE.setView(isEditorOn(mode) ? "preview" : "split");
}
export function togglePreviewPane(): void {
  const mode = get(viewMode);
  if (isPreviewOn(mode) && !isEditorOn(mode)) return;
  window.MDE.setView(isPreviewOn(mode) ? "editor" : "split");
}
