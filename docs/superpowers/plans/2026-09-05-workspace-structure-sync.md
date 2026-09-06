# Workspace Structure Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a shared workspace's name, and the fact that a document was deleted from it, reach every collaborator live — the same way document content, images, and names already do — closing the "shows 'Shared workspace' instead of the real name" and "deleted doc lingers forever for everyone else" gaps.

**Architecture:** `WorkspaceRoom` (the Durable Object) gains one more small piece of persisted, synced state — `{ name: string, docOrder: string[] }` (`docOrder` is the existing `docIds`, nothing new to track there) — broadcast over the workspace's existing single WebSocket as a new, docId-less message type `MESSAGE_WORKSPACE_META = 3`, alongside the existing `MESSAGE_SYNC`/`MESSAGE_AWARENESS`/`MESSAGE_PRESENCE`. Mutations (rename, document delete) go over plain HTTP — `PUT /api/workspace/:id/meta` and the already-existing-but-never-called `DELETE /api/workspace/:id/docs` — matching how `/access` and `/docs` already work; the socket only broadcasts the result and greets new connections with current state.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects (`src/workspace-room.ts`), `lib0/encoding`+`lib0/decoding` wire format, Svelte 5 (`WorkspaceSwitcher.svelte`), Vitest (`unit` project for both `tests/src/**` and `tests/client/src/**`), Playwright (`tests/e2e/collab/**`).

**Spec:** `docs/superpowers/specs/2026-09-05-workspace-structure-sync-design.md`

## Global Constraints

- Non-goals (do not implement): document order UI/drag-and-drop, a new visible "connection status" indicator, any change to how document content/images/name/metadata/citations already sync, and renaming/deleting on a workspace that was never shared (no `remoteId`) — those stay purely local.
- The `/meta` endpoint is **editor-gated** (like `/docs`'s `POST`/`DELETE`), not owner-gated (unlike `/access`'s `PUT`) — renaming a workspace is closer in spirit to renaming a document than to changing sharing settings.
- Wire format for `MESSAGE_WORKSPACE_META`: `writeVarUint(3)`, `writeVarString(name)`, `writeVarUint(docOrder.length)`, then `writeVarString(id)` per entry — decode in the same order.
- A user-facing change (this whole feature) gets a **minor** version bump + CHANGELOG entry + What's New entry, per `CLAUDE.md`'s versioning convention — done once, in Task 8, not per-task.
- Every task's tests go in `unit` (`npm test`), except Task 7's, which are Playwright specs run via `npm run test:e2e:collab`.

---

## Task 1: Server — workspace `name` field, `PUT /meta`, `broadcastWorkspaceMeta()`, greeting, `/access` extension

**Files:**
- Modify: `src/workspace-room.ts:19-27` (message constants), `:108-138` (constructor/fields), `:252-256` (fetch routing), `:327-363` (handleAccessRequest), `:367-393` (handleSession)
- Test: `tests/src/workspace-room.test.ts`

**Interfaces:**
- Produces: `MESSAGE_WORKSPACE_META = 3` (module constant); `WorkspaceRoom.name: string` (public field, defaults to `""`); `WorkspaceRoom.encodeWorkspaceMeta(): Uint8Array`; `WorkspaceRoom.broadcastWorkspaceMeta(): void`; `WorkspaceRoom.handleMetaRequest(request: Request): Promise<Response>`; `GET /access` response body gains `workspaceName: string`.
- Consumes: existing `this.broadcast(message: Uint8Array, exceptWs: unknown): void` (passing `null` as `exceptWs` broadcasts to every connected session — already the pattern documented at `src/workspace-room.ts:549`), existing `this.authorize(request)`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/src/workspace-room.test.ts`, right after the closing `});` of the `describe("WorkspaceRoom document membership", ...)` block (the block ending at line 715, immediately before `describe("WorkspaceRoom.handleInternalSeedRequest", ...)` at line 717):

```ts
describe("WorkspaceRoom.handleMetaRequest", () => {
  it("a non-editor's PUT is rejected without persisting or broadcasting", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    const request = new Request("https://example.com/w/ws1/meta", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
    const res = await room.handleMetaRequest(request);
    expect(res.status).toBe(403);
    expect(room.name).toBe("");
  });

  it("an editor's PUT persists the name, returns it, and it survives a storage reload", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/meta", {
      method: "PUT",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed Workspace" }),
    });
    const res = await room.handleMetaRequest(request);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Renamed Workspace" });
    expect(room.name).toBe("Renamed Workspace");
    expect(await room.state.storage.get("name")).toBe("Renamed Workspace");
  });

  it("broadcasts the new name and current docOrder to other connected sessions", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    room.docIds = ["docA", "docB"];
    const sent: ArrayBuffer[] = [];
    const ws = { send: (m: ArrayBuffer) => sent.push(m) } as unknown as WebSocket;
    (room as any).sessions.set(ws, { username: "bob", role: "viewer", viewingDocId: null });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/meta", {
      method: "PUT",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed Workspace" }),
    });
    await room.handleMetaRequest(request);

    expect(sent).toHaveLength(1);
    const decoder = decoding.createDecoder(new Uint8Array(sent[0]));
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_WORKSPACE_META);
    expect(decoding.readVarString(decoder)).toBe("Renamed Workspace");
    const count = decoding.readVarUint(decoder);
    const ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push(decoding.readVarString(decoder));
    expect(ids).toEqual(["docA", "docB"]);
  });

  it("rejects a non-PUT method", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const res = await room.handleMetaRequest(new Request("https://example.com/w/ws1/meta"));
    expect(res.status).toBe(405);
  });

  it("GET /access includes the current workspaceName", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    room.name = "My Shared Workspace";
    const res = await room.handleAccessRequest(new Request("https://example.com/w/ws1/access"));
    const body = await res.json();
    expect(body.workspaceName).toBe("My Shared Workspace");
  });

  it("a freshly-connected session is greeted with the current workspace meta", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    room.name = "Greeted Workspace";
    room.docIds = ["docA"];
    await room.loadDocRoom("docA");
    const sent: ArrayBuffer[] = [];
    const ws = { send: (m: ArrayBuffer) => sent.push(m), accept: () => {}, addEventListener: () => {} } as unknown as WebSocket;

    room.handleSession(ws, "alice", "editor");

    // One sync-step1 frame for docA, then the meta greeting.
    const metaFrame = sent[sent.length - 1];
    const decoder = decoding.createDecoder(new Uint8Array(metaFrame));
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_WORKSPACE_META);
    expect(decoding.readVarString(decoder)).toBe("Greeted Workspace");
  });
});
```

Add `const MESSAGE_WORKSPACE_META = 3;` next to the file's existing `const MESSAGE_SYNC = 0; const MESSAGE_AWARENESS = 1;` (line 13-14).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "handleMetaRequest"`
Expected: FAIL — `room.handleMetaRequest is not a function`, `room.name` is `undefined`, etc.

