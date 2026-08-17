// Presentational state for the Share modal (Share.svelte) and the topbar
// presence pill near #shareBtn — both are just views onto state collab.ts
// owns (room lifecycle, Yjs, WebSocket transport, access-control API).
import { writable } from "svelte/store";
import type { AccessRecord, PresenceEntry } from "../types";

export const shareModalOpen = writable(false);
export const shareAccess = writable<AccessRecord | null>(null);
// Named for what it actually is since workspace-level sharing (v1.21.0):
// every share is a *workspace* share, even the "just this document" path
// (isolate-then-share creates a new single-document workspace named
// after that document, so the two happen to read the same there) — the
// modal title should always reflect the workspace being shared, not
// whichever document happened to be open when Share was clicked.
export const shareTargetName = writable("Untitled workspace");
// Connected collaborators (excluding the local user) — consumed by both
// Share.svelte's people list and collab.ts's own topbar avatar rendering,
// so the two never drift out of sync with each other.
export const sharePresence = writable<PresenceEntry[]>([]);
