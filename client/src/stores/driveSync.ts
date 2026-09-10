import { writable } from "svelte/store";

// Whether an mde_google_session cookie is live — hydrated from
// GET /api/auth/google/status by drive-files.ts on load, and re-checked
// after the connect popup reports success. Drives whether the Google
// menu items show as "Connect…" or the real actions.
export const driveConnected = writable(false);

// Transient status text while a Picker import is in flight ("Importing…").
// null → the menu shows its static label.
export const driveImportBusyLabel = writable<string | null>(null);