- [ ] **Step 3: Implement**

In `src/workspace-room.ts`, add the new message constant next to the existing ones (line 19-27):

```ts
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// Workspace-wide "which document am I currently looking at" signal —
// separate from MESSAGE_AWARENESS because each document keeps its own
// independent y-protocols Awareness instance (needed for correct
// per-document cursor/selection sync, same as CollabRoom today); this
// message type is the thing that lets the doc list show "who's on which
// file" across the whole workspace instead of just within one open doc.
const MESSAGE_PRESENCE = 2;
// The workspace's own name plus its ordered document list ({name,
// docOrder}) — a single last-write-wins value nobody co-edits
// character-by-character the way document content is, so it rides the
// same socket as a plain broadcast/greeting frame instead of a Y.Doc.
// docId-less, like MESSAGE_PRESENCE.
const MESSAGE_WORKSPACE_META = 3;
```

Add the `name` field next to `docIds` (line 117-138):

```ts
export class WorkspaceRoom {
  state: DurableObjectState;
  env: Env;
  sessions: Map<WebSocket, SessionInfo>;
  docs: Map<string, DocRoom>;
  docIds: string[];
  name: string;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.docs = new Map();
    this.docIds = [];
    this.name = "";

    this.state.blockConcurrencyWhile(async () => {
      const storedDocIds = await this.state.storage.get<string[]>("docs");
      this.docIds = storedDocIds || [];
      for (const docId of this.docIds) {
        await this.loadDocRoom(docId);
      }
      this.name = (await this.state.storage.get<string>("name")) || "";
    });
  }
```

Add the routing line in `fetch()` (line 252-256), right after the `/docs` line:

```ts
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/access")) return this.handleAccessRequest(request);
    if (url.pathname.endsWith("/docs")) return this.handleDocsRequest(request);
    if (url.pathname.endsWith("/meta")) return this.handleMetaRequest(request);
    if (url.pathname.endsWith("/internal/seed")) return this.handleInternalSeedRequest(request);
```

Add `encodeWorkspaceMeta()`, `broadcastWorkspaceMeta()`, and `handleMetaRequest()` as new methods — placed right after `handleAccessRequest` (after line 363, before the `// ---------- WebSocket session ----------` comment at line 365):

```ts
  encodeWorkspaceMeta(): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_WORKSPACE_META);
    encoding.writeVarString(encoder, this.name);
    encoding.writeVarUint(encoder, this.docIds.length);
    for (const id of this.docIds) encoding.writeVarString(encoder, id);
    return encoding.toUint8Array(encoder);
  }

  broadcastWorkspaceMeta(): void {
    this.broadcast(this.encodeWorkspaceMeta(), null);
  }

  async handleMetaRequest(request: Request): Promise<Response> {
    if (request.method !== "PUT") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    if (auth.role !== "editor") return new Response("Only an editor can rename this workspace.", { status: 403 });
    let body: { name?: unknown };
    try {
      body = await request.json();
    } catch (err) {
      return new Response("Invalid JSON.", { status: 400 });
    }
    if (typeof body.name !== "string") return new Response("Invalid name.", { status: 400 });
    this.name = body.name;
    await this.state.storage.put("name", this.name);
    this.broadcastWorkspaceMeta();
    return Response.json({ name: this.name });
  }
```

Update `handleAccessRequest`'s GET branch (line 327-335) to include `workspaceName`:

```ts
  async handleAccessRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const access = await this.getAccess();
      // Readable without authorization on purpose (the join flow needs it
      // before the visitor has any access), but only participants see the
      // roster — see access-visibility.ts.
      const auth = await this.authorize(request);
      const body = auth.ok ? access : redactAccessForOutsider(access);
      return Response.json({ ...body, workspaceName: this.name });
    }
```

Update `handleSession()` (line 367-393) to send one meta greeting frame right after the per-document greeting loop, before the event listeners are attached:

```ts
  handleSession(ws: WebSocket, username: string | null, role: Role): void {
    ws.accept();
    this.sessions.set(ws, { username, role, viewingDocId: null });

    for (const docId of this.docIds) {
      const docRoom = this.docs.get(docId);
      if (!docRoom) continue;
      const syncEncoder = encoding.createEncoder();
      encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
      encoding.writeVarString(syncEncoder, docId);
      syncProtocol.writeSyncStep1(syncEncoder, docRoom.doc);
      ws.send(encoding.toUint8Array(syncEncoder));

      const states = docRoom.awareness.getStates();
      if (states.size > 0) {
        const awarenessEncoder = encoding.createEncoder();
        encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
        encoding.writeVarString(awarenessEncoder, docId);
        encoding.writeVarUint8Array(awarenessEncoder, awarenessProtocol.encodeAwarenessUpdate(docRoom.awareness, Array.from(states.keys())));
        ws.send(encoding.toUint8Array(awarenessEncoder));
      }
    }
    ws.send(this.encodeWorkspaceMeta());

    ws.addEventListener("message", (event: MessageEvent) => this.handleMessage(ws, event.data));
    ws.addEventListener("close", () => this.handleClose(ws));
    ws.addEventListener("error", () => this.handleClose(ws));
  }
```

Add the import for `MESSAGE_WORKSPACE_META` and `decoding`/`encoding` calls needed in the test file — add to `tests/src/workspace-room.test.ts`'s top-level constants (line 13-14):

```ts
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_WORKSPACE_META = 3;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/src/workspace-room.test.ts`
Expected: PASS (all tests in the file, including the new `WorkspaceRoom.handleMetaRequest` block)

- [ ] **Step 5: Commit**

```bash
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "feat: sync a shared workspace's name over its WorkspaceRoom"
```

---

## Task 2: Server — `DELETE /docs` storage cleanup + broadcast

**Files:**
- Modify: `src/workspace-room.ts:905-913` (handleDocsRequest DELETE branch)
- Test: `tests/src/workspace-room.test.ts`

