# Shared Document Name Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rename of a shared document reaches every collaborator live, the same way a content edit or an inserted image already does — including a fresh joiner, who should see the real name instead of the hardcoded `"Shared document"` placeholder.

**Architecture:** The document name becomes a third top-level type on the same per-document `Y.Doc` as `ytext`/`imagesMap` — a `meta: Y.Map<string>` holding `name`, exactly mirroring how `imagesMap` was added. This rides the existing `MESSAGE_SYNC` wire format and `WorkspaceRoom` persistence/broadcast path with zero server-side changes, and is gated editor-only for free (the server's existing write check already covers the whole Y.Doc update, not just `ytext`). Two new `MDEBridge` hooks (`setDocName`/`onDocRenamed`) mirror the existing `setDocImage`/`onImageAdded` pair for the two sync directions.

**Tech Stack:** TypeScript, Svelte 5, Yjs, Vitest.

## Global Constraints

- No changes to `src/workspace-room.ts` or the WebSocket wire protocol — the whole point of piggybacking on the Y.Doc is that the server needs zero changes.
- No changes to `src/collab-room.ts` (legacy single-doc rooms) — every document reaching this feature has already migrated onto `WorkspaceRoom` before any live sync attaches.
- A remote rename that collides with an unrelated local document's name must be silently suffixed (`-2`, `-3`, ...), same as `importRemoteDocs` already does — never left to break the app's global-uniqueness invariant.
- Version History / snapshot restore must not be affected — snapshots keep tracking `content`/`images` only.

---

### Task 1: `MDEBridge` hooks for the two sync directions

**Files:**
- Modify: `client/src/types.ts`
- Modify: `client/src/app.ts`

**Interfaces:**
- Produces (on `MDEBridge`):
  ```ts
  setDocName(id: string, name: string): void;
  onDocRenamed: ((id: string, name: string) => void) | null;
  ```

- [ ] **Step 1: Add the two members to `MDEBridge`**

In `client/src/types.ts`, find:

```ts
  setDocImage(key: string, dataUrl: string): void;
  onImageAdded: ((key: string, dataUrl: string) => void) | null;
```

Change to:

```ts
  setDocImage(key: string, dataUrl: string): void;
  onImageAdded: ((key: string, dataUrl: string) => void) | null;
  // Same shape as setDocImage/onImageAdded, for the document's name: a
  // collaborator renaming a shared document (collab.ts's metaMap) calls
  // setDocName to update the docTitle input/page title/store for
  // whichever doc that is; the local user renaming via the docTitle
  // input calls onDocRenamed so collab.ts can push that name to the
  // shared workspace's Y.Doc if the document is currently shared.
  setDocName(id: string, name: string): void;
  onDocRenamed: ((id: string, name: string) => void) | null;
```

- [ ] **Step 2: Implement `setDocName` and initialize `onDocRenamed` on the bridge**

In `client/src/app.ts`, extend the docs-store import to add `docsStore` and `persistDocs`, and import `ensureUniqueName`. Find:

```ts
import {
  activeIdStore,
  activeDocContent,
  getActiveDoc,
  createDoc,
  switchDoc as storeSwitchDoc,
  renameDoc,
  saveActiveDocContent,
  setDocImage,
  refreshDocNoteAnchors,
  findCollidingDoc,
} from "./stores/docs";
import { workspacesStore, createWorkspace } from "./stores/workspaces";
```

Change to:

```ts
import {
  activeIdStore,
  activeDocContent,
  docsStore,
  getActiveDoc,
  createDoc,
  switchDoc as storeSwitchDoc,
  renameDoc,
  saveActiveDocContent,
  setDocImage,
  refreshDocNoteAnchors,
  findCollidingDoc,
  persistDocs,
} from "./stores/docs";
import { ensureUniqueName } from "./doc-naming";
import { workspacesStore, createWorkspace } from "./stores/workspaces";
```

Find the bridge object literal's `setDocImage`/`onImageAdded` entries:

```ts
    setDocImage(key, dataUrl) {
      setDocImage(key, dataUrl);
      window.MDE.updatePreview?.();
    },
    onImageAdded: null,
```

Change to:

```ts
    setDocImage(key, dataUrl) {
      setDocImage(key, dataUrl);
      window.MDE.updatePreview?.();
    },
    onImageAdded: null,
    // Called by collab.ts when a collaborator renames a shared document
    // (its Y.Doc "meta" map changed remotely). Re-applies the same
    // global-uniqueness rule createDoc/importRemoteDocs use rather than
    // trusting the incoming name as-is — a remote rename that happens to
    // collide with an unrelated local document must not silently break
    // wikilink resolution's exact-match assumption.
    setDocName(id, name) {
      const finalName = ensureUniqueName(name || "Untitled", get(docsStore), id);
      renameDoc(id, finalName);
      persistDocs();
      if (getActiveDoc()?.id === id) {
        (document.getElementById("docTitle") as HTMLInputElement).value = finalName;
        resizeDocTitle();
        updatePageTitle(finalName);
      }
    },
    onDocRenamed: null,
```

- [ ] **Step 3: Push local renames through the new hook**

In `client/src/app.ts`'s `initToolbar`, find the docTitle `input` handler:

```ts
      const name = (e.target as HTMLInputElement).value || "Untitled";
      renameDoc(doc.id, name);
      scheduleSave();
      resizeDocTitle();
      updatePageTitle(name);
    });
```

Change to:

```ts
      const name = (e.target as HTMLInputElement).value || "Untitled";
      renameDoc(doc.id, name);
      scheduleSave();
      resizeDocTitle();
      updatePageTitle(name);
      window.MDE.onDocRenamed?.(doc.id, name);
    });
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean (`get` from `svelte/store` is already imported in `app.ts`; `resizeDocTitle`/`updatePageTitle` are already in scope in the same closure).

- [ ] **Step 5: Commit**

```bash
git add client/src/types.ts client/src/app.ts
git commit -m "feat: add setDocName/onDocRenamed bridge hooks"
```

---

### Task 2: `syncRemoteDocContent` gains a `name` parameter

**Files:**
- Modify: `client/src/stores/docs.ts`
- Modify: `tests/client/src/stores/docs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function syncRemoteDocContent(id: string, content: string, images: Record<string, string> | undefined, name?: string): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

In `tests/client/src/stores/docs.test.ts`, immediately after the existing `it("syncRemoteDocContent returns false when the doc id doesn't exist", ...)` test, add:

```ts
  it("syncRemoteDocContent writes a collaborator's rename and bumps updatedAt when the name differs", async () => {
    const { createDoc, syncRemoteDocContent, findDocById } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Notes");
    const doc = createDoc({ workspaceId: ws.id, name: "a", content: "same" });
    const before = findDocById(doc.id)!.updatedAt;
    const wrote = syncRemoteDocContent(doc.id, "same", undefined, "renamed by collaborator");
    expect(wrote).toBe(true);
    const after = findDocById(doc.id)!;
    expect(after.name).toBe("renamed by collaborator");
    expect(after.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("syncRemoteDocContent is a no-op when only an unchanged name is passed", async () => {
    const { createDoc, syncRemoteDocContent, findDocById } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Notes");
    const doc = createDoc({ workspaceId: ws.id, name: "a", content: "same" });
    const before = findDocById(doc.id)!.updatedAt;
    const wrote = syncRemoteDocContent(doc.id, "same", undefined, "a");
    expect(wrote).toBe(false);
    expect(findDocById(doc.id)!.updatedAt).toBe(before);
  });

  it("syncRemoteDocContent silently suffixes a collaborator's rename that collides with another local document's name", async () => {
    const { createDoc, syncRemoteDocContent, findDocById } = await import("../../../../client/src/stores/docs");
    const { createWorkspace } = await import("../../../../client/src/stores/workspaces");
    const ws = createWorkspace("Notes");
    createDoc({ workspaceId: ws.id, name: "Taken" });
    const doc = createDoc({ workspaceId: ws.id, name: "a", content: "same" });
    const wrote = syncRemoteDocContent(doc.id, "same", undefined, "Taken");
    expect(wrote).toBe(true);
    expect(findDocById(doc.id)!.name).toBe("Taken-2");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/src/stores/docs.test.ts`
Expected: FAIL — `syncRemoteDocContent` doesn't accept a fourth argument yet, so the name is never written.

- [ ] **Step 3: Write the implementation**

In `client/src/stores/docs.ts`, find:

```ts
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

Change to:

```ts
// Writes a shared workspace's background (non-active) document content —
// and, since v1.28.0, its name — back into docsStore. Called by
// collab.ts for every document in a shared workspace that isn't the one
// currently open — the active document's content already flows through
// activeDocContent -> saveActiveDocContent instead (and its name through
// the MDEBridge.setDocName path collab.ts uses directly, see app.ts), so
// this only ever runs for documents the user isn't looking at right now.
// Mirrors saveActiveDocContent's "don't bump updatedAt unless something
// actually changed" rule: a collaborator really editing a document is a
// real modification and should bump it the same way a local edit would,
// but reconnecting/resyncing identical content must not.
export function syncRemoteDocContent(id: string, content: string, images: Record<string, string> | undefined, name?: string): boolean {
  const doc = findDocById(id);
  if (!doc) return false;
  const contentChanged = content !== doc.content;
  const imagesChanged = !sameImages(images, doc.images);
  // Re-applies the same global-uniqueness rule createDoc/importRemoteDocs
  // use rather than trusting the incoming name as-is — a remote rename
  // that happens to collide with an unrelated local document must not
  // silently break wikilink resolution's exact-match assumption.
  const finalName = name !== undefined ? ensureUniqueName(name || "Untitled", get(docsStore), id) : undefined;
  const nameChanged = finalName !== undefined && finalName !== doc.name;
  if (!contentChanged && !imagesChanged && !nameChanged) return false;
  updateDoc(id, { content, images, ...(nameChanged ? { name: finalName } : {}), updatedAt: Date.now() });
  return true;
}
```

(`ensureUniqueName` and `get` are already imported at the top of this file — no new imports needed here.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/client/src/stores/docs.test.ts`
Expected: PASS (all tests in the file, including the 3 new ones).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/stores/docs.ts tests/client/src/stores/docs.test.ts
git commit -m "feat: teach syncRemoteDocContent to sync a collaborator's rename"
```

---

### Task 3: Wire `collab.ts`'s `meta` Y.Map

**Files:**
- Modify: `client/src/collab.ts`
- Modify: `tests/client/src/collab.test.ts`

**Interfaces:**
- Consumes: `MDEBridge.setDocName`/`onDocRenamed` (Task 1); `syncRemoteDocContent`'s new `name` parameter (Task 2).
- Produces: `DocBinding.metaMap: Y.Map<string>`.

- [ ] **Step 1: Add `metaMap` to `DocBinding`**

Find:

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
```

Change to:

```ts
interface DocBinding {
  ydoc: Y.Doc;
  ytext: Y.Text;
  imagesMap: Y.Map<string>;
  // The document's name — a third top-level type on the same Y.Doc as
  // ytext/imagesMap, keyed "name". Content sync got this for free the
  // moment it started riding the same MESSAGE_SYNC/Y.Doc-update wire
  // format imagesMap already used; the name is just another field on
  // it, gated editor-only by the exact same write-check the server
  // already applies to every Y.Doc update (workspace-room.ts's
  // handleMessage), same as content edits.
  metaMap: Y.Map<string>;
  awareness: awarenessProtocol.Awareness;
  undoManager: Y.UndoManager | null;
  ydocUpdateHandler: (update: Uint8Array, origin: unknown) => void;
  role: string;
}
```

- [ ] **Step 2: Create and observe `metaMap` in `createDocBinding`**

Find:

```ts
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

Change to:

```ts
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
  const metaMap = ydoc.getMap<string>("meta");
  metaMap.observe((event, tr) => {
    if (tr.origin === "local") return;
    if (!event.changes.keys.has("name")) return;
    if (workspaceRoom.activeDocId === docId) {
      const name = metaMap.get("name");
      if (name !== undefined) window.MDE.setDocName(docId, name);
    } else {
      markDirty(docId);
    }
  });
  const awareness = new awarenessProtocol.Awareness(ydoc);
```

Find the binding's return literal:

```ts
  const binding: DocBinding = { ydoc, ytext, imagesMap, awareness, undoManager: null, ydocUpdateHandler, role };
```

Change to:

```ts
  const binding: DocBinding = { ydoc, ytext, imagesMap, metaMap, awareness, undoManager: null, ydocUpdateHandler, role };
```

- [ ] **Step 3: Seed the name on first share**

Find `seedDocBindingFromEditor`:

```ts
  if (content) binding.ydoc.transact(() => binding.ytext.insert(0, content), "local");
  const doc = getActiveDoc();
  if (doc && doc.id === docId && doc.images) {
    binding.ydoc.transact(() => {
      Object.entries(doc.images!).forEach(([key, dataUrl]) => binding.imagesMap.set(key, dataUrl));
    }, "local");
  }
}
```

Change to:

```ts
  if (content) binding.ydoc.transact(() => binding.ytext.insert(0, content), "local");
  const doc = getActiveDoc();
  if (doc && doc.id === docId) {
    binding.ydoc.transact(() => {
      binding.metaMap.set("name", doc.name || "Untitled");
      if (doc.images) Object.entries(doc.images).forEach(([key, dataUrl]) => binding.imagesMap.set(key, dataUrl));
    }, "local");
  }
}
```

- [ ] **Step 4: Push local renames into the bound doc**

In `init()`, find:

```ts
  window.MDE.onImageAdded = (key, dataUrl) => {
    const binding = workspaceRoom.activeDocId ? workspaceRoom.docs.get(workspaceRoom.activeDocId) : undefined;
    if (binding) binding.ydoc.transact(() => binding.imagesMap.set(key, dataUrl), "local");
  };
