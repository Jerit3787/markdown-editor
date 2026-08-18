# Multi-Tab Save Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saving from one browser tab never again silently destroys documents or workspaces another tab created or edited.

**Architecture:** A new pure merge utility (`mergeById`) that reconciles two arrays of records by id, preferring whichever side has the newer `updatedAt`. Both `docs.ts`'s `persistDocs()` and `workspaces.ts`'s `persistWorkspaces()` read `localStorage` fresh at save time and merge through it instead of blindly overwriting. `Workspace` gains an `updatedAt` field (it only has `createdAt` today) so the same merge strategy applies uniformly to both stores.

**Tech Stack:** TypeScript, Svelte stores, Vitest.

## Global Constraints

- The merge has no tombstones: a record deleted in one tab can reappear if another tab still has it in memory and saves afterward. This is a deliberate, accepted tradeoff (see the spec) — "when unsure, don't delete" over "when unsure, discard." No task should try to add delete-tracking; that's explicitly out of scope.
- Out of scope entirely: what the currently-open editor does if the document being edited is changed or deleted by another tab mid-session, and any "this doc is open elsewhere" UI. This plan only stops silent data loss on save.
- The two workspace-mutating call sites in `client/src/collab.ts` (inside `setAccessMode` and `addPerson`) get the same `updatedAt: Date.now()` treatment as everything in `workspaces.ts`, but — matching this codebase's existing boundary around `collab.ts`'s async, WebSocket/DOM-coupled orchestration functions (already untested: `joinSharedLink`, `openShareModal`) — no new tests are added for those two call sites specifically.

---

### Task 1: `mergeById` — the merge utility

**Files:**
- Create: `client/src/merge-records.ts`
- Test: `client/src/merge-records.test.ts`

**Interfaces:**
- Produces: `export function mergeById<T extends { id: string; updatedAt: number }>(current: T[], external: T[]): T[]`. Tasks 2 and 4 import this directly.

- [ ] **Step 1: Write the failing tests**

Create `client/src/merge-records.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mergeById } from "./merge-records";

interface Item {
  id: string;
  updatedAt: number;
  label: string;
}

describe("mergeById", () => {
  it("keeps the current version when it's newer", () => {
    const current: Item[] = [{ id: "a", updatedAt: 10, label: "current" }];
    const external: Item[] = [{ id: "a", updatedAt: 5, label: "external" }];
    expect(mergeById(current, external)).toEqual([{ id: "a", updatedAt: 10, label: "current" }]);
  });

  it("keeps the external version when it's newer", () => {
    const current: Item[] = [{ id: "a", updatedAt: 5, label: "current" }];
    const external: Item[] = [{ id: "a", updatedAt: 10, label: "external" }];
    expect(mergeById(current, external)).toEqual([{ id: "a", updatedAt: 10, label: "external" }]);
  });

  it("keeps the current version on a tie", () => {
    const current: Item[] = [{ id: "a", updatedAt: 10, label: "current" }];
    const external: Item[] = [{ id: "a", updatedAt: 10, label: "external" }];
    expect(mergeById(current, external)).toEqual([{ id: "a", updatedAt: 10, label: "current" }]);
  });

  it("keeps a record present only in current", () => {
    const current: Item[] = [{ id: "a", updatedAt: 1, label: "only-current" }];
    expect(mergeById(current, [])).toEqual([{ id: "a", updatedAt: 1, label: "only-current" }]);
  });

  it("keeps a record present only in external", () => {
    const external: Item[] = [{ id: "a", updatedAt: 1, label: "only-external" }];
    expect(mergeById([], external)).toEqual([{ id: "a", updatedAt: 1, label: "only-external" }]);
  });

  it("returns current unchanged when external is empty", () => {
    const current: Item[] = [
      { id: "a", updatedAt: 1, label: "a" },
      { id: "b", updatedAt: 2, label: "b" },
    ];
    expect(mergeById(current, [])).toEqual(current);
  });

  it("returns external unchanged when current is empty", () => {
    const external: Item[] = [
      { id: "a", updatedAt: 1, label: "a" },
      { id: "b", updatedAt: 2, label: "b" },
    ];
    expect(mergeById([], external)).toEqual(external);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- merge-records.test.ts`
