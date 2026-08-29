# Smart Version-History Grouping — Design Spec

**IMPROVEMENTS.md Phase 3 item:** "Smart version-history grouping. Replace (or augment) the current time-window-based snapshotting with dynamic grouping closer to Google Docs' behavior: continuous edits within a session collapse into one entry, a real gap starts a new one, and small in-between changes nest under the session they belong to. Needs its own grouping algorithm design. Bundle in diff display between versions (already tracked as a deferred consideration from the original Version History feature)."

## Scope

Two independent but currently identical snapshotting implementations both change: `client/src/history.ts` (local, never-shared documents — IndexedDB) and `src/workspace-room.ts` (shared documents — Durable Object storage). Both currently capture at most one snapshot per fixed 5-minute window, capped at 50 total snapshots, with no concept of "session." This item replaces that with:

1. Much finer-grained capture (30 seconds instead of 5 minutes), so there is real fine-grained history to show.
2. A pure, timestamp-derived grouping of snapshots into "sessions" — a run of edits with no gap over 30 minutes — computed on read, not stored as a field.
3. Pruning a session's intermediate snapshots down to just its final state the moment that session is detected to have closed, keeping storage bounded even at the new finer capture cadence.
4. A collapsible session-grouped list UI in `VersionHistory.svelte`, replacing today's flat list.
5. Extending the existing Diff view (today: selected snapshot vs. the live document only) to compare any two selected historical entries against each other.

## Goal

Opening Version History shows a list grouped by editing session ("Today, 2:00–2:45 PM · 12 edits") instead of a flat list of sparse 5-minute-apart snapshots. Expanding a session reveals every fine-grained snapshot captured within it, each individually selectable and restorable. Any two entries — across sessions, or a session entry against the live document — can be diffed against each other.

## Non-goals (deferred)

- **No user-configurable capture interval or session-gap threshold.** Both are fixed constants (30 seconds, 30 minutes) — YAGNI, no settings UI for this.
- **No changes to repo-commit history or its own list/diff behavior.** Commits stay exactly as they render today — their own always-flat, always-expanded rows in the same sorted list, never grouped into or breaking a session's continuity.
- **No retroactive migration of already-stored snapshots.** Grouping is computed purely from each snapshot's existing `timestamp` field — history captured before this ships groups correctly the very first time the new code runs, with no backfill step needed.
- **No cross-document session concept.** Sessions are per-document, exactly like snapshots already are.

## Components

### `client/src/version-grouping.ts` (new)

A pure module with no I/O, mirroring the shape of `mmd-citations.ts`/`mmd-inline-blocks.ts` — small, focused, independently testable.

```ts
export interface SnapshotLike {
  id: string;
  timestamp: number;
}

export interface SessionGroup<T extends SnapshotLike> {
  entries: T[]; // oldest first, same order as input
  startTimestamp: number; // entries[0].timestamp
  endTimestamp: number; // entries[entries.length - 1].timestamp
}

export const SESSION_GAP_MS = 30 * 60 * 1000;

// Input must already be sorted oldest-first (both history.ts's and
// workspace-room.ts's stored snapshot arrays already are). Starts a new
// group whenever the gap to the previous entry's timestamp exceeds
// sessionGapMs; a single lone snapshot is its own one-entry group.
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
```

Used by three call sites: `history.ts`'s write-time pruning, `VersionHistory.svelte`'s display grouping, and its own duplicate in `src/version-grouping.ts` for `workspace-room.ts`'s write-time pruning (client and Worker code don't cross-import in this repo — same intentional-duplication pattern already used for citation-block serialization between `app.ts` and `repo-sync.ts`).

### `client/src/history.ts` (modified)

- `SNAPSHOT_INTERVAL_MS` changes from `5 * 60 * 1000` to `30 * 1000`.
- `MAX_SNAPSHOTS` changes from `50` to `300`.
- `appendSnapshot`'s caller (`maybeSnapshotVersion`) gains a pruning step before appending: group the existing snapshots via `groupSnapshotsIntoSessions`; if the last group's `endTimestamp` is more than `SESSION_GAP_MS` before `now` (meaning that group has just closed), replace that group's snapshots in the stored array with only its last entry before appending the new snapshot. A still-open last group (gap within threshold) is left untouched.

### `src/version-grouping.ts` (new, Worker-side duplicate)

Identical `groupSnapshotsIntoSessions`/`SessionGroup`/`SESSION_GAP_MS` to the client copy above, used only by `workspace-room.ts`.

