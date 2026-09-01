# Shared-Document Session Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a shared workspace from silently hijacking a fresh tab's default landing spot, and stop joining a share link from forcing an immediate permanent commitment.

**Architecture:** Add an `ephemeral?: boolean` flag to `Workspace`. Ephemeral workspaces live fully in the in-memory Svelte stores (render everywhere normally) but are filtered out at the one localStorage-write choke point each store already has, and skip persisting themselves as the "active workspace/doc" pointer a fresh tab reads on load. A new "Preview only" join option and a "Keep this workspace" promote action are the two ways in and out of that state.

**Tech Stack:** TypeScript, Svelte 5 (runes), Vitest (`unit` + `components` projects), Playwright (`local` + `collab` projects).

**Spec:** `docs/superpowers/specs/2026-09-01-shared-doc-session-separation-design.md` — read both before starting; this plan argues from that spec's Non-goals and Error handling sections without repeating them in full.

## Global Constraints

- No changes to `src/workspace-room.ts`, any other server file, or the live WebSocket/Yjs sync path — this is entirely a client-side persistence and join-UI change.
- No `sessionStorage`, no `BroadcastChannel` — the fix is "skip the localStorage write for ephemeral state," not a new storage mechanism.
- Every persistence filter lives at the existing single choke point (`persistWorkspacesExcluding` in `stores/workspaces.ts`, `persistDocsExcluding` in `stores/docs.ts`) — never scattered across call sites.
- `stores/workspaces.ts` still has zero dependency on `stores/docs.ts` (existing module-level constraint, stated in its own header comment) — any operation needing both is coordinated by the calling component, exactly as `deleteWorkspaceRecord`/`switchWorkspace` already are.
- This ships as a minor version bump with its own What's New entry (category: Collaboration) per `CLAUDE.md`'s versioning convention — it's user-facing (new modal button, new switcher badge/action, a real behavior fix).

---

### Task 1: `Workspace.ephemeral` + core `stores/workspaces.ts` logic

**Files:**
- Modify: `client/src/types.ts` (`Workspace` interface, after `pendingRepoDeletions?: string[];`)
- Modify: `client/src/stores/workspaces.ts` (`persistWorkspacesExcluding`, `setActiveWorkspaceId`; new `previewSharedWorkspace`, `promoteEphemeralWorkspace`)
- Test: `tests/client/src/stores/workspaces.test.ts` (existing file)

**Interfaces:**
- Produces: `Workspace.ephemeral?: boolean`; `previewSharedWorkspace(remoteId: string, name: string): Workspace`; `promoteEphemeralWorkspace(id: string): void`. Both exported from `client/src/stores/workspaces.ts`, used by Task 3 (`collab.ts`), Task 4 (`JoinWorkspaceModal.svelte`), and Task 5 (`WorkspaceSwitcher.svelte`).

- [ ] **Step 1: Add the `ephemeral` field to `Workspace`**

In `client/src/types.ts`, inside the `Workspace` interface, right after the existing `pendingRepoDeletions?: string[];` line:

```ts
  // Live in workspacesStore/docsStore normally (renders everywhere:
  // sidebar, switcher, editor) but never written to localStorage —
  // persistWorkspaces()/persistDocs() filter these out at the one choke
  // point each, so no call site has to remember to skip them. Sends the
  // workspace back to being effectively gone on reload since nothing
  // durable existed to restore it from. Cleared by
  // promoteEphemeralWorkspace(), the one way to make it permanent after
  // the fact.
  ephemeral?: boolean;
```

- [ ] **Step 2: Write the failing tests for `previewSharedWorkspace`**

Add to `tests/client/src/stores/workspaces.test.ts`, inside the existing `describe("workspaces store — mutations", ...)` block (after the `mergeSharedWorkspaceInto` test):

