# Shared Workspace Background Document Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every document in a shared workspace stays live-synced into `docsStore` — not just the one currently open — and the sidebar's display order no longer depends on `updatedAt`, so a collaborator editing a document you aren't viewing doesn't reshuffle your document list.

**Architecture:** `docs.ts` gains a small, pure-ish `syncRemoteDocContent()` mutator that writes a document's content/images and bumps `updatedAt` only when something actually changed. `collab.ts` tracks which background documents have unflushed remote Yjs changes in a `Set`, debounces (800ms) writing them into `docsStore` via that new mutator, and flushes synchronously on teardown so nothing is lost on disconnect. `DocList.svelte`'s sidebar sort switches from `updatedAt` to document name.

**Tech Stack:** TypeScript, Svelte 5, Yjs, Vitest.

## Global Constraints

- `syncRemoteDocContent` only bumps `updatedAt` when content or images actually differ from what's stored — mirrors `saveActiveDocContent`'s existing "don't bump on a no-op" rule.
- Image-set comparison must be key-order-independent (Y.Map's `.entries()` iteration order has no guaranteed relationship to a stored object's key order) — never a naive `JSON.stringify` equality check.
- `MenuBar.svelte`'s "Open Recent" submenu and `ensureActiveDocInWorkspace`'s target-doc selection both stay on `updatedAt` — out of scope, do not touch.
- No forced synchronous flush before `pushToRepo` or other `doc.content` readers — the 800ms debounce plus a synchronous flush on `teardownWorkspace()` is the full extent of this spec's guarantee (see spec's Non-goals).

---

### Task 1: `syncRemoteDocContent` in `stores/docs.ts`

**Files:**
- Modify: `client/src/stores/docs.ts`
- Test: `client/src/stores/docs.test.ts`

**Interfaces:**
- Consumes: `findDocById` (already exported, same file), `updateDoc` (already defined, module-private, same file).
- Produces: `export function syncRemoteDocContent(id: string, content: string, images: Record<string, string> | undefined): boolean` — returns `true` if it wrote a change, `false` if the doc doesn't exist or nothing actually changed.

- [ ] **Step 1: Write the failing tests**

In `client/src/stores/docs.test.ts`, add at the end of the `describe("docs store — workspace integration", ...)` block, right before its closing `});` (currently the line right after the `clearRepoSyncMetadata` test):

```ts
  it("syncRemoteDocContent writes new content and bumps updatedAt when content differs", async () => {
    const { createDoc, syncRemoteDocContent, findDocById } = await import("./docs");
    const { createWorkspace } = await import("./workspaces");
    const ws = createWorkspace("Notes");
    const doc = createDoc({ workspaceId: ws.id, name: "a" });
    const before = findDocById(doc.id)!.updatedAt;
    const wrote = syncRemoteDocContent(doc.id, "new content", undefined);
    expect(wrote).toBe(true);
    const after = findDocById(doc.id)!;
    expect(after.content).toBe("new content");
    expect(after.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("syncRemoteDocContent writes new images and bumps updatedAt when images differ", async () => {
    const { createDoc, syncRemoteDocContent, findDocById } = await import("./docs");
    const { createWorkspace } = await import("./workspaces");
    const ws = createWorkspace("Notes");
    const doc = createDoc({ workspaceId: ws.id, name: "a", content: "same" });
    const wrote = syncRemoteDocContent(doc.id, "same", { "img-1": "data-a" });
    expect(wrote).toBe(true);
    expect(findDocById(doc.id)!.images).toEqual({ "img-1": "data-a" });
  });

  it("syncRemoteDocContent is a no-op when content and images are unchanged, even with images in a different key order", async () => {
    const { createDoc, syncRemoteDocContent, findDocById } = await import("./docs");
    const { createWorkspace } = await import("./workspaces");
    const ws = createWorkspace("Notes");
    const doc = createDoc({ workspaceId: ws.id, name: "a", content: "same" });
    syncRemoteDocContent(doc.id, "same", { "img-1": "data-a", "img-2": "data-b" });
    const before = findDocById(doc.id)!.updatedAt;
    const wrote = syncRemoteDocContent(doc.id, "same", { "img-2": "data-b", "img-1": "data-a" });
    expect(wrote).toBe(false);
    expect(findDocById(doc.id)!.updatedAt).toBe(before);
  });

  it("syncRemoteDocContent returns false when the doc id doesn't exist", async () => {
    const { syncRemoteDocContent } = await import("./docs");
    expect(syncRemoteDocContent("does-not-exist", "content", undefined)).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/src/stores/docs.test.ts`