```

Change to:

```ts
  window.MDE.onImageAdded = (key, dataUrl) => {
    const binding = workspaceRoom.activeDocId ? workspaceRoom.docs.get(workspaceRoom.activeDocId) : undefined;
    if (binding) binding.ydoc.transact(() => binding.imagesMap.set(key, dataUrl), "local");
  };
  // A rename always happens through the docTitle input, which is always
  // the active document (DocList.svelte's row "Rename" action switches
  // to the target doc first before focusing it) — but this looks the
  // binding up by id rather than assuming activeDocId regardless, same
  // as onImageAdded's own binding lookup above. Editor-only gated
  // implicitly: a non-editor's write never reaches any collaborator
  // anyway (the server drops it, see workspace-room.ts's handleMessage
  // isWrite check), it just optimistically renders locally for the
  // person doing the (rejected) rename until the next resync.
  window.MDE.onDocRenamed = (docId, name) => {
    const binding = workspaceRoom.docs.get(docId);
    if (binding) binding.ydoc.transact(() => binding.metaMap.set("name", name || "Untitled"), "local");
  };
```

- [ ] **Step 5: Flush a background doc's renamed name**

Find `flushDirtyBackgroundDocs`:

```ts
    const content = binding.ytext.toString();
    const imageEntries = Array.from(binding.imagesMap.entries());
    const images = imageEntries.length > 0 ? Object.fromEntries(imageEntries) : undefined;
    if (syncRemoteDocContent(docId, content, images)) changed = true;
