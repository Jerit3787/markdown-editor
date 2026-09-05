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
// True only in the one genuinely ambiguous case: there's no session at
// all (not merely a session belonging to someone else), yet the access
// record still granted a role via general access — see
// collab.ts's isIdentityUnverified(). Doesn't gate anything; purely
// tells the UI the role shown might not be what this visitor would get
// if they were recognized. Reset to false in collab.ts's
// handleDocChanged(), specifically only in the branches that leave
// shared context for good (not the generic teardownWorkspace() helper,
// which also runs right before an immediate rejoin — resetting there too
// raced the rejoin's own correct value on every redundant reactive
// teardown+rejoin cycle a fresh join can trigger).
export const identityUnverified = writable(false);
