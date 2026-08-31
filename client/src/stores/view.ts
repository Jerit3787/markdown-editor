import { writable, get } from "svelte/store";

// Sole owner of view-mode state, including the #body className and
// localStorage side effects — same full-ownership treatment
// stores/keybindings.ts already got in Phase A of the editor-core
// migration. Read by MenuBar.svelte for the View menu's checkmarks and
// by Toolbar.svelte for the view-selector buttons' active state.
export type ViewMode = "editor" | "split" | "preview";

const STORAGE_VIEW = "mde:view";

function loadViewMode(): ViewMode {
  const raw = localStorage.getItem(STORAGE_VIEW);
  return raw === "editor" || raw === "preview" ? raw : "split";
}

export const viewMode = writable<ViewMode>(loadViewMode());

export function isEditorOn(mode: ViewMode): boolean {
  return mode !== "preview";
}
export function isPreviewOn(mode: ViewMode): boolean {
  return mode !== "editor";
}

// Set while the active document's role is "viewer" (collab.ts) — a true
// look-only mode with no edit surface, so the Editor/Split panes are
// unreachable rather than merely read-only. setView becomes a no-op for
// any value other than "preview" while locked; lockToPreviewOnly/
// unlockViewMode are the only way to change the lock itself.
export const viewModeLocked = writable(false);

export function setView(view: ViewMode): void {
  if (get(viewModeLocked) && view !== "preview") return;
  document.getElementById("body")!.className = `mode-${view}`;
  localStorage.setItem(STORAGE_VIEW, view);
  viewMode.set(view);
}

export function lockToPreviewOnly(): void {
  viewModeLocked.set(true);
  setView("preview");
}

export function unlockViewMode(): void {
  viewModeLocked.set(false);
}

// Applies the loaded mode's #body class on module load — mirrors
// app.ts's old initViewToggle(), now self-contained here instead of
// being kicked off from its DOMContentLoaded-gated init(). #body
// already exists by module-load time (a plain div early in index.html,
// well before any <script type="module"> tag) — same guarantee
// docsStore's/keybindingMode's own self-init already relies on.
document.getElementById("body")!.className = `mode-${get(viewMode)}`;

// Toggling the only pane that's currently on is a no-op — there's
// always at least one pane visible, never both hidden at once. Past
// that guard, exactly one case remains each way: this pane was on (so
// the other must be too, i.e. split) and is turning off, leaving the
// other pane alone; or this pane was off (so the other was on alone)
// and is turning on, which is always "split".
export function toggleEditorPane(): void {
  const mode = get(viewMode);
  if (isEditorOn(mode) && !isPreviewOn(mode)) return;
  setView(isEditorOn(mode) ? "preview" : "split");
}
export function togglePreviewPane(): void {
  const mode = get(viewMode);
  if (isPreviewOn(mode) && !isEditorOn(mode)) return;
  setView(isPreviewOn(mode) ? "editor" : "split");
}