```

Change to:

```ts
    const content = binding.ytext.toString();
    const imageEntries = Array.from(binding.imagesMap.entries());
    const images = imageEntries.length > 0 ? Object.fromEntries(imageEntries) : undefined;
    const name = binding.metaMap.get("name");
    if (syncRemoteDocContent(docId, content, images, name)) changed = true;
```

- [ ] **Step 6: Fix the join-preview placeholder name**

Find `fetchRemoteDocContent`'s `onmessage` handler:

```ts
      syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), scratchDoc, "server");
      const now = Date.now();
      finish({ id: docId, name: "Shared document", content: scratchDoc.getText("content").toString(), updatedAt: now, createdAt: now });
```

Change to:

```ts
      syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), scratchDoc, "server");
      const now = Date.now();
      const name = scratchDoc.getMap<string>("meta").get("name") || "Shared document";
      finish({ id: docId, name, content: scratchDoc.getText("content").toString(), updatedAt: now, createdAt: now });
```

- [ ] **Step 7: Write the failing tests**

In `tests/client/src/collab.test.ts`, extend the import line. Find:

```ts
import { decideShareTarget, decideJoinTarget, handleDocChanged, workspaceRoom } from "../../../client/src/collab";
import { docsStore } from "../../../client/src/stores/docs";
import { workspacesStore } from "../../../client/src/stores/workspaces";
import type { Doc, Workspace } from "../../../client/src/types";
```

Change to:

```ts
import { decideShareTarget, decideJoinTarget, handleDocChanged, workspaceRoom, setAccessMode } from "../../../client/src/collab";
import { docsStore, activeIdStore } from "../../../client/src/stores/docs";
import { workspacesStore, activeWorkspaceIdStore } from "../../../client/src/stores/workspaces";
import type { Doc, Workspace } from "../../../client/src/types";
```

Then, after the existing `describe("join-generation race ...", ...)` block (reusing its module-scoped `MockWebSocket`/`fakeWorkspace` helpers), append:

```ts
// Regression coverage for "shared document name sync" (IMPROVEMENTS.md
// Phase 2): the document name now rides the same Y.Doc as its content, as
// a third top-level type ("meta") alongside ytext/imagesMap — the exact
// pattern imagesMap already established. These tests exercise both
// directions: a local rename pushed into the shared doc, and a remote
// rename applied back onto docsStore/the docTitle input.
describe("shared document name sync", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="shareBtn"></div><div id="shareDropdownBtn"></div>';
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (url.includes("/access") && init?.method === "PUT") {
          return { ok: true, json: async () => ({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] }) };
        }
        if (url.includes("/docs")) {
          return { ok: true, json: async () => [] };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    window.MDE = {
      enterCollabMode: vi.fn(),
      exitCollabMode: vi.fn(),
      setReadOnly: vi.fn(),
      getEditor: vi.fn(() => ({ state: { doc: { toString: () => "hello" } } })),
      githubUsername: "alice",
      githubSessionReady: Promise.resolve(),
      setDocImage: vi.fn(),
      setDocName: vi.fn(),
      requireGithubSignIn: vi.fn(),
    } as unknown as typeof window.MDE;

    // workspaceRoom is a module-level singleton shared across every test
    // in this file — reset it in case an earlier describe block (e.g.
    // "join-generation race" above) left it connected to its own
    // workspace, which would otherwise make setAccessMode below see
    // workspaceRoom.workspaceId already set and skip joining entirely.
    handleDocChanged(undefined as unknown as Doc);

    const ws = fakeWorkspace({ id: "ws1", name: "WS" });
    workspacesStore.set([ws]);
    activeWorkspaceIdStore.set("ws1");
    docsStore.set([{ id: "doc1", name: "My Doc", content: "hello", updatedAt: 0, createdAt: 0, workspaceId: "ws1" }]);
    activeIdStore.set("doc1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("seeds the shared doc's current name into its Y.Doc meta map when sharing for the first time", async () => {
    await setAccessMode("anyone-link", "editor");
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const binding = workspaceRoom.docs.get("doc1");
    expect(binding?.metaMap.get("name")).toBe("My Doc");
  });

  it("applies a remote rename on the active doc via MDE.setDocName", async () => {
    await setAccessMode("anyone-link", "editor");
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const binding = workspaceRoom.docs.get("doc1")!;
    binding.ydoc.transact(() => binding.metaMap.set("name", "Renamed By Collaborator"), "server");

    expect(window.MDE.setDocName).toHaveBeenCalledWith("doc1", "Renamed By Collaborator");
  });
});
```

Note: a third test exercising `onDocRenamed` (the local-rename-push direction) is deliberately *not* included — that handler is assigned inside `init()`, which never runs in this test environment (jsdom's `DOMContentLoaded` has already fired before the module is imported, per the file's own top-of-file comment), matching the existing test suite's coverage boundary for `onImageAdded`'s equivalent wiring.

- [ ] **Step 8: Run test to verify it fails, then passes**

Run: `npx vitest run tests/client/src/collab.test.ts`
Expected: fails first (no `metaMap` field / no `setDocName` bridge member yet, if Steps 1-6 haven't landed) — after Steps 1-6 above are in place, run again and expect PASS (all tests in the file).

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 10: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
git add client/src/collab.ts tests/client/src/collab.test.ts
git commit -m "feat: sync a shared document's name via its Y.Doc meta map"
```

