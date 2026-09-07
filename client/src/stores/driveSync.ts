import { writable } from "svelte/store";

// Whether an mde_google_session cookie is live — hydrated from
// GET /api/auth/google/status by drive-files.ts on load, and re-checked
// after the connect popup reports success. Drives whether the Google menu
// items show "Connect…" or the real actions.
export const driveConnected = writable(false);

// false once /api/auth/google/status has returned 503 — the whole Google
// Drive feature is unconfigured on this deployment, so its menu items are
// hidden entirely (not just disabled). Starts true (optimistic) so the
// items aren't hidden during the initial status check.
export const driveConfigured = writable(true);

// Transient status text while a Picker import is in flight ("Importing…").
// null → the menu shows its static label.
export const driveImportBusyLabel = writable<string | null>(null);
