// Google Drive integration, client side. Two more flows come in later
// plans (save to Drive, folder sync); this file owns "Connect Google
// Drive" + "Open markdown from Drive". The Google OAuth grant lives in an
// HttpOnly cookie server-side (src/google-auth.ts) — this script only
// calls our own /api/auth/google/* + /api/drive/* endpoints, except for
// the Picker, which needs a token in the browser (fetched from
// picker-token, used only for the Picker widget).
import "./types";
import { get } from "svelte/store";
import { driveConnected, driveConfigured, driveImportBusyLabel, driveExportBusyLabel } from "./stores/driveSync";
import { workspacesStore } from "./stores/workspaces";
import { createDoc, activeDocContent, getActiveDoc, setDocDriveExport, clearDocDriveExport } from "./stores/docs";
import { showToast, showProgressToast, finishProgressToast } from "./stores/toast";
import { chooseDriveExport } from "./stores/driveExport";

window.MDE.connectGoogleDrive = connect;
window.MDE.disconnectGoogleDrive = disconnect;
window.MDE.importMarkdownFromDrive = importMarkdownFromDrive;
window.MDE.saveToDrive = saveToDrive;
window.MDE.pickDriveFolder = pickDriveFolder;

checkSession();

// Set when an import/save was requested before Drive was connected: the
// menu item had to open the OAuth popup first. The popup's success message
// resumes the pending action, instead of leaving the user to find and
// click the menu item again. Expires so a cancelled/abandoned connect
// can't fire a surprise picker/save much later.
type PendingDriveAction = "import" | "save";
let pendingAction: PendingDriveAction | null = null;
let pendingActionAt = 0;
const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;

function clearPendingAction(): void {
  pendingAction = null;
  pendingActionAt = 0;
}

function connectFor(action: PendingDriveAction): void {
  pendingAction = action;
  pendingActionAt = Date.now();
  // Go through the bridge (not the local connect directly) so tests can
  // stub the popup call, and so any wrapper installed by Settings runs.
  window.MDE.connectGoogleDrive?.();
}

// The GitHub popup's `mde-github-auth` listener lives in
// GithubSignInModal.svelte, not app.ts — so this module registers its own
// listener for `mde-google-auth`, mirroring that pattern.
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || !e.data || e.data.type !== "mde-google-auth") return;
  if (!e.data.ok) {
    // The popup reported a failure — don't leave a stale resume request.
    clearPendingAction();
    return;
  }
  driveConnected.set(true);
  window.MDE.onGoogleAuthComplete?.();
  const resume = Date.now() - pendingActionAt <= PENDING_ACTION_TTL_MS ? pendingAction : null;
  clearPendingAction();
  if (resume === "import") void importMarkdownFromDrive();
  if (resume === "save") void saveToDrive();
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
// (oauthToken, apiKey, appId, onPicked) => void, onPicked gets [{id,name}].
type OpenPicker = (token: string, apiKey: string, appId: string, onPicked: (files: { id: string; name: string }[]) => void) => void;
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

