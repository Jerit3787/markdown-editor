# Image Rendering in Diffs — Phase 3 (Legacy collab-room) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror Phase 2's fix in the legacy single-document `CollabRoom` (pre-workspace-model rooms, still used for docs not yet migrated via `migrateLegacyDoc`) — snapshots capture the doc's images, and restoring one writes them back.

**Architecture:** Identical to Phase 2, adapted to `CollabRoom`'s flat (non-nested) structure — one `Y.Doc` per instance (`this.doc`), not a `Map<docId, DocRoom>`. Same `images` Y.Map read/write pattern.

**Tech Stack:** Cloudflare Durable Objects, Yjs (`Y.Map`), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-diff-view-image-rendering-design.md`

## Global Constraints

- Restoring a snapshot's images is a full replace of the `images` Y.Map, not a merge — matches Phases 1-2.
- `CollabRoom` has no `restore-content` endpoint at all (no `/versions/restore-content` route exists here — that's workspace-room-only, for restoring repo-commit content, which legacy rooms never linked to a repo). Nothing to defer here, unlike Phase 2.
- No client-side changes in this phase. `history.ts`'s shared-doc wrapper functions (`getSharedVersionSnapshot`, `restoreSharedVersion`) already target `/api/workspace/...` paths; they do not call `CollabRoom`'s own `/api/collab/{roomId}/versions` endpoints at all today (a separate, pre-existing gap unrelated to image rendering — not addressed by this plan).

---

### Task 1: `Snapshot.images` — capture at snapshot time

**Files:**
- Modify: `src/collab-room.ts`
- Test: `src/collab-room.test.ts`

**Interfaces:**
- Produces: `Snapshot.images?: Record<string, string>`. `maybeSnapshot`/`forceSnapshot` signatures unchanged (same reasoning as Phase 2 — they read the live `this.doc` at call time, no new parameter needed).

- [ ] **Step 1: Write the failing tests**

Add to `src/collab-room.test.ts`, inside the existing `describe("CollabRoom version snapshots", ...)` block (after its last test, `"forceSnapshot always appends, bypassing the throttle"`):

```ts
  it("captures the doc's images Y.Map into the snapshot", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    room.doc.transact(() => {
      room.doc.getText("content").insert(0, "v1");
      room.doc.getMap<string>("images").set("img-1", "data:image/png;base64,aGk=");
    }, "storage");
    await room.maybeSnapshot(1_000);
    const snapshots = await room.getSnapshots();
    expect(snapshots[0]!.images).toEqual({ "img-1": "data:image/png;base64,aGk=" });
  });

  it("stores undefined images for a doc with an empty images map", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    room.doc.transact(() => room.doc.getText("content").insert(0, "v1"), "storage");
    await room.maybeSnapshot(1_000);
    const snapshots = await room.getSnapshots();
    expect(snapshots[0]!.images).toBeUndefined();
  });

  it("forceSnapshot also captures images", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    room.doc.transact(() => room.doc.getMap<string>("images").set("img-2", "data:image/png;base64,eHk="), "storage");
    const created = await room.forceSnapshot("forced content", 2_000);
    expect(created.images).toEqual({ "img-2": "data:image/png;base64,eHk=" });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/collab-room.test.ts`
Expected: FAIL — `snapshots[0]!.images` is `undefined` where the "captures"/"forceSnapshot" tests expect a populated object.

- [ ] **Step 3: Add `images` to `Snapshot` and the extraction helper**

In `src/collab-room.ts`, update the `Snapshot` interface (near the top of the file):

```ts
export interface Snapshot {
  id: string;
  timestamp: number;
  content: string;
  images?: Record<string, string>;
}
```

Add a helper method right before `maybeSnapshot` (in the `// ---------- Version snapshots ----------` section):

```ts
  imagesFromDoc(): Record<string, string> | undefined {
    const map = this.doc.getMap<string>("images");
    return map.size > 0 ? (Object.fromEntries(map.entries()) as Record<string, string>) : undefined;
  }
```

Update `maybeSnapshot`'s push line:

```ts
    snapshots.push({ id: uid(), timestamp: now, content, images: this.imagesFromDoc() });
```

Update `forceSnapshot`'s snap construction:

```ts
    const snap: Snapshot = { id: uid(), timestamp: now, content, images: this.imagesFromDoc() };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/collab-room.test.ts`
Expected: PASS (all tests, including the 3 new ones)

- [ ] **Step 5: Commit**

```bash
git add src/collab-room.ts src/collab-room.test.ts
git commit -m "feat: capture doc images into legacy collab-room version snapshots"
```

---

### Task 2: Restore writes a snapshot's images back into the Y.Map

**Files:**
- Modify: `src/collab-room.ts`
- Test: `src/collab-room.test.ts`

**Interfaces:**
- Consumes: `Snapshot.images` from Task 1.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `src/collab-room.test.ts`, right after `describe("CollabRoom version snapshots", ...)`'s closing `});`:

```ts
describe("CollabRoom.handleVersionRestoreRequest — images", () => {
  it("replaces the doc's images with the restored snapshot's, not merges them", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    room.doc.transact(() => {
      room.doc.getText("content").insert(0, "old content");
      room.doc.getMap<string>("images").set("img-current-only", "data:image/png;base64,Y3Vycg==");
    }, "storage");
    const oldSnap = await room.forceSnapshot("old content", 1_000);
    // oldSnap captured "img-current-only" too (same doc state) -- overwrite
    // the doc's images to something ELSE before restoring, so the test can
    // tell "replaced back to the snapshot's" apart from "left untouched".
    room.doc.transact(() => {
      const map = room.doc.getMap<string>("images");
      for (const key of Array.from(map.keys())) map.delete(key);
      map.set("img-newer", "data:image/png;base64,bmV3");
    }, "local");

    const req = await authedRequest("alice", `/room1/versions/${oldSnap.id}/restore`, { method: "POST" });
    const res = await room.fetch(req);
    expect(res.status).toBe(200);
    expect(room.doc.getMap<string>("images").toJSON()).toEqual({ "img-current-only": "data:image/png;base64,Y3Vycg==" });
  });

  it("clears the doc's images when restoring a snapshot that had none", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    room.doc.transact(() => room.doc.getText("content").insert(0, "no images here"), "storage");
    const snapNoImages = await room.forceSnapshot("no images here", 1_000);
    room.doc.transact(() => room.doc.getMap<string>("images").set("img-x", "data:image/png;base64,eA=="), "local");

    const req = await authedRequest("alice", `/room1/versions/${snapNoImages.id}/restore`, { method: "POST" });
    await room.fetch(req);
    expect(room.doc.getMap<string>("images").toJSON()).toEqual({});
  });
});
```

Note: `handleVersionRestoreRequest` requires an authorized editor (see `authorize`) — `room.fetch(req)` is used here (not calling `handleVersionRestoreRequest` directly) because it's the only entry point that runs `authorize` against the request's cookie and routes to the handler, matching how this file's other restore-adjacent tests reach authenticated POST handlers (see `authedRequest`'s existing usage for `/comments/:id/reply` etc.). This room has no `access` record set, and `authedRequest("alice", ...)` alone does not make "alice" the owner — before these two tests, `authorize` would reject with "This room hasn't been shared" (no owner set). Set access first, right after creating `room` in both tests:

