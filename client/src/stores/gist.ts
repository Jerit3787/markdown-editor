import { writable } from "svelte/store";

// Transient status text shown in File > Publish while a publish/update is
// in flight or has just finished ("Publishing…", "Published ✓", "Failed:
// ..."). null means "show the static label" — MenuBar.svelte derives that
// from the active doc's gistId itself (Update Gist vs Publish to Gist).
export const gistBusyLabel = writable<string | null>(null);