---

### Task 4: Version bump and docs

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `IMPROVEMENTS.md`

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "1.27.2"` to `"version": "1.28.0"` (minor bump — new feature, no breaking change).

In `package-lock.json`, update the same two `"version"` fields (the top-level one and the one under `packages[""]`) by hand rather than a full `npm install --package-lock-only` regeneration — a full regeneration can introduce unrelated metadata churn from a different local npm version (e.g. `libc` fields on optional platform packages), which is noise this change shouldn't carry.

- [ ] **Step 2: Add a CHANGELOG entry**

In `CHANGELOG.md`, add a new section above the current top entry:

```md
## [1.28.0] - 2026-08-27

### Added

- **Shared document names now sync to every collaborator.** Renaming a shared document previously only changed the title on your own browser — everyone else kept seeing the old name until they happened to reload. The name now travels over the same live connection as the document's content and images (and is gated the same way: only an editor's rename reaches collaborators), so a rename shows up for everyone immediately, including on a fresh join.
```

- [ ] **Step 3: Mark the IMPROVEMENTS.md backlog item done**

Find the `- [ ] **Shared document name sync.** ...` entry under Phase 2 and change its checkbox to `- [x]`, replacing its body with a short "shipped" summary in the same style as other completed Phase 2/3 items (see e.g. the Workspace core entries), noting: the `meta` Y.Map approach chosen, and the editor-only gating decision (reusing content edits' existing server-side write check).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md IMPROVEMENTS.md
git commit -m "docs: ship notes for shared document name sync"
```

---

### Task 5: Final verification

**Files:** None (verification only).

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: all tests pass, including the new tests from Tasks 2 and 3.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 3: Format check**

Run: `npx prettier --check .`
Expected: clean.

- [ ] **Step 4: Manual verification**

Run the dev server (`npm run dev:client`), share a document with a second browser/incognito session invited as editor, and confirm: (a) renaming in either session updates the other session's title live; (b) a fresh join to the workspace shows the real document name instead of a placeholder; (c) a rename attempted by a viewer/reviewer session does not propagate (server drops the write).