Expected: FAIL — `Cannot find module './merge-records'`.

- [ ] **Step 3: Implement `mergeById`**

Create `client/src/merge-records.ts`:

```ts
// Reconciles two arrays of the same record type by id — used to merge
// what a browser tab is about to save with whatever's already in
// localStorage, instead of blindly overwriting it (see
// docs/superpowers/specs/2026-08-18-multi-tab-save-safety-design.md).
// No tombstones: a record present in only one side always survives,
// even if that means a deletion made elsewhere gets undone. Accepted
// tradeoff — losing a record silently is worse than one reappearing.
export function mergeById<T extends { id: string; updatedAt: number }>(current: T[], external: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of external) byId.set(item.id, item);
  for (const item of current) {
    const existing = byId.get(item.id);
    if (!existing || item.updatedAt >= existing.updatedAt) byId.set(item.id, item);
  }
  return [...byId.values()];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- merge-records.test.ts`
Expected: PASS — all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/merge-records.ts client/src/merge-records.test.ts
git commit -m "feat: add mergeById for reconciling records across tabs"
```

---

### Task 2: Merge-on-save for `persistDocs()`

**Files:**
- Modify: `client/src/stores/docs.ts` (the `persistDocs` function, currently at lines 121-129, and its imports at the top of the file)
- Test: `client/src/stores/docs.test.ts`

**Interfaces:**
- Consumes: `mergeById` from Task 1's `client/src/merge-records.ts`.

- [ ] **Step 1: Write the failing tests**

Add this to `client/src/stores/docs.test.ts`, inside the existing `describe("docs store — workspace integration", ...)` block (it already has a `beforeEach` that calls `localStorage.clear()` and `vi.resetModules()` — reuse that, don't add a new describe block):

```ts
  it("persistDocs merges with what another tab already saved instead of overwriting it", async () => {
    localStorage.setItem(
      "mde:docs",
      JSON.stringify([{ id: "doc-a", name: "A", content: "original", updatedAt: 1, createdAt: 1, workspaceId: "ws1" }])
    );
    const { docsStore, persistDocs } = await import("./docs");

    // Simulate another tab having since created doc-b and saved it.
    localStorage.setItem(
      "mde:docs",
      JSON.stringify([
        { id: "doc-a", name: "A", content: "original", updatedAt: 1, createdAt: 1, workspaceId: "ws1" },
        { id: "doc-b", name: "B", content: "from another tab", updatedAt: 2, createdAt: 2, workspaceId: "ws1" },
      ])
    );

    // This tab, unaware of doc-b, edits doc-a and saves.
    docsStore.set([{ id: "doc-a", name: "A", content: "edited here", updatedAt: 3, createdAt: 1, workspaceId: "ws1" }]);
    persistDocs();

    const persisted = JSON.parse(localStorage.getItem("mde:docs")!);
    expect(persisted).toHaveLength(2);
    expect(persisted.find((d: any) => d.id === "doc-a").content).toBe("edited here");
    expect(persisted.find((d: any) => d.id === "doc-b").content).toBe("from another tab");
    expect(get(docsStore)).toHaveLength(2);
  });

  it("persistDocs keeps another tab's newer edit to a document this tab hasn't touched", async () => {
    localStorage.setItem(
      "mde:docs",
      JSON.stringify([{ id: "doc-a", name: "A", content: "v1", updatedAt: 1, createdAt: 1, workspaceId: "ws1" }])
    );
    const { docsStore, persistDocs } = await import("./docs");

    // Another tab edited doc-a (newer updatedAt) after this tab loaded its own stale copy.
    localStorage.setItem(
      "mde:docs",
      JSON.stringify([{ id: "doc-a", name: "A", content: "v2 from another tab", updatedAt: 5, createdAt: 1, workspaceId: "ws1" }])
    );

    persistDocs();

    const persisted = JSON.parse(localStorage.getItem("mde:docs")!);
    expect(persisted.find((d: any) => d.id === "doc-a").content).toBe("v2 from another tab");
    expect(get(docsStore).find((d) => d.id === "doc-a")?.content).toBe("v2 from another tab");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- docs.test.ts`
Expected: FAIL — both new tests fail because `persistDocs()` currently overwrites `localStorage` with only the in-memory `docsStore` value, so `doc-b`/the newer external edit never survive.

- [ ] **Step 3: Implement the merge in `persistDocs`**

In `client/src/stores/docs.ts`, add this import near the top of the file (alongside the existing imports, e.g. right after `import { ensureUniqueName, nextAvailableName } from "../doc-naming";`):

```ts
import { mergeById } from "../merge-records";
```

Replace the current `persistDocs` function:

```ts
export function persistDocs() {
  try {
    localStorage.setItem(STORAGE_DOCS, JSON.stringify(get(docsStore)));
  } catch (e) {
    // Most commonly a full storage quota (large embedded images) — this
    // used to fail silently, leaving the in-memory doc looking "saved"
    // (the status pill doesn't know the write itself failed) while
    // nothing actually persisted.
    showToast("Couldn't save — your browser's local storage may be full", "error");
  }
}
```

with:

```ts
export function persistDocs() {
  try {
    // Read fresh instead of trusting this tab's own possibly-stale copy —
    // another tab may have saved since this tab last loaded. Merging
    // (rather than overwriting) is what stops a save in one tab from
    // silently destroying a document another tab created or edited.
    const raw = localStorage.getItem(STORAGE_DOCS);
    const external = raw ? (JSON.parse(raw) as Doc[]) : [];
    const merged = mergeById(get(docsStore), external);
    docsStore.set(merged);
    localStorage.setItem(STORAGE_DOCS, JSON.stringify(merged));
  } catch (e) {
    // Most commonly a full storage quota (large embedded images) — this
    // used to fail silently, leaving the in-memory doc looking "saved"
    // (the status pill doesn't know the write itself failed) while
    // nothing actually persisted.
    showToast("Couldn't save — your browser's local storage may be full", "error");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- docs.test.ts`
Expected: FAIL — this plan originally stopped at Step 4, but implementing it this far surfaced a real regression:
`removeDocsByRepoPaths removes every doc in the workspace matching one of the given paths` fails, because `mergeById` can't distinguish "this id is missing from `current` because another tab never told me about it" from "this id is missing because THIS tab just deleted it" — both look identical (absent from `current`, present in whatever's still in `localStorage`). `removeDocById` filters the doc out of `docsStore` and calls `persistDocs()`, whose merge reads `localStorage` fresh — still holding the pre-deletion state, since writing the deletion *is* what this call is doing — and the union resurrects the doc from that stale snapshot. This is not the narrower cross-tab tradeoff from the spec's Global Constraints; it broke ordinary same-tab deletion. Confirmed with the user before proceeding (this expands the task): add a companion function that lets deletion win regardless of what's still in `localStorage`.

- [ ] **Step 4b: Give deletion an explicit exclusion the merge respects**

Replace the `persistDocs` just written in Step 3 with:

```ts
// Deletion goes through this instead of persistDocs() directly: a plain
// merge can't tell "this id is missing from docsStore because another tab
// never told me about it" apart from "this id is missing because THIS tab
// just deleted it" — both look identical (absent from current, present in
// whatever's still in localStorage). Explicitly excluding deletedIds from
// the external side too means a delete always wins for this tab, instead
// of the merge resurrecting it from a pre-deletion snapshot on the very
// save that's supposed to record the deletion.
function persistDocsExcluding(deletedIds: Set<string>) {
  try {
    const raw = localStorage.getItem(STORAGE_DOCS);
    const external = raw ? (JSON.parse(raw) as Doc[]).filter((d) => !deletedIds.has(d.id)) : [];
    const merged = mergeById(get(docsStore), external);
    docsStore.set(merged);
    localStorage.setItem(STORAGE_DOCS, JSON.stringify(merged));
  } catch (e) {
    // Most commonly a full storage quota (large embedded images) — this
    // used to fail silently, leaving the in-memory doc looking "saved"
    // (the status pill doesn't know the write itself failed) while
    // nothing actually persisted.
    showToast("Couldn't save — your browser's local storage may be full", "error");
  }
}

export function persistDocs() {
  // Read fresh instead of trusting this tab's own possibly-stale copy —
  // another tab may have saved since this tab last loaded. Merging
  // (rather than overwriting) is what stops a save in one tab from
  // silently destroying a document another tab created or edited.
  persistDocsExcluding(new Set());
}
```

Then in `removeDocById` (`client/src/stores/docs.ts`, currently around line 292-304), replace its `persistDocs();` call with `persistDocsExcluding(new Set([id]));`.

Add one more test to `client/src/stores/docs.test.ts`, alongside the two added in Step 1:

```ts
  it("removeDocById's own save doesn't resurrect the doc from the pre-deletion snapshot still in localStorage", async () => {
    localStorage.setItem(
      "mde:docs",
      JSON.stringify([{ id: "doc-a", name: "A", content: "gone soon", updatedAt: 1, createdAt: 1, workspaceId: "ws1" }])
    );
    const { docsStore, removeDocById } = await import("./docs");

    removeDocById("doc-a");

    const persisted = JSON.parse(localStorage.getItem("mde:docs")!);
    expect(persisted.find((d: any) => d.id === "doc-a")).toBeUndefined();
    expect(get(docsStore).find((d) => d.id === "doc-a")).toBeUndefined();
  });
```

- [ ] **Step 4c: Run tests to verify they pass**

Run: `npm test -- docs.test.ts`
Expected: PASS — all tests in the file, including the 3 new ones (2 from Step 1, 1 from Step 4b).

- [ ] **Step 5: Commit**

```bash
git add client/src/stores/docs.ts client/src/stores/docs.test.ts
git commit -m "feat: merge-on-save for documents instead of overwriting localStorage"
```

---

### Task 3: `Workspace.updatedAt` — field, backfill, and bump every mutation site

**Files:**
- Modify: `client/src/types.ts` (the `Workspace` interface, currently lines 37-63)
- Modify: `client/src/stores/workspaces.ts` (`loadWorkspacesFromStorage`, `createWorkspace`, `adoptSharedWorkspace`, `mergeSharedWorkspaceInto`, `setWorkspaceRepoLink`, `clearWorkspaceRepoLink`, `setWorkspaceLastSynced`, `renameWorkspace`)
- Modify: `client/src/collab.ts` (the `workspacesStore.update` calls inside `setAccessMode`, line 821, and `addPerson`, line 882)
- Test: `client/src/stores/workspaces.test.ts`

**Interfaces:**
- Produces: `Workspace` (from `client/src/types.ts`) gains a required `updatedAt: number` field. Task 4 relies on every `Workspace` record having an accurate one by the time `persistWorkspaces()` runs.

- [ ] **Step 1: Add `updatedAt` to the `Workspace` interface**

In `client/src/types.ts`, inside the `Workspace` interface, add the field right after `createdAt: number;`:

```ts
  createdAt: number;
  // Backfilled from createdAt for any workspace that predates this field
  // (see stores/workspaces.ts's loadWorkspacesFromStorage) — always
  // present on every workspace in workspacesStore after load. Bumped on
  // every mutation so persistWorkspaces() can merge across tabs by
  // recency instead of blindly overwriting localStorage.
  updatedAt: number;
```

- [ ] **Step 2: Write the failing tests**

Add this new `describe` block to `client/src/stores/workspaces.test.ts`, after the existing `describe("workspaces store — mutations", ...)` block:

```ts
describe("workspaces store — updatedAt", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("backfills updatedAt from createdAt for a workspace stored before this field existed", async () => {
    localStorage.setItem("mde:workspaces", JSON.stringify([{ id: "a", name: "A", createdAt: 42 }]));
    const { workspacesStore } = await import("./workspaces");
    expect(get(workspacesStore).find((w) => w.id === "a")?.updatedAt).toBe(42);
  });

  it("createWorkspace stamps updatedAt at creation", async () => {
    const { createWorkspace } = await import("./workspaces");
    const ws = createWorkspace("New");
    expect(ws.updatedAt).toBe(1000);
  });

  it("adoptSharedWorkspace stamps updatedAt at creation", async () => {
    const { adoptSharedWorkspace } = await import("./workspaces");
    const ws = adoptSharedWorkspace("remote-1", "Shared");
    expect(ws.updatedAt).toBe(1000);
  });

  it("renameWorkspace bumps updatedAt", async () => {
    const { workspacesStore, createWorkspace, renameWorkspace } = await import("./workspaces");
    const original = createWorkspace("Original");
    vi.setSystemTime(2000);
    renameWorkspace(original.id, "Renamed");
    expect(get(workspacesStore).find((w) => w.id === original.id)?.updatedAt).toBe(2000);
  });

  it("mergeSharedWorkspaceInto bumps updatedAt", async () => {
    const { workspacesStore, createWorkspace, mergeSharedWorkspaceInto } = await import("./workspaces");
    const original = createWorkspace("Original");
    vi.setSystemTime(2000);
    mergeSharedWorkspaceInto(original.id, "remote-1");
    expect(get(workspacesStore).find((w) => w.id === original.id)?.updatedAt).toBe(2000);
  });

  it("setWorkspaceRepoLink bumps updatedAt", async () => {
    const { workspacesStore, createWorkspace, setWorkspaceRepoLink } = await import("./workspaces");
    const original = createWorkspace("Original");
    vi.setSystemTime(2000);
    setWorkspaceRepoLink(original.id, { owner: "alice", repo: "notes", branch: "main" });
    expect(get(workspacesStore).find((w) => w.id === original.id)?.updatedAt).toBe(2000);
  });

  it("clearWorkspaceRepoLink bumps updatedAt", async () => {
    const { workspacesStore, createWorkspace, setWorkspaceRepoLink, clearWorkspaceRepoLink } = await import("./workspaces");
    const original = createWorkspace("Original");
    setWorkspaceRepoLink(original.id, { owner: "alice", repo: "notes", branch: "main" });
    vi.setSystemTime(2000);
    clearWorkspaceRepoLink(original.id);
    expect(get(workspacesStore).find((w) => w.id === original.id)?.updatedAt).toBe(2000);
  });

  it("setWorkspaceLastSynced bumps updatedAt", async () => {
    const { workspacesStore, createWorkspace, setWorkspaceLastSynced } = await import("./workspaces");
    const original = createWorkspace("Original");
    vi.setSystemTime(2000);
    setWorkspaceLastSynced(original.id, 2000);
    expect(get(workspacesStore).find((w) => w.id === original.id)?.updatedAt).toBe(2000);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- workspaces.test.ts`
Expected: FAIL — the backfill test fails (no backfill logic yet), and every bump test fails (`updatedAt` is `undefined`, not the expected timestamp).

- [ ] **Step 4: Implement the backfill in `loadWorkspacesFromStorage`**

In `client/src/stores/workspaces.ts`, replace:

```ts
function loadWorkspacesFromStorage(): Workspace[] | null {
  const raw = localStorage.getItem(STORAGE_WORKSPACES);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}
```

with:

```ts
function loadWorkspacesFromStorage(): Workspace[] | null {
  const raw = localStorage.getItem(STORAGE_WORKSPACES);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Workspace[];
    return parsed.map((w) => ({ ...w, updatedAt: w.updatedAt ?? w.createdAt }));
  } catch (e) {
    return [];
  }
}
```

- [ ] **Step 5: Stamp `updatedAt` on new-record creation**

In `client/src/stores/workspaces.ts`, in `createWorkspace`:

```ts
export function createWorkspace(name: string): Workspace {
  const ws: Workspace = { id: uid(), name, createdAt: Date.now() };
```

becomes:

```ts
export function createWorkspace(name: string): Workspace {
  const ws: Workspace = { id: uid(), name, createdAt: Date.now(), updatedAt: Date.now() };
```

And in `adoptSharedWorkspace`:

```ts
export function adoptSharedWorkspace(remoteId: string, name: string): Workspace {
  const ws: Workspace = { id: uid(), name, createdAt: Date.now(), shared: true, remoteId };
```

becomes:

```ts
export function adoptSharedWorkspace(remoteId: string, name: string): Workspace {
  const ws: Workspace = { id: uid(), name, createdAt: Date.now(), updatedAt: Date.now(), shared: true, remoteId };
```

- [ ] **Step 6: Bump `updatedAt` in every workspace-mutating function in `workspaces.ts`**

Replace each of the following four functions:

```ts
export function mergeSharedWorkspaceInto(workspaceId: string, remoteId: string): void {
  workspacesStore.update((all) => all.map((w) => (w.id === workspaceId ? { ...w, shared: true, remoteId } : w)));
  persistWorkspaces();
}

export function setWorkspaceRepoLink(id: string, repoLink: { owner: string; repo: string; branch: string }): void {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, repoLink } : w)));
  persistWorkspaces();
}

export function clearWorkspaceRepoLink(id: string): void {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, repoLink: undefined, repoLastSyncedAt: undefined } : w)));
  persistWorkspaces();
}

export function setWorkspaceLastSynced(id: string, timestamp: number): void {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, repoLastSyncedAt: timestamp } : w)));
  persistWorkspaces();
}
```

with:

```ts
export function mergeSharedWorkspaceInto(workspaceId: string, remoteId: string): void {
  workspacesStore.update((all) => all.map((w) => (w.id === workspaceId ? { ...w, shared: true, remoteId, updatedAt: Date.now() } : w)));
  persistWorkspaces();
}

