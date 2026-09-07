// Google Drive integration, client side. Later plans add "Save to Drive"
// and full folder sync; this file owns "Connect Google Drive" and "Open
// markdown from Drive". The Google OAuth grant lives in an HttpOnly
// cookie server-side (src/google-auth.ts) — this script only calls our
// own /api/auth/google/* + /api/drive/* endpoints, except for the Google
// Picker, which is a Google-hosted iframe and needs a token in the
// browser (fetched from /api/auth/google/picker-token, used only for the
// Picker widget itself — the file downloads route back through
// /api/drive/import).
import "./types";
import { get } from "svelte/store";
import { driveConnected, driveConfigured, driveImportBusyLabel } from "./stores/driveSync";
import { workspacesStore } from "./stores/workspaces";
import { createDoc, activeDocContent } from "./stores/docs";
import { showToast } from "./stores/toast";

window.MDE.connectGoogleDrive = connect;
window.MDE.disconnectGoogleDrive = disconnect;
window.MDE.importMarkdownFromDrive = importMarkdownFromDrive;
window.MDE.onGoogleAuthComplete = checkSession;

checkSession();

// The connect popup posts { type: "mde-google-auth", ok } back to its
// opener (see src/auth.ts popupHtml). This listener is always active
// because the connect action can be triggered from the Settings modal or
// the File menu (no owning modal), unlike the GitHub sign-in popup.
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || !e.data || e.data.type !== "mde-google-auth") return;
  if (e.data.ok) window.MDE.onGoogleAuthComplete?.();
});

async function checkSession(): Promise<void> {
  try {
    const res = await fetch("/api/auth/google/status");
    if (res.status === 503) {
      driveConfigured.set(false);
      driveConnected.set(false);
      return;
    }
    const data = await res.json();
    driveConnected.set(!!data.connected);
  } catch {
    driveConnected.set(false);
  }
}

// A 500x650 popup, same shape as the GitHub sign-in popup.
function connect(): void {
  const w = 500;
  const h = 650;
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

// ---- Google Picker (client-side widget) ----
// Injected so tests can bypass the real Google iframe. Signature:
// (oauthToken, apiKey, onPicked) => void, where onPicked gets [{id,name}].
type OpenPicker = (token: string, apiKey: string, onPicked: (files: { id: string; name: string }[]) => void) => void | Promise<void>;
let openPickerImpl: OpenPicker | null = null;

/** @internal test seam */
export function __setPickerForTest(fn: OpenPicker | null): void {
  openPickerImpl = fn;
}

/** @internal exported for tests — re-hydrates driveConnected/driveConfigured. */
export { checkSession };

const GAPI_SRC = "https://apis.google.com/js/api.js";
let gapiLoad: Promise<void> | null = null;

function loadGapi(): Promise<void> {
  if (gapiLoad) return gapiLoad;
  gapiLoad = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GAPI_SRC;
    s.onload = () =>
      (window as unknown as { gapi: { load: (n: string, o: { callback: () => void }) => void } }).gapi.load("picker", { callback: () => resolve() });
    s.onerror = () => reject(new Error("Couldn't load the Google Picker"));
    document.head.appendChild(s);
  });
  return gapiLoad;
}

async function openPicker(token: string, apiKey: string, onPicked: (files: { id: string; name: string }[]) => void): Promise<void> {
  if (openPickerImpl) return openPickerImpl(token, apiKey, onPicked);
  await loadGapi();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const google = (window as any).google;
  const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
    .setMode(google.picker.DocsViewMode.LIST)
    .setSelectFolderEnabled(false)
    // Loose MIME hint — the import step re-checks each file's name and
    // skips anything that isn't markdown-ish.
    .setMimeTypes("text/markdown,text/plain,text/x-markdown");
  const picker = new google.picker.PickerBuilder()
    .setOAuthToken(token)
    .setDeveloperKey(apiKey)
    .addView(view)
    .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
    .setTitle("Choose markdown files to import")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .setCallback((data: any) => {
      if (data.action !== google.picker.Action.PICKED) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    connect(); // connect, then the user re-runs the action
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
        for (const m of content.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
          if (!/^(https?:|data:)/.test(m[1]!)) unresolvedImages++;
        }
        const doc = createDoc({ name: stripExt(r.name), content });
        // createDoc()'s first line is saveActiveDocContent(), which
        // persists get(activeDocContent) into the now-active doc — in the
        // editor that store tracks the buffer, but in this loop it would
        // be stale and wipe the doc we just made. Keep it in step.
        activeDocContent.set(doc.content);
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
