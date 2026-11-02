import { writable } from "svelte/store";

// Whether an mde_google_session cookie is live — hydrated from
// GET /api/auth/google/status by drive-files.ts on load, and re-checked
// after the connect popup reports success. Drives whether the Google
// menu items show as "Connect…" or the real actions.
export const driveConnected = writable(false);

// Whether the Worker has Google OAuth configured at all — set from
// GET /api/auth/google/status by drive-files.ts's checkSession(). Starts
// false ("not known to be configured") so an unconfigured deploy — or a
// client-only dev server where the status fetch fails — never shows a
// Drive action that can't work. When false AND disconnected, the Drive
// menu items hide entirely.
export const driveConfigured = writable(false);

// Transient status text while a Picker import is in flight ("Importing…").
// null → the menu shows its static label.
export const driveImportBusyLabel = writable<string | null>(null);

// Transient status text while a "Save to Google Drive" export is in
// flight — the menu label shows "Saving…" / "Updating…" and disables.
export const driveExportBusyLabel = writable<string | null>(null);

// Folder-sync presentational state, mirroring stores/repoSync.ts.
export const openDriveModalOpen = writable(false);
export const linkDriveModalOpen = writable(false);
export const driveSyncBusyLabel = writable<string | null>(null);
