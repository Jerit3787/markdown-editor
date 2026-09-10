// Google Drive integration, client side. Two more flows come in later
// plans (save to Drive, folder sync); this file owns "Connect Google
// Drive" + "Open markdown from Drive". The Google OAuth grant lives in an
// HttpOnly cookie server-side (src/google-auth.ts) — this script only
// calls our own /api/auth/google/* + /api/drive/* endpoints, except for
// the Picker, which needs a token in the browser (fetched from
// picker-token, used only for the Picker widget — see Task 10).
import "./types";
import { driveConnected, driveImportBusyLabel } from "./stores/driveSync";

window.MDE.connectGoogleDrive = connect;
window.MDE.disconnectGoogleDrive = disconnect;

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

// re-exported for Task 10 (Picker load + importMarkdownFromDrive)
export { checkSession, driveImportBusyLabel };