export function setWorkspaceRepoLink(id: string, repoLink: { owner: string; repo: string; branch: string }): void {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, repoLink, updatedAt: Date.now() } : w)));
  persistWorkspaces();
}

export function clearWorkspaceRepoLink(id: string): void {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, repoLink: undefined, repoLastSyncedAt: undefined, updatedAt: Date.now() } : w)));
  persistWorkspaces();
}

export function setWorkspaceLastSynced(id: string, timestamp: number): void {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, repoLastSyncedAt: timestamp, updatedAt: Date.now() } : w)));
  persistWorkspaces();
}
```

And `renameWorkspace`:

```ts
export function renameWorkspace(id: string, name: string) {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, name: name || "Untitled workspace" } : w)));
  persistWorkspaces();
}
```

becomes:

```ts
export function renameWorkspace(id: string, name: string) {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, name: name || "Untitled workspace", updatedAt: Date.now() } : w)));
  persistWorkspaces();
}
```

- [ ] **Step 7: Bump `updatedAt` in `collab.ts`'s two workspace-mutating call sites**

In `client/src/collab.ts`, line 821 (inside `setAccessMode`):

```ts
  workspacesStore.update((all) => all.map((w) => (w.id === doc.workspaceId ? { ...w, shared: wantAnyone || access.invited.length > 0 || w.shared, remoteId: w.remoteId || doc.workspaceId } : w)));