```ts
  it("previewSharedWorkspace creates an ephemeral workspace, activates it, but never persists it", async () => {
    const { workspacesStore, activeWorkspaceIdStore, previewSharedWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = previewSharedWorkspace("room-preview", "Peek");
    expect(ws.ephemeral).toBe(true);
    expect(get(workspacesStore).find((w) => w.id === ws.id)).toBeTruthy();
    expect(get(activeWorkspaceIdStore)).toBe(ws.id);
    expect(JSON.parse(localStorage.getItem("mde:workspaces")!)).toEqual([]);
    expect(localStorage.getItem("mde:activeWorkspace")).toBeNull();
  });

  it("previewSharedWorkspace does not overwrite the persisted default landing workspace", async () => {
    const { createWorkspace, previewSharedWorkspace, activeWorkspaceIdStore } = await import("../../../../client/src/stores/workspaces");
    const real = createWorkspace("Real");
    expect(localStorage.getItem("mde:activeWorkspace")).toBe(real.id);
    const preview = previewSharedWorkspace("room-x", "Preview");
    expect(get(activeWorkspaceIdStore)).toBe(preview.id);
    expect(localStorage.getItem("mde:activeWorkspace")).toBe(real.id);
  });

  it("persistWorkspaces never writes an ephemeral workspace to storage, even via an unrelated call", async () => {
    const { createWorkspace, previewSharedWorkspace, renameWorkspace } = await import("../../../../client/src/stores/workspaces");
    const real = createWorkspace("Real");
    const preview = previewSharedWorkspace("room-x", "Preview");
    renameWorkspace(real.id, "Real renamed");
    const persisted = JSON.parse(localStorage.getItem("mde:workspaces")!);
    expect(persisted.map((w: { id: string }) => w.id)).not.toContain(preview.id);
    expect(persisted.find((w: { id: string }) => w.id === real.id)?.name).toBe("Real renamed");
  });

  it("promoteEphemeralWorkspace clears the ephemeral flag and persists the workspace for real", async () => {
    const { previewSharedWorkspace, promoteEphemeralWorkspace, workspacesStore } = await import("../../../../client/src/stores/workspaces");
    const preview = previewSharedWorkspace("room-x", "Preview");
    promoteEphemeralWorkspace(preview.id);
    expect(get(workspacesStore).find((w) => w.id === preview.id)?.ephemeral).toBe(false);
    const persisted = JSON.parse(localStorage.getItem("mde:workspaces")!);
    expect(persisted.map((w: { id: string }) => w.id)).toContain(preview.id);
  });

  it("promoting the active ephemeral workspace also makes it the persisted default landing workspace", async () => {
    const { createWorkspace, previewSharedWorkspace, promoteEphemeralWorkspace } = await import("../../../../client/src/stores/workspaces");
    createWorkspace("Real");
    const preview = previewSharedWorkspace("room-x", "Preview");
    promoteEphemeralWorkspace(preview.id);
    expect(localStorage.getItem("mde:activeWorkspace")).toBe(preview.id);
  });

  it("switching between two previewed workspaces never touches the persisted default landing workspace", async () => {
    const { createWorkspace, previewSharedWorkspace } = await import("../../../../client/src/stores/workspaces");
    const real = createWorkspace("Real");
    previewSharedWorkspace("room-a", "Preview A");
    previewSharedWorkspace("room-b", "Preview B");
    expect(localStorage.getItem("mde:activeWorkspace")).toBe(real.id);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/client/src/stores/workspaces.test.ts --project=unit`
Expected: FAIL — `previewSharedWorkspace`/`promoteEphemeralWorkspace` are not exported yet.

- [ ] **Step 4: Implement `previewSharedWorkspace` and `promoteEphemeralWorkspace`, update the persistence/activation logic**

In `client/src/stores/workspaces.ts`, replace `persistWorkspacesExcluding`:

```ts
function persistWorkspacesExcluding(deletedIds: Set<string>) {
  try {
    const raw = localStorage.getItem(STORAGE_WORKSPACES);
    const external = raw ? (JSON.parse(raw) as Workspace[]).filter((w) => !deletedIds.has(w.id)) : [];
    const merged = mergeById(get(workspacesStore), external);
    workspacesStore.set(merged);
    // Ephemeral workspaces (see previewSharedWorkspace) live in the store
    // for this tab's lifetime only — excluded here, at the one place
    // every persistence path funnels through, rather than at each call
    // site.
    const toPersist = merged.filter((w) => !w.ephemeral);
    localStorage.setItem(STORAGE_WORKSPACES, JSON.stringify(toPersist));
  } catch (e) {
    showToast("Couldn't save — your browser's local storage may be full", "error");
  }
}
```

Replace `setActiveWorkspaceId`:

```ts
function setActiveWorkspaceId(id: string | null) {
  activeWorkspaceIdStore.set(id);
  if (!id) {
    localStorage.removeItem(STORAGE_ACTIVE_WORKSPACE);
    return;
  }
  const ws = get(workspacesStore).find((w) => w.id === id);
  // Leave the persisted "default landing workspace" pointing at whatever
  // real workspace was active before — a fresh tab must never inherit an
  // ephemeral one. Switching away from an ephemeral workspace back to a
  // real one persists normally on that later call, immediately restoring
  // the invariant.
  if (ws?.ephemeral) return;
  localStorage.setItem(STORAGE_ACTIVE_WORKSPACE, id);
}
```

Add `previewSharedWorkspace` and `promoteEphemeralWorkspace` right after `mergeSharedWorkspaceInto`:

```ts
// Opening a shared link when the receiver already has workspaces of
// their own and there's nothing meaningfully to choose between (a single
// shared document) — lands it as active immediately, but never commits
// it to storage. "Keep this workspace" (promoteEphemeralWorkspace) is
// the only way it survives a reload.
export function previewSharedWorkspace(remoteId: string, name: string): Workspace {
  const ws: Workspace = { id: uid(), name, createdAt: Date.now(), updatedAt: Date.now(), shared: true, remoteId, ephemeral: true };
  workspacesStore.update((all) => [ws, ...all]);
  setActiveWorkspaceId(ws.id);
  // Deliberately no persistWorkspaces() call — persistWorkspacesExcluding's
  // own filter would drop this record anyway (defense in depth for any
  // *other* persist call that runs while this is active), but skipping it
  // here avoids a pointless localStorage rewrite for a record that was
  // never going to be written.
  return ws;
}

// Backs the "Keep this workspace" UI action (WorkspaceSwitcher.svelte).
// Only handles the workspace-side half — this module still has no
// dependency on stores/docs.ts (see the module comment at the top of this
// file), so the caller is responsible for also calling docs.ts's
// persistDocs() to flush this workspace's now-no-longer-ephemeral
// documents.
export function promoteEphemeralWorkspace(id: string): void {
  workspacesStore.update((all) => all.map((w) => (w.id === id ? { ...w, ephemeral: false, updatedAt: Date.now() } : w)));
  persistWorkspaces();
  // If this was the active workspace, its activation was never persisted
  // (see setActiveWorkspaceId above) — now that it's no longer ephemeral,
  // run it again so a fresh tab going forward actually lands here.
  if (get(activeWorkspaceIdStore) === id) setActiveWorkspaceId(id);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/client/src/stores/workspaces.test.ts --project=unit`
