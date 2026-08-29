// Pure, timestamp-derived grouping — deliberately not stored as a field
// on any snapshot. Both history.ts's write-time pruning and
// VersionHistory.svelte's display grouping call this same function, so
// there is exactly one definition of what a "session" is. Duplicated
// (not imported) into src/version-grouping.ts for workspace-room.ts's
// own write-time pruning, since client and Worker code don't cross-import
// in this repo — same pattern already used for citation-block
// serialization between app.ts and repo-sync.ts.

export interface SnapshotLike {
  id: string;
  timestamp: number;
}

export interface SessionGroup<T extends SnapshotLike> {
  entries: T[]; // oldest first, same order as input
  startTimestamp: number;
  endTimestamp: number;
}

export const SESSION_GAP_MS = 30 * 60 * 1000;

// Input must already be sorted oldest-first (both history.ts's and
// workspace-room.ts's stored snapshot arrays already are).
export function groupSnapshotsIntoSessions<T extends SnapshotLike>(snapshots: T[], sessionGapMs: number = SESSION_GAP_MS): SessionGroup<T>[] {
  const groups: SessionGroup<T>[] = [];
  for (const snap of snapshots) {
    const current = groups[groups.length - 1];
    if (current && snap.timestamp - current.endTimestamp <= sessionGapMs) {
      current.entries.push(snap);
      current.endTimestamp = snap.timestamp;
    } else {
      groups.push({ entries: [snap], startTimestamp: snap.timestamp, endTimestamp: snap.timestamp });
    }
  }
  return groups;
}