### `src/workspace-room.ts` (modified)

- The inline `SNAPSHOT_INTERVAL_MS` in `maybeSnapshot` changes from `5 * 60 * 1000` to `30 * 1000`; its `50`-entry cap becomes `300`.
- `maybeSnapshot` gains the same pre-append pruning step as `history.ts`'s `appendSnapshot`, using `src/version-grouping.ts`'s copy of the function.

### `client/src/components/VersionHistory.svelte` (modified)

- `loadVersions()` unchanged in what it fetches; after building `localEntries` (already tagged `kind: "local"`), group just that subset via `groupSnapshotsIntoSessions`, then merge each group's entries back into the combined, timestamp-sorted list as a new `kind: "session"` wrapper entry (single-entry groups render as a plain `kind: "local"` row exactly as today — no wrapper, nothing to expand):

  ```ts
  interface SessionEntry {
    kind: "session";
    id: string; // the group's first entry's id, stable across re-renders
    timestamp: number; // endTimestamp — sorts with the rest of the list by recency
    startTimestamp: number;
    endTimestamp: number;
    entries: LocalEntry[];
  }
  type HistoryEntry = LocalEntry | CommitEntry | SessionEntry;
  ```

- A session row renders a computed label (new helper `formatSessionLabel(startTimestamp, endTimestamp, count)`: same-day → `"Today, 2:00–2:45 PM · 12 edits"`/`"Aug 27, 2:00–2:45 PM · 12 edits"`; spanning days → `"Aug 27, 9:10 AM – Aug 28, 6:40 PM · 40 edits"`) plus an expand chevron; clicking the chevron toggles a `$state<Set<string>>` of expanded session ids, revealing its `entries` as indented rows directly beneath, each behaving exactly like today's plain local rows (clickable, selectable).
- Selection becomes two named slots instead of one: `selectedA: HistoryEntry | null` (defaults to `null`, meaning "the live document") and `selectedB: HistoryEntry | null` (the primary/most-recently-clicked selection — defaults to the newest entry, matching today's `selectVersion(doc, isShared, versions[0])` initial behavior). A small "Comparing against: [Live document ▾]" control above the Diff toggle lets A be reassigned to any entry via a picker, or reset back to "Live document." Clicking a row always sets B (matching today's single-click UX); the content-loading logic already in `selectVersion` is reused for whichever slot changed.
- `viewMode === "diff"` renders `<DiffView before={contentFor(selectedA) ?? $activeDocContent} after={contentFor(selectedB)} beforeImages={imagesFor(selectedA)} afterImages={imagesFor(selectedB) ?? getActiveDoc()?.images} />`, where `contentFor`/`imagesFor` are small helpers reading from a `Map<entryId, {content, images}>` cache populated by `selectVersion` (replacing today's single `selectedContent`/`selectedImages` state pair) — avoids re-fetching a slot's content on every re-render.
- `restore()` is unchanged in effect — it always restores slot B's content, exactly like today's `selectedContent`/`selectedEntry`, just renamed.

## Testing

- `tests/client/src/version-grouping.test.ts` (new): single session for edits within the gap, a real gap starts a new group, a lone far-apart snapshot is its own one-entry group, empty input returns `[]`, and grouping is order-preserving (doesn't need pre-sorted input to already be sorted — actually consumed pre-sorted, so this test also asserts sortedness is assumed, not enforced, matching the stated input contract).
- `tests/client/src/history.test.ts` (extended, if it exists — otherwise new): the write-time pruning behavior — appending after a session-closing gap collapses the prior session to one entry; appending within an open session does not prune anything.
- `tests/src/workspace-room.test.ts` (extended): equivalent pruning coverage for `maybeSnapshot`, server-side.
- `tests/client/src/components/VersionHistory.test.ts` (new, `vitest-browser-svelte`): session rows render collapsed by default with the correct label; expanding reveals nested entries; selecting two different entries and switching to Diff view passes the right `before`/`after` props (verified via a stubbed `DiffView` or by asserting on rendered diff-row content).
- New Playwright e2e test (`tests/e2e/local/`): typing in two bursts with a simulated gap between them (advancing the fake snapshot clock, not a real 30-minute wait) produces two distinct session rows in Version History; expanding one reveals its nested snapshots; selecting two entries and viewing Diff shows a real diff between them, not against the live document.

## Versioning

User-facing change to Version History's UI and behavior: minor version bump, `CHANGELOG.md` entry, and a `whats-new-entries.ts` entry with a real screenshot, per this repo's versioning convention.