Expected: FAIL — `syncRemoteDocContent` is not exported yet.

- [ ] **Step 3: Write the implementation**

In `client/src/stores/docs.ts`, find:

```ts
function updateDoc(id: string, changes: Partial<Doc>) {
  docsStore.update((docs) => docs.map((d) => (d.id === id ? { ...d, ...changes } : d)));
}
```

Change to:

```ts
function updateDoc(id: string, changes: Partial<Doc>) {
  docsStore.update((docs) => docs.map((d) => (d.id === id ? { ...d, ...changes } : d)));
}

// True key-set-and-value equality regardless of insertion order — Y.Map's
// own .entries() iteration order has no guaranteed relationship to the
// order doc.images' keys were originally inserted in, so a naive
// JSON.stringify comparison could report "changed" for genuinely
// identical image sets and bump updatedAt for no real reason.
function sameImages(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const aEntries = Object.entries(a ?? {});
  const bMap = b ?? {};
  if (aEntries.length !== Object.keys(bMap).length) return false;
  return aEntries.every(([key, value]) => bMap[key] === value);
}

// Writes a shared workspace's background (non-active) document content
// back into docsStore. Called by collab.ts for every document in a
// shared workspace that isn't the one currently open — the active
// document's content already flows through activeDocContent ->
// saveActiveDocContent instead, so this only ever runs for documents the
// user isn't looking at right now. Mirrors saveActiveDocContent's "don't
// bump updatedAt unless something actually changed" rule: a collaborator
// really editing a document is a real modification and should bump it
// the same way a local edit would, but reconnecting/resyncing identical
// content must not.
export function syncRemoteDocContent(id: string, content: string, images: Record<string, string> | undefined): boolean {
  const doc = findDocById(id);
  if (!doc) return false;
  const contentChanged = content !== doc.content;
  const imagesChanged = !sameImages(images, doc.images);
  if (!contentChanged && !imagesChanged) return false;
  updateDoc(id, { content, images, updatedAt: Date.now() });
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run client/src/stores/docs.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Update the now-stale comment in `saveActiveDocContent`**

`saveActiveDocContent`'s comment currently justifies its no-op check by
saying "DocList.svelte sorts by it" (`updatedAt`) — Task 3 below removes
that sort, so the comment needs to explain the rule on its own merits
instead of a display-order side effect that will no longer be true.

Find:

```ts
export function saveActiveDocContent() {
  const doc = getActiveDoc();
  if (!doc) return;
  const content = get(activeDocContent);
  // Merely opening/switching away from a document with no pending
  // edit must not bump updatedAt — DocList.svelte sorts by it, and
  // navigation alone shouldn't reorder the sidebar (only a real edit
  // should). switchDoc() calls this on every switch regardless of
  // whether anything actually changed, so this check is what makes
  // that distinction instead of the debounced-save path.
  if (content === doc.content) return;
  updateDoc(doc.id, { content, updatedAt: Date.now() });
  persistDocs();
}
```

Change to:

```ts
export function saveActiveDocContent() {
  const doc = getActiveDoc();
  if (!doc) return;
  const content = get(activeDocContent);
  // Merely opening/switching away from a document with no pending edit
  // must not bump updatedAt — it should only ever reflect a real
  // modification. switchDoc() calls this on every switch regardless of
  // whether anything actually changed, so this check is what makes that
  // distinction instead of the debounced-save path. Same rule
  // syncRemoteDocContent (below) applies for remote/collaborator edits.
  if (content === doc.content) return;
  updateDoc(doc.id, { content, updatedAt: Date.now() });
  persistDocs();
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add client/src/stores/docs.ts client/src/stores/docs.test.ts
git commit -m "feat: add syncRemoteDocContent for writing back background doc changes"
```

---

### Task 2: Debounced background-doc sync in `collab.ts`

**Files:**
- Modify: `client/src/collab.ts`

**Interfaces:**
- Consumes: `syncRemoteDocContent` (from Task 1, `./stores/docs`), `debounceWithFlush` (already exists in `./debounce`, signature `debounceWithFlush<T>(fn: () => T | Promise<T>, ms: number): { trigger(): void; runNow(): Promise<T>; flush(): Promise<T | undefined> }`).
- Produces: internal `markDirty(docId: string)` and `flushDirtyBackgroundDocs()` functions (not exported — collab.ts's public surface is unchanged), and a call to `backgroundSyncDebounce.flush()` at the top of `teardownWorkspace()`.

- [ ] **Step 1: Add the new import**

In `client/src/collab.ts`, find:

```ts
import { getActiveDoc, switchDoc, docsStore, moveDocToWorkspace, findDocById, persistDocs, importRemoteDocs } from "./stores/docs";
```

Change to:

```ts
import { getActiveDoc, switchDoc, docsStore, moveDocToWorkspace, findDocById, persistDocs, importRemoteDocs, syncRemoteDocContent } from "./stores/docs";
import { debounceWithFlush } from "./debounce";
```

- [ ] **Step 2: Add dirty-tracking state and the flush function**

Find the `DocBinding` interface and the `workspaceRoom` object:

```ts
interface DocBinding {
  ydoc: Y.Doc;
  ytext: Y.Text;
  imagesMap: Y.Map<string>;
  awareness: awarenessProtocol.Awareness;
  undoManager: Y.UndoManager | null;
  ydocUpdateHandler: (update: Uint8Array, origin: unknown) => void;
  role: string;
}

const workspaceRoom = {
  workspaceId: null as string | null,
  ws: null as WebSocket | null,
  docs: new Map<string, DocBinding>(),
  activeDocId: null as string | null,
  reconnectTimer: null as ReturnType<typeof setTimeout> | null,
  reconnectDelay: 1000,
};
```

Change to:

```ts
interface DocBinding {
  ydoc: Y.Doc;
  ytext: Y.Text;
  imagesMap: Y.Map<string>;
  awareness: awarenessProtocol.Awareness;
  undoManager: Y.UndoManager | null;
  ydocUpdateHandler: (update: Uint8Array, origin: unknown) => void;
  role: string;
}

const workspaceRoom = {
  workspaceId: null as string | null,
  ws: null as WebSocket | null,
  docs: new Map<string, DocBinding>(),
  activeDocId: null as string | null,
  reconnectTimer: null as ReturnType<typeof setTimeout> | null,
  reconnectDelay: 1000,
};

// Documents in the shared workspace whose Y.Text/images changed while
// they weren't the active document — the active document's content
// already flows into docsStore through the normal CodeMirror ->
// activeDocContent -> saveActiveDocContent pipeline, so this only ever
// tracks the ones nobody is currently looking at.
const dirtyBackgroundDocs = new Set<string>();

function markDirty(docId: string): void {
  dirtyBackgroundDocs.add(docId);
  backgroundSyncDebounce.trigger();
}

function flushDirtyBackgroundDocs(): void {
  let changed = false;
  for (const docId of dirtyBackgroundDocs) {
    // Became active while waiting to flush — the CodeMirror pipeline
    // owns it now, and its Y.Text already has the correct content
    // regardless of who reads it, so there's nothing to write here.
    if (docId === workspaceRoom.activeDocId) continue;
    const binding = workspaceRoom.docs.get(docId);
    if (!binding) continue; // workspace was torn down mid-flight
    const content = binding.ytext.toString();
    const imageEntries = Array.from(binding.imagesMap.entries());
    const images = imageEntries.length > 0 ? Object.fromEntries(imageEntries) : undefined;
    if (syncRemoteDocContent(docId, content, images)) changed = true;
  }
  dirtyBackgroundDocs.clear();
  if (changed) persistDocs();
}

const backgroundSyncDebounce = debounceWithFlush(flushDirtyBackgroundDocs, 800);
```

- [ ] **Step 3: Observe background text changes in `createDocBinding`**

Find:

```ts
function createDocBinding(docId: string, role: string): DocBinding {
  const existing = workspaceRoom.docs.get(docId);
  if (existing) return existing;

  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  const imagesMap = ydoc.getMap<string>("images");
  imagesMap.observe((event, tr) => {
    if (tr.origin === "local") return;
    event.changes.keys.forEach((change, key) => {
      if (change.action === "delete") return;
      const dataUrl = imagesMap.get(key);
      if (dataUrl && workspaceRoom.activeDocId === docId) window.MDE.setDocImage(key, dataUrl);
    });
  });
  const awareness = new awarenessProtocol.Awareness(ydoc);
```

Change to:

```ts
function createDocBinding(docId: string, role: string): DocBinding {
  const existing = workspaceRoom.docs.get(docId);
  if (existing) return existing;

  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.observe(() => {
    if (docId !== workspaceRoom.activeDocId) markDirty(docId);
  });
  const imagesMap = ydoc.getMap<string>("images");
  imagesMap.observe((event, tr) => {
    if (tr.origin === "local") return;
    if (workspaceRoom.activeDocId === docId) {
      event.changes.keys.forEach((change, key) => {
        if (change.action === "delete") return;
        const dataUrl = imagesMap.get(key);
        if (dataUrl) window.MDE.setDocImage(key, dataUrl);
      });
    } else {
      markDirty(docId);
    }
  });
  const awareness = new awarenessProtocol.Awareness(ydoc);
```

- [ ] **Step 4: Flush synchronously on teardown**

Find:

```ts
function teardownWorkspace(): void {
  remotePresenceByUsername.clear();
  workspacePresence.set(new Map());
```

Change to:

```ts
function teardownWorkspace(): void {
  // Cancels any pending debounce timer and runs the flush immediately —
  // its side effects (docsStore writes, persistDocs) happen synchronously
  // within this call even though the returned Promise resolves later, so
  // nothing pending is lost to the Y.Doc destruction below.
  backgroundSyncDebounce.flush();
  remotePresenceByUsername.clear();
  workspacePresence.set(new Map());
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all tests pass (this codebase has no automated coverage for `collab.ts`'s WebSocket/Yjs wiring beyond the already-passing `decideShareTarget` tests — this step confirms nothing else broke).

- [ ] **Step 7: Commit**

```bash
git add client/src/collab.ts
git commit -m "feat: sync background documents' live edits back into docsStore"
```

---

### Task 3: Sidebar sort order

**Files:**
- Modify: `client/src/components/DocList.svelte`

**Interfaces:**
- None — purely a display-order change, no new exports or consumers.

- [ ] **Step 1: Change the sort**

In `client/src/components/DocList.svelte`, find:

```ts
[...$docsStore].filter((d) => d.workspaceId === $activeWorkspaceIdStore).sort((a, b) => b.updatedAt - a.updatedAt)
```

Change to:

```ts
[...$docsStore].filter((d) => d.workspaceId === $activeWorkspaceIdStore).sort((a, b) => a.name.localeCompare(b.name))
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass (no automated coverage for `DocList.svelte` — matches this codebase's established precedent of no Svelte component tests).

- [ ] **Step 4: Commit**

```bash
git add client/src/components/DocList.svelte
git commit -m "feat: sort the sidebar document list by name instead of last-modified"
```

---

### Task 4: Final verification

**Files:** None (verification only).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass, including Task 1's new `syncRemoteDocContent` tests.

- [ ] **Step 2: Both typechecks**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p client/tsconfig.json
```
Expected: both clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds (pre-existing chunk-size warnings are fine and unrelated).

- [ ] **Step 4: Manual two-session verification**

This needs a real GitHub-authenticated collaboration session — the `npm run dev` full stack (Worker + GitHub OAuth), not `dev:client` alone. With two browser sessions (can be two different browsers or a normal + incognito window, each signed in as a different GitHub account) sharing a workspace with 2+ documents:

- Session A opens Document 1, Session B opens Document 2 (different document, same shared workspace).
- Type in Session A's Document 1. In Session B, without switching documents, confirm Document 1's row in the sidebar (heading outline / preview) updates within about a second.
- Confirm the sidebar list itself stays in alphabetical order throughout — it must not reorder while Session A types.
- Reload Session B's page entirely. Confirm Document 1 still shows the latest edited content (proves it was actually persisted to `docsStore`/`localStorage`, not just live in the in-memory `Y.Doc`).
- In Session B, right after Session A makes an edit, immediately switch Session B to an unshared workspace (disconnecting it) and then back — confirm the edit wasn't lost (proves `teardownWorkspace()`'s synchronous flush worked).

If you can't run the full two-account stack, flag this to the user rather than attempting it blind, same as the join-flow verification note in the previous plan.
