import { get } from "svelte/store";
import { collabRemoteId, effectiveMode, type Mode } from "./stores/collabMode";
import { showToast, dismissToast } from "./stores/toast";

export const MODE_ANNOUNCE_COPY: Record<Mode, string> = {
  editing: "You're now editing",
  suggesting: "You're now suggesting",
  viewing: "You're now viewing",
};

export interface ModeState {
  remoteId: string | null;
  mode: Mode | null;
}

// Pure decision: given the previous state this ran with and the current
// state, return the Mode to announce, or null. Counts a workspace entry
// by adding its remoteId to `seen` (the one side effect).
export function nextAnnouncement(prev: ModeState, next: ModeState, seen: Set<string>): Mode | null {
  if (!next.mode || !next.remoteId) return null;
  if (next.remoteId === prev.remoteId) {
    return next.mode !== prev.mode ? next.mode : null;
  }
  if (seen.has(next.remoteId)) return null;
  seen.add(next.remoteId);
  return next.mode;
}

// Subscribe effectiveMode → toast. Call exactly once (from collab.ts at
// module load). effectiveMode fires its current value immediately (null
// at load — a no-op) and then on every role/chosenMode change;
// enterCollabRoom sets collabRemoteId before collabRole, so
// get(collabRemoteId) here already reflects the new room. A plain doc
// rebind does not fire this (it never touches role/chosenMode).
export function initModeAnnounce(): void {
  let prev: ModeState = { remoteId: null, mode: null };
  const seen = new Set<string>();
  let lastToastId: number | null = null;

  effectiveMode.subscribe((mode) => {
    const next: ModeState = { remoteId: get(collabRemoteId), mode };
    const toAnnounce = nextAnnouncement(prev, next, seen);
    prev = next;
    if (!toAnnounce) return;
    if (lastToastId !== null) dismissToast(lastToastId);
    lastToastId = showToast(MODE_ANNOUNCE_COPY[toAnnounce], "info");
  });
}