**Interfaces:**
- Consumes: `docStorageKey(docId, suffix)` (`src/workspace-room.ts:108`), `this.broadcastWorkspaceMeta()` (Task 1).
- Produces: `DELETE /api/workspace/:id/docs?docId=X` now also deletes `docStorageKey(docId, "update"|"snapshots"|"comments")` and broadcasts the updated `docOrder`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/src/workspace-room.test.ts`, right after the existing `it("removing a doc drops it from the docs list", ...)` test (lines 701-714), inside the same `describe("WorkspaceRoom document membership", ...)` block:

```ts
  it("removing a doc also deletes its stored content, snapshots, and comments", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    await room.state.storage.put("docs", ["docA"]);
    room.docIds = ["docA"];
    await room.state.storage.put("doc:docA:update", new ArrayBuffer(4));
    await room.state.storage.put("doc:docA:snapshots", [{ id: "s1", timestamp: 1, content: "x" }]);
    await room.state.storage.put("doc:docA:comments", [{ id: "c1" }]);
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs?docId=docA", {
      method: "DELETE",
      headers: { Cookie: `mde_gh_session=${cookie}` },
    });

    const res = await room.handleDocsRequest(request);

    expect(res.status).toBe(204);
    expect(await room.state.storage.get("doc:docA:update")).toBeUndefined();
    expect(await room.state.storage.get("doc:docA:snapshots")).toBeUndefined();
    expect(await room.state.storage.get("doc:docA:comments")).toBeUndefined();
  });

  it("removing a doc broadcasts the updated docOrder to other connected sessions", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    await room.state.storage.put("docs", ["docA", "docB"]);
    room.docIds = ["docA", "docB"];
    const sent: ArrayBuffer[] = [];
    const ws = { send: (m: ArrayBuffer) => sent.push(m) } as unknown as WebSocket;
    (room as any).sessions.set(ws, { username: "bob", role: "viewer", viewingDocId: null });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs?docId=docA", {
      method: "DELETE",
      headers: { Cookie: `mde_gh_session=${cookie}` },
    });

    await room.handleDocsRequest(request);

    expect(sent).toHaveLength(1);
    const decoder = decoding.createDecoder(new Uint8Array(sent[0]));
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_WORKSPACE_META);
    decoding.readVarString(decoder); // name, irrelevant here
    const count = decoding.readVarUint(decoder);
    const ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push(decoding.readVarString(decoder));
    expect(ids).toEqual(["docB"]);
  });