async function openPicker(token: string, apiKey: string, appId: string, onPicked: (files: { id: string; name: string }[]) => void): Promise<void> {
  if (openPickerImpl) return openPickerImpl(token, apiKey, appId, onPicked);
  await loadGapi();
  const google = (window as any).google;
  const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
    .setMode(google.picker.DocsViewMode.LIST)
    .setSelectFolderEnabled(false)
    // loose MIME hint — the import step re-checks each file's name and
    // skips anything that isn't markdown-ish.
    .setMimeTypes("text/markdown,text/plain,text/x-markdown");
  const builder = new google.picker.PickerBuilder().setOAuthToken(token).setDeveloperKey(apiKey).addView(view);
  // Required for the drive.file scope — without it the files the user
  // picks are never actually shared with the app and every download 404s.
  if (appId) builder.setAppId(appId);
  const picker = builder
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
    // Not connected yet: remember that the user actually wanted to import,
    // so the OAuth popup's success handler can resume this instead of
    // making them re-open the menu item (see the message listener above).
    connectFor("import");
    return;
  }
  if (!tokRes.ok) {
    showToast("Google Drive isn't available right now", "error");
    return;
  }
  const { token, apiKey, appId } = await tokRes.json();

  await openPicker(token, apiKey, appId ?? "", async (files) => {
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
      const { results } = (await res.json()) as { results: { name: string; contentBase64: string; ok: boolean; error?: string }[] };
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
      const failures = results.filter((r) => !r.ok);
      const failed = failures.length;
      let msg = `Imported ${imported} file${imported === 1 ? "" : "s"} from Drive`;
      if (failed) msg += `, ${failed} failed${failures[0]?.error ? ` (${failures[0].error})` : ""}`;
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

// ---- Save markdown to Drive (per-file export) ----
// The filename proposed in the modal: doc name with characters Drive/git
// dislike replaced, always ending in .md.
function defaultDriveName(doc: { name?: string }): string {
  const base = (doc.name || "document").trim().replace(/[\\/:*?"<>|]+/g, "-") || "document";
  return /\.md$/i.test(base) ? base : `${base}.md`;
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

async function exportErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const data = JSON.parse(text) as { message?: string };
    if (typeof data.message === "string" && data.message) return data.message;
  } catch {
    /* not JSON — fall through */
  }
  return text || `HTTP ${res.status}`;
}

function countLocalImageRefs(content: string): number {
  let count = 0;
  for (const m of content.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (!/^(https?:|data:)/.test(m[1]!)) count++;
  }
  return count;
}

// Save / update the active document as a standalone Drive .md file. First
// save asks for a filename/folder; later saves PATCH the remembered file
// with no dialog (overwrite, like "Update Gist"). A file deleted in Drive
// drops the link and falls back to a create.
async function saveToDrive(): Promise<void> {
  if (!get(driveConnected)) {
    connectFor("save");
    return;
  }
  const doc = getActiveDoc();
  if (!doc) return;

  let fileId = doc.driveExportId;
  let name = doc.driveExportName || defaultDriveName(doc);
  let parentFolderId: string | undefined;
  if (!fileId) {
    const choice = await chooseDriveExport(defaultDriveName(doc));
    if (!choice) return;
    name = choice.name.trim() || defaultDriveName(doc);
    parentFolderId = choice.parentFolderId;
  }

  const content = window.MDE.getEditor().state.doc.toString();
  driveExportBusyLabel.set(fileId ? "Updating…" : "Saving…");
  const toastId = showProgressToast(fileId ? "Updating in Google Drive…" : "Saving to Google Drive…");
  try {
    const post = (targetId?: string) =>
      fetch("/api/drive/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: targetId, name, parentFolderId, contentBase64: utf8ToBase64(content) }),
      });

    let res = await post(fileId);
    if (res.status === 404 && fileId) {
      clearDocDriveExport(doc.id);
      fileId = undefined;
      res = await post(undefined);
    }
    if (res.status === 401) {
      driveConnected.set(false);
      connectFor("save");
      finishProgressToast(toastId, "Google Drive disconnected — reconnect to save", "error");
      return;
    }
    if (!res.ok) throw new Error(await exportErrorMessage(res));
    const data = (await res.json()) as { fileId: string; name?: string; webViewLink?: string };
    setDocDriveExport(doc.id, data.fileId, data.name || name);
    window.MDE.refreshSaveStatus?.();
    const localRefs = countLocalImageRefs(content);
    const suffix = localRefs ? ` — ${localRefs} image reference${localRefs === 1 ? " stays" : "s stay"} local` : "";
    finishProgressToast(toastId, `${fileId ? "Updated in Google Drive" : "Saved to Google Drive"}${suffix}`, "success");
  } catch (err) {
    finishProgressToast(toastId, `Couldn't save to Google Drive: ${(err as Error).message}`, "error");
  } finally {
    setTimeout(() => driveExportBusyLabel.set(null), 2000);
  }
}

// Folder-select Picker for the save dialog. Returns null on cancel/error;
// a disconnected caller is sent through the OAuth popup first.
async function pickDriveFolder(): Promise<{ id: string; name: string } | null> {
  if (!get(driveConnected)) {
    connectFor("save");
    return null;
  }
  const tokRes = await fetch("/api/auth/google/picker-token");
  if (tokRes.status === 401) {
    driveConnected.set(false);
    connectFor("save");
    return null;
  }
  if (!tokRes.ok) {
    showToast("Google Drive isn't available right now", "error");
    return null;
  }
  const { token, apiKey, appId } = (await tokRes.json()) as { token: string; apiKey: string; appId?: string };
  await loadGapi();
  const google = (window as any).google;
  return new Promise((resolve) => {
    const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
      .setSelectFolderEnabled(true)
      .setIncludeFolders(true)
      .setMode(google.picker.DocsViewMode.LIST);
    const builder = new google.picker.PickerBuilder()
      .setOAuthToken(token)
      .setDeveloperKey(apiKey)
      .addView(view)
      .setTitle("Choose a destination folder")
      .setCallback((data: any) => {
        if (data.action === google.picker.Action.PICKED) {
          const folder = data.docs?.[0];
          resolve(folder ? { id: folder.id, name: folder.name } : null);
        } else if (data.action === google.picker.Action.CANCEL) {
          resolve(null);
        }
      });
    if (appId) builder.setAppId(appId);
    builder.build().setVisible(true);
  });
}

// re-exported for later plans / tests
export { checkSession, driveImportBusyLabel };
