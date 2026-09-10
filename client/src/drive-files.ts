// Google Drive integration, client side. Two more flows come in later
// plans (save to Drive, folder sync); this file owns "Connect Google
// Drive" + "Open markdown from Drive". The Google OAuth grant lives in an
// HttpOnly cookie server-side (src/google-auth.ts) — this script only
// calls our own /api/auth/google/* + /api/drive/* endpoints, except for
// the Picker, which needs a token in the browser (fetched from
// picker-token, used only for the Picker widget).
import "./types";
import { get } from "svelte/store";
import { driveConnected, driveConfigured, driveImportBusyLabel } from "./stores/driveSync";
import { workspacesStore } from "./stores/workspaces";
import { createDoc, activeDocContent } from "./stores/docs";
import { showToast } from "./stores/toast";

window.MDE.connectGoogleDrive = connect;
window.MDE.disconnectGoogleDrive = disconnect;
window.MDE.importMarkdownFromDrive = importMarkdownFromDrive;

checkSession();

// The GitHub popup's `mde-github-auth` listener lives in
// GithubSignInModal.svelte, not app.ts — so this module registers its own
// listener for `mde-google-auth`, mirroring that pattern.
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || !e.data || e.data.type !== "mde-google-auth") return;
  if (e.data.ok) {
    driveConnected.set(true);
    window.MDE.onGoogleAuthComplete?.();
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const existing = window.MDE.onGoogleAuthComplete;
  window.MDE.onGoogleAuthComplete = () => {
    existing?.();
    checkSession();
  };
});

async function checkSession(): Promise<void> {
  try {
    const res = await fetch("/api/auth/google/status");
    const data = await res.json();
    driveConnected.set(!!data.connected);
    driveConfigured.set(data.configured !== false);
  } catch {
    driveConnected.set(false);
  }
}

// A 500x650 popup, same window-features string app.ts uses for the GitHub
// sign-in popup. The `message` listener above handles the
// { type: "mde-google-auth" } postMessage the popup sends on completion.
function connect(): void {
  const w = 500,
    h = 650;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  window.open("/api/auth/google/connect", "google-oauth", `width=${w},height=${h},left=${left},top=${top}`);
}

async function disconnect(): Promise<void> {
  try {
    await fetch("/api/auth/google/disconnect", { method: "POST" });
  } finally {
    driveConnected.set(false);
  }
}

// ---- Picker loading (client-side Google widget) ----
// Injected so tests can bypass the real Google iframe. Signature:
// (oauthToken, apiKey, onPicked) => void, where onPicked gets [{id,name}].
type OpenPicker = (token: string, apiKey: string, onPicked: (files: { id: string; name: string }[]) => void) => void;
let openPickerImpl: OpenPicker | null = null;

/** @internal test seam */
export function __setPickerForTest(fn: OpenPicker | null): void {
  openPickerImpl = fn;
}

const GAPI_SRC = "https://apis.google.com/js/api.js";
let gapiLoad: Promise<void> | null = null;

function loadGapi(): Promise<void> {
  if (gapiLoad) return gapiLoad;
  gapiLoad = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GAPI_SRC;
    s.onload = () => (window as any).gapi.load("picker", { callback: () => resolve() });
    s.onerror = () => reject(new Error("Couldn't load the Google Picker"));
    document.head.appendChild(s);
  });
  return gapiLoad;
}

async function openPicker(token: string, apiKey: string, onPicked: (files: { id: string; name: string }[]) => void): Promise<void> {
  if (openPickerImpl) return openPickerImpl(token, apiKey, onPicked);
  await loadGapi();
  const google = (window as any).google;
  const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
    .setMode(google.picker.DocsViewMode.LIST)
    .setSelectFolderEnabled(false)
    // loose MIME hint — the import step re-checks each file's name and
    // skips anything that isn't markdown-ish.
    .setMimeTypes("text/markdown,text/plain,text/x-markdown");
  const picker = new google.picker.PickerBuilder()
    .setOAuthToken(token)
    .setDeveloperKey(apiKey)
    .addView(view)
    .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
    .setTitle("Choose markdown files to import")
    .setCallback((data: any) => {
      if (data.action !== google.picker.Action.PICKED) return;
      onPicked((data.docs || []).map((d: any) => ({ id: d.id, name: d.name })));
    })
    .build();
  picker.setVisible(true);
}

function isMarkdownName(name: string): boolean {
  return /\.(md|markdown|mdown|mkd|txt)$/i.test(name);
}
function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "") || name;
}
function decodeB64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function importMarkdownFromDrive(): Promise<void> {
  if (get(workspacesStore).length === 0) {
    showToast("Create a workspace first", "error");
    return;
  }
  const tokRes = await fetch("/api/auth/google/picker-token");
  if (tokRes.status === 401) {
    window.MDE.connectGoogleDrive?.(); // connect, then the user re-runs
    return;
  }
  if (!tokRes.ok) {
    showToast("Google Drive isn't available right now", "error");
    return;
  }
  const { token, apiKey } = await tokRes.json();

  await openPicker(token, apiKey, async (files) => {
    const wanted = files.filter((f) => isMarkdownName(f.name));
    const skipped = files.filter((f) => !isMarkdownName(f.name));
    if (wanted.length === 0) {
      if (skipped.length) showToast(`Nothing imported — ${skipped.length} file(s) weren't markdown`, "error");
      return;
    }
    driveImportBusyLabel.set("Importing…");
    try {
      const res = await fetch("/api/drive/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileIds: wanted.map((f) => f.id) }),
      });
      if (!res.ok) throw new Error(`import ${res.status}`);
      const { results } = (await res.json()) as { results: { name: string; contentBase64: string; ok: boolean }[] };
      let imported = 0;
      let unresolvedImages = 0;
      for (const r of results) {
        if (!r.ok) continue;
        const content = decodeB64(r.contentBase64);
        // count image refs that won't resolve (an import carries no doc.images)
        for (const m of content.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
          if (!/^(https?:|data:)/.test(m[1]!)) unresolvedImages++;
        }
        createDoc({ name: stripExt(r.name), content });
        // createDoc makes each new doc active and the *next* createDoc
        // flushes activeDocContent (the live-editor buffer) into the doc
        // it just left. app.ts's activeIdStore subscriber normally keeps
        // that buffer in step; keep it in step here too so a back-to-back
        // import loop doesn't blank the previous file.
        activeDocContent.set(content);
        imported++;
      }
      const failed = results.length - results.filter((r) => r.ok).length;
      let msg = `Imported ${imported} file${imported === 1 ? "" : "s"} from Drive`;
      if (failed) msg += `, ${failed} failed`;
      if (skipped.length) msg += `; ${skipped.length} non-markdown skipped`;
      if (unresolvedImages) msg += `. ${unresolvedImages} image reference${unresolvedImages === 1 ? "" : "s"} won't resolve`;
      showToast(msg, failed || unresolvedImages ? "info" : "success");
    } catch (err) {
      showToast(`Import failed: ${(err as Error).message}`, "error");
    } finally {
      driveImportBusyLabel.set(null);
    }
  });
}

// re-exported for later plans / tests
export { checkSession, driveImportBusyLabel };