```

becomes:

```ts
  workspacesStore.update((all) => all.map((w) => (w.id === doc.workspaceId ? { ...w, shared: wantAnyone || access.invited.length > 0 || w.shared, remoteId: w.remoteId || doc.workspaceId, updatedAt: Date.now() } : w)));
```

And line 882 (inside `addPerson`):

```ts
    workspacesStore.update((all) => all.map((w) => (w.id === doc.workspaceId ? { ...w, shared: true, remoteId: w.remoteId || doc.workspaceId } : w)));
```

becomes:

```ts
    workspacesStore.update((all) => all.map((w) => (w.id === doc.workspaceId ? { ...w, shared: true, remoteId: w.remoteId || doc.workspaceId, updatedAt: Date.now() } : w)));
```

No test coverage is added for these two call sites — see this plan's Global Constraints.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test -- workspaces.test.ts`
Expected: PASS — all tests in the file, including the 8 new ones.

- [ ] **Step 9: Type-check**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: no errors. (This step matters here specifically because `updatedAt` just became a required field on `Workspace` — if any other code constructs a `Workspace` object literal directly instead of through one of the functions touched above, this is where it would surface.)

- [ ] **Step 10: Commit**

```bash
git add client/src/types.ts client/src/stores/workspaces.ts client/src/collab.ts client/src/stores/workspaces.test.ts
git commit -m "feat: add Workspace.updatedAt, backfilled and bumped on every mutation"
```

