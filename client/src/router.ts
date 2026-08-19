import { get } from "svelte/store";
import { docsStore, switchDoc } from "./stores/docs";

const DOC_PATH = /^\/d\/([A-Za-z0-9]{1,64})$/;

// Shared with collab.ts's own route match. DOMContentLoaded listeners fire
// in registration order, and app.ts's router listener (which drives
// replaceToRoot/replaceDocUrl below, via its activeIdStore subscription)
// always runs before collab.ts's — so without this guard, a direct visit to
// a /w/:remoteId/:docId/(view|review|edit) share link got its URL silently
// rewritten to "/" (or "/d/<some other doc>") before collab.ts's own
// DOMContentLoaded listener ever got to check location.pathname against
// this same pattern, breaking every direct share-link join.
export const SHARE_PATH = /^\/w\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/(?:view|review|edit)$/;

export function parseDocIdFromPath(pathname: string): string | null {
  const match = pathname.match(DOC_PATH);
  return match ? match[1]! : null;
}

export function pushDocUrl(docId: string): void {
  const path = `/d/${docId}`;
  if (location.pathname !== path) history.pushState(null, "", path);
}

// Establishes a document's URL as the CURRENT history entry rather than a
// new one — used once, at load time, to make the very first entry in a
// tab's history correctly reflect whichever document ended up active
// (whether from a deep link or the localStorage fallback). Without this,
// a tab that loaded via the fallback keeps a bare "/" as its baseline
// entry, and navigating back to it later doesn't restore anything —
// applyPathToState finds no docId in "/" and just leaves the current
// document as-is.
export function replaceDocUrl(docId: string): void {
  if (SHARE_PATH.test(location.pathname)) return;
  const path = `/d/${docId}`;
  if (location.pathname !== path) history.replaceState(null, "", path);
}

export function replaceToRoot(): void {
  if (SHARE_PATH.test(location.pathname)) return;
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
