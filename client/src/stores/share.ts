// Presentational state for the Share modal (Share.svelte) and the topbar
// presence pill near #shareBtn — both are just views onto state collab.ts
// owns (room lifecycle, Yjs, WebSocket transport, access-control API).
import { writable } from "svelte/store";
import type { AccessRecord, PresenceEntry } from "../types";

export const shareModalOpen = writable(false);
export const shareAccess = writable<AccessRecord | null>(null);
export const shareDocName = writable("Untitled");
// Connected collaborators (excluding the local user) — consumed by both
// Share.svelte's people list and collab.ts's own topbar avatar rendering,
// so the two never drift out of sync with each other.
export const sharePresence = writable<PresenceEntry[]>([]);