---

### Task 4: Merge-on-save for `persistWorkspaces()`

**Files:**
- Modify: `client/src/stores/workspaces.ts` (the `persistWorkspaces` function, currently lines 52-58, and `deleteWorkspaceRecord`, currently lines 134-142)
- Test: `client/src/stores/workspaces.test.ts`

**Interfaces:**
- Consumes: `mergeById` from Task 1's `client/src/merge-records.ts`. Relies on every `Workspace` having an accurate `updatedAt` (Task 3).

**Note carried over from Task 2:** the same-tab deletion bug found there applies here identically — `deleteWorkspaceRecord` filters a workspace out of `workspacesStore` and calls `persistWorkspaces()`, whose merge would resurrect it from the pre-deletion snapshot still in `localStorage`. This task builds the exclusion-aware persist from the start instead of discovering the regression the hard way twice.

- [ ] **Step 1: Write the failing tests**

Add this to the `describe("workspaces store — updatedAt", ...)` block added in Task 3, in `client/src/stores/workspaces.test.ts`:

```ts
  it("persistWorkspaces merges with what another tab already saved instead of overwriting it", async () => {
    localStorage.setItem("mde:workspaces", JSON.stringify([{ id: "ws-a", name: "A", createdAt: 1, updatedAt: 1 }]));
    const { workspacesStore, persistWorkspaces } = await import("./workspaces");

    // Simulate another tab having since created ws-b and saved it.
    localStorage.setItem(
      "mde:workspaces",
      JSON.stringify([
        { id: "ws-a", name: "A", createdAt: 1, updatedAt: 1 },
        { id: "ws-b", name: "B from another tab", createdAt: 2, updatedAt: 2 },
      ])
    );

    // This tab, unaware of ws-b, renames ws-a and saves.
    workspacesStore.set([{ id: "ws-a", name: "A renamed here", createdAt: 1, updatedAt: 3 }]);
    persistWorkspaces();

    const persisted = JSON.parse(localStorage.getItem("mde:workspaces")!);
    expect(persisted).toHaveLength(2);
    expect(persisted.find((w: any) => w.id === "ws-a").name).toBe("A renamed here");
    expect(persisted.find((w: any) => w.id === "ws-b").name).toBe("B from another tab");
    expect(get(workspacesStore)).toHaveLength(2);
  });

  it("deleteWorkspaceRecord's own save doesn't resurrect the workspace from the pre-deletion snapshot still in localStorage", async () => {
    localStorage.setItem("mde:workspaces", JSON.stringify([{ id: "ws-a", name: "A", createdAt: 1, updatedAt: 1 }]));
    const { workspacesStore, deleteWorkspaceRecord } = await import("./workspaces");

    deleteWorkspaceRecord("ws-a");

    const persisted = JSON.parse(localStorage.getItem("mde:workspaces")!);
    expect(persisted.find((w: any) => w.id === "ws-a")).toBeUndefined();
    expect(get(workspacesStore).find((w) => w.id === "ws-a")).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- workspaces.test.ts`