```ts
    await putAccess(room, "alice", { generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
```

(Insert this line as the very first statement inside each `it(...)` callback, before the `room.doc.transact(...)` calls.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/collab-room.test.ts`
Expected: FAIL — the doc's images map still holds `img-newer`/`img-x` after restore, since nothing writes it back yet.

- [ ] **Step 3: Update `handleVersionRestoreRequest`**

In `src/collab-room.ts`:

```ts
  async handleVersionRestoreRequest(request: Request, versionId: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    if (auth.role !== "editor") return new Response("Only an editor can restore a version.", { status: 403 });
    const snapshots = await this.getSnapshots();
    const snap = snapshots.find((s) => s.id === versionId);
    if (!snap) return new Response("Version not found.", { status: 404 });

    const text = this.doc.getText("content");
    this.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, snap.content);
      const imagesMap = this.doc.getMap<string>("images");
      for (const key of Array.from(imagesMap.keys())) imagesMap.delete(key);
      if (snap.images) {
        for (const [key, value] of Object.entries(snap.images)) imagesMap.set(key, value);
      }
    }, "restore");
    const created = await this.forceSnapshot(snap.content);
    return Response.json(created);
  }
```

(Only the `this.doc.transact(...)` block's contents changed — the images-map clear-then-set lines were added inside it.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/collab-room.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full test suite, typecheck**

Run: `npm test && npx tsc --noEmit -p tsconfig.json`
Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/collab-room.ts src/collab-room.test.ts
git commit -m "feat: restore a legacy collab-room version's images, not just its content"
```

---

## Self-Review Notes

**Spec coverage:** `Snapshot.images` capture at snapshot time (`maybeSnapshot`/`forceSnapshot` reading the already-synced `images` Y.Map) ✓ Task 1. Restore writes images back as a full replace ✓ Task 2. `restoreSharedVersionContent`-equivalent explicitly noted as not existing in this room type — nothing to defer, nothing to touch.

**Type consistency:** `Snapshot.images` and `imagesFromDoc()`'s return shape match Phase 2's identically-named/shaped counterparts, adapted only for the flat (non-`docId`-keyed) structure.

**Placeholder scan:** No TBD/TODO; every step carries complete, exact code. Task 2's auth-setup requirement (`putAccess` call, and why `room.fetch` is used instead of calling the handler directly) is spelled out explicitly rather than left for the implementer to discover via a failing test with no explanation.
