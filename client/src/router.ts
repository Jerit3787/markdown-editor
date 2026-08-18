import { get } from "svelte/store";
import { docsStore, switchDoc } from "./stores/docs";

const DOC_PATH = /^\/d\/([A-Za-z0-9]{1,64})$/;

export function parseDocIdFromPath(pathname: string): string | null {
  const match = pathname.match(DOC_PATH);
  return match ? match[1]! : null;
}

export function pushDocUrl(docId: string): void {
  const path = `/d/${docId}`;
  if (location.pathname !== path) history.pushState(null, "", path);
}

export function replaceToRoot(): void {
  if (location.pathname !== "/") history.replaceState(null, "", "/");
}

// Applies whatever /d/<id> is currently in the URL to app state — shared
// by initRouter's initial load and every popstate (back/forward) event.
// switchDoc (stores/docs.ts) already switches the workspace too if the
// target document belongs to a different one, so no separate
// switchWorkspace call is needed here.
function applyPathToState(): void {
  const docId = parseDocIdFromPath(location.pathname);
  if (!docId) return;
  const exists = get(docsStore).some((d) => d.id === docId);
  if (!exists) {
    replaceToRoot();
    return;
  }
  switchDoc(docId);
}

export function initRouter(): void {
  applyPathToState();
  window.addEventListener("popstate", applyPathToState);
}
