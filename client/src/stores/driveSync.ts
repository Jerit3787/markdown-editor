import { writable } from "svelte/store";

// Whether an mde_google_session cookie is live — hydrated from
// GET /api/auth/google/status by drive-files.ts on load, and re-checked
// after the connect popup reports success. Drives whether the Google
// menu items show as "Connect…" or the real actions.
export const driveConnected = writable(false);

// Whether the Worker has Google OAuth configured at all — flipped to
// false by drive-files.ts's checkSession() when /api/auth/google/status
// returns 503. When false AND disconnected, the Drive menu items hide
// entirely (an unconfigured deploy shows no Drive UI).
export const driveConfigured = writable(true);

// Transient status text while a Picker import is in flight ("Importing…").
// null → the menu shows its static label.
export const driveImportBusyLabel = writable<string | null>(null);