Expected: FAIL — both. `ws-b` is missing from the persisted result because `persistWorkspaces()` currently overwrites `localStorage` with only the in-memory `workspacesStore` value. The deletion test fails once Step 3's plain merge is in place, for the same reason `removeDocById` failed in Task 2 — a plain merge resurrects `ws-a` from the pre-deletion snapshot still in `localStorage`, since writing the deletion is what this save is trying to do.

- [ ] **Step 3: Implement the merge in `persistWorkspaces`, with deletion exclusion from the start**

In `client/src/stores/workspaces.ts`, add this import near the top of the file (alongside the existing `import { showToast } from "./toast";`):

```ts
import { mergeById } from "../merge-records";
```

Replace the current `persistWorkspaces` function:

```ts
export function persistWorkspaces() {
  try {
    localStorage.setItem(STORAGE_WORKSPACES, JSON.stringify(get(workspacesStore)));
  } catch (e) {
    showToast("Couldn't save — your browser's local storage may be full", "error");
  }
}
```

with:

```ts
// Deletion goes through this instead of persistWorkspaces() directly —
// see docs.ts's persistDocsExcluding, which exists for the identical
// reason: a plain merge can't tell "missing because another tab never
// told me about it" apart from "missing because THIS tab just deleted
// it," so a delete's own save would otherwise resurrect the record from
// whatever pre-deletion snapshot is still in localStorage.
function persistWorkspacesExcluding(deletedIds: Set<string>) {
  try {
    const raw = localStorage.getItem(STORAGE_WORKSPACES);
    const external = raw ? (JSON.parse(raw) as Workspace[]).filter((w) => !deletedIds.has(w.id)) : [];
    const merged = mergeById(get(workspacesStore), external);
    workspacesStore.set(merged);
    localStorage.setItem(STORAGE_WORKSPACES, JSON.stringify(merged));
  } catch (e) {
    showToast("Couldn't save — your browser's local storage may be full", "error");
  }
}

export function persistWorkspaces() {
  // Read fresh instead of trusting this tab's own possibly-stale copy —
  // see docs.ts's persistDocs, which does the same thing for the same
  // reason.
  persistWorkspacesExcluding(new Set());
}
```

Then in `deleteWorkspaceRecord` (currently lines 134-142):

```ts
export function deleteWorkspaceRecord(id: string) {
  const remaining = get(workspacesStore).filter((w) => w.id !== id);
  workspacesStore.set(remaining);
  persistWorkspaces();
  if (get(activeWorkspaceIdStore) === id) {
    const fallback = [...remaining].sort((a, b) => a.createdAt - b.createdAt)[0];
    setActiveWorkspaceId(fallback ? fallback.id : null);
  }
}
```

replace `persistWorkspaces();` with `persistWorkspacesExcluding(new Set([id]));`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- workspaces.test.ts`
Expected: PASS — all tests in the file, including both new ones.

- [ ] **Step 5: Run the full test suite and type-check**

Run: `npm test`
Expected: PASS — no regressions anywhere else in the suite.

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/stores/workspaces.ts client/src/stores/workspaces.test.ts
git commit -m "feat: merge-on-save for workspaces instead of overwriting localStorage"
```
