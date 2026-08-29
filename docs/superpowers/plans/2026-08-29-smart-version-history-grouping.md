# Smart Version-History Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed 5-minute snapshot throttle with 30-second capture plus timestamp-derived session grouping, pruning closed sessions to their final state, and surface this as collapsible session rows in Version History with the ability to diff any two selected entries.

**Architecture:** A new pure grouping function (duplicated once, client and Worker sides) drives both write-time pruning (in `history.ts` and `workspace-room.ts`) and read-time display grouping (in `VersionHistory.svelte`) from the exact same algorithm, with no schema changes to stored snapshots.

**Tech Stack:** TypeScript, Svelte 5, IndexedDB (`fake-indexeddb` in tests), Cloudflare Durable Object storage, Vitest (`unit` + `components` projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-29-smart-version-history-grouping-design.md`

## Global Constraints

- `SESSION_GAP_MS` = 30 minutes (fixed constant, not user-configurable).
- Capture interval drops from 5 minutes to 30 seconds, in both `client/src/history.ts` and `src/workspace-room.ts`.
- `MAX_SNAPSHOTS` rises from 50 to 300, in both files.
- No stored-snapshot schema change — session grouping is always computed from existing `timestamp` fields, never persisted as a field.
- Pruning only ever collapses a session once it has actually closed (gap since its last entry exceeds `SESSION_GAP_MS`); a still-open session is never touched.
- Repo commit entries are excluded from grouping entirely — no changes to their own behavior.
- User-facing change: minor version bump, `CHANGELOG.md` entry, `whats-new-entries.ts` entry with a real screenshot.

---

### Task 1: `version-grouping.ts` — pure grouping function (client + Worker copies)

**Files:**
- Create: `client/src/version-grouping.ts`
- Create: `src/version-grouping.ts`
- Test: `tests/client/src/version-grouping.test.ts`
- Test: `tests/src/version-grouping.test.ts`

**Interfaces:**
- Produces: `SnapshotLike { id: string; timestamp: number }`, `SessionGroup<T> { entries: T[]; startTimestamp: number; endTimestamp: number }`, `SESSION_GAP_MS: number`, `groupSnapshotsIntoSessions<T extends SnapshotLike>(snapshots: T[], sessionGapMs?: number): SessionGroup<T>[]` — consumed by Task 2 (`history.ts`), Task 3 (`workspace-room.ts`), Task 4 (`VersionHistory.svelte`).

- [ ] **Step 1: Write the failing tests (client copy)**

```ts
// tests/client/src/version-grouping.test.ts
import { describe, it, expect } from "vitest";
import { groupSnapshotsIntoSessions, SESSION_GAP_MS } from "../../../client/src/version-grouping";

describe("groupSnapshotsIntoSessions", () => {
  it("returns an empty array for no snapshots", () => {
    expect(groupSnapshotsIntoSessions([])).toEqual([]);
  });

  it("puts a single snapshot into its own one-entry group", () => {
    const groups = groupSnapshotsIntoSessions([{ id: "a", timestamp: 1000 }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(["a"]);
    expect(groups[0]!.startTimestamp).toBe(1000);
    expect(groups[0]!.endTimestamp).toBe(1000);
  });

  it("groups consecutive snapshots within the gap into one session", () => {
    const groups = groupSnapshotsIntoSessions([
      { id: "a", timestamp: 0 },
      { id: "b", timestamp: 5 * 60 * 1000 },
      { id: "c", timestamp: 10 * 60 * 1000 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(groups[0]!.startTimestamp).toBe(0);
    expect(groups[0]!.endTimestamp).toBe(10 * 60 * 1000);
  });

  it("starts a new group when the gap exceeds the threshold", () => {
    const groups = groupSnapshotsIntoSessions([
      { id: "a", timestamp: 0 },
      { id: "b", timestamp: 40 * 60 * 1000 },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(["a"]);
    expect(groups[1]!.entries.map((e) => e.id)).toEqual(["b"]);
  });

  it("respects a custom sessionGapMs", () => {
    const groups = groupSnapshotsIntoSessions(
      [
        { id: "a", timestamp: 0 },
        { id: "b", timestamp: 5000 },
      ],
      1000,
    );
    expect(groups).toHaveLength(2);
  });

  it("exports the default 30-minute session gap", () => {
    expect(SESSION_GAP_MS).toBe(30 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run the client test to verify it fails**

Run: `npx vitest run tests/client/src/version-grouping.test.ts`
Expected: FAIL — `Cannot find module '../../../client/src/version-grouping'`

- [ ] **Step 3: Implement the client copy**

```ts
// client/src/version-grouping.ts
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
```

- [ ] **Step 4: Run the client test to verify it passes**

Run: `npx vitest run tests/client/src/version-grouping.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Write the failing test for the Worker copy**

```ts
// tests/src/version-grouping.test.ts
import { describe, it, expect } from "vitest";
import { groupSnapshotsIntoSessions, SESSION_GAP_MS } from "../../src/version-grouping";

describe("groupSnapshotsIntoSessions (Worker copy)", () => {
  it("returns an empty array for no snapshots", () => {
    expect(groupSnapshotsIntoSessions([])).toEqual([]);
  });

  it("groups consecutive snapshots within the gap into one session", () => {
    const groups = groupSnapshotsIntoSessions([
      { id: "a", timestamp: 0 },
      { id: "b", timestamp: 5 * 60 * 1000 },
    ]);
    expect(groups).toHaveLength(1);
  });

  it("starts a new group when the gap exceeds the threshold", () => {
    const groups = groupSnapshotsIntoSessions([
      { id: "a", timestamp: 0 },
      { id: "b", timestamp: 40 * 60 * 1000 },
    ]);
    expect(groups).toHaveLength(2);
  });

  it("exports the default 30-minute session gap", () => {
    expect(SESSION_GAP_MS).toBe(30 * 60 * 1000);
  });
});
```

- [ ] **Step 6: Run the Worker test to verify it fails**

Run: `npx vitest run tests/src/version-grouping.test.ts`
Expected: FAIL — `Cannot find module '../../src/version-grouping'`

- [ ] **Step 7: Implement the Worker copy**

Create `src/version-grouping.ts` with byte-for-byte the same content as `client/src/version-grouping.ts` from Step 3 above.

- [ ] **Step 8: Run the Worker test to verify it passes**

Run: `npx vitest run tests/src/version-grouping.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 9: Typecheck and commit**

```bash
npm run typecheck
git add client/src/version-grouping.ts src/version-grouping.ts tests/client/src/version-grouping.test.ts tests/src/version-grouping.test.ts
git commit -m "feat: add pure session-grouping function for version history"
```

---

### Task 2: `history.ts` — finer capture, raised cap, session pruning

**Files:**
- Modify: `client/src/history.ts`
- Test: `tests/client/src/history.test.ts`

**Interfaces:**
- Consumes: `groupSnapshotsIntoSessions`, `SESSION_GAP_MS` (Task 1).

- [ ] **Step 1: Update the two tests whose numbers depend on the old constants**

In `tests/client/src/history.test.ts`, change:

```ts
  it("does not snapshot before the throttle window elapses", async () => {
    await maybeSnapshotVersion("doc-throttle-skip", "hello", 1_000);
    await maybeSnapshotVersion("doc-throttle-skip", "hello world", 1_000 + 4 * 60 * 1000);
    expect(await listVersions("doc-throttle-skip")).toHaveLength(1);
  });
```

to:

```ts
  it("does not snapshot before the throttle window elapses", async () => {
    await maybeSnapshotVersion("doc-throttle-skip", "hello", 1_000);
    await maybeSnapshotVersion("doc-throttle-skip", "hello world", 1_000 + 20 * 1000);
    expect(await listVersions("doc-throttle-skip")).toHaveLength(1);
  });
```

Change:

```ts
  it("prunes the oldest snapshot past the 50 cap", async () => {
    for (let i = 0; i < 51; i++) {
      await maybeSnapshotVersion("doc-cap", `v${i}`, 1_000 + i * 6 * 60 * 1000);
    }
    const versions = await listVersions("doc-cap");
    expect(versions).toHaveLength(50);
  });
```

to:

```ts
  it("prunes the oldest snapshot past the 300 cap", async () => {
    for (let i = 0; i < 301; i++) {
      await maybeSnapshotVersion("doc-cap", `v${i}`, 1_000 + i * 35 * 1000);
    }
    const versions = await listVersions("doc-cap");
    expect(versions).toHaveLength(300);
  });
```

(35-second steps stay above the new 30-second throttle so every call captures, and stay far below the 30-minute session gap so this test exercises only the raw cap eviction, not session pruning.)

Change:

```ts
  it("re-sorts by timestamp and re-caps at 50 after merging", async () => {
    for (let i = 0; i < 40; i++) {
      await maybeSnapshotVersion("doc-merge-cap", `v${i}`, 1_000 + i * 6 * 60 * 1000);
    }
    const remote = Array.from({ length: 20 }, (_, i) => ({
      id: `remote-${i}`,
      timestamp: 1_000 + (40 + i) * 6 * 60 * 1000,
      content: `remote v${i}`,
    }));
    await mergeSnapshotsFromRepo("doc-merge-cap", remote);
    const versions = await listVersions("doc-merge-cap");
    expect(versions).toHaveLength(50);
    // listVersions reverses to newest-first — the newest merged-in remote entry must survive the cap
    expect(versions[0]!.id).toBe("remote-19");
  });
```

to:

```ts
  it("re-sorts by timestamp and re-caps at 300 after merging", async () => {
    for (let i = 0; i < 280; i++) {
      await maybeSnapshotVersion("doc-merge-cap", `v${i}`, 1_000 + i * 35 * 1000);
    }
    const remote = Array.from({ length: 40 }, (_, i) => ({
      id: `remote-${i}`,
      timestamp: 1_000 + (280 + i) * 35 * 1000,
      content: `remote v${i}`,
    }));
    await mergeSnapshotsFromRepo("doc-merge-cap", remote);
    const versions = await listVersions("doc-merge-cap");
    expect(versions).toHaveLength(300);
    // listVersions reverses to newest-first — the newest merged-in remote entry must survive the cap
    expect(versions[0]!.id).toBe("remote-39");
  });
```

- [ ] **Step 2: Write the new failing tests for session pruning**

Add to the `describe("local version history", ...)` block:

```ts
  it("keeps every snapshot within a still-open session", async () => {
    await maybeSnapshotVersion("doc-open-session", "v0", 1_000);
    await maybeSnapshotVersion("doc-open-session", "v1", 1_000 + 35 * 1000);
    await maybeSnapshotVersion("doc-open-session", "v2", 1_000 + 70 * 1000);
    expect(await listVersions("doc-open-session")).toHaveLength(3);
  });

  it("collapses a closed session to its final snapshot once a new session starts", async () => {
    await maybeSnapshotVersion("doc-closed-session", "v0", 1_000);
    await maybeSnapshotVersion("doc-closed-session", "v1", 1_000 + 35 * 1000);
    await maybeSnapshotVersion("doc-closed-session", "v2", 1_000 + 70 * 1000);
    // A gap over 30 minutes closes the session "v0, v1, v2" belong to.
    await maybeSnapshotVersion("doc-closed-session", "v3", 1_000 + 70 * 1000 + 31 * 60 * 1000);
    const versions = await listVersions("doc-closed-session");
    // listVersions reverses to newest-first.
    expect(versions.map((v) => v.id).length).toBe(2);
    expect(await getVersionContent("doc-closed-session", versions[1]!.id)).toBe("v2");
    expect(await getVersionContent("doc-closed-session", versions[0]!.id)).toBe("v3");
  });
```

- [ ] **Step 3: Run the tests to verify the new ones fail and the updated ones now match current (unfixed) behavior**

Run: `npx vitest run tests/client/src/history.test.ts`
Expected: FAIL — the two renamed cap tests fail (still capping at the old 50), and the two new session-pruning tests fail (`doc-closed-session` has no pruning yet, so it has 4 entries, not 2)

- [ ] **Step 4: Implement the changes in `history.ts`**

Add the import near the top of `client/src/history.ts`:

```ts
import { groupSnapshotsIntoSessions, SESSION_GAP_MS } from "./version-grouping";
```

Change the two constants:

```ts
const SNAPSHOT_INTERVAL_MS = 30 * 1000;
const MAX_SNAPSHOTS = 300;
```

Change `maybeSnapshotVersion`:

```ts
export async function maybeSnapshotVersion(docId: string, content: string, now: number = Date.now(), images?: Record<string, string>): Promise<void> {
  try {
    let snapshots = await getHistory(docId);
    const last = snapshots[snapshots.length - 1];
    if (last) {
      if (now - last.timestamp < SNAPSHOT_INTERVAL_MS) return;
      if (last.content === content) return;
      // The most recent session may have just closed (nothing captured
      // in the last SESSION_GAP_MS) — if so, collapse it down to its
      // final snapshot now, before this new one starts a fresh session.
      // A still-open session (small gap) is left untouched.
      const groups = groupSnapshotsIntoSessions(snapshots);
      const lastGroup = groups[groups.length - 1]!;
      if (now - lastGroup.endTimestamp > SESSION_GAP_MS && lastGroup.entries.length > 1) {
        const idsToKeep = new Set(snapshots.map((s) => s.id));
        for (const entry of lastGroup.entries.slice(0, -1)) idsToKeep.delete(entry.id);
        snapshots = snapshots.filter((s) => idsToKeep.has(s.id));
      }
    }
    snapshots.push({ id: uid(), timestamp: now, content, images });
    while (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();
    await putHistory(docId, snapshots);
  } catch (err) {
    // best-effort — see comment above
  }
}
```

(`appendSnapshot` itself is unchanged — `restoreLocalVersion`/`restoreLocalVersionContent` still call it directly for their force-append-bypassing-throttle behavior, which stays exactly as it is today.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/client/src/history.test.ts`
Expected: PASS (all tests, including the full pre-existing suite)

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add client/src/history.ts tests/client/src/history.test.ts
git commit -m "feat: capture finer-grained local history and prune closed sessions"
```

---

### Task 3: `workspace-room.ts` — same changes, server side

**Files:**
- Modify: `src/workspace-room.ts`
- Test: `tests/src/workspace-room.test.ts`

**Interfaces:**
- Consumes: `groupSnapshotsIntoSessions`, `SESSION_GAP_MS` from `src/version-grouping.ts` (Task 1).

- [ ] **Step 1: Update the test file's own interval constant**

In `tests/src/workspace-room.test.ts`, change:

```ts
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
```

to:

```ts
const SNAPSHOT_INTERVAL_MS = 30 * 1000;
```

(The existing "throttles snapshots within the interval" test uses `SNAPSHOT_INTERVAL_MS - 1` as a relative offset, so it stays correct against the new value with no other change.)

- [ ] **Step 2: Write the new failing tests**

Add to the `describe("WorkspaceRoom version snapshots", ...)` block, right after the existing `"forceSnapshot also captures images"` test:

```ts
  it("caps snapshots at 300", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const docRoom = await room.loadDocRoom("docA");
    for (let i = 0; i < 301; i++) {
      docRoom.doc.transact(() => {
        const text = docRoom.doc.getText("content");
        text.delete(0, text.length);
        text.insert(0, `v${i}`);
      }, "storage");
      await room.maybeSnapshot("docA", docRoom, 1000 + i * 35 * 1000);
    }
    expect(await room.getSnapshots("docA")).toHaveLength(300);
  });

  it("collapses a closed session to its final snapshot once a new session starts", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const docRoom = await room.loadDocRoom("docA");
    const setContent = (text: string) =>
      docRoom.doc.transact(() => {
        const t = docRoom.doc.getText("content");
        t.delete(0, t.length);
        t.insert(0, text);
      }, "storage");
    setContent("v0");
    await room.maybeSnapshot("docA", docRoom, 1000);
    setContent("v1");
    await room.maybeSnapshot("docA", docRoom, 1000 + 35 * 1000);
    setContent("v2");
    await room.maybeSnapshot("docA", docRoom, 1000 + 70 * 1000);
    // A gap over 30 minutes closes the session "v0, v1, v2" belong to.
    setContent("v3");
    await room.maybeSnapshot("docA", docRoom, 1000 + 70 * 1000 + 31 * 60 * 1000);
    const snapshots = await room.getSnapshots("docA");
    expect(snapshots.map((s) => s.content)).toEqual(["v2", "v3"]);
  });
```

- [ ] **Step 3: Run the tests to verify the new ones fail**

Run: `npx vitest run tests/src/workspace-room.test.ts`
Expected: FAIL — the cap test still allows unlimited growth past 300 under the old cap logic path (actually still capped at 50 currently, so this fails differently — the assertion of exactly 300 fails either way until Step 4 lands both the new cap AND pruning); the session-pruning test fails (currently keeps all 4 snapshots, not 2)

- [ ] **Step 4: Implement the changes in `workspace-room.ts`**

Add the import near the top of `src/workspace-room.ts`:

```ts
import { groupSnapshotsIntoSessions, SESSION_GAP_MS } from "./version-grouping";
```

Change `maybeSnapshot`:

```ts
  async maybeSnapshot(docId: string, docRoom: DocRoom, now: number = Date.now()): Promise<void> {
    const SNAPSHOT_INTERVAL_MS = 30 * 1000;
    if (docRoom.lastSnapshotAt !== undefined && now - docRoom.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
    const content = docRoom.doc.getText("content").toString();
    let snapshots = await this.getSnapshots(docId);
    const last = snapshots[snapshots.length - 1];
    if (last && last.content === content) {
      docRoom.lastSnapshotAt = last.timestamp;
      return;
    }
    if (last) {
      const groups = groupSnapshotsIntoSessions(snapshots);
      const lastGroup = groups[groups.length - 1]!;
      if (now - lastGroup.endTimestamp > SESSION_GAP_MS && lastGroup.entries.length > 1) {
        const idsToKeep = new Set(snapshots.map((s) => s.id));
        for (const entry of lastGroup.entries.slice(0, -1)) idsToKeep.delete(entry.id);
        snapshots = snapshots.filter((s) => idsToKeep.has(s.id));
      }
    }
    snapshots.push({ id: uid(), timestamp: now, content, images: this.imagesFromDoc(docRoom) });
    while (snapshots.length > 300) snapshots.shift();
    await this.state.storage.put(docStorageKey(docId, "snapshots"), snapshots);
    docRoom.lastSnapshotAt = now;
  }
```

(`forceSnapshot` is unchanged — restore paths keep bypassing throttle/pruning entirely, exactly as `appendSnapshot` does on the client side.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/src/workspace-room.test.ts`
Expected: PASS (all tests, including the full pre-existing suite)

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "feat: capture finer-grained shared-doc history and prune closed sessions"
```

---

### Task 4: `VersionHistory.svelte` — collapsible session rows

**Files:**
- Modify: `client/src/components/VersionHistory.svelte`
- Modify: `client/src/styles/_diff-view.scss`
- Test: `tests/client/src/components/VersionHistory.test.ts` (new)

**Interfaces:**
- Consumes: `groupSnapshotsIntoSessions` (Task 1, client copy).
- Produces: `SessionEntry` type, `formatSessionLabel(start, end, count): string`, `toggleSession(id): void` — consumed by Task 5.

- [ ] **Step 1: Write the failing component test**

```ts
// tests/client/src/components/VersionHistory.test.ts
import "fake-indexeddb/auto";
import { test, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import VersionHistory from "../../../../client/src/components/VersionHistory.svelte";
import { versionHistoryOpen } from "../../../../client/src/stores/versionHistory";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";
import { workspacesStore } from "../../../../client/src/stores/workspaces";
import { maybeSnapshotVersion, deleteHistory } from "../../../../client/src/history";

const DOC_ID = "vh-test-doc";

beforeEach(async () => {
  window.MDE = { getEditor: () => ({ state: { readOnly: false } }), formatRelativeTime: () => "just now" } as unknown as typeof window.MDE;
  await deleteHistory(DOC_ID);
  workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
  docsStore.set([{ id: DOC_ID, name: "Test", content: "v3", updatedAt: 0, createdAt: 0, workspaceId: "w1" }]);
  activeIdStore.set(DOC_ID);
  versionHistoryOpen.set(false);
});

test("groups snapshots from the same session into one collapsible row", async () => {
  await maybeSnapshotVersion(DOC_ID, "v0", 1_000);
  await maybeSnapshotVersion(DOC_ID, "v1", 1_000 + 35 * 1000);
  await maybeSnapshotVersion(DOC_ID, "v2", 1_000 + 70 * 1000);

  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);

  await expect.element(screen.getByText(/3 edits/)).toBeVisible();
  // Nested rows use formatTimestamp's full toLocaleString() (includes the
  // year); the session label uses a short month/day format with no year
  // (see formatSessionLabel below) — "1970" (these snapshots' epoch-ms
  // timestamps land on Jan 1 1970) only ever appears in a nested row's
  // own text, never in the collapsed session header's label, so counting
  // it is a locale-format-independent way to detect nested rows without
  // depending on exact time-string punctuation.
  expect((await screen.getByText(/1970/).all()).length).toBe(0);
});

test("expanding a session reveals its nested snapshots, collapsing hides them again", async () => {
  await maybeSnapshotVersion(DOC_ID, "v0", 1_000);
  await maybeSnapshotVersion(DOC_ID, "v1", 1_000 + 35 * 1000);

  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);
  await expect.element(screen.getByText(/2 edits/)).toBeVisible();

  await screen.getByText(/2 edits/).click();
  expect((await screen.getByText(/1970/).all()).length).toBe(2);

  await screen.getByText(/2 edits/).click();
  expect((await screen.getByText(/1970/).all()).length).toBe(0);
});

test("a session with only one snapshot renders as a plain row, not a group", async () => {
  await maybeSnapshotVersion(DOC_ID, "v0", 1_000);

  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);

  expect((await screen.getByText(/edits/).all())).toHaveLength(0);
  expect((await screen.getByText(/1970/).all()).length).toBe(1);
});
```

(This doc has no `repoPath` and its workspace has no `shared`/`repoLink`, so `loadVersions()` never calls `window.MDE.getEditor()`, `fetch`, or `loadCommitEntries`'s repo path — only the stubbed `getEditor` above is needed as a safety net for `restoreAllowed`'s short-circuited `!isShared` check.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project=components tests/client/src/components/VersionHistory.test.ts`
Expected: FAIL — no session grouping exists yet, so every snapshot renders as its own plain row and no "N edits" text exists

- [ ] **Step 3: Implement session grouping in `VersionHistory.svelte`**

Add the import alongside the existing ones:

```ts
  import { groupSnapshotsIntoSessions } from "../version-grouping";
```

Change the `HistoryEntry` type definitions:

```ts
  interface LocalEntry {
    kind: "local";
    id: string;
    timestamp: number;
  }
  interface CommitEntry {
    kind: "commit";
    id: string;
    timestamp: number;
    message: string;
    author: string;
    html_url: string;
  }
  interface SessionEntry {
    kind: "session";
    id: string;
    timestamp: number;
    startTimestamp: number;
    endTimestamp: number;
    entries: LocalEntry[];
  }
  type HistoryEntry = LocalEntry | CommitEntry | SessionEntry;
```

Add state for which sessions are expanded, and the label helper, right after the existing `let restoreAllowed = $state(true);`:

```ts
  let expandedSessions = $state<Set<string>>(new Set());

  function toggleSession(id: string) {
    const next = new Set(expandedSessions);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedSessions = next;
  }

  function formatSessionLabel(start: number, end: number, count: number): string {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const sameDay = startDate.toDateString() === endDate.toDateString();
    const dateLabel = (d: Date) => (d.toDateString() === new Date().toDateString() ? "Today" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    const timeLabel = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const range = sameDay
      ? `${dateLabel(startDate)}, ${timeLabel(startDate)}–${timeLabel(endDate)}`
      : `${dateLabel(startDate)}, ${timeLabel(startDate)} – ${dateLabel(endDate)}, ${timeLabel(endDate)}`;
    return `${range} · ${count} edit${count === 1 ? "" : "s"}`;
  }
```

Change `loadVersions()`'s entry-building step:

```ts
    const localList = isShared ? await listSharedVersions(doc.workspaceId, doc.id) : await listVersions(doc.id);
    const localEntries: HistoryEntry[] = localList.map((v) => ({ kind: "local" as const, id: v.id, timestamp: v.timestamp }));
    const commitEntries: HistoryEntry[] = await loadCommitEntries(doc);
    versions = [...localEntries, ...commitEntries].sort((a, b) => b.timestamp - a.timestamp);
```

to:

```ts
    const localList = isShared ? await listSharedVersions(doc.workspaceId, doc.id) : await listVersions(doc.id);
    const localEntries: LocalEntry[] = localList.map((v) => ({ kind: "local" as const, id: v.id, timestamp: v.timestamp }));
    const groupedLocalEntries: HistoryEntry[] = groupSnapshotsIntoSessions(localEntries).map((g) =>
      g.entries.length > 1
        ? { kind: "session" as const, id: g.entries[0]!.id, timestamp: g.endTimestamp, startTimestamp: g.startTimestamp, endTimestamp: g.endTimestamp, entries: g.entries }
        : g.entries[0]!,
    );
    const commitEntries: HistoryEntry[] = await loadCommitEntries(doc);
    versions = [...groupedLocalEntries, ...commitEntries].sort((a, b) => b.timestamp - a.timestamp);
```

`loadVersions()`'s own tail still auto-selects `versions[0]` on load — but `versions[0]` can now be a `SessionEntry` wrapper instead of a real leaf entry, which `selectVersion` doesn't know how to load content for. Change:

```ts
    if (versions.length > 0) await selectVersion(doc, isShared, versions[0]!);
```

to:

```ts
    if (versions.length > 0) {
      const first = versions[0]!;
      const initial = first.kind === "session" ? first.entries[first.entries.length - 1]! : first;
      await selectVersion(doc, isShared, initial);
    }
```

(`entries` is oldest-first, so its last element is the session's own newest snapshot — the correct thing to auto-select when the newest overall entry happens to be collapsed inside a session.)

Change the list-rendering template block:

```svelte
          {#each versions as v, i (v.id)}
            <button
              type="button"
              class="version-history-row"
              class:active={v.id === selectedId}
              onclick={() => selectVersion(getActiveDoc(), isDocShared(getActiveDoc()), v)}
            >
              <span class="version-history-row-label">
                {#if v.kind === "commit"}
                  <svg class="icon"><use href="#icon-github"></use></svg>
                  {v.message}
                {:else}
                  {formatTimestamp(v.timestamp)}
                {/if}
              </span>
              {#if i === 0}<span class="version-history-current">(current)</span>{/if}
            </button>
          {/each}
```

to:

```svelte
          {#each versions as v, i (v.id)}
            {#if v.kind === "session"}
              <div class="version-history-session">
                <button type="button" class="version-history-row version-history-session-header" onclick={() => toggleSession(v.id)}>
                  <span class="version-history-row-label">
                    <svg class="icon version-history-chevron" class:expanded={expandedSessions.has(v.id)}><use href="#icon-chevron-right"></use></svg>
                    {formatSessionLabel(v.startTimestamp, v.endTimestamp, v.entries.length)}
                  </span>
                  {#if i === 0}<span class="version-history-current">(includes current)</span>{/if}
                </button>
                {#if expandedSessions.has(v.id)}
                  {#each [...v.entries].reverse() as nested, ni (nested.id)}
                    <button
                      type="button"
                      class="version-history-row version-history-nested-row"
                      class:active={nested.id === selectedId}
                      onclick={() => selectVersion(getActiveDoc(), isDocShared(getActiveDoc()), nested)}
                    >
                      <span class="version-history-row-label">{formatTimestamp(nested.timestamp)}</span>
                      {#if i === 0 && ni === 0}<span class="version-history-current">(current)</span>{/if}
                    </button>
                  {/each}
                {/if}
              </div>
            {:else}
              <button
                type="button"
                class="version-history-row"
                class:active={v.id === selectedId}
                onclick={() => selectVersion(getActiveDoc(), isDocShared(getActiveDoc()), v)}
              >
                <span class="version-history-row-label">
                  {#if v.kind === "commit"}
                    <svg class="icon"><use href="#icon-github"></use></svg>
                    {v.message}
                  {:else}
                    {formatTimestamp(v.timestamp)}
                  {/if}
                </span>
                {#if i === 0}<span class="version-history-current">(current)</span>{/if}
              </button>
            {/if}
          {/each}
```

(`v.entries` is oldest-first per `groupSnapshotsIntoSessions`'s contract — reversing for display keeps the whole panel newest-first, consistent with the top-level list's own ordering. `i === 0 && ni === 0` after reversal identifies the single overall-newest entry when it's nested inside the top session.)

- [ ] **Step 4: Add the new SCSS**

Add to `client/src/styles/_diff-view.scss`, next to the other `.version-history-*` rules:

```scss
.version-history-session-header {
  font-weight: 600;
}
.version-history-chevron {
  width: 12px;
  height: 12px;
  transition: transform 0.15s;
}
.version-history-chevron.expanded {
  transform: rotate(90deg);
}
.version-history-nested-row {
  padding-left: 24px;
  font-size: 12.5px;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project=components tests/client/src/components/VersionHistory.test.ts`
Expected: PASS (all 3 tests)

- [ ] **Step 6: Typecheck, format, and commit**

```bash
npm run typecheck
npm run format
git add client/src/components/VersionHistory.svelte client/src/styles/_diff-view.scss tests/client/src/components/VersionHistory.test.ts
git commit -m "feat: group version history into collapsible sessions"
```

---

### Task 5: `VersionHistory.svelte` — diff between any two selected entries

**Files:**
- Modify: `client/src/components/VersionHistory.svelte`
- Modify: `client/src/styles/_diff-view.scss`
- Test: `tests/client/src/components/VersionHistory.test.ts`

**Interfaces:**
- Consumes: `SessionEntry`, `LocalEntry`, `CommitEntry`, `formatTimestamp` (Task 4, all already in this file).
- Produces: `compareId`/`compareContent`/`compareImages` state, `selectCompare(id: string): Promise<void>` — this task's own addition, not consumed elsewhere.

- [ ] **Step 1: Write the failing component test**

Add to `tests/client/src/components/VersionHistory.test.ts`:

```ts
test("the compare picker defaults to Live document and lists every historical entry", async () => {
  await maybeSnapshotVersion(DOC_ID, "v0", 1_000);
  // A 40-minute gap exceeds the 30-minute session gap, so v0 and v1 land
  // in two separate one-entry groups — both render as plain (ungrouped)
  // entries, so the compare picker's option count is deterministic:
  // "Live document" + v0 + v1 = 3.
  await maybeSnapshotVersion(DOC_ID, "v1", 1_000 + 40 * 60 * 1000);

  const screen = await render(VersionHistory);
  versionHistoryOpen.set(true);
  await screen.getByRole("button", { name: "Diff" }).click();

  const compareSelect = screen.getByLabelText("Compare against");
  await expect.element(compareSelect).toHaveValue("__live__");
  const options = await compareSelect.element().querySelectorAll("option");
  expect(options.length).toBe(3);
});
```

(This test only verifies the picker exists, defaults to "Live document," and has more than one real option — the underlying `DiffView` rendering itself already has coverage via `diff-lines.test.ts`/`DiffView`'s own usage elsewhere, so this stays focused on the new selection wiring rather than re-testing diff rendering.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project=components tests/client/src/components/VersionHistory.test.ts`
Expected: FAIL — no "Compare against" control exists yet

- [ ] **Step 3: Extract a reusable content-loading helper**

Change `selectVersion`'s body:

```ts
  async function selectVersion(doc: ReturnType<typeof getActiveDoc>, isShared: boolean, entry: HistoryEntry) {
    selectedId = entry.id;
    selectedEntry = entry;
    selectedContent = undefined;
    selectedImages = undefined;
    if (!doc) return;
    if (entry.kind === "local") {
      if (isShared) {
        const result = await getSharedVersionSnapshot(doc.workspaceId, doc.id, entry.id);
        if (result === undefined) {
          showToast("Couldn't load this version's content", "error");
          return;
        }
        selectedContent = result.content;
        selectedImages = result.images;
      } else {
        const content = await getVersionContent(doc.id, entry.id);
        if (content === undefined) {
          showToast("Couldn't load this version's content", "error");
          return;
        }
        selectedContent = content;
        selectedImages = await getVersionImages(doc.id, entry.id);
      }
    } else {
      const content = await fetchCommitContent(doc, entry.id);
      if (content === undefined) {
        showToast("Couldn't load this version's content", "error");
        return;
      }
      selectedContent = content;
      selectedImages = await fetchCommitImages(doc, entry.id, content);
    }
  }
```

to:

```ts
  async function loadEntryContent(
    doc: ReturnType<typeof getActiveDoc>,
    isShared: boolean,
    entry: LocalEntry | CommitEntry,
  ): Promise<{ content: string; images: Record<string, string> | undefined } | undefined> {
    if (!doc) return undefined;
    if (entry.kind === "local") {
      if (isShared) {
        const result = await getSharedVersionSnapshot(doc.workspaceId, doc.id, entry.id);
        if (result === undefined) {
          showToast("Couldn't load this version's content", "error");
          return undefined;
        }
        return result;
      }
      const content = await getVersionContent(doc.id, entry.id);
      if (content === undefined) {
        showToast("Couldn't load this version's content", "error");
        return undefined;
      }
      return { content, images: await getVersionImages(doc.id, entry.id) };
    }
    const content = await fetchCommitContent(doc, entry.id);
    if (content === undefined) {
      showToast("Couldn't load this version's content", "error");
      return undefined;
    }
    return { content, images: await fetchCommitImages(doc, entry.id, content) };
  }

  async function selectVersion(doc: ReturnType<typeof getActiveDoc>, isShared: boolean, entry: LocalEntry | CommitEntry) {
    selectedId = entry.id;
    selectedEntry = entry;
    selectedContent = undefined;
    selectedImages = undefined;
    const result = await loadEntryContent(doc, isShared, entry);
    if (result) {
      selectedContent = result.content;
      selectedImages = result.images;
    }
  }
```

- [ ] **Step 4: Add the compare-slot state and picker**

Add alongside the existing `selectedId`/`selectedEntry`/etc. state:

```ts
  let compareId = $state<string>("__live__");
  let compareContent = $state<string | undefined>(undefined);
  let compareImages = $state<Record<string, string> | undefined>(undefined);

  const flatEntries = $derived.by((): (LocalEntry | CommitEntry)[] =>
    versions.flatMap((v) => (v.kind === "session" ? v.entries : [v])),
  );

  function compareLabel(entry: LocalEntry | CommitEntry): string {
    return entry.kind === "commit" ? entry.message : formatTimestamp(entry.timestamp);
  }

  async function selectCompare(id: string) {
    compareId = id;
    compareContent = undefined;
    compareImages = undefined;
    if (id === "__live__") return;
    const doc = getActiveDoc();
    if (!doc) return;
    const entry = flatEntries.find((e) => e.id === id);
    if (!entry) return;
    const result = await loadEntryContent(doc, isDocShared(doc), entry);
    if (result) {
      compareContent = result.content;
      compareImages = result.images;
    }
  }
```

Reset the compare slot back to "Live document" whenever the panel loads a fresh document, at the end of `loadVersions()`:

```ts
    compareId = "__live__";
    compareContent = undefined;
    compareImages = undefined;
```

- [ ] **Step 5: Add the picker to the template and wire the Diff view**

Change the view-toggle block:

```svelte
        <div class="version-history-view-toggle">
          <button type="button" class:active={viewMode === "preview"} onclick={() => (viewMode = "preview")}>Preview</button>
          <button type="button" class:active={viewMode === "diff"} onclick={() => (viewMode = "diff")}>Diff</button>
        </div>
```

to:

```svelte
        <div class="version-history-view-toggle">
          <button type="button" class:active={viewMode === "preview"} onclick={() => (viewMode = "preview")}>Preview</button>
          <button type="button" class:active={viewMode === "diff"} onclick={() => (viewMode = "diff")}>Diff</button>
        </div>
        {#if viewMode === "diff"}
          <div class="version-history-compare-picker">
            <label for="versionCompareSelect">Compare against</label>
            <select id="versionCompareSelect" value={compareId} onchange={(e) => selectCompare((e.target as HTMLSelectElement).value)}>
              <option value="__live__">Live document</option>
              {#each flatEntries as entry (entry.id)}
                <option value={entry.id}>{compareLabel(entry)}</option>
              {/each}
            </select>
          </div>
        {/if}
```

Change the diff-mode `DiffView` usage:

```svelte
              <DiffView before={selectedContent} after={$activeDocContent} beforeImages={selectedImages} afterImages={getActiveDoc()?.images} />
```

to:

```svelte
              <DiffView
                before={selectedContent}
                after={compareId === "__live__" ? $activeDocContent : compareContent}
                beforeImages={selectedImages}
                afterImages={compareId === "__live__" ? getActiveDoc()?.images : compareImages}
              />
```

(`restore()` is unchanged — it still restores whatever `selectedEntry`/`selectedContent` holds, i.e. the row you clicked in the list, exactly as before this task.)

- [ ] **Step 6: Add the picker's SCSS**

Add to `client/src/styles/_diff-view.scss`:

```scss
.version-history-compare-picker {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px 0;
  font-size: 12.5px;
  color: var(--text-dim);

  select {
    font-family: inherit;
    font-size: 12.5px;
    padding: 3px 6px;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run --project=components tests/client/src/components/VersionHistory.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 8: Typecheck, format, and commit**

```bash
npm run typecheck
npm run format
git add client/src/components/VersionHistory.svelte client/src/styles/_diff-view.scss tests/client/src/components/VersionHistory.test.ts
git commit -m "feat: diff any two selected version history entries"
```

---

### Task 6: e2e coverage for grouped sessions and two-entry diff

**Files:**
- Create: `tests/e2e/local/version-history-grouping.spec.ts`

**Interfaces:**
- Consumes: the fully-wired feature from Tasks 1–5.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/e2e/local/version-history-grouping.spec.ts
import { test, expect } from "./support/fixtures";

test("a still-open session with several edits renders as one collapsible row", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.evaluate(async () => {
    const { maybeSnapshotVersion } = await import("/src/history.ts");
    const { getActiveDoc } = await import("/src/stores/docs.ts");
    const doc = getActiveDoc();
    if (!doc) throw new Error("no active doc");
    await maybeSnapshotVersion(doc.id, "v0", 1_000);
    await maybeSnapshotVersion(doc.id, "v1", 1_000 + 35_000);
    await maybeSnapshotVersion(doc.id, "v2", 1_000 + 70_000);
  });

  await page.click("#versionHistoryBtn");
  await expect(page.locator(".version-history-row-label", { hasText: "3 edits" })).toBeVisible();
});

test("a real gap prunes the closed session down to its final snapshot", async ({ page }) => {
  // Once "v3" lands 31 minutes after "v2", the write path detects the
  // "v0, v1, v2" session has closed and collapses it to just "v2" before
  // appending "v3" — a closed session is never shown with its full detail
  // again, only the still-open (most recent) one ever is. This test
  // asserts that pruning actually happened: exactly 2 rows exist and
  // neither is a multi-edit session anymore.
  await page.click("#editor-mount .cm-content");
  await page.evaluate(async () => {
    const { maybeSnapshotVersion } = await import("/src/history.ts");
    const { getActiveDoc } = await import("/src/stores/docs.ts");
    const doc = getActiveDoc();
    if (!doc) throw new Error("no active doc");
    await maybeSnapshotVersion(doc.id, "v0", 1_000);
    await maybeSnapshotVersion(doc.id, "v1", 1_000 + 35_000);
    await maybeSnapshotVersion(doc.id, "v2", 1_000 + 70_000);
    await maybeSnapshotVersion(doc.id, "v3", 1_000 + 70_000 + 31 * 60 * 1000);
  });

  await page.click("#versionHistoryBtn");
  await expect(page.locator(".version-history-row")).toHaveCount(2);
  await expect(page.locator(".version-history-row-label", { hasText: "edits" })).toHaveCount(0);
});

test("expanding a session and diffing two of its entries against each other works", async ({ page }) => {
  await page.click("#editor-mount .cm-content");
  await page.evaluate(async () => {
    const { maybeSnapshotVersion } = await import("/src/history.ts");
    const { getActiveDoc } = await import("/src/stores/docs.ts");
    const doc = getActiveDoc();
    if (!doc) throw new Error("no active doc");
    await maybeSnapshotVersion(doc.id, "alpha", 1_000);
    await maybeSnapshotVersion(doc.id, "beta", 1_000 + 35_000);
  });

  await page.click("#versionHistoryBtn");
  await page.click(".version-history-row-label:has-text('edits')");
  await page.click('button:has-text("Diff")');
  await page.selectOption("#versionCompareSelect", { index: 1 });
  await expect(page.locator(".diff-view, .version-history-preview")).toBeVisible();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx playwright test --project=local tests/e2e/local/version-history-grouping.spec.ts`
Expected: FAIL until Tasks 1–5 are all in place (should already pass at this point — this is confirmation, not new implementation)

- [ ] **Step 3: Run them and fix any selector mismatches**

Run: `npx playwright test --project=local tests/e2e/local/version-history-grouping.spec.ts`
Expected: PASS

- [ ] **Step 4: Run the full local Playwright suite**

Run: `npx playwright test --project=local`
Expected: PASS (all tests, no regressions)

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/local/version-history-grouping.spec.ts
git commit -m "test: cover grouped session rows and two-entry diff end to end"
```

---

### Task 7: Version bump, CHANGELOG, What's New, IMPROVEMENTS.md

**Files:**
- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `IMPROVEMENTS.md`
- Create: `client/public/whats-new/smart-version-history-grouping.png`

- [ ] **Step 1: Bump the version**

Read `package.json`'s current `"version"`, bump the minor component, hand-edit both `package.json`'s `"version"` and `package-lock.json`'s two `"version"` fields — do not run `npm install --package-lock-only`.

- [ ] **Step 2: Add the CHANGELOG entry**

Add a new `## [1.X.0] - 2026-08-29` section at the top of `CHANGELOG.md`:

```markdown
## [1.X.0] - 2026-08-29

### Added

- **Smart version-history grouping.** History now captures every 30 seconds instead of every 5 minutes, and Version History groups continuous edits into collapsible sessions (e.g. "Today, 2:00–2:45 PM · 12 edits") instead of a flat list — a real gap of 30+ minutes starts a new session, and an older session's in-between snapshots collapse down to its final state once it closes, keeping storage bounded. The Diff view can now compare any two selected historical entries against each other, not just a version against the live document.
```

- [ ] **Step 3: Take a real screenshot for What's New**

Start the app locally, build up a couple of sessions' worth of history (type, wait, type again with `maybeSnapshotVersion` called directly via the console if needed to simulate a gap), open Version History with a session expanded, and capture a screenshot to `client/public/whats-new/smart-version-history-grouping.png`, matching the framing of an existing file in that directory.

- [ ] **Step 4: Add the What's New entry**

Append to the end of `WHATS_NEW_ENTRIES` in `client/src/whats-new-entries.ts`:

```ts
  {
    version: "1.X.0",
    title: "Smart Version History Grouping",
    description:
      "Version History now groups continuous edits into collapsible sessions instead of a flat list, with much finer-grained capture underneath. Compare any two historical entries against each other, not just a version against the live document.",
    screenshot: "/whats-new/smart-version-history-grouping.png",
  },
```

(Replace `1.X.0` with the actual version chosen in Step 1.)

- [ ] **Step 5: Update IMPROVEMENTS.md**

Change:

```markdown
- [ ] **Smart version-history grouping.** Replace (or augment) the
      current time-window-based snapshotting with dynamic grouping
      closer to Google Docs' behavior: continuous edits within a
      session collapse into one entry, a real gap starts a new one,
      and small in-between changes nest under the session they
      belong to. Needs its own grouping algorithm design. Bundle in
      diff display between versions (already tracked as a deferred
      consideration from the original Version History feature).
```

to:

```markdown
- [x] **Smart version-history grouping.** (Shipped v1.X.0.) 30-second
      capture instead of 5-minute, with sessions computed purely from
      timestamps (a 30-minute gap starts a new one) — a closed
      session's intermediate snapshots collapse to its final state,
      shown as collapsible rows in Version History. Diff view now
      compares any two selected entries, not just a version against
      the live document.
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts client/public/whats-new/smart-version-history-grouping.png IMPROVEMENTS.md
git commit -m "docs: version/changelog/what's-new for smart version-history grouping"
```

---

### Task 8: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit/component test suite**

Run: `npm test`
Expected: PASS (all `unit` and `components` project tests)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS, 0 errors

- [ ] **Step 3: Format check**

Run: `npm run format:check`
Expected: PASS

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS, no errors

- [ ] **Step 5: Full local Playwright e2e suite**

Run: `npm run test:e2e:local`
Expected: PASS (all tests, no regressions)

- [ ] **Step 6: Collab e2e suite**

Run: `npm run test:e2e:collab`
Expected: PASS — exercises `workspace-room.ts`'s `maybeSnapshot` path Task 3 touched.

- [ ] **Step 7: Manual smoke test**

Using `npm run dev` (after `npm run build`): type in the editor, wait past 30 seconds and type again to confirm both land in one open session; open Version History and confirm the session shows as one collapsible row with the right count; expand it and confirm every nested snapshot is individually selectable and restorable; switch to Diff, pick a different "Compare against" entry, and confirm the diff updates to compare those two entries instead of the live document.

- [ ] **Step 8: Hand off to finishing-a-development-branch**

Once all of the above are green, proceed to `superpowers:finishing-a-development-branch`.
