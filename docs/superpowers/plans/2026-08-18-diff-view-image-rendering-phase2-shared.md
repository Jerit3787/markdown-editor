# Image Rendering in Diffs — Phase 2 (Shared Docs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make images render in the diff view for shared documents' own version history too, mirroring Phase 1's local-doc behavior — a historical snapshot shows the images it actually had, and restoring it brings them back.

**Architecture:** `src/workspace-room.ts`'s `Snapshot` gains an `images` field, populated at snapshot time by reading the doc's already-synced `images` Y.Map (no new sync plumbing — the data already replicates via normal Yjs sync, just never got read out before). Restoring a snapshot writes its images back into that Y.Map inside the same transaction that restores the text, so the change propagates to every connected client through the existing Yjs sync channel — no separate client-side "apply images" call needed (unlike Phase 1's local docs, which have no live sync channel at all).

**Tech Stack:** Cloudflare Durable Objects, Yjs (`Y.Map`), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-diff-view-image-rendering-design.md`

## Global Constraints

- Restoring a snapshot's images is a **full replace** of the `images` Y.Map (delete every existing key, then set each of the snapshot's), not a merge — matches Phase 1's `replaceDocImages` semantics.
- `restoreSharedVersionContent`/`handleVersionRestoreContentRequest` (restoring a repo-commit's content into a shared doc) are **out of scope** for this phase — repo-commit images don't exist until Phase 4. Do not touch these.
- `getSharedVersionContent` is replaced outright by `getSharedVersionSnapshot` (not supplemented by a second images-fetch function) — content and images arrive together in one HTTP response already; a second fetch would be a wasted round trip. It has exactly one caller (`VersionHistory.svelte`), so this is a clean, contained change.
- No component-test infrastructure exists for `.svelte` files — `VersionHistory.svelte`'s wiring is verified by typecheck + build, not a live authenticated collaborative session (spinning up a real shared workspace requires a GitHub OAuth sign-in this environment can't complete headlessly). The Durable Object logic itself (where the real risk lives — Y.Map extraction, restore-writes-back) gets full Vitest coverage with no such limitation.

---

### Task 1: Server-side `Snapshot.images` — capture at snapshot time

**Files:**
- Modify: `src/workspace-room.ts`
- Test: `src/workspace-room.test.ts`

**Interfaces:**
- Produces: `Snapshot.images?: Record<string, string>`. `maybeSnapshot`/`forceSnapshot` unchanged in signature — they already read whatever's live on `docRoom.doc` at call time, so no new parameter is needed (contrast with Phase 1's client-side `appendSnapshot`, which had no live doc object to read from and needed `images` passed in explicitly).

- [ ] **Step 1: Write the failing tests**

Add to `src/workspace-room.test.ts`, inside the existing `describe("WorkspaceRoom version snapshots", ...)` block (after its last test):

```ts
  it("captures the doc's images Y.Map into the snapshot", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.transact(() => {
      docRoom.doc.getText("content").insert(0, "v1");
      docRoom.doc.getMap<string>("images").set("img-1", "data:image/png;base64,aGk=");
    }, "storage");
    await room.maybeSnapshot("docA", docRoom, 1000);
    const snapshots = await room.getSnapshots("docA");
    expect(snapshots[0]!.images).toEqual({ "img-1": "data:image/png;base64,aGk=" });
  });

  it("stores undefined images for a doc with an empty images map", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.transact(() => docRoom.doc.getText("content").insert(0, "v1"), "storage");
    await room.maybeSnapshot("docA", docRoom, 1000);
    const snapshots = await room.getSnapshots("docA");
    expect(snapshots[0]!.images).toBeUndefined();
  });

  it("forceSnapshot also captures images", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.transact(() => docRoom.doc.getMap<string>("images").set("img-2", "data:image/png;base64,eHk="), "storage");
    const created = await room.forceSnapshot("docA", docRoom, "forced content", 2000);
    expect(created.images).toEqual({ "img-2": "data:image/png;base64,eHk=" });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/workspace-room.test.ts`
Expected: FAIL — `snapshots[0]!.images` is `undefined` where the test expects a populated object (the "captures" and "forceSnapshot" tests); the "empty map" test currently passes trivially (no behavior change needed for it yet, but it locks in the target behavior before the code changes near it).

- [ ] **Step 3: Extract the images map in `maybeSnapshot` and `forceSnapshot`**

In `src/workspace-room.ts`, add a small helper right before `maybeSnapshot` (in the `// ---------- Version snapshots ----------` section):

```ts
  imagesFromDoc(docRoom: DocRoom): Record<string, string> | undefined {
    const map = docRoom.doc.getMap<string>("images");
    return map.size > 0 ? (Object.fromEntries(map.entries()) as Record<string, string>) : undefined;
  }
```

Update `maybeSnapshot`:

```ts
  async maybeSnapshot(docId: string, docRoom: DocRoom, now: number = Date.now()): Promise<void> {
    const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
    if (docRoom.lastSnapshotAt !== undefined && now - docRoom.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
    const content = docRoom.doc.getText("content").toString();
    const snapshots = await this.getSnapshots(docId);
    const last = snapshots[snapshots.length - 1];
    if (last && last.content === content) {
      docRoom.lastSnapshotAt = last.timestamp;
      return;
    }
    snapshots.push({ id: uid(), timestamp: now, content, images: this.imagesFromDoc(docRoom) });
    while (snapshots.length > 50) snapshots.shift();
    await this.state.storage.put(docStorageKey(docId, "snapshots"), snapshots);
    docRoom.lastSnapshotAt = now;
  }
```

Update `forceSnapshot`:

```ts
  async forceSnapshot(docId: string, docRoom: DocRoom, content: string, now: number = Date.now()): Promise<Snapshot> {
    const snapshots = await this.getSnapshots(docId);
    const snap: Snapshot = { id: uid(), timestamp: now, content, images: this.imagesFromDoc(docRoom) };
    snapshots.push(snap);
    while (snapshots.length > 50) snapshots.shift();
    await this.state.storage.put(docStorageKey(docId, "snapshots"), snapshots);
    docRoom.lastSnapshotAt = now;
    return snap;
  }
```

And add `images` to the `Snapshot` interface (near the top of the file, where it's currently declared):

```ts
export interface Snapshot {
  id: string;
  timestamp: number;
  content: string;
  images?: Record<string, string>;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/workspace-room.test.ts`
Expected: PASS (all tests, including the 3 new ones)

- [ ] **Step 5: Commit**

```bash
git add src/workspace-room.ts src/workspace-room.test.ts
git commit -m "feat: capture doc images into shared workspace version snapshots"
```

---

### Task 2: Restore writes a snapshot's images back into the Y.Map

**Files:**
- Modify: `src/workspace-room.ts`
- Test: `src/workspace-room.test.ts`

**Interfaces:**
- Consumes: `Snapshot.images` from Task 1.

- [ ] **Step 1: Write the failing test**

Add a new `describe` block to `src/workspace-room.test.ts`, after `describe("WorkspaceRoom version snapshots", ...)`:

```ts
describe("WorkspaceRoom.handleVersionRestoreRequest — images", () => {
  it("replaces the doc's images with the restored snapshot's, not merges them", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.transact(() => {
      docRoom.doc.getText("content").insert(0, "old content");
      docRoom.doc.getMap<string>("images").set("img-current-only", "data:image/png;base64,Y3Vycg==");
    }, "storage");
    const oldSnap = await room.forceSnapshot("docA", docRoom, "old content", 1000);
    // oldSnap captured "img-current-only" too (same doc state) -- overwrite
    // the doc's images to something ELSE before restoring, so the test can
    // tell "replaced back to the snapshot's" apart from "left untouched".
    docRoom.doc.transact(() => {
      const map = docRoom.doc.getMap<string>("images");
      for (const key of Array.from(map.keys())) map.delete(key);
      map.set("img-newer", "data:image/png;base64,bmV3");
    }, "local");

    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request(`https://example.com/w/ws1/docs/docA/versions/${oldSnap.id}/restore`, {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}` },
    });
    const res = await room.handleVersionRestoreRequest(request, "docA", oldSnap.id);
    expect(res.status).toBe(200);
    expect(docRoom.doc.getMap<string>("images").toJSON()).toEqual({ "img-current-only": "data:image/png;base64,Y3Vycg==" });
  });

  it("clears the doc's images when restoring a snapshot that had none", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.transact(() => docRoom.doc.getText("content").insert(0, "no images here"), "storage");
    const snapNoImages = await room.forceSnapshot("docA", docRoom, "no images here", 1000);
    docRoom.doc.transact(() => docRoom.doc.getMap<string>("images").set("img-x", "data:image/png;base64,eA=="), "local");

    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request(`https://example.com/w/ws1/docs/docA/versions/${snapNoImages.id}/restore`, {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}` },
    });
    await room.handleVersionRestoreRequest(request, "docA", snapNoImages.id);
    expect(docRoom.doc.getMap<string>("images").toJSON()).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/workspace-room.test.ts`
Expected: FAIL — the doc's images map still holds `img-newer`/`img-x` after restore, since nothing writes it back yet.

- [ ] **Step 3: Update `handleVersionRestoreRequest`**

In `src/workspace-room.ts`:

```ts
  async handleVersionRestoreRequest(request: Request, docId: string, versionId: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    if (auth.role !== "editor") return new Response("Only an editor can restore a version.", { status: 403 });
    const snapshots = await this.getSnapshots(docId);
    const snap = snapshots.find((s) => s.id === versionId);
    if (!snap) return new Response("Version not found.", { status: 404 });

    const docRoom = await this.loadDocRoom(docId);
    const text = docRoom.doc.getText("content");
    docRoom.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, snap.content);
      const imagesMap = docRoom.doc.getMap<string>("images");
      for (const key of Array.from(imagesMap.keys())) imagesMap.delete(key);
      if (snap.images) {
        for (const [key, value] of Object.entries(snap.images)) imagesMap.set(key, value);
      }
    }, "restore");
    const created = await this.forceSnapshot(docId, docRoom, snap.content);
    return Response.json(created);
  }
```

(Only the `docRoom.doc.transact(...)` block's contents changed — the images-map clear-then-set lines were added inside it, alongside the existing text delete/insert.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/workspace-room.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/workspace-room.ts src/workspace-room.test.ts
git commit -m "feat: restore a shared doc version's images, not just its content"
```

---

### Task 3: Client wiring — `getSharedVersionSnapshot` and `VersionHistory.svelte`

**Files:**
- Modify: `client/src/history.ts`
- Modify: `client/src/components/VersionHistory.svelte`

**Interfaces:**
- Consumes: `Snapshot.images` (now present in the JSON `handleVersionContentRequest` already returns, from Task 1 — no server response-shape code change needed, the field just starts appearing).
- Produces: `getSharedVersionSnapshot(workspaceId: string, docId: string, versionId: string): Promise<{ content: string; images: Record<string, string> | undefined } | undefined>` — replaces `getSharedVersionContent` (deleted, not kept alongside).

- [ ] **Step 1: Replace `getSharedVersionContent` in `client/src/history.ts`**

```ts
export async function getSharedVersionSnapshot(
  workspaceId: string,
  docId: string,
  versionId: string
): Promise<{ content: string; images: Record<string, string> | undefined } | undefined> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionId)}`);
    if (!res.ok) return undefined;
    const snap = (await res.json()) as Snapshot;
    return { content: snap.content, images: snap.images };
  } catch (err) {
    return undefined;
  }
}
```

- [ ] **Step 2: Update `VersionHistory.svelte`'s import and `selectVersion`**

Change the `../history` import's `getSharedVersionContent` to `getSharedVersionSnapshot`.

Replace `selectVersion`'s `isShared` branch:

```ts
      if (isShared) {
        const result = await getSharedVersionSnapshot(doc.workspaceId, doc.id, entry.id);
        if (result === undefined) {
          showToast("Couldn't load this version's content", "error");
          return;
        }
        selectedContent = result.content;
        selectedImages = result.images;
      } else {
```

(Replacing only the `if (isShared) { ... }` block — the surrounding `if (entry.kind === "local") { ... } else { ... }` structure from Phase 1's Task 6 is unchanged.)

- [ ] **Step 3: Run the full test suite, typecheck, and build**

Run: `npm test && npx tsc --noEmit -p client/tsconfig.json && npm run build`
Expected: all tests pass, no type errors, clean build. (No new automated test in this task — this is a thin fetch-wrapper change with no existing test coverage to extend, matching this file's established convention; the Durable Object logic it calls into is fully covered by Tasks 1-2.)

- [ ] **Step 4: Commit**

```bash
git add client/src/history.ts client/src/components/VersionHistory.svelte
git commit -m "feat: wire shared-doc version images into the diff view and restore flow"
```

---

## Self-Review Notes

**Spec coverage:** `Snapshot.images` capture at snapshot time (`maybeSnapshot`/`forceSnapshot` reading the already-synced `images` Y.Map) ✓ Task 1. Restore writes images back as a full replace, not a merge ✓ Task 2. `getSharedVersionSnapshot` replacing `getSharedVersionContent` in one round trip instead of two ✓ Task 3. `restoreSharedVersionContent`/`handleVersionRestoreContentRequest` explicitly left untouched (Phase 4's job) ✓ (no task touches them).

**Type consistency:** `Snapshot.images`, `imagesFromDoc`'s return shape, and `getSharedVersionSnapshot`'s return shape are identical everywhere referenced across all 3 tasks.

**Placeholder scan:** No TBD/TODO; every step carries complete, exact code, including full replaced function bodies rather than diffs the implementer would have to reconstruct.