```

Add the `.delete` mock to `fakeState()` (line 19-33), since it currently only mocks `.get`/`.put`/`.setAlarm`:

```ts
function fakeState() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      delete: async (keyOrKeys: string | string[]) => {
        const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
        let count = 0;
        for (const k of keys) if (store.delete(k)) count++;
        return count;
      },
      setAlarm: async () => {},
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => {
      await fn();
    },
  } as unknown as DurableObjectState;
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "also deletes its stored content"`
Expected: FAIL — the `doc:docA:update`/`snapshots`/`comments` keys are still present (nothing deletes them yet), and the broadcast test fails with `sent` having length 0 (nothing broadcasts yet).

- [ ] **Step 3: Implement**

In `src/workspace-room.ts`, update the `DELETE` branch of `handleDocsRequest` (line 905-913):

```ts
    if (request.method === "DELETE") {
      if (auth.role !== "editor") return new Response("Only an editor can remove a document.", { status: 403 });
      const docId = new URL(request.url).searchParams.get("docId");
      if (!docId) return new Response("Missing docId.", { status: 400 });
      this.docIds = this.docIds.filter((id) => id !== docId);
      await this.state.storage.put("docs", this.docIds);
      this.docs.delete(docId);
      await this.state.storage.delete([docStorageKey(docId, "update"), docStorageKey(docId, "snapshots"), docStorageKey(docId, "comments")]);
      this.broadcastWorkspaceMeta();
      return new Response(null, { status: 204 });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/src/workspace-room.test.ts`
Expected: PASS (whole file)

- [ ] **Step 5: Commit**

```bash
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "fix: clean up a deleted document's stored content and broadcast its removal"
```

---

## Task 3: Client — `MESSAGE_WORKSPACE_META` handling, `applyWorkspaceMeta()`, `destroyBinding()` refactor

**Files:**
- Modify: `client/src/collab.ts:45-47` (constants), `:754-796` (teardownWorkspace), `:833-897` (handleServerMessage)
- Test: `tests/client/src/collab.test.ts`

**Interfaces:**
- Consumes: wire format from Task 1 (`MESSAGE_WORKSPACE_META=3`, `{name, docOrder}`); `renameWorkspace(id, name)` (`client/src/stores/workspaces.ts:207`); `removeDocById(id)` (`client/src/stores/docs.ts:338`).
- Produces: `const MESSAGE_WORKSPACE_META = 3`; `function destroyBinding(docId: string): void`; `function applyWorkspaceMeta(remoteWorkspaceId: string, name: string, docOrder: string[]): void` — both internal (not exported), exercised via `handleServerMessage`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/client/src/collab.test.ts`, as a new top-level `describe` block placed right after the closing `});` of `describe("discovering a document created by another collaborator", ...)` (the file's last block, ending at line 864):

```ts
describe("incoming workspace meta sync (rename + document removal)", () => {
  const MESSAGE_WORKSPACE_META = 3;

  function sendWorkspaceMeta(name: string, docOrder: string[]) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_WORKSPACE_META);
    encoding.writeVarString(encoder, name);
    encoding.writeVarUint(encoder, docOrder.length);
    for (const id of docOrder) encoding.writeVarString(encoder, id);
    const buffer = encoding.toUint8Array(encoder).buffer;
    MockWebSocket.instances[0].onmessage!({ data: buffer } as MessageEvent);
  }

  async function setup(suffix: string) {
    document.body.innerHTML = '<div id="shareBtn"></div>';
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access")) {
          return { ok: true, json: async () => ({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] }) };
        }
        if (url.includes("/docs")) {
          return { ok: true, json: async () => [`doc-${suffix}-a`, `doc-${suffix}-b`] };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    window.MDE = {
      enterCollabMode: vi.fn(),
      exitCollabMode: vi.fn(),
      setReadOnly: vi.fn(),
      getEditor: vi.fn(() => ({ state: { doc: { toString: () => "" } } })),
      githubUsername: "alice",
      githubSessionReady: Promise.resolve(),
      setDocImage: vi.fn(),
      requireGithubSignIn: vi.fn(),
    } as unknown as typeof window.MDE;

    const ws = fakeSharedWorkspace({ id: `local-ws-${suffix}`, remoteId: `remote-${suffix}`, name: "Old Name" });
    workspacesStore.set([ws]);
    const docA = { id: `doc-${suffix}-a`, name: "A", content: "", updatedAt: 0, createdAt: 0, workspaceId: ws.id };
    const docB = { id: `doc-${suffix}-b`, name: "B", content: "", updatedAt: 0, createdAt: 0, workspaceId: ws.id };
    docsStore.set([docA, docB]);

    handleDocChanged(docA);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    return { ws, docA, docB };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates the local workspace's name when a non-empty name arrives", async () => {
    const { ws, docA, docB } = await setup("meta1");
    sendWorkspaceMeta("Renamed By Owner", [docA.id, docB.id]);

    expect(get(workspacesStore).find((w) => w.id === ws.id)?.name).toBe("Renamed By Owner");
  });

  it("leaves the local workspace's name alone when the incoming name is empty", async () => {
    const { ws } = await setup("meta2");
    sendWorkspaceMeta("", [`doc-meta2-a`, `doc-meta2-b`]);

    expect(get(workspacesStore).find((w) => w.id === ws.id)?.name).toBe("Old Name");
  });

  it("removes a local document whose id is missing from the incoming docOrder, tearing down its binding", async () => {
    const { docB } = await setup("meta3");
    sendWorkspaceMeta("Old Name", [`doc-meta3-a`]);

    expect(get(docsStore).find((d) => d.id === docB.id)).toBeUndefined();
    expect(workspaceRoom.docs.has(docB.id)).toBe(false);
  });

  it("leaves a document alone whose id is still present in docOrder", async () => {
    const { docA, docB } = await setup("meta4");
    sendWorkspaceMeta("Old Name", [docA.id, docB.id]);

    expect(get(docsStore).find((d) => d.id === docA.id)).toBeDefined();
    expect(get(docsStore).find((d) => d.id === docB.id)).toBeDefined();
    expect(workspaceRoom.docs.has(docB.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/src/collab.test.ts -t "incoming workspace meta sync"`
Expected: FAIL — an incoming `MESSAGE_WORKSPACE_META` frame is currently unhandled (falls through to `handleServerMessage`'s generic `docId`-reading path and is silently dropped/misread), so none of the four assertions hold.

- [ ] **Step 3: Implement**

In `client/src/collab.ts`, add the new message constant (line 45-47):

```ts
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_PRESENCE = 2;
const MESSAGE_WORKSPACE_META = 3;
```

Add `renameWorkspace` and `removeDocById` to the existing imports (line 25 and 29):

```ts
import { getActiveDoc, switchDoc, docsStore, moveDocToWorkspace, findDocById, persistDocs, importRemoteDocs, syncRemoteDocContent, removeDocById } from "./stores/docs";
```

```ts
import { workspacesStore, switchWorkspace, createWorkspace, persistWorkspaces, adoptSharedWorkspace, previewSharedWorkspace, renameWorkspace } from "./stores/workspaces";
```

Add `destroyBinding()` right above `teardownWorkspace()` (line 754), and refactor `teardownWorkspace()`'s own per-binding loop to use it:

```ts
// Tears down one document's Yjs/awareness state and drops it from
// workspaceRoom.docs — the same cleanup teardownWorkspace() already does
// per-binding when leaving a workspace entirely, extracted so
// applyWorkspaceMeta() can do it for a single removed document without
// tearing down the whole connection.
function destroyBinding(docId: string): void {
  const binding = workspaceRoom.docs.get(docId);
  if (!binding) return;
  binding.awareness.destroy();
  binding.ydoc.off("update", binding.ydocUpdateHandler);
  if (binding.undoManager) binding.undoManager.destroy();
  binding.ydoc.destroy();
  workspaceRoom.docs.delete(docId);
}

function teardownWorkspace(): void {
  joinGeneration++;
  // Cancels any pending debounce timer and runs the flush immediately —
  // its side effects (docsStore writes, persistDocs) happen synchronously
  // within this call even though the returned Promise resolves later, so
  // nothing pending is lost to the Y.Doc destruction below.
  backgroundSyncDebounce.flush();
  remotePresenceByUsername.clear();
  workspacePresence.set(new Map());
  window.MDE.setReadOnly(false);
  unlockViewMode();
  window.MDE.exitCollabMode();
  if (workspaceRoom.reconnectTimer) {
    clearTimeout(workspaceRoom.reconnectTimer);
    workspaceRoom.reconnectTimer = null;
  }
  // Destroy each doc's awareness (broadcasting its own "I'm leaving" state
  // update, see bindActiveDoc's awareness.on("update", ...) listener) BEFORE
  // closing the socket — send() only transmits while the socket is OPEN, so
  // closing first silently drops that broadcast almost every time, leaving
  // a phantom presence entry the server never learns to remove.
  for (const docId of Array.from(workspaceRoom.docs.keys())) destroyBinding(docId);
  if (workspaceRoom.ws) {
    workspaceRoom.ws.onclose = null;
    workspaceRoom.ws.onerror = null;
    try {
      workspaceRoom.ws.close();
    } catch (e) {
      /* already closed */
    }
  }
  workspaceRoom.workspaceId = null;
  workspaceRoom.ws = null;
  workspaceRoom.activeDocId = null;
  workspaceRoom.role = null;
  workspaceRoom.reconnectDelay = 1000;
}
```

Add `applyWorkspaceMeta()` right after `teardownWorkspace()`:

```ts
// Applies an incoming MESSAGE_WORKSPACE_META frame: mirrors the sharer's
// real workspace name onto our local copy (matched by remoteId), and
// removes any local document whose id is no longer in the room's
// docOrder — the workspace-level counterpart to how a document's own
// name/content already sync. Runs on every frame, including the one-time
// greeting a freshly-opened connection gets (see WorkspaceRoom.handleSession),
// so a stale local cache never has more than the same brief window every
// other synced field already tolerates before the first real frame lands.
function applyWorkspaceMeta(remoteWorkspaceId: string, name: string, docOrder: string[]): void {
  const local = get(workspacesStore).find((w) => w.remoteId === remoteWorkspaceId);
  if (!local) return;
  if (name) renameWorkspace(local.id, name);
  const orderSet = new Set(docOrder);
  for (const doc of get(docsStore).filter((d) => d.workspaceId === local.id)) {
    if (!orderSet.has(doc.id)) {
      destroyBinding(doc.id);
      removeDocById(doc.id);
    }
  }
}
```

Update `handleServerMessage()` (line 833-897) to branch on the new message type, right after the existing `MESSAGE_PRESENCE` branch and before the generic `docId` read:

```ts
function handleServerMessage(data: Uint8Array): void {
  const decoder = decoding.createDecoder(data);
  const messageType = decoding.readVarUint(decoder);

  if (messageType === MESSAGE_PRESENCE) {
    const username = decoding.readVarString(decoder);
    const docId = decoding.readVarString(decoder);
    handleRemotePresence(username, docId);
    return;
  }

  if (messageType === MESSAGE_WORKSPACE_META) {
    const name = decoding.readVarString(decoder);
    const count = decoding.readVarUint(decoder);
    const docOrder: string[] = [];
    for (let i = 0; i < count; i++) docOrder.push(decoding.readVarString(decoder));
    if (workspaceRoom.workspaceId) applyWorkspaceMeta(workspaceRoom.workspaceId, name, docOrder);
    return;
  }

  const docId = decoding.readVarString(decoder);
  // ...unchanged below this point
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/src/collab.test.ts`
Expected: PASS (whole file — this also guards against a regression in every pre-existing describe block, since `teardownWorkspace` was refactored)

- [ ] **Step 5: Commit**

```bash
git add client/src/collab.ts tests/client/src/collab.test.ts
git commit -m "feat: apply incoming workspace name/document-removal sync client-side"
```

---

## Task 4: Client — `pushWorkspaceRename()` + `WorkspaceSwitcher.svelte` wiring

**Files:**
- Modify: `client/src/collab.ts` (new exported function, placed near `fetchWorkspaceAccess`/`putWorkspaceAccess` around line 999-1019), `client/src/components/WorkspaceSwitcher.svelte:1-13,59-62`
- Test: `tests/client/src/collab.test.ts`

**Interfaces:**
- Produces: `export function pushWorkspaceRename(workspaceId: string, name: string): void`.
- Consumes: `workspacesStore` (already imported in collab.ts).

- [ ] **Step 1: Write the failing tests**

Add to `tests/client/src/collab.test.ts`, right after the `describe("decideJoinTarget", ...)` block (after line 140):

```ts
describe("pushWorkspaceRename", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PUTs the new name to the workspace's room when the workspace is shared", () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    workspacesStore.set([fakeSharedWorkspace({ id: "ws1", remoteId: "remote-1" })]);

    pushWorkspaceRename("ws1", "New Name");

    expect(fetchMock).toHaveBeenCalledWith("/api/workspace/remote-1/meta", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
  });

  it("does nothing for a workspace that was never shared", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    workspacesStore.set([fakeWorkspace({ id: "ws1" })]);

    pushWorkspaceRename("ws1", "New Name");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

`fakeSharedWorkspace` is defined later in the file (line 218) — since this new `describe` block is placed before it, hoist `fakeSharedWorkspace` and `fakeWorkspace` are function declarations (`function fakeWorkspace(...)` at line 36, `function fakeSharedWorkspace(...)` at line 218) so both are already usable anywhere in the file regardless of position; no reordering needed.

Add `pushWorkspaceRename` to the `collab.ts` import list at the top of the test file (line 17-25):

```ts
import {
  decideShareTarget,
  decideJoinTarget,
  handleDocChanged,
  workspaceRoom,
  setAccessMode,
  isIdentityUnverified,
  DEFAULT_ACCESS,
  pushWorkspaceRename,
} from "../../../client/src/collab";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/src/collab.test.ts -t "pushWorkspaceRename"`
Expected: FAIL — `pushWorkspaceRename` is not exported yet.

- [ ] **Step 3: Implement**

In `client/src/collab.ts`, add the new exported function right after `fetchWorkspaceAccess` (after line 1007, before `putWorkspaceAccess`):

```ts
export function pushWorkspaceRename(workspaceId: string, name: string): void {
  const ws = get(workspacesStore).find((w) => w.id === workspaceId);
  if (!ws || !ws.shared || !ws.remoteId) return;
  void fetch(`/api/workspace/${encodeURIComponent(ws.remoteId)}/meta`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}
```

In `client/src/components/WorkspaceSwitcher.svelte`, add the import (line 1-13):

```svelte
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
  import { confirmAction } from "../stores/confirmDialog";
  import { pushWorkspaceRename } from "../collab";
```

Update `commitRename()` (line 59-62):

```svelte
  function commitRename() {
    if (renamingId) {
      renameWorkspace(renamingId, renameValue.trim());
      pushWorkspaceRename(renamingId, renameValue.trim());
    }
    renamingId = null;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/src/collab.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/collab.ts client/src/components/WorkspaceSwitcher.svelte tests/client/src/collab.test.ts
git commit -m "feat: push a workspace rename to its shared room"
```

---

## Task 5: Client — `docRemovalHook` + `deleteDoc()` wiring + `pushWorkspaceDocDelete()`

**Files:**
- Modify: `client/src/stores/docs.ts:1-19` (imports — no new ones needed, hook is self-contained), `:357-364` (deleteDoc), `client/src/collab.ts:155-186` (init), plus a new exported function near `pushWorkspaceRename` (Task 4)
- Test: `tests/client/src/collab.test.ts`

**Interfaces:**
- Consumes: `destroyBinding(docId)` (Task 3, internal to collab.ts).
- Produces: `export const docRemovalHook: { onRemoved: ((id: string, workspaceId: string) => void) | null }` (`client/src/stores/docs.ts`); `export function pushWorkspaceDocDelete(docId: string, workspaceId: string): void` (`client/src/collab.ts`); `deleteDoc()` now calls `docRemovalHook.onRemoved?.(id, doc.workspaceId)` before `removeDocById(id)`; `collab.ts`'s `init()` sets `docRemovalHook.onRemoved = pushWorkspaceDocDelete`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/client/src/collab.test.ts`, right after the `describe("pushWorkspaceRename", ...)` block added in Task 4:

```ts
describe("pushWorkspaceDocDelete", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("DELETEs the document from the workspace's room when the workspace is shared", () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    workspacesStore.set([fakeSharedWorkspace({ id: "ws1", remoteId: "remote-1" })]);

    pushWorkspaceDocDelete("doc1", "ws1");

    expect(fetchMock).toHaveBeenCalledWith("/api/workspace/remote-1/docs?docId=doc1", { method: "DELETE" });
  });

  it("does nothing for a workspace that was never shared", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    workspacesStore.set([fakeWorkspace({ id: "ws1" })]);

    pushWorkspaceDocDelete("doc1", "ws1");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("also destroys this session's own Yjs binding for the deleted document immediately", async () => {
    document.body.innerHTML = '<div id="shareBtn"></div><div id="shareDropdownBtn"></div>';
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (url.includes("/access") && init?.method === "PUT") {
          return { ok: true, json: async () => ({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] }) };
        }
        if (url.includes("/docs")) return { ok: true, json: async () => [] };
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
    handleDocChanged(undefined as unknown as Doc);
    workspacesStore.set([fakeWorkspace({ id: "ws1", name: "WS" })]);
    activeWorkspaceIdStore.set("ws1");
    docsStore.set([{ id: "doc1", name: "My Doc", content: "hello", updatedAt: 0, createdAt: 0, workspaceId: "ws1" }]);
    activeIdStore.set("doc1");

    await setAccessMode("anyone-link", "editor");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(workspaceRoom.docs.has("doc1")).toBe(true);

    pushWorkspaceDocDelete("doc1", "ws1");

    expect(workspaceRoom.docs.has("doc1")).toBe(false);
  });
});
```

Add `pushWorkspaceDocDelete` to the same `collab.ts` import list updated in Task 4:

```ts
import {
  decideShareTarget,
  decideJoinTarget,
  handleDocChanged,
  workspaceRoom,
  setAccessMode,
  isIdentityUnverified,
  DEFAULT_ACCESS,
  pushWorkspaceRename,
  pushWorkspaceDocDelete,
} from "../../../client/src/collab";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/src/collab.test.ts -t "pushWorkspaceDocDelete"`
Expected: FAIL — `pushWorkspaceDocDelete` is not exported yet.

- [ ] **Step 3: Implement**

In `client/src/stores/docs.ts`, add the hook object right after the imports (after line 18, before `const STORAGE_DOCS = "mde:docs";`):

```ts
// Lets collab.ts learn about a genuine LOCAL delete intent without this
// module importing collab.ts back (this module never touches window.MDE
// or collab.ts — see the module comment at the top of this file).
// collab.ts's init() sets onRemoved once; deleteDoc() (the only
// local-intent delete call site) invokes it right before removeDocById()
// actually mutates state. Deliberately NOT called from removeDocById()
// itself: applying a REMOTE-triggered deletion (collab.ts's
// applyWorkspaceMeta) also goes through removeDocById(), and must not
// re-trigger an outbound DELETE request for a deletion that already came
// from the server.
export const docRemovalHook: { onRemoved: ((id: string, workspaceId: string) => void) | null } = { onRemoved: null };
```

Update `deleteDoc()` (line 357-364):

```ts
export async function deleteDoc(id: string): Promise<Doc | undefined> {
  const doc = findDocById(id);
  if (!doc) return undefined;
  if (!(await confirmAction(`Delete "${doc.name || "Untitled"}"?`, "This can't be undone."))) return undefined;
  docRemovalHook.onRemoved?.(id, doc.workspaceId);
  removeDocById(id);
  showToast(`Deleted "${doc.name || "Untitled"}"`, "success");
  return doc;
}
```

In `client/src/collab.ts`, add `docRemovalHook` to the `stores/docs` import (line 25, same line touched in Task 3):

```ts
import { getActiveDoc, switchDoc, docsStore, moveDocToWorkspace, findDocById, persistDocs, importRemoteDocs, syncRemoteDocContent, removeDocById, docRemovalHook } from "./stores/docs";
```

Add `pushWorkspaceDocDelete` right after `pushWorkspaceRename` (Task 4):

```ts
export function pushWorkspaceDocDelete(docId: string, workspaceId: string): void {
  const ws = get(workspacesStore).find((w) => w.id === workspaceId);
  if (!ws || !ws.shared || !ws.remoteId) return;
  // Destroy this session's own binding immediately rather than waiting
  // for the broadcast echo — the deleting session may not even be
  // currently connected via WS (renaming/deleting works regardless, see
  // this feature's "Why HTTP, not WS" design note), and stores/docs.ts's
  // own removeDocById() already dropped the local Doc by the time any
  // echo could arrive anyway.
  destroyBinding(docId);
  void fetch(`/api/workspace/${encodeURIComponent(ws.remoteId)}/docs?docId=${encodeURIComponent(docId)}`, { method: "DELETE" });
}
```

Wire the hook in `init()` (line 182-186), right after the existing `onDocRenamed` assignment:

```ts
  window.MDE.onDocRenamed = (docId, name) => {
    const binding = workspaceRoom.docs.get(docId);
    if (binding) binding.ydoc.transact(() => binding.metaMap.set("name", name || "Untitled"), "local");
  };
  docRemovalHook.onRemoved = pushWorkspaceDocDelete;

  setupShareUI();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/src/collab.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/stores/docs.ts client/src/collab.ts tests/client/src/collab.test.ts
git commit -m "feat: push a local document deletion to its shared workspace room"
```

---

## Task 6: Client — real `workspaceName` wiring into `decideJoinTarget`/`joinSharedLink`

**Files:**
- Modify: `client/src/collab.ts:1204-1210` (decideJoinTarget), `:208-253` (joinSharedLink), `client/src/types.ts:11-20` (AccessRecord)
- Test: `tests/client/src/collab.test.ts`

**Interfaces:**
- Produces: `decideJoinTarget(validDocs: { name: string }[], existingWorkspaceCount: number, remoteWorkspaceName?: string): JoinDecision` (backward-compatible — the new parameter is optional); `AccessRecord.workspaceName?: string`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/client/src/collab.test.ts`'s existing `describe("decideJoinTarget", ...)` block, right before its closing `});` (after the "treats zero valid documents..." test at line 136-139):

```ts
  it("uses the real remote workspace name for a multi-document permanent landing when provided", () => {
    const result = decideJoinTarget([{ name: "A" }, { name: "B" }], 0, "Team Docs");
    expect(result).toEqual({ kind: "auto-permanent", workspaceName: "Team Docs" });
  });

  it("falls back to the 'Shared workspace' placeholder when no remote workspace name is provided", () => {
    const result = decideJoinTarget([{ name: "A" }, { name: "B" }], 0);
    expect(result).toEqual({ kind: "auto-permanent", workspaceName: "Shared workspace" });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client/src/collab.test.ts -t "remote workspace name"`
Expected: FAIL — the first new test gets `workspaceName: "Shared workspace"` instead of `"Team Docs"` (the third argument is currently ignored/nonexistent).

- [ ] **Step 3: Implement**

In `client/src/types.ts`, add the new optional field to `AccessRecord` (line 11-20):

```ts
export interface AccessRecord {
  owner: string | null;
  generalAccess: "restricted" | "anyone";
  // Only meaningful when generalAccess is "anyone" — false (default)
  // means a fully public link, no account needed; true means any signed
  // -in GitHub account works without being individually invited.
  requireAccount: boolean;
  role: string;
  invited: InvitedPerson[];
  // The sharer's real workspace name, as of the last fetch — empty/absent
  // for a workspace shared before this field existed, or one that was
  // never explicitly renamed. See collab.ts's decideJoinTarget/joinSharedLink.
  workspaceName?: string;
}
```

In `client/src/collab.ts`, update `decideJoinTarget` (line 1204-1210):

```ts
export function decideJoinTarget(validDocs: { name: string }[], existingWorkspaceCount: number, remoteWorkspaceName?: string): JoinDecision {
  const multiDocName = remoteWorkspaceName || "Shared workspace";
  if (existingWorkspaceCount === 0) {
    return { kind: "auto-permanent", workspaceName: validDocs.length === 1 ? validDocs[0]!.name || "Untitled" : multiDocName };
  }
  if (validDocs.length === 1) return { kind: "auto-preview", workspaceName: validDocs[0]!.name || "Untitled" };
  return { kind: "choice" };
}
```

Update `joinSharedLink()` (line 208-253) to pass the real name through, both into `decideJoinTarget` and into the `"choice"` path's own `pendingJoin.set`:

```ts
  const decision = decideJoinTarget(validDocs, get(workspacesStore).length, access.workspaceName);
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

  pendingJoin.set({ remoteId: workspaceId, workspaceName: access.workspaceName || "Shared workspace", docs: validDocs, landOnDocId });
```

(Only the `decideJoinTarget(...)` call's arguments and the `pendingJoin.set(...)` literal change — everything else in the function is untouched.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client/src/collab.test.ts`
Expected: PASS. `npm run typecheck` should also still pass (the new `AccessRecord.workspaceName?` field is optional, so every existing object literal typed as `AccessRecord` — `DEFAULT_ACCESS` included — stays valid).

`joinSharedLink()` itself has no pre-existing unit test coverage in this file (it's only reachable through `init()`, which never runs under jsdom — confirmed by grep finding zero references to `joinSharedLink`/`pendingJoin` in the test file); its wiring is validated end-to-end by Task 7's e2e test instead, consistent with that existing coverage boundary.

- [ ] **Step 5: Commit**

```bash
git add client/src/collab.ts client/src/types.ts tests/client/src/collab.test.ts
git commit -m "feat: use the sharer's real workspace name when joining a shared link"
```

---

## Task 7: Playwright e2e coverage

**Files:**
- Create: `tests/e2e/collab/workspace-structure-sync.spec.ts`

**Interfaces:**
- Consumes: `signInAsDevUser` (`tests/e2e/collab/support/dev-login.ts`), the UI wired in Tasks 1-6 (`WorkspaceSwitcher.svelte`'s rename UI, `DocList.svelte`'s delete UI, `Share.svelte`'s access selects).

- [ ] **Step 1: Write the e2e tests**

Create `tests/e2e/collab/workspace-structure-sync.spec.ts`:

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

async function createFirstWorkspaceAndDoc(page: import("@playwright/test").Page) {
  await page.click("#emptyNewWorkspaceBtn");
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => window.MDE.newDoc());
  await page.waitForSelector("#editor-mount .cm-content", { state: "visible" });
}

async function shareAsAnyoneWithLink(owner: import("@playwright/test").Page, roleLabel: "Viewer" | "Editor") {
  await owner.click('button:has-text("Share")');
  const moveDialog = owner.locator('button:has-text("Continue")');
  if (await moveDialog.isVisible({ timeout: 2000 }).catch(() => false)) await moveDialog.click();
  const accessSelect = owner.locator('select[aria-label="General access"]');
  await accessSelect.waitFor({ state: "visible" });
  await Promise.all([
    owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    accessSelect.selectOption({ label: "Anyone with the link" }),
  ]);
  const roleSelect = owner.locator('select[aria-label="Access level for people with the link"]');
  await roleSelect.waitFor({ state: "visible" });
  await Promise.all([
    owner.waitForResponse((res) => /\/api\/workspace\/[^/]+\/access$/.test(res.url()) && res.request().method() === "PUT"),
    roleSelect.selectOption({ label: roleLabel }),
  ]);
  await owner.keyboard.press("Escape").catch(() => {});
}

async function joinAsNewWorkspace(viewer: import("@playwright/test").Page, shareUrl: string) {
  await viewer.goto(shareUrl);
  await viewer.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  const joinModal = viewer.locator('text="Join shared workspace"');
  if (await joinModal.isVisible({ timeout: 3000 }).catch(() => false)) {
    await viewer.click('button:has-text("Add as new workspace")');
  }
  await dismissWhatsNew(viewer);
}

test("a shared workspace's real name reaches a fresh joiner and updates live for an already-connected collaborator", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await signInAsDevUser(owner, "wsname-owner-e2e");
  await signInAsDevUser(viewer, "wsname-viewer-e2e");

  await owner.goto(BASE);
  await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(owner);
  await createFirstWorkspaceAndDoc(owner);
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.type("first doc content");

  // Give the workspace a real, distinctive name before sharing.
  await owner.click(".workspace-switcher-trigger");
  await owner.click('.workspace-row [aria-label="Rename workspace"]');
  const renameInput = owner.locator(".workspace-rename-input");
  await renameInput.fill("Team Docs");
  await renameInput.press("Enter");
  await owner.keyboard.press("Escape").catch(() => {});

  // A second document so the joiner takes the multi-document join path,
  // where the real workspace name (not a single doc's own name) is shown.
  await owner.evaluate(() => window.MDE.newDoc());
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.type("second doc content");
  const firstDocId = await owner.evaluate(() => {
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]") as { id: string; name: string }[];
    return docs.find((d) => d.name !== "Untitled")?.id ?? docs[0]!.id;
  });
  await owner.evaluate((id) => window.MDE.switchDoc(id), firstDocId);

  await shareAsAnyoneWithLink(owner, "Editor");

  const shareState = await owner.evaluate((docId) => {
    const workspaces = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const activeDoc = docs.find((d: { id: string }) => d.id === docId);
    const ws = workspaces.find((w: { id: string }) => w.id === activeDoc?.workspaceId);
    return { ws };
  }, firstDocId);
  const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${firstDocId}/edit`;

  await joinAsNewWorkspace(viewer, shareUrl);

  // The fresh joiner sees the sharer's real workspace name, not the
  // "Shared workspace" placeholder the old, name-less join path showed.
  await expect(viewer.locator(".workspace-switcher-trigger .workspace-name")).toHaveText("Team Docs");

  // Live rename: the owner renames the workspace again while the viewer
  // stays connected — the label updates with no reload.
  await owner.click(".workspace-switcher-trigger");
  await owner.click('.workspace-row [aria-label="Rename workspace"]');
  const renameInput2 = owner.locator(".workspace-rename-input");
  await renameInput2.fill("Renamed Live");
  await renameInput2.press("Enter");
  await owner.keyboard.press("Escape").catch(() => {});

  await expect.poll(() => viewer.locator(".workspace-switcher-trigger .workspace-name").textContent()).toBe("Renamed Live");
});

test("deleting a document from a shared workspace removes it live for other collaborators, landing them somewhere sane if it was their active document", async ({
  browser,
}) => {
  const ownerCtx = await browser.newContext();
  const viewerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const viewer = await viewerCtx.newPage();

  await signInAsDevUser(owner, "wsdel-owner-e2e");
  await signInAsDevUser(viewer, "wsdel-viewer-e2e");

  await owner.goto(BASE);
  await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(owner);
  await createFirstWorkspaceAndDoc(owner);
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.type("first doc");
  const firstDocId = await owner.evaluate(() => localStorage.getItem("mde:active"));

  await owner.evaluate(() => window.MDE.newDoc());
  await owner.click("#editor-mount .cm-content");
  await owner.keyboard.type("second doc");
  const secondDocId = await owner.evaluate(() => localStorage.getItem("mde:active"));
  await owner.evaluate((id) => window.MDE.switchDoc(id), firstDocId);

  await shareAsAnyoneWithLink(owner, "Editor");

  const shareState = await owner.evaluate((docId) => {
    const workspaces = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const activeDoc = docs.find((d: { id: string }) => d.id === docId);
    const ws = workspaces.find((w: { id: string }) => w.id === activeDoc?.workspaceId);
    return { ws };
  }, firstDocId);
  const shareUrl = `${BASE}/w/${shareState.ws.remoteId}/${firstDocId}/edit`;

  await joinAsNewWorkspace(viewer, shareUrl);
  await expect.poll(() => viewer.evaluate(() => window.MDE.getEditor()?.state?.doc?.toString() ?? "")).toContain("first doc");
  await expect(viewer.locator("#docList li")).toHaveCount(2);

  // Owner deletes the SECOND document (not the one the viewer has open) —
  // it should vanish from the viewer's sidebar with no reload.
  await owner.evaluate((id) => window.MDE.switchDoc(id), secondDocId);
  await owner.click('#docList li.active [aria-label="Document options"]');
  await owner.click(".doc-menu-popover button.danger");
  await owner.click(".primary-btn.danger");

  await expect(viewer.locator("#docList li")).toHaveCount(1);

  // Owner now deletes the FIRST document — the one the viewer currently
  // has open — the viewer must land somewhere sane instead of a
  // broken/blank editor.
  await owner.click('#docList li.active [aria-label="Document options"]');
  await owner.click(".doc-menu-popover button.danger");
  await owner.click(".primary-btn.danger");

  await expect(viewer.locator("#docList li")).toHaveCount(0);
  await expect(viewer.locator("#emptyState")).toBeVisible();
});
```

- [ ] **Step 2: Run the tests**

Per `CLAUDE.md`'s sandboxed-environment note: check `ls /opt/pw-browsers/` for the actual installed `chromium-*` build (not `chromium_headless_shell-*`), temporarily add `launchOptions: { executablePath: "/opt/pw-browsers/chromium" }` under `playwright.config.ts`'s top-level `use`, then run:

Run: `npm run test:e2e:collab`
Expected: PASS, both new tests. Revert the `playwright.config.ts` workaround before committing.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/collab/workspace-structure-sync.spec.ts
git commit -m "test: e2e coverage for live workspace rename and document-deletion sync"
```

---

## Task 8: Version/CHANGELOG/What's New + final verification

**Files:**
- Modify: `package.json`, `package-lock.json` (two `"version"` fields), `CHANGELOG.md`, `client/src/whats-new-entries.ts`

**Interfaces:** None — this task only touches metadata/docs, no code interfaces.

- [ ] **Step 1: Determine the target version**

This branch sits on top of `fix/share-whole-workspace-and-toolbar-collapse`, whose own `CHANGELOG.md` entry (`## [1.44.1] - 2026-09-05`) bumped nothing in `package.json` yet (still `1.44.0` as of this branch). Before bumping, check whichever of these two is true at execution time:

Run: `git log origin/master -1 --format=%H -- package.json` and `git show origin/master:package.json | grep '"version"'`
- If `master` has since shipped `1.44.1` (its own PR merged first): this feature bumps to the next **minor**, `1.45.0`.
- If `master` is still on `1.44.0` (the `1.44.1` patch branch hasn't merged yet): per `CLAUDE.md`'s "collapse orphaned version bumps" rule, fold the still-unshipped `1.44.1` `### Fixed` bullets into this feature's own version section instead of leaving two consecutive unreleased headings, and bump straight to `1.45.0`.

Either way the target is `1.45.0` (a user-facing feature is always a minor bump) — the only variable is whether `CHANGELOG.md` ends up with one merged `## [1.45.0]` section (fold case) or two separate shipped sections, `## [1.44.1]` followed by `## [1.45.0]` (already-shipped case). Inspect `CHANGELOG.md`'s current top section at execution time to see which situation applies before editing it.

- [ ] **Step 2: Bump `package.json` and `package-lock.json`**

In `package.json`, change `"version": "1.44.0"` to `"version": "1.45.0"` (or whatever `"version"` currently reads, per Step 1's check). In `package-lock.json`, hand-edit both `"version"` fields (the top-level one and the matching one under `"packages": { "": { ... } }`) to match — per `CLAUDE.md`, do not run a full `npm install --package-lock-only` regeneration.

- [ ] **Step 3: Add the `CHANGELOG.md` entry**

Add a new section at the top of `CHANGELOG.md` (exact placement — fold vs. two-section — decided by Step 1):

```markdown
## [1.45.0] - 2026-09-05

### Added

- **A shared workspace now mirrors the sharer's side one-to-one, the way a shared folder does.** Its real name reaches every collaborator — joining (or already being connected to) a multi-document shared workspace no longer shows the placeholder "Shared workspace" — and renaming it afterward propagates live to everyone still connected, with no reload needed.
- **Deleting a document from a shared workspace now removes it for every collaborator, live**, instead of leaving a silently-orphaned local copy behind for everyone but the person who deleted it.

### Fixed

- **A deleted shared document's stored content, snapshots, and comments were never actually cleaned up server-side**, left indefinitely in Durable Object storage even though the document itself was gone from the workspace's document list.
```

(If Step 1 found `1.44.1` still unshipped on this branch's base, fold its three `### Fixed` bullets from the existing `## [1.44.1]` section into this same `## [1.45.0]` section's own `### Fixed` list, and delete the now-orphaned `## [1.44.1]` heading.)

- [ ] **Step 4: Add the What's New entry**

Add to `client/src/whats-new-entries.ts`'s `WHATS_NEW_ENTRIES` array (append at the end, oldest-first convention):

```ts
  {
    version: "1.45.0",
    title: "Live Workspace Sync",
    description:
      "A shared workspace now mirrors the sharer's side completely, not just its documents' own content and names: the workspace's real name reaches every collaborator and updates live if it's renamed, and deleting a document removes it for everyone instead of leaving an orphaned copy behind.",
    screenshot: "/whats-new/live-workspace-sync.png",
    category: "Collaboration",
  },
```

A real screenshot still needs to be captured and saved to `client/public/whats-new/live-workspace-sync.png` before shipping (per `CLAUDE.md`'s note that `WhatsNew.svelte` expects the `screenshot` path to point at a real asset) — capture the `WorkspaceSwitcher` popover showing a synced real name, or the live-update moment, whichever renders more clearly at the What's New modal's display size.

- [ ] **Step 5: Final verification**

Run, in order:

```bash
npm test
npm run typecheck
npm run format
npm run build
```

Expected: all pass/clean. Then run the full e2e suite (with the sandbox `playwright.config.ts` workaround from Task 7, reverted afterward either way):

```bash
npm run test:e2e:local
npm run test:e2e:collab
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md client/src/whats-new-entries.ts
git commit -m "chore: bump version to 1.45.0 for workspace structure sync"
```