Expected: PASS (all previous tests in this file must still pass too).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/types.ts client/src/stores/workspaces.ts tests/client/src/stores/workspaces.test.ts
git commit -m "feat: ephemeral (preview) workspaces that never persist"
```

---

### Task 2: `stores/docs.ts` ephemeral-aware persistence

**Files:**
- Modify: `client/src/stores/docs.ts` (`persistDocsExcluding`, `setActiveId`)
- Test: `tests/client/src/stores/docs.test.ts` (existing file)

**Interfaces:**
- Consumes: `Workspace.ephemeral` (Task 1), `previewSharedWorkspace`/`promoteEphemeralWorkspace` (Task 1) — both already imported into this test file's dynamic imports.
- Produces: no new exports — `persistDocs()`/`setActiveId` behavior change only, transparent to every existing caller (`createDoc`, `switchDoc`, `importRemoteDocs`, etc.).

- [ ] **Step 1: Write the failing tests**

Add to `tests/client/src/stores/docs.test.ts`, inside `describe("docs store — workspace integration", ...)` (after the existing tests):

```ts
  it("excludes documents belonging to an ephemeral workspace from persistence", async () => {
    const { docsStore, createDoc } = await import("../../../../client/src/stores/docs");
    const { previewSharedWorkspace } = await import("../../../../client/src/stores/workspaces");
    const preview = previewSharedWorkspace("room-x", "Preview");
    const doc = createDoc({ name: "Preview Doc" });
    expect(doc.workspaceId).toBe(preview.id);
    const persisted = JSON.parse(localStorage.getItem("mde:docs")!);
    expect(persisted.map((d: { id: string }) => d.id)).not.toContain(doc.id);
    expect(get(docsStore).find((d) => d.id === doc.id)).toBeTruthy();
  });

  it("persists a workspace's documents once it's promoted out of ephemeral", async () => {
    const { createDoc, persistDocs } = await import("../../../../client/src/stores/docs");
    const { previewSharedWorkspace, promoteEphemeralWorkspace } = await import("../../../../client/src/stores/workspaces");
    const preview = previewSharedWorkspace("room-x", "Preview");
    const doc = createDoc({ name: "Preview Doc" });
    promoteEphemeralWorkspace(preview.id);
    persistDocs();
    const persisted = JSON.parse(localStorage.getItem("mde:docs")!);
    expect(persisted.map((d: { id: string }) => d.id)).toContain(doc.id);
  });

  it("switching to a doc in an ephemeral workspace does not persist it as the active doc", async () => {
    const { createDoc } = await import("../../../../client/src/stores/docs");
    const { createWorkspace, previewSharedWorkspace } = await import("../../../../client/src/stores/workspaces");
    createWorkspace("Real");
    const realDoc = createDoc({ name: "Real Doc" });
    expect(localStorage.getItem("mde:active")).toBe(realDoc.id);
    previewSharedWorkspace("room-x", "Preview");
    createDoc({ name: "Preview Doc" }); // createDoc's own setActiveId call
    expect(localStorage.getItem("mde:active")).toBe(realDoc.id);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/client/src/stores/docs.test.ts --project=unit`
Expected: FAIL — new docs/active-id writes aren't excluded yet.

- [ ] **Step 3: Implement the filter in `persistDocsExcluding` and the ephemeral check in `setActiveId`**

In `client/src/stores/docs.ts`, replace `persistDocsExcluding`:

```ts
function persistDocsExcluding(deletedIds: Set<string>) {
  try {
    const raw = localStorage.getItem(STORAGE_DOCS);
    const external = raw ? (JSON.parse(raw) as Doc[]).filter((d) => !deletedIds.has(d.id)) : [];
    const merged = mergeById(get(docsStore), external);
    docsStore.set(merged);
    // A doc belonging to an ephemeral workspace (see stores/workspaces.ts's
    // previewSharedWorkspace) follows that workspace's own exclusion from
    // localStorage — same one-choke-point pattern persistWorkspacesExcluding
    // uses for the workspace record itself.
    const ephemeralWorkspaceIds = new Set(get(workspacesStore).filter((w) => w.ephemeral).map((w) => w.id));
    const toPersist = ephemeralWorkspaceIds.size === 0 ? merged : merged.filter((d) => !ephemeralWorkspaceIds.has(d.workspaceId));
    localStorage.setItem(STORAGE_DOCS, JSON.stringify(toPersist));
  } catch (e) {
    showToast("Couldn't save — your browser's local storage may be full", "error");
  }
}
```

Replace `setActiveId`:

```ts
function setActiveId(id: string | null) {
  activeIdStore.set(id);
  if (!id) {
    localStorage.removeItem(STORAGE_ACTIVE);
    return;
  }
  const doc = findDocById(id);
  const ws = doc ? get(workspacesStore).find((w) => w.id === doc.workspaceId) : undefined;
  if (ws?.ephemeral) return;
  localStorage.setItem(STORAGE_ACTIVE, id);
}
```

`findDocById` is already defined earlier in this same file — no new import needed. `workspacesStore` is already imported at the top of `docs.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/client/src/stores/docs.test.ts --project=unit`
Expected: PASS (all previous tests in this file too).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/stores/docs.ts tests/client/src/stores/docs.test.ts
git commit -m "feat: exclude ephemeral-workspace docs and active-id from persistence"
```

---

### Task 3: `collab.ts` — split `decideJoinTarget`, wire the preview path

**Files:**
- Modify: `client/src/collab.ts` (`JoinDecision` type, `decideJoinTarget`, `joinSharedLink`, imports)
- Test: `tests/client/src/collab.test.ts` (existing file, `describe("decideJoinTarget", ...)`)

**Interfaces:**
- Consumes: `previewSharedWorkspace` (Task 1).
- Produces: `JoinDecision` now has three variants — `{ kind: "auto-permanent"; workspaceName: string }`, `{ kind: "auto-preview"; workspaceName: string }`, `{ kind: "choice" }`. Task 4 does not consume this type directly (it only calls `previewSharedWorkspace`), but should know the modal is reached only via `"choice"`, unchanged from today.

- [ ] **Step 1: Update the failing tests**

In `tests/client/src/collab.test.ts`, replace the entire `describe("decideJoinTarget", ...)` block:

```ts
describe("decideJoinTarget", () => {
  it("auto-previews a single document when the receiver already has workspaces of their own", () => {
    const result = decideJoinTarget([{ name: "Release Notes" }], 3);
    expect(result).toEqual({ kind: "auto-preview", workspaceName: "Release Notes" });
  });

  it("auto-lands a single document permanently when the receiver has none", () => {
    const result = decideJoinTarget([{ name: "Release Notes" }], 0);
    expect(result).toEqual({ kind: "auto-permanent", workspaceName: "Release Notes" });
  });

  it("falls back to a placeholder name when the single document has no name", () => {
    const result = decideJoinTarget([{ name: "" }], 1);
    expect(result).toEqual({ kind: "auto-preview", workspaceName: "Untitled" });
  });

  it("auto-lands a multi-document workspace permanently when the receiver has zero workspaces", () => {
    const result = decideJoinTarget([{ name: "A" }, { name: "B" }], 0);
    expect(result).toEqual({ kind: "auto-permanent", workspaceName: "Shared workspace" });
  });

  it("returns a choice decision for a multi-document workspace when the receiver has existing workspaces", () => {
    const result = decideJoinTarget([{ name: "A" }, { name: "B" }], 2);
    expect(result).toEqual({ kind: "choice" });
  });

  it("treats zero valid documents as a multi-document share (no single doc to auto-land)", () => {
    const result = decideJoinTarget([], 0);
    expect(result).toEqual({ kind: "auto-permanent", workspaceName: "Shared workspace" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/client/src/collab.test.ts --project=unit`
Expected: FAIL — current implementation returns `{ kind: "auto", ... }` for every case above.

- [ ] **Step 3: Update `JoinDecision`/`decideJoinTarget`, and `joinSharedLink`**

In `client/src/collab.ts`, add `previewSharedWorkspace` to the existing import:

```ts
import { workspacesStore, switchWorkspace, createWorkspace, persistWorkspaces, adoptSharedWorkspace, previewSharedWorkspace } from "./stores/workspaces";
```

Replace the `JoinDecision` type and `decideJoinTarget`:

```ts
export type JoinDecision = { kind: "auto-permanent"; workspaceName: string } | { kind: "auto-preview"; workspaceName: string } | { kind: "choice" };

// A single shared document is unambiguous — there's nothing meaningful to
// choose between (merge it into an existing workspace, or give it its
// own?). It lands permanently only when the receiver has no workspaces of
// their own — likely their only reason for being here at all, so losing
// it on reload would be worse than today's behavior, and there's no
// existing local library to protect. Otherwise it previews first:
// auto-committing into an existing library is exactly the clutter this
// was built to avoid. A multi-document workspace share gets a real choice
// (including a Preview option — see JoinWorkspaceModal.svelte), except for
// a receiver with zero workspaces, who has nothing to choose between
// either and lands permanently the same way as the single-doc case.
export function decideJoinTarget(validDocs: { name: string }[], existingWorkspaceCount: number): JoinDecision {
  if (existingWorkspaceCount === 0) {
    return { kind: "auto-permanent", workspaceName: validDocs.length === 1 ? validDocs[0]!.name || "Untitled" : "Shared workspace" };
  }
  if (validDocs.length === 1) return { kind: "auto-preview", workspaceName: validDocs[0]!.name || "Untitled" };
  return { kind: "choice" };
}
```

Replace the `decision.kind === "auto"` branch inside `joinSharedLink`:

```ts
  const decision = decideJoinTarget(validDocs, get(workspacesStore).length);
  if (decision.kind === "auto-permanent") {
    const ws = adoptSharedWorkspace(workspaceId, decision.workspaceName);
    importRemoteDocs(ws.id, validDocs);
    switchWorkspace(ws.id);
    switchDoc(landOnDocId);
    return;
  }
  if (decision.kind === "auto-preview") {
    const ws = previewSharedWorkspace(workspaceId, decision.workspaceName);
    importRemoteDocs(ws.id, validDocs);
    switchWorkspace(ws.id);
    switchDoc(landOnDocId);
    return;
  }

  pendingJoin.set({ remoteId: workspaceId, workspaceName: "Shared workspace", docs: validDocs, landOnDocId });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/client/src/collab.test.ts --project=unit`
Expected: PASS (the whole file — `decideShareTarget` and every other existing `describe` block in this file must still pass too).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add client/src/collab.ts tests/client/src/collab.test.ts
git commit -m "feat: auto-join previews instead of auto-committing when the receiver has their own workspaces"
```

---

### Task 4: `JoinWorkspaceModal.svelte` — "Preview only" option

**Files:**
- Modify: `client/src/components/JoinWorkspaceModal.svelte`
- Test: `tests/client/src/components/JoinWorkspaceModal.test.ts` (new — routes to the `components` Vitest project, matching `tests/client/src/components/WhatsNew.test.ts`'s naming/placement convention)

**Interfaces:**
- Consumes: `previewSharedWorkspace` (Task 1).

- [ ] **Step 1: Write the failing component test**

Create `tests/client/src/components/JoinWorkspaceModal.test.ts`:

```ts
import { test, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { get } from "svelte/store";
import JoinWorkspaceModal from "../../../../client/src/components/JoinWorkspaceModal.svelte";
import { pendingJoin } from "../../../../client/src/stores/joinWorkspace";
import { workspacesStore } from "../../../../client/src/stores/workspaces";
import { docsStore } from "../../../../client/src/stores/docs";

beforeEach(() => {
  localStorage.clear();
  pendingJoin.set(null);
  workspacesStore.set([{ id: "ws-1", name: "My Workspace", createdAt: 0, updatedAt: 0 }]);
  docsStore.set([]);
});

function openPendingJoin() {
  pendingJoin.set({
    remoteId: "room-x",
    workspaceName: "Shared workspace",
    docs: [
      { id: "d1", name: "Doc A", content: "", updatedAt: 0, createdAt: 0 },
      { id: "d2", name: "Doc B", content: "", updatedAt: 0, createdAt: 0 },
    ],
    landOnDocId: "d1",
  });
}

test("renders all three join options", async () => {
  const screen = await render(JoinWorkspaceModal);
  openPendingJoin();
  await expect.element(screen.getByRole("button", { name: "Add as new workspace" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Merge in" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Preview only" })).toBeVisible();
});

test("Preview only creates an ephemeral workspace, closes the modal, and never persists it", async () => {
  const screen = await render(JoinWorkspaceModal);
  openPendingJoin();
  await screen.getByRole("button", { name: "Preview only" }).click();
  await expect.element(screen.getByText("Join shared workspace")).not.toBeInTheDocument();
  const preview = get(workspacesStore).find((w) => w.remoteId === "room-x");
  expect(preview?.ephemeral).toBe(true);
  const persisted = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
  expect(persisted.map((w: { id: string }) => w.id)).not.toContain(preview!.id);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project=components tests/client/src/components/JoinWorkspaceModal.test.ts`
Expected: FAIL — no "Preview only" button exists yet.

- [ ] **Step 3: Add the "Preview only" button and handler**

Replace the full contents of `client/src/components/JoinWorkspaceModal.svelte`:

```svelte
<script lang="ts">
  import Modal from "./Modal.svelte";
  import { pendingJoin } from "../stores/joinWorkspace";
  import { workspacesStore, adoptSharedWorkspace, mergeSharedWorkspaceInto, previewSharedWorkspace, switchWorkspace } from "../stores/workspaces";
  import { importRemoteDocs, switchDoc } from "../stores/docs";

  let mergeTargetId = $state<string | null>(null);

  function cancel() {
    pendingJoin.set(null);
  }

  function addAsNew() {
    const state = $pendingJoin;
    if (!state) return;
    const ws = adoptSharedWorkspace(state.remoteId, state.workspaceName);
    importRemoteDocs(ws.id, state.docs);
    switchWorkspace(ws.id);
    switchDoc(state.landOnDocId);
    pendingJoin.set(null);
  }

  function merge() {
    const state = $pendingJoin;
    if (!state || !mergeTargetId) return;
    mergeSharedWorkspaceInto(mergeTargetId, state.remoteId);
    importRemoteDocs(mergeTargetId, state.docs);
    switchWorkspace(mergeTargetId);
    switchDoc(state.landOnDocId);
    pendingJoin.set(null);
  }

  function preview() {
    const state = $pendingJoin;
    if (!state) return;
    const ws = previewSharedWorkspace(state.remoteId, state.workspaceName);
    importRemoteDocs(ws.id, state.docs);
    switchWorkspace(ws.id);
    switchDoc(state.landOnDocId);
    pendingJoin.set(null);
  }
</script>

{#if $pendingJoin}
  <Modal title="Join shared workspace" labelledBy="joinWorkspaceTitle" onClose={cancel}>
    <p>"{$pendingJoin.workspaceName}" has been shared with you. Add it as a new workspace of its own, merge its documents into one you already have, or just look without saving?</p>

    <div class="menu-section-label">Merge into an existing workspace</div>
    <select bind:value={mergeTargetId} aria-label="Choose a workspace to merge into">
      <option value={null}>Choose a workspace…</option>
      {#each $workspacesStore as ws (ws.id)}
        <option value={ws.id}>{ws.name}</option>
      {/each}
    </select>

    {#snippet footer()}
      <button type="button" class="secondary-btn" onclick={cancel}>Cancel</button>
      <button type="button" class="secondary-btn" onclick={preview}>Preview only</button>
      <button type="button" class="secondary-btn" disabled={!mergeTargetId} onclick={merge}>Merge in</button>
      <button type="button" class="primary-btn" onclick={addAsNew}>Add as new workspace</button>
    {/snippet}
  </Modal>
{/if}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project=components tests/client/src/components/JoinWorkspaceModal.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and format**

Run: `npm run typecheck && npx prettier --check client/src/components/JoinWorkspaceModal.svelte tests/client/src/components/JoinWorkspaceModal.test.ts`
Expected: 0 errors; if prettier reports a diff, run `npx prettier --write` on the two files and re-check.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/JoinWorkspaceModal.svelte tests/client/src/components/JoinWorkspaceModal.test.ts
git commit -m "feat: Preview only option in the join-shared-workspace modal"
```

---

### Task 5: `WorkspaceSwitcher.svelte` — Preview badge + "Keep this workspace"

**Files:**
- Modify: `client/src/components/WorkspaceSwitcher.svelte`
- Modify: `client/src/styles/_share-workspace.scss`
- Test: `tests/e2e/local/` is not applicable here (no local-only e2e project has a shared-workspace flow — this is covered end-to-end in Task 6's collab e2e test instead). This task is verified by Task 6.

**Interfaces:**
- Consumes: `promoteEphemeralWorkspace` (Task 1), `persistDocs` (already exported from `stores/docs.ts`).

- [ ] **Step 1: Add the badge and Keep action to the component**

In `client/src/components/WorkspaceSwitcher.svelte`, update the imports:

```ts
  import {
    workspacesStore,
    activeWorkspaceIdStore,
    createWorkspace,
    renameWorkspace,
    switchWorkspace,
    deleteWorkspaceRecord,
    promoteEphemeralWorkspace,
  } from "../stores/workspaces";
  import { docsStore, removeDocById, ensureActiveDocInWorkspace, persistDocs } from "../stores/docs";
```

Add a `keepWorkspace` function, right after `pick`:

```ts
  function keepWorkspace(id: string) {
    promoteEphemeralWorkspace(id);
    persistDocs();
    close();
  }
```

Update the trigger button and popover in the template:

```svelte
<div class="workspace-switcher">
  <button type="button" class="workspace-switcher-trigger" onclick={toggle}>
    <span class="workspace-name">{activeWorkspace?.name ?? "No workspace"}</span>
    {#if activeWorkspace?.ephemeral}<span class="workspace-preview-badge">Preview</span>{/if}
    <svg class="icon"><use href="#icon-chevron-down"></use></svg>
  </button>
  {#if open}
    <div class="workspace-switcher-popover">
      {#if activeWorkspace?.ephemeral}
        <button type="button" class="workspace-keep-btn" onclick={() => keepWorkspace(activeWorkspace!.id)}>Keep this workspace</button>
      {/if}
      <ul class="workspace-list">
```

(The rest of the template — the `<ul class="workspace-list">` contents, `.workspace-new-btn`, and the closing tags — is unchanged.)

- [ ] **Step 2: Add the CSS**

In `client/src/styles/_share-workspace.scss`, right after the `.workspace-switcher-trigger { ... }` block's closing brace:

```scss
.workspace-preview-badge {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  flex-shrink: 0;
}
```

And right after the `.workspace-new-btn:hover { ... }` block's closing brace:

```scss
.workspace-keep-btn {
  display: block;
  width: 100%;
  text-align: left;
  padding: 9px 14px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: var(--accent-dim);
  color: var(--accent);
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
}
.workspace-keep-btn:hover {
  background: var(--accent);
  color: var(--bg);
}
```

- [ ] **Step 3: Typecheck and format**

Run: `npm run typecheck && npx prettier --check client/src/components/WorkspaceSwitcher.svelte client/src/styles/_share-workspace.scss`
Expected: 0 errors; run `npx prettier --write` on either file if it reports a diff.

- [ ] **Step 4: Manual smoke check**

Run `npm run build` then `npm run dev` (needs `.dev.vars` with GitHub OAuth creds — if unavailable in this environment, skip this step and rely on Task 6's e2e coverage instead, noting that in the task's completion message). In a browser: use `previewSharedWorkspace` via the browser console against a running instance (`window.MDE` doesn't expose it directly — this is easiest to verify once Task 6's e2e test passes) to confirm the badge and "Keep this workspace" button render and behave as expected.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/WorkspaceSwitcher.svelte client/src/styles/_share-workspace.scss
git commit -m "feat: Preview badge and Keep-this-workspace action in the workspace switcher"
```

---

### Task 6: End-to-end collab coverage

**Files:**
- Create: `tests/e2e/collab/shared-workspace-preview.spec.ts`

**Interfaces:**
- Consumes: `signInAsDevUser` from `tests/e2e/collab/support/dev-login.ts` (existing helper, used by `live-sync.spec.ts`).

- [ ] **Step 1: Write the test**

Create `tests/e2e/collab/shared-workspace-preview.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { signInAsDevUser } from "./support/dev-login";

const BASE = "http://localhost:8787";

async function dismissWhatsNew(page: import("@playwright/test").Page) {
  const gotIt = page.locator('button:has-text("Got it")');
  if (await gotIt.isVisible({ timeout: 2000 }).catch(() => false)) {
    await gotIt.click();
  }
}

async function waitForApp(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
}

test("a shared workspace previews without persisting, and Keep makes it survive a reload", async ({ browser }) => {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  await signInAsDevUser(alice, "alice-preview-e2e");
  await signInAsDevUser(bob, "bob-preview-e2e");

  // Alice: create and share a single document.
  await alice.goto(BASE);
  await waitForApp(alice);
  await dismissWhatsNew(alice);
  await alice.click("#emptyNewWorkspaceBtn");
  await alice.keyboard.press("Escape").catch(() => {});
  await alice.evaluate(() => window.MDE.newDoc());
  await alice.waitForSelector("#editor-mount .cm-content", { state: "visible" });
  await alice.click("#editor-mount .cm-content");
  await alice.keyboard.type("Shared preview content");

  await alice.click('button:has-text("Share")');
  const moveDialog = alice.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();
  const accessSelect = alice.locator("select").first();
  await accessSelect.waitFor({ state: "visible" });
  await Promise.all([
    alice.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    accessSelect.selectOption({ label: "Anyone with the link" }),
  ]);
  const shareState = await alice.evaluate(() => {
    const workspaces = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const activeId = localStorage.getItem("mde:active");
    const activeDoc = docs.find((d: { id: string }) => d.id === activeId);
    const ws = workspaces.find((w: { id: string }) => w.id === activeDoc?.workspaceId);
    return { activeDoc, ws };
  });
  const remoteId = shareState.ws.remoteId as string;
  const shareUrl = `${BASE}/w/${remoteId}/${shareState.activeDoc.id}/edit`;

  // Bob already has a workspace of his own before ever seeing the link —
  // this is what makes the single-doc auto-join land as a preview instead
  // of committing permanently (decideJoinTarget in collab.ts).
  await bob.goto(BASE);
  await waitForApp(bob);
  await dismissWhatsNew(bob);
  await bob.click("#emptyNewWorkspaceBtn");
  await bob.keyboard.press("Escape").catch(() => {});

  await bob.goto(shareUrl);
  await waitForApp(bob);
  await expect.poll(() => bob.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("Shared preview content");
  await expect(bob.locator(".workspace-preview-badge")).toBeVisible();

  await bob.reload();
  await waitForApp(bob);
  const afterReload = await bob.evaluate(() => JSON.parse(localStorage.getItem("mde:workspaces") || "[]"));
  expect(afterReload.some((w: { remoteId?: string }) => w.remoteId === remoteId)).toBe(false);

  // Re-join, this time click Keep — it must survive a reload.
  await bob.goto(shareUrl);
  await waitForApp(bob);
  await expect(bob.locator(".workspace-preview-badge")).toBeVisible();
  await bob.click(".workspace-switcher-trigger");
  await bob.click('button:has-text("Keep this workspace")');

  await bob.reload();
  await waitForApp(bob);
  const afterKeepReload = await bob.evaluate(() => JSON.parse(localStorage.getItem("mde:workspaces") || "[]"));
  expect(afterKeepReload.some((w: { remoteId?: string }) => w.remoteId === remoteId)).toBe(true);
});
```

- [ ] **Step 2: Run it against a real backend**

Run: `npm run test:e2e:collab`
Expected: PASS, alongside every other spec in `tests/e2e/collab/`. If it fails, use the systematic-debugging skill before changing anything — read the actual error/screenshot first (this exercises real DO-backed workspace state, dev-login, and the full share round trip, so a first failure is more likely a selector/assumption mismatch with the real app than a logic bug already covered by Tasks 1-4's unit/component tests).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/collab/shared-workspace-preview.spec.ts
git commit -m "test: e2e coverage for shared-workspace preview and Keep"
```

---

### Task 7: Version / CHANGELOG / What's New / IMPROVEMENTS

**Files:**
- Modify: `package.json`, `package-lock.json` (both `"version"` fields)
- Modify: `CHANGELOG.md`
- Modify: `client/src/whats-new-entries.ts`
- Modify: `IMPROVEMENTS.md`

**Interfaces:** none — documentation/metadata only.

- [ ] **Step 1: Bump the version**

In `package.json`, bump `"version"` to the next minor (e.g. current `1.40.x` → `1.41.0` — check `package.json`'s current value first, since other work may have shipped since this plan was written, and bump from whatever that actual current value is). Make the identical edit to both `"version"` occurrences in `package-lock.json` (top-level and the `packages[""]` entry) by hand, not a full `npm install --package-lock-only` regeneration, per `CLAUDE.md`.

- [ ] **Step 2: Add the CHANGELOG entry**

At the top of `CHANGELOG.md`, add (using the version from Step 1 and today's date):

```markdown
## [1.41.0] - YYYY-MM-DD

### Added

- **Shared-workspace previews.** Opening a share link when you already have your own workspaces now previews it instead of permanently adding it to your sidebar — a "Preview" badge shows in the workspace switcher, with a "Keep this workspace" action if you decide to hang onto it. Closing or reloading the tab drops an unpicked preview; revisiting the link starts a fresh one. A brand-new visitor with no workspaces of their own still lands directly in the shared workspace, same as before. The "Join shared workspace" dialog (shown for a multi-document share when you have workspaces to merge into) also gains a "Preview only" option alongside "Merge in" and "Add as new workspace".
```

- [ ] **Step 3: Add the What's New entry**

Append to the `WHATS_NEW_ENTRIES` array in `client/src/whats-new-entries.ts` (oldest-first, so this goes last):

```ts
  {
    version: "1.41.0",
    title: "Shared-Workspace Previews",
    description:
      "Opening a share link now previews it instead of permanently cluttering your sidebar — look first, and click \"Keep this workspace\" only if you want to hang onto it. Closing or reloading the tab drops an unpicked preview.",
    screenshot: "/whats-new/shared-workspace-preview.png",
    category: "Collaboration",
  },
```

Note: capturing the actual screenshot at `client/public/whats-new/shared-workspace-preview.png` requires a live two-user collab session (unlike the client-only What's New screenshot script from the September 1st categories feature) — use `tests/scripts/manual-testing/` conventions if a capture script is needed, driving it against `npm run dev` with a real `.dev.vars`, or capture manually and save to that path. If no `.dev.vars`/GitHub OAuth app is available in the environment doing this work, use a placeholder screenshot path is NOT acceptable per this repo's own convention (`WhatsNew.svelte` expects a real asset) — flag this explicitly as a blocker requiring the user's own environment rather than skipping it silently.

- [ ] **Step 4: Check off the IMPROVEMENTS.md item**

In `IMPROVEMENTS.md`, replace:

```markdown
- [ ] **Shared-document session separation.** A shared document is
      currently treated like any local document in the same window/
      session. Evaluate: either keep that, or make an opened shared
      document exclusive to its own window/session (local documents
      would need a separate window). Also relevant prep work if
      folder/repo sync is ever built.
```

with:

```markdown
- [x] **Shared-document session separation.** (Shipped v1.41.0.)
      Opening a share link now previews the workspace (never persisted)
      instead of always permanently committing it — a "Preview" badge
      and "Keep this workspace" action in the switcher, plus a "Preview
      only" option in the join-choice modal. A receiver with zero
      workspaces of their own still lands directly and permanently,
      since there's nothing to protect from clutter and losing their
      only workspace on reload would be worse than today.
```

(Adjust the version number in both places if Step 1's actual bump differs from `1.41.0`.)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts IMPROVEMENTS.md
git commit -m "chore: version bump and changelog for shared-workspace previews"
```

(If the What's New screenshot is genuinely blocked per Step 3's note, commit everything else and raise the screenshot as an explicit open item rather than silently omitting the entry or using a fake asset.)

---

### Task 8: Final verification

**Files:** none — verification only.

**Interfaces:** none.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: every test file passes, including all of Tasks 1-4's new/updated tests.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Format check**

Run: `npm run format:check`
Expected: no diffs. If any file is unformatted, run `npm run format` and re-verify, then amend the relevant commit or add a small formatting commit.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 5: Local e2e suite (regression check)**

Run: `npm run test:e2e:local`
Expected: all pass — this feature touches no local-only e2e-covered flow, so this is a pure regression check.

- [ ] **Step 6: Collab e2e suite**

Run: `npm run test:e2e:collab`
Expected: all pass, including Task 6's new spec and the existing `live-sync.spec.ts` (confirms the existing single-doc/zero-workspace auto-join path is unaffected by the `decideJoinTarget` split).

- [ ] **Step 7: Report**

Summarize: version shipped, all tests green, and explicitly call out whether the What's New screenshot (Task 7, Step 3) was captured or is still an open blocker.
