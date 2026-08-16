# Workspace-Level Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign sharing so an entire workspace's documents sync live to collaborators simultaneously, with one access record per workspace, replacing today's one-document-at-a-time `CollabRoom`.

**Architecture:** A new `WorkspaceRoom` Durable Object (one per shared workspace) holds a `Map<docId, DocRoom>` and multiplexes every document's Yjs sync + awareness traffic over a single WebSocket, keyed by a doc id prefix on every message frame. The client's `collab.ts` singleton `room` generalizes into `workspaceRoom`, holding one live `Y.Doc` per document in the active shared workspace. Access control, join/merge flow, and single-document relocate-and-share are all workspace-scoped. Already-shared documents migrate lazily (no bulk pass — no server-side registry exists) via a tombstone on the old `CollabRoom`.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite-backed), Yjs + y-protocols (sync, awareness), lib0 encoding/decoding, Svelte 5, Vitest.

## Global Constraints

- One role per person per workspace — no per-document roles within a shared workspace (spec Non-goals).
- Version history and comment-thread *behavior* is unchanged — only their storage re-scopes from "per document" to "per document within a workspace" (spec Non-goals).
- No new merge-conflict UI — name collisions when merging a shared workspace's documents into an existing local workspace use the existing silent-suffix primitive, `ensureUniqueName`/`nextAvailableName` in `client/src/doc-naming.ts` (spec Non-goals).
- `CollabRoom` (`src/collab-room.ts`) is NOT deleted in this plan — it stays as the migration path's read side (spec Architecture > Migration).
- Share links move from `/d/<docId>/<mode>` to `/w/<workspaceId>/<docId>/<mode>` (spec Architecture > Share links).

---

## Task 1: Data model — `Workspace.shared`/`remoteId`

**Files:**
- Modify: `client/src/types.ts:37-41` (`Workspace` interface)
- Test: `client/src/stores/workspaces.test.ts`

**Interfaces:**
- Produces: `Workspace.shared?: boolean`, `Workspace.remoteId?: string` — read by every later client task that touches workspace sharing state.

`Doc.shared` (`client/src/types.ts:69-72`) stays exactly as-is in this task — it keeps its current meaning until Task 12 repoints it to a legacy-migration-only signal. Removing it early would break `collab.ts`, `docs.ts`, and two Svelte components that aren't touched until later tasks.

- [ ] **Step 1: Add the two new fields to `Workspace`**

In `client/src/types.ts`, replace:

```typescript
export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
}
```

with:

```typescript
export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  // Set once this workspace has ever been shared or joined from a share
  // link — mirrors the same "try to reconnect on load" role Doc.shared
  // plays for local documents, just at workspace scope.
  shared?: boolean;
  // The WorkspaceRoom Durable Object's name, once shared/joined.
  // Deliberately separate from `id`: a workspace joined via "merge into an
  // existing workspace" keeps its own local id/name but still needs to
  // know which remote room to connect to.
  remoteId?: string;
}
```

- [ ] **Step 2: Write a failing test asserting the fields round-trip through storage**

Add to `client/src/stores/workspaces.test.ts` (open the file first to match its existing `localStorage` mock / `beforeEach` setup pattern):

```typescript
it("persists shared and remoteId through createWorkspace + reload", () => {
  const ws = createWorkspace("Team Docs");
  workspacesStore.update((all) => all.map((w) => (w.id === ws.id ? { ...w, shared: true, remoteId: "room-abc" } : w)));
  persistWorkspaces();

  const stored = JSON.parse(localStorage.getItem("mde:workspaces")!);
  const found = stored.find((w: Workspace) => w.id === ws.id);
  expect(found.shared).toBe(true);
  expect(found.remoteId).toBe("room-abc");
});
```

Add `import type { Workspace } from "../types";` to the test file's imports if not already present.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- workspaces.test.ts`
Expected: FAIL — `Workspace` type has no `shared`/`remoteId` yet is fine (TS structural typing won't fail this at runtime), but the assertion `found.shared` will be `undefined`, not `true`, only if step 1 wasn't applied yet. Apply step 1 first, then this test should already pass — so instead run it *before* Step 1's edit to confirm it fails (`found.shared` is `undefined`), confirming the test actually exercises real behavior.

- [ ] **Step 4: Run the full test file to verify everything passes**

Run: `npm test -- workspaces.test.ts`
Expected: PASS, all tests including the new one.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: no errors.

```bash
git add client/src/types.ts client/src/stores/workspaces.test.ts
git commit -m "feat: add shared/remoteId fields to Workspace"
```

---

## Task 2: `WorkspaceRoom` DO scaffold — multiplexed sync + awareness wire protocol

**Files:**
- Create: `src/workspace-room.ts`
- Modify: `src/env.ts` (add `WORKSPACE_ROOM` binding)
- Modify: `wrangler.jsonc` (add binding + migration entry)
- Modify: `src/worker.ts` (export the new class)
- Test: `src/workspace-room.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (first server task).
- Produces: `export class WorkspaceRoom` with `docs: Map<string, DocRoom>`, `sessions: Map<WebSocket, SessionInfo>`, `fetch(request): Promise<Response>` (websocket upgrade only in this task — later tasks add more routes to the same method), `handleMessage(ws, data)`, `handleSession(ws, username, role)`. `DocRoom` and `SessionInfo` types, consumed by Tasks 3-6.

This task is the foundation every later `WorkspaceRoom` task builds on. It gets one document's sync+awareness fully multiplexed and working end-to-end (no access control yet — Task 3 adds that; every session in this task is treated as `role: "editor"` so the plumbing can be tested in isolation).

- [ ] **Step 1: Add the Durable Object binding to `wrangler.jsonc`**

Open `wrangler.jsonc`. Change:

```jsonc
  "durable_objects": {
    "bindings": [
      { "name": "COLLAB_ROOM", "class_name": "CollabRoom" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["CollabRoom"] },
    { "tag": "v2", "new_sqlite_classes": ["ImageQuota"] },
    { "tag": "v3", "deleted_classes": ["ImageQuota"] }
  ]
```

to:

```jsonc
  "durable_objects": {
    "bindings": [
      { "name": "COLLAB_ROOM", "class_name": "CollabRoom" },
      { "name": "WORKSPACE_ROOM", "class_name": "WorkspaceRoom" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["CollabRoom"] },
    { "tag": "v2", "new_sqlite_classes": ["ImageQuota"] },
    { "tag": "v3", "deleted_classes": ["ImageQuota"] },
    { "tag": "v4", "new_sqlite_classes": ["WorkspaceRoom"] }
  ]
```

- [ ] **Step 2: Add the binding to `Env`**

In `src/env.ts`, change:

```typescript
export interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  COLLAB_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}
```

to:

```typescript
export interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  COLLAB_ROOM: DurableObjectNamespace;
  WORKSPACE_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}
```

- [ ] **Step 3: Write the failing test for multiplexed sync**

Create `src/workspace-room.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { WorkspaceRoom } from "./workspace-room";
import type { Env } from "./env";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

// Minimal in-memory stand-in for DurableObjectState — same pattern as
// src/collab-room.test.ts's fakeState(), WorkspaceRoom only ever touches
// .storage.{get,put,setAlarm} and .blockConcurrencyWhile.
function fakeState() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      setAlarm: async () => {},
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => {
      await fn();
    },
  } as unknown as DurableObjectState;
}

const fakeEnv = {} as unknown as Env;

function encodeSyncUpdate(docId: string, update: Uint8Array): ArrayBuffer {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarString(encoder, docId);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder).buffer as ArrayBuffer;
}

function decodeEnvelope(data: ArrayBuffer): { type: number; docId: string; decoder: decoding.Decoder } {
  const decoder = decoding.createDecoder(new Uint8Array(data));
  const type = decoding.readVarUint(decoder);
  const docId = decoding.readVarString(decoder);
  return { type, docId, decoder };
}

describe("WorkspaceRoom multiplexed sync", () => {
  it("routes an update for docA to docA's Y.Doc without touching docB", () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const fakeWs = {} as WebSocket;
    room.sessions.set(fakeWs, { username: "alice", role: "editor", viewingDocId: null });

    const scratch = new Y.Doc();
    scratch.getText("content").insert(0, "hello docA");
    const update = Y.encodeStateAsUpdate(scratch);

    room.handleMessage(fakeWs, encodeSyncUpdate("docA", update));

    expect(room.docs.get("docA")?.doc.getText("content").toString()).toBe("hello docA");
    expect(room.docs.has("docB")).toBe(false);
  });

  it("broadcasts a docA update to other sessions with docA's id in the envelope, not to a fresh session for docB", () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const sentByReceiver: ArrayBuffer[] = [];
    const receiverWs = { send: (data: ArrayBuffer) => sentByReceiver.push(data) } as unknown as WebSocket;
    const senderWs = {} as WebSocket;
    room.sessions.set(receiverWs, { username: "bob", role: "editor", viewingDocId: null });
    room.sessions.set(senderWs, { username: "alice", role: "editor", viewingDocId: null });

    const scratch = new Y.Doc();
    scratch.getText("content").insert(0, "hi");
    const update = Y.encodeStateAsUpdate(scratch);
    room.handleMessage(senderWs, encodeSyncUpdate("docA", update));

    expect(sentByReceiver.length).toBeGreaterThan(0);
    const { type, docId } = decodeEnvelope(sentByReceiver[sentByReceiver.length - 1]!);
    expect(type).toBe(MESSAGE_SYNC);
    expect(docId).toBe("docA");
  });

  it("keeps two documents' content independent within the same room", () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const fakeWs = {} as WebSocket;
    room.sessions.set(fakeWs, { username: "alice", role: "editor", viewingDocId: null });

    const scratchA = new Y.Doc();
    scratchA.getText("content").insert(0, "A content");
    const scratchB = new Y.Doc();
    scratchB.getText("content").insert(0, "B content");

    room.handleMessage(fakeWs, encodeSyncUpdate("docA", Y.encodeStateAsUpdate(scratchA)));
    room.handleMessage(fakeWs, encodeSyncUpdate("docB", Y.encodeStateAsUpdate(scratchB)));

    expect(room.docs.get("docA")?.doc.getText("content").toString()).toBe("A content");
    expect(room.docs.get("docB")?.doc.getText("content").toString()).toBe("B content");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- workspace-room.test.ts`
Expected: FAIL — `Cannot find module './workspace-room'`.

- [ ] **Step 3: Create `src/workspace-room.ts`**

```typescript
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { getCookie, decryptSession, SESSION_COOKIE } from "./auth.js";
import { relocateAnchor } from "./anchor";
import type { Env } from "./env";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// Workspace-wide "which document am I currently looking at" signal —
// separate from MESSAGE_AWARENESS because each document keeps its own
// independent y-protocols Awareness instance (needed for correct
// per-document cursor/selection sync, same as CollabRoom today); this
// message type is the thing that lets the doc list show "who's on which
// file" across the whole workspace instead of just within one open doc.
const MESSAGE_PRESENCE = 2;

const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

const PERSIST_DELAY_MS = 1000;

export interface Snapshot {
  id: string;
  timestamp: number;
  content: string;
}

export interface CommentReply {
  id: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface CommentThread {
  id: string;
  from: number;
  to: number;
  quote: string;
  orphaned: boolean;
  resolved: boolean;
  comments: CommentReply[];
}

export type Role = "viewer" | "reviewer" | "editor";

export interface InvitedPerson {
  username: string;
  role: Role;
}

export interface AccessRecord {
  owner: string | null;
  generalAccess: "restricted" | "anyone";
  requireAccount: boolean;
  role: Role;
  invited: InvitedPerson[];
}

export const DEFAULT_ACCESS: AccessRecord = { owner: null, generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] };

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// One entry per document currently in the workspace — same per-document
// state CollabRoom held at the top level of one DO instance, now nested
// one level so a single WorkspaceRoom instance can hold several.
export interface DocRoom {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  snapshots: Snapshot[];
  lastSnapshotAt: number | undefined;
  commentThreads: CommentThread[];
  persistScheduled: boolean;
}

interface SessionInfo {
  username: string | null;
  role: Role;
  // Which document this connection currently has open, for cross-file
  // presence — null until the client sends its first MESSAGE_PRESENCE.
  viewingDocId: string | null;
}

function docStorageKey(docId: string, suffix: "update" | "snapshots" | "comments"): string {
  return `doc:${docId}:${suffix}`;
}

// One WorkspaceRoom instance == one shared workspace, addressed by the
// workspace's own client-generated id. Replaces CollabRoom for anything
// inside a shared workspace — every document in the workspace lives in
// this same DO instance instead of getting one of its own, so the whole
// workspace can be live-synced over a single WebSocket connection.
export class WorkspaceRoom {
  state: DurableObjectState;
  env: Env;
  sessions: Map<WebSocket, SessionInfo>;
  docs: Map<string, DocRoom>;
  docIds: string[];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.docs = new Map();
    this.docIds = [];

    this.state.blockConcurrencyWhile(async () => {
      const storedDocIds = await this.state.storage.get<string[]>("docs");
      this.docIds = storedDocIds || [];
      for (const docId of this.docIds) {
        await this.loadDocRoom(docId);
      }
    });
  }

  async loadDocRoom(docId: string): Promise<DocRoom> {
    const existing = this.docs.get(docId);
    if (existing) return existing;

    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    const stored = await this.state.storage.get<ArrayBuffer>(docStorageKey(docId, "update"));
    if (stored) Y.applyUpdate(doc, new Uint8Array(stored), "storage");
    const storedComments = await this.state.storage.get<CommentThread[]>(docStorageKey(docId, "comments"));

    const docRoom: DocRoom = {
      doc,
      awareness,
      snapshots: [],
      lastSnapshotAt: undefined,
      commentThreads: storedComments || [],
      persistScheduled: false,
    };
    doc.on("update", (update: Uint8Array, origin: unknown) => this.handleDocUpdate(docId, docRoom, update, origin));
    awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) =>
        this.handleAwarenessUpdate(docId, docRoom, added, updated, removed, origin)
    );
    this.docs.set(docId, docRoom);
    return docRoom;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.handleSession(server, auth.username, auth.role);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Placeholder until Task 3 replaces it — every connection is treated as
  // an editor with no identity check, so this task's sync/awareness
  // plumbing can be built and tested in isolation from access control.
  async authorize(_request: Request): Promise<{ ok: true; username: string | null; role: Role }> {
    return { ok: true, username: null, role: "editor" };
  }

  // ---------- WebSocket session ----------

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

    ws.addEventListener("message", (event: MessageEvent) => this.handleMessage(ws, event.data));
    ws.addEventListener("close", () => this.handleClose(ws));
    ws.addEventListener("error", () => this.handleClose(ws));
  }

  handleMessage(ws: WebSocket, data: unknown): void {
    if (typeof data === "string") return;
    const session = this.sessions.get(ws);
    const decoder = decoding.createDecoder(new Uint8Array(data as ArrayBuffer));
    const messageType = decoding.readVarUint(decoder);

    if (messageType === MESSAGE_PRESENCE) {
      const viewingDocId = decoding.readVarString(decoder);
      if (session) session.viewingDocId = viewingDocId || null;
      this.broadcastPresence(ws, session);
      return;
    }

    const docId = decoding.readVarString(decoder);

    if (messageType === MESSAGE_SYNC) {
      const savedPos = decoder.pos;
      const syncType = decoding.readVarUint(decoder);
      decoder.pos = savedPos;

      const isWrite = syncType === SYNC_STEP2 || syncType === SYNC_UPDATE;
      if (isWrite && session && session.role !== "editor") return; // read-only: drop silently

      void this.withDocRoom(docId, (docRoom) => {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        encoding.writeVarString(encoder, docId);
        syncProtocol.readSyncMessage(decoder, encoder, docRoom.doc, ws);
        if (encoding.length(encoder) > 2) ws.send(encoding.toUint8Array(encoder));
      });
    } else if (messageType === MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      void this.withDocRoom(docId, (docRoom) => {
        awarenessProtocol.applyAwarenessUpdate(docRoom.awareness, update, ws);
      });
    }
  }

  // Sync/awareness messages can legitimately arrive for a docId this
  // in-memory instance hasn't loaded yet (e.g. right after a cold start
  // that only just finished replaying `docIds` — loadDocRoom itself is
  // idempotent, so this is safe to call unconditionally).
  async withDocRoom(docId: string, fn: (docRoom: DocRoom) => void): Promise<void> {
    if (!this.docIds.includes(docId)) return; // not a member of this workspace
    const docRoom = await this.loadDocRoom(docId);
    fn(docRoom);
  }

  broadcastPresence(exceptWs: WebSocket, session: SessionInfo | undefined): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_PRESENCE);
    encoding.writeVarString(encoder, session?.username || "");
    encoding.writeVarString(encoder, session?.viewingDocId || "");
    const message = encoding.toUint8Array(encoder);
    for (const ws of this.sessions.keys()) {
      if (ws === exceptWs) continue;
      try {
        ws.send(message);
      } catch (err) {
        this.sessions.delete(ws);
      }
    }
  }

  handleClose(ws: WebSocket): void {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    for (const docRoom of this.docs.values()) {
      // Awareness client ids are scoped to each doc's own Y.Doc/Awareness
      // pair, not tracked per-session here (see CollabRoom's awarenessIds
      // for the pattern this simplifies away) — a closed socket simply
      // stops sending updates for any doc, and yCollab's own client-side
      // awareness timeout (unchanged from today) clears stale remote
      // cursors independently of this server-side cleanup.
      void docRoom;
    }
    if (session) this.broadcastPresence(ws, { ...session, viewingDocId: null, username: session.username });
    if (this.sessions.size === 0) this.persistAllNow();
  }

  handleDocUpdate(docId: string, docRoom: DocRoom, update: Uint8Array, origin: unknown): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarString(encoder, docId);
    syncProtocol.writeUpdate(encoder, update);
    this.broadcast(encoding.toUint8Array(encoder), origin);
    if (origin === "storage") return;
    this.schedulePersist(docId, docRoom);
  }

  handleAwarenessUpdate(docId: string, docRoom: DocRoom, added: number[], updated: number[], removed: number[], origin: unknown): void {
    const changed = added.concat(updated, removed);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarString(encoder, docId);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(docRoom.awareness, changed));
    this.broadcast(encoding.toUint8Array(encoder), origin);
  }

  broadcast(message: Uint8Array, exceptWs: unknown): void {
    for (const ws of this.sessions.keys()) {
      if (ws === exceptWs) continue;
      try {
        ws.send(message);
      } catch (err) {
        this.sessions.delete(ws);
      }
    }
  }

  async schedulePersist(docId: string, docRoom: DocRoom): Promise<void> {
    if (docRoom.persistScheduled) return;
    docRoom.persistScheduled = true;
    await this.state.storage.setAlarm(Date.now() + PERSIST_DELAY_MS);
  }

  async alarm(): Promise<void> {
    await this.persistAllNow();
  }

  async persistAllNow(): Promise<void> {
    for (const [docId, docRoom] of this.docs.entries()) {
      if (!docRoom.persistScheduled && this.sessions.size > 0) continue;
      docRoom.persistScheduled = false;
      await this.state.storage.put(docStorageKey(docId, "update"), Y.encodeStateAsUpdate(docRoom.doc));
    }
  }
}
```

Note: `relocateAnchor` and comment/snapshot logic are imported/used starting in Tasks 4-5 — the `relocateAnchor` import above is unused until then; remove it from this task's imports if `tsc`/lint flags unused imports (check `npx tsc --noEmit` output in Step 5 below — if it errors on unused import, delete that one line; the module exists and Task 5 re-adds it).

- [ ] **Step 4: Export `WorkspaceRoom` from the worker entrypoint**

In `src/worker.ts`, change the first line from:

```typescript
export { CollabRoom } from "./collab-room.js";
```

to:

```typescript
export { CollabRoom } from "./collab-room.js";
export { WorkspaceRoom } from "./workspace-room.js";
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -- workspace-room.test.ts`
Expected: PASS, all 3 tests.

Run: `npx tsc --noEmit -p tsconfig.json` (or the repo's root TS config used for `src/` — check `package.json`'s existing typecheck script if one differs from this)
Expected: no errors. If `relocateAnchor` is reported unused, remove that import line from `src/workspace-room.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/workspace-room.ts src/workspace-room.test.ts src/env.ts src/worker.ts wrangler.jsonc
git commit -m "feat: add WorkspaceRoom DO with multiplexed sync/awareness protocol"
```

---

## Task 3: `WorkspaceRoom` access control

**Files:**
- Modify: `src/workspace-room.ts`
- Test: `src/workspace-room.test.ts`

**Interfaces:**
- Consumes: `WorkspaceRoom` from Task 2, `AccessRecord`/`Role`/`DEFAULT_ACCESS` types already defined in Task 2's file.
- Produces: `authorize(request)` (real implementation, replaces Task 2's placeholder), `getAccess()`, `handleAccessRequest(request)` — consumed by Task 7 (worker.ts routing) and by the client (Task 9).

This ports `CollabRoom.authorize`/`getAccess`/`handleAccessRequest` (`src/collab-room.ts:313-407`) near-verbatim, reading/writing a single workspace-wide `access` storage key instead of a per-document one.

- [ ] **Step 1: Write failing tests**

Add to `src/workspace-room.test.ts` (new `describe` block, reuse `fakeState`/`fakeEnv` from Task 2's file — import `encryptSession` from `./auth` and construct sessioned requests the same way `src/collab-room.test.ts` does):

```typescript
import { encryptSession } from "./auth";

const fakeEnvWithSecret = { SESSION_SECRET: "test-secret-key-not-real" } as unknown as Env;

async function sessionRequest(username: string | null): Promise<Request> {
  if (username === null) return new Request("https://example.com/w/ws1");
  const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username });
  return new Request("https://example.com/w/ws1", { headers: { Cookie: `mde_gh_session=${cookie}` } });
}

describe("WorkspaceRoom.authorize", () => {
  it("rejects when the workspace has never been shared (no owner set)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const result = await room.authorize(await sessionRequest(null));
    expect(result.ok).toBe(false);
  });

  it("grants the owner editor access regardless of general access", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const result = await room.authorize(await sessionRequest("alice"));
    expect(result).toEqual({ ok: true, username: "alice", role: "editor" });
  });

  it("grants an invited person their assigned role", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", {
      owner: "alice",
      generalAccess: "restricted",
      requireAccount: false,
      role: "viewer",
      invited: [{ username: "bob", role: "reviewer" }],
    });
    const result = await room.authorize(await sessionRequest("bob"));
    expect(result).toEqual({ ok: true, username: "bob", role: "reviewer" });
  });

  it("rejects a signed-in stranger on a restricted workspace", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const result = await room.authorize(await sessionRequest("carol"));
    expect(result.ok).toBe(false);
  });

  it("grants anonymous visitors the general-access role on a public link", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    const result = await room.authorize(await sessionRequest(null));
    expect(result).toEqual({ ok: true, username: null, role: "viewer" });
  });
});

describe("WorkspaceRoom.handleAccessRequest", () => {
  it("lets the owner update general access via PUT", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/access", {
      method: "PUT",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] }),
    });
    const res = await room.handleAccessRequest(request);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generalAccess).toBe("anyone");
  });

  it("rejects a non-owner's attempt to change access", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "mallory" });
    const request = new Request("https://example.com/w/ws1/access", {
      method: "PUT",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] }),
    });
    const res = await room.handleAccessRequest(request);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- workspace-room.test.ts`
Expected: FAIL — `room.handleAccessRequest is not a function`, and the placeholder `authorize` always returns `ok: true`.

- [ ] **Step 3: Implement `getAccess`, real `authorize`, and `handleAccessRequest`**

In `src/workspace-room.ts`, delete the Task 2 placeholder:

```typescript
  // Placeholder until Task 3 replaces it — every connection is treated as
  // an editor with no identity check, so this task's sync/awareness
  // plumbing can be built and tested in isolation from access control.
  async authorize(_request: Request): Promise<{ ok: true; username: string | null; role: Role }> {
    return { ok: true, username: null, role: "editor" };
  }
```

and replace it with (insert near the `fetch` method — this is a direct port of `CollabRoom`'s `getAccess`/`getSession`/`authorize`/`handleAccessRequest`, `src/collab-room.ts:313-407`, reading the workspace-wide `access` key instead of a per-doc one):

```typescript
  // ---------- Access control ----------

  async getAccess(): Promise<AccessRecord> {
    const stored = await this.state.storage.get<Record<string, unknown>>("access");
    if (!stored) return { ...DEFAULT_ACCESS };
    const rawInvited = Array.isArray(stored.invited) ? stored.invited : [];
    const invited: InvitedPerson[] = rawInvited.map((entry) =>
      typeof entry === "string" ? { username: entry, role: "editor" } : (entry as InvitedPerson)
    );
    return { ...DEFAULT_ACCESS, ...stored, invited } as AccessRecord;
  }

  async getSession(request: Request) {
    const cookie = getCookie(request, SESSION_COOKIE);
    if (!cookie) return null;
    return decryptSession(this.env, cookie);
  }

  async authorize(request: Request): Promise<{ ok: true; username: string | null; role: Role } | { ok: false; status: number; message: string }> {
    const session = await this.getSession(request);
    const access = await this.getAccess();
    if (!access.owner) {
      return { ok: false, status: 403, message: "This workspace hasn't been shared." };
    }
    if (session && session.username === access.owner) {
      return { ok: true, username: session.username, role: "editor" };
    }
    if (access.generalAccess === "anyone") {
      if (access.requireAccount && (!session || !session.username)) {
        return { ok: false, status: 401, message: "Sign in with GitHub to join this workspace." };
      }
      return { ok: true, username: session ? session.username : null, role: access.role };
    }
    if (!session || !session.username) {
      return { ok: false, status: 401, message: "Sign in with GitHub to join this workspace." };
    }
    const invited = access.invited.find((p) => p.username === session.username);
    if (invited) {
      return { ok: true, username: session.username, role: invited.role };
    }
    return { ok: false, status: 403, message: "You don't have access to this workspace." };
  }

  async handleAccessRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const access = await this.getAccess();
      return Response.json(access);
    }
    if (request.method === "PUT") {
      let body: { generalAccess?: unknown; requireAccount?: unknown; role?: unknown; invited?: unknown };
      try {
        body = await request.json();
      } catch (err) {
        return new Response("Invalid JSON.", { status: 400 });
      }

      const session = await this.getSession(request);
      if (!session || !session.username) return new Response("Sign in with GitHub first.", { status: 401 });

      const access = await this.getAccess();
      if (access.owner && access.owner !== session.username) {
        return new Response("Only the owner can change access.", { status: 403 });
      }

      const next: AccessRecord = {
        owner: access.owner || session.username,
        generalAccess: body.generalAccess === "anyone" ? "anyone" : "restricted",
        requireAccount: body.requireAccount === true,
        role: (["viewer", "reviewer", "editor"] as const).includes(body.role as Role) ? (body.role as Role) : "viewer",
        invited: Array.isArray(body.invited) ? normalizeInvited(body.invited) : access.invited,
      };
      await this.state.storage.put("access", next);
      return Response.json(next);
    }
    return new Response("Method not allowed", { status: 405 });
  }
```

Also add, near the top of the file alongside the other module-level helpers (port of `src/collab-room.ts:93-106`, unchanged):

```typescript
export function normalizeInvited(raw: unknown[]): InvitedPerson[] {
  const seen = new Set<string>();
  const result: InvitedPerson[] = [];
  for (const entry of raw) {
    const username = typeof entry === "string" ? entry.trim() : String((entry as any)?.username || "").trim();
    if (!username || seen.has(username)) continue;
    const rawRole = typeof entry === "string" ? "editor" : (entry as any)?.role;
    const role: Role = (["viewer", "reviewer", "editor"] as const).includes(rawRole) ? rawRole : "editor";
    seen.add(username);
    result.push({ username, role });
    if (result.length >= 100) break;
  }
  return result;
}
```

And route `/access` requests to it in `fetch`, replacing:

```typescript
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
```

with:

```typescript
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/access")) return this.handleAccessRequest(request);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- workspace-room.test.ts`
Expected: PASS, all tests from Tasks 2 and 3.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

```bash
git add src/workspace-room.ts src/workspace-room.test.ts
git commit -m "feat: add access control to WorkspaceRoom"
```

---

## Task 4: `WorkspaceRoom` version snapshots (per document)

**Files:**
- Modify: `src/workspace-room.ts`
- Test: `src/workspace-room.test.ts`

**Interfaces:**
- Consumes: `DocRoom` (Task 2), `withDocRoom` helper (Task 2).
- Produces: `getSnapshots(docId)`, `maybeSnapshot(docId, docRoom, now?)`, `forceSnapshot(docId, docRoom, content, now?)`, HTTP handlers for `/docs/<docId>/versions[/…]` — routed in Task 7.

Ports `CollabRoom`'s snapshot logic (`src/collab-room.ts:24-26, 194-231, 525-562`), storing each document's snapshots under `doc:<docId>:snapshots` instead of a DO-wide key, and keeping `lastSnapshotAt` on the `DocRoom` object (already declared in Task 2) instead of the DO instance.

- [ ] **Step 1: Write failing tests**

Add to `src/workspace-room.test.ts`:

```typescript
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

describe("WorkspaceRoom version snapshots", () => {
  it("takes an initial snapshot on the first check", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.transact(() => docRoom.doc.getText("content").insert(0, "v1"), "storage");
    await room.maybeSnapshot("docA", docRoom, 1000);
    const snapshots = await room.getSnapshots("docA");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.content).toBe("v1");
  });

  it("throttles snapshots within the interval", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.transact(() => docRoom.doc.getText("content").insert(0, "v1"), "storage");
    await room.maybeSnapshot("docA", docRoom, 1000);
    docRoom.doc.transact(() => docRoom.doc.getText("content").insert(2, "v2"), "storage");
    await room.maybeSnapshot("docA", docRoom, 1000 + SNAPSHOT_INTERVAL_MS - 1);
    expect(await room.getSnapshots("docA")).toHaveLength(1);
  });

  it("keeps docA's and docB's snapshots independent", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const docA = await room.loadDocRoom("docA");
    const docB = await room.loadDocRoom("docB");
    docA.doc.transact(() => docA.doc.getText("content").insert(0, "A"), "storage");
    docB.doc.transact(() => docB.doc.getText("content").insert(0, "B"), "storage");
    await room.maybeSnapshot("docA", docA, 1000);
    await room.maybeSnapshot("docB", docB, 1000);
    expect((await room.getSnapshots("docA"))[0]!.content).toBe("A");
    expect((await room.getSnapshots("docB"))[0]!.content).toBe("B");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- workspace-room.test.ts`
Expected: FAIL — `room.maybeSnapshot is not a function`.

- [ ] **Step 3: Implement snapshot methods and HTTP handlers**

In `src/workspace-room.ts`, add near the bottom of the class (port of `src/collab-room.ts:196-231, 525-562`):

```typescript
  // ---------- Version snapshots ----------

  async getSnapshots(docId: string): Promise<Snapshot[]> {
    const stored = await this.state.storage.get<Snapshot[]>(docStorageKey(docId, "snapshots"));
    return stored || [];
  }

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
    snapshots.push({ id: uid(), timestamp: now, content });
    while (snapshots.length > 50) snapshots.shift();
    await this.state.storage.put(docStorageKey(docId, "snapshots"), snapshots);
    docRoom.lastSnapshotAt = now;
  }

  async forceSnapshot(docId: string, docRoom: DocRoom, content: string, now: number = Date.now()): Promise<Snapshot> {
    const snapshots = await this.getSnapshots(docId);
    const snap: Snapshot = { id: uid(), timestamp: now, content };
    snapshots.push(snap);
    while (snapshots.length > 50) snapshots.shift();
    await this.state.storage.put(docStorageKey(docId, "snapshots"), snapshots);
    docRoom.lastSnapshotAt = now;
    return snap;
  }

  async handleVersionsListRequest(request: Request, docId: string): Promise<Response> {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    const snapshots = await this.getSnapshots(docId);
    const list = snapshots.map((s) => ({ id: s.id, timestamp: s.timestamp })).reverse();
    return Response.json(list);
  }

  async handleVersionContentRequest(request: Request, docId: string, versionId: string): Promise<Response> {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    const snapshots = await this.getSnapshots(docId);
    const snap = snapshots.find((s) => s.id === versionId);
    if (!snap) return new Response("Version not found.", { status: 404 });
    return Response.json(snap);
  }

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
    }, "restore");
    const created = await this.forceSnapshot(docId, docRoom, snap.content);
    return Response.json(created);
  }
```

Update `handleDocUpdate` (from Task 2) to call `maybeSnapshot`, changing:

```typescript
  handleDocUpdate(docId: string, docRoom: DocRoom, update: Uint8Array, origin: unknown): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarString(encoder, docId);
    syncProtocol.writeUpdate(encoder, update);
    this.broadcast(encoding.toUint8Array(encoder), origin);
    if (origin === "storage") return;
    this.schedulePersist(docId, docRoom);
  }
```

to:

```typescript
  handleDocUpdate(docId: string, docRoom: DocRoom, update: Uint8Array, origin: unknown): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarString(encoder, docId);
    syncProtocol.writeUpdate(encoder, update);
    this.broadcast(encoding.toUint8Array(encoder), origin);
    if (origin === "storage") return;
    this.schedulePersist(docId, docRoom);
    if (origin !== "restore") void this.maybeSnapshot(docId, docRoom);
  }
```

Wire the three new handlers into `fetch` (add above the `/access` check):

```typescript
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/access")) return this.handleAccessRequest(request);

    const restoreMatch = url.pathname.match(/\/docs\/([^/]+)\/versions\/([^/]+)\/restore$/);
    if (restoreMatch) return this.handleVersionRestoreRequest(request, restoreMatch[1]!, restoreMatch[2]!);
    const versionMatch = url.pathname.match(/\/docs\/([^/]+)\/versions\/([^/]+)$/);
    if (versionMatch) return this.handleVersionContentRequest(request, versionMatch[1]!, versionMatch[2]!);
    const versionsListMatch = url.pathname.match(/\/docs\/([^/]+)\/versions$/);
    if (versionsListMatch) return this.handleVersionsListRequest(request, versionsListMatch[1]!);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- workspace-room.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

```bash
git add src/workspace-room.ts src/workspace-room.test.ts
git commit -m "feat: add per-document version snapshots to WorkspaceRoom"
```

---

## Task 5: `WorkspaceRoom` comment threads (per document)

**Files:**
- Modify: `src/workspace-room.ts`
- Test: `src/workspace-room.test.ts`

**Interfaces:**
- Consumes: `DocRoom.commentThreads` (Task 2), `docStorageKey` (Task 2).
- Produces: `getComments(docId)`, `createThread`/`addReply`/`resolveThread`/`deleteThread`/`refreshCommentAnchors` (all docId-scoped), HTTP handlers for `/docs/<docId>/comments[/…]` — routed in Task 7.

Ports `CollabRoom`'s comment-thread logic (`src/collab-room.ts:233-310, 564-622`) near-verbatim, storing under `doc:<docId>:comments` and keeping `commentThreads` on the `DocRoom` (already declared in Task 2).

- [ ] **Step 1: Write failing tests**

Add to `src/workspace-room.test.ts`:

```typescript
describe("WorkspaceRoom comment threads", () => {
  it("creates a thread and persists it under the doc's own storage key", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const docRoom = await room.loadDocRoom("docA");
    room.createThread("docA", docRoom, 0, 5, "hello", "alice", "nice edit");
    await room.persistComments("docA", docRoom);
    const stored = await room.state.storage.get("doc:docA:comments");
    expect(stored).toHaveLength(1);
  });

  it("keeps docA's and docB's threads independent", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const docA = await room.loadDocRoom("docA");
    const docB = await room.loadDocRoom("docB");
    room.createThread("docA", docA, 0, 5, "a", "alice", "on A");
    expect(room.getComments("docB")).toHaveLength(0);
    expect(room.getComments("docA")).toHaveLength(1);
  });

  it("only the thread's author or the workspace owner can delete it", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const docRoom = await room.loadDocRoom("docA");
    const thread = room.createThread("docA", docRoom, 0, 5, "a", "alice", "note");
    expect(room.deleteThread(docRoom, thread.id, "bob", false)).toBe("forbidden");
    expect(room.deleteThread(docRoom, thread.id, "alice", false)).toBe("deleted");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- workspace-room.test.ts`
Expected: FAIL — `room.createThread is not a function`.

- [ ] **Step 3: Implement comment methods and HTTP handlers**

Add the `relocateAnchor` import back if it was removed in Task 2:

```typescript
import { relocateAnchor } from "./anchor";
```

Add near the bottom of the class (port of `src/collab-room.ts:564-622`, `docId`/`docRoom` now explicit parameters instead of `this`):

```typescript
  // ---------- Comment threads ----------

  getComments(docId: string): CommentThread[] {
    return this.docs.get(docId)?.commentThreads || [];
  }

  async persistComments(docId: string, docRoom: DocRoom): Promise<void> {
    await this.state.storage.put(docStorageKey(docId, "comments"), docRoom.commentThreads);
  }

  createThread(docId: string, docRoom: DocRoom, from: number, to: number, quote: string, author: string, body: string, now: number = Date.now()): CommentThread {
    const thread: CommentThread = {
      id: uid(),
      from,
      to,
      quote,
      orphaned: false,
      resolved: false,
      comments: [{ id: uid(), author, body, createdAt: now }],
    };
    docRoom.commentThreads = [...docRoom.commentThreads, thread];
    return thread;
  }

  addReply(docRoom: DocRoom, threadId: string, author: string, body: string, now: number = Date.now()): CommentThread | null {
    const thread = docRoom.commentThreads.find((t) => t.id === threadId);
    if (!thread) return null;
    thread.comments = [...thread.comments, { id: uid(), author, body, createdAt: now }];
    return thread;
  }

  resolveThread(docRoom: DocRoom, threadId: string, resolved: boolean): CommentThread | null {
    const thread = docRoom.commentThreads.find((t) => t.id === threadId);
    if (!thread) return null;
    thread.resolved = resolved;
    return thread;
  }

  deleteThread(docRoom: DocRoom, threadId: string, username: string | null, isOwner: boolean): "deleted" | "not_found" | "forbidden" {
    const thread = docRoom.commentThreads.find((t) => t.id === threadId);
    if (!thread) return "not_found";
    const startedBy = thread.comments[0]?.author;
    if (!isOwner && startedBy !== username) return "forbidden";
    docRoom.commentThreads = docRoom.commentThreads.filter((t) => t.id !== threadId);
    return "deleted";
  }

  refreshCommentAnchors(docRoom: DocRoom, content: string): void {
    docRoom.commentThreads = docRoom.commentThreads.map((t) => {
      const relocated = relocateAnchor(content, t);
      if (!relocated) return { ...t, orphaned: true };
      return { ...t, from: relocated.from, to: relocated.to, orphaned: false };
    });
  }

  async handleCommentsRequest(request: Request, docId: string): Promise<Response> {
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    const docRoom = await this.loadDocRoom(docId);
    if (request.method === "GET") return Response.json(this.getComments(docId));
    if (request.method === "POST") {
      if (auth.role === "viewer") return new Response("Viewers can't comment.", { status: 403 });
      let body: { from?: unknown; to?: unknown; quote?: unknown; body?: unknown };
      try {
        body = await request.json();
      } catch (err) {
        return new Response("Invalid JSON.", { status: 400 });
      }
      if (typeof body.from !== "number" || typeof body.to !== "number" || typeof body.quote !== "string" || typeof body.body !== "string" || !body.body.trim()) {
        return new Response("Invalid comment.", { status: 400 });
      }
      const thread = this.createThread(docId, docRoom, body.from, body.to, body.quote, auth.username || "Anonymous", body.body);
      await this.persistComments(docId, docRoom);
      return Response.json(thread);
    }
    return new Response("Method not allowed", { status: 405 });
  }

  async handleCommentReplyRequest(request: Request, docId: string, threadId: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    if (auth.role === "viewer") return new Response("Viewers can't comment.", { status: 403 });
    let body: { body?: unknown };
    try {
      body = await request.json();
    } catch (err) {
      return new Response("Invalid JSON.", { status: 400 });
    }
    if (typeof body.body !== "string" || !body.body.trim()) return new Response("Invalid reply.", { status: 400 });
    const docRoom = await this.loadDocRoom(docId);
    const thread = this.addReply(docRoom, threadId, auth.username || "Anonymous", body.body);
    if (!thread) return new Response("Thread not found.", { status: 404 });
    await this.persistComments(docId, docRoom);
    return Response.json(thread);
  }

  async handleCommentResolveRequest(request: Request, docId: string, threadId: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    if (auth.role === "viewer") return new Response("Viewers can't resolve comments.", { status: 403 });
    let body: { resolved?: unknown };
    try {
      body = await request.json();
    } catch (err) {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const docRoom = await this.loadDocRoom(docId);
    const thread = this.resolveThread(docRoom, threadId, body.resolved !== false);
    if (!thread) return new Response("Thread not found.", { status: 404 });
    await this.persistComments(docId, docRoom);
    return Response.json(thread);
  }

  async handleCommentDeleteRequest(request: Request, docId: string, threadId: string): Promise<Response> {
    if (request.method !== "DELETE") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    const access = await this.getAccess();
    const isOwner = auth.username !== null && auth.username === access.owner;
    const docRoom = await this.loadDocRoom(docId);
    const result = this.deleteThread(docRoom, threadId, auth.username, isOwner);
    if (result === "not_found") return new Response("Thread not found.", { status: 404 });
    if (result === "forbidden") return new Response("Only the thread's author or the workspace owner can delete it.", { status: 403 });
    await this.persistComments(docId, docRoom);
    return new Response(null, { status: 204 });
  }
```

Wire comment routes into `fetch`, and have `handleDocUpdate` refresh anchors (matching `CollabRoom.handleDocUpdate`'s `refreshCommentAnchors` call, `src/collab-room.ts:477`). Update `handleDocUpdate` again:

```typescript
  handleDocUpdate(docId: string, docRoom: DocRoom, update: Uint8Array, origin: unknown): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarString(encoder, docId);
    syncProtocol.writeUpdate(encoder, update);
    this.broadcast(encoding.toUint8Array(encoder), origin);
    if (origin === "storage") return;
    this.refreshCommentAnchors(docRoom, docRoom.doc.getText("content").toString());
    this.schedulePersist(docId, docRoom);
    if (origin !== "restore") void this.maybeSnapshot(docId, docRoom);
  }
```

Add to `fetch` (above the versions routes added in Task 4):

```typescript
    const replyMatch = url.pathname.match(/\/docs\/([^/]+)\/comments\/([^/]+)\/reply$/);
    if (replyMatch) return this.handleCommentReplyRequest(request, replyMatch[1]!, replyMatch[2]!);
    const resolveMatch = url.pathname.match(/\/docs\/([^/]+)\/comments\/([^/]+)\/resolve$/);
    if (resolveMatch) return this.handleCommentResolveRequest(request, resolveMatch[1]!, resolveMatch[2]!);
    const commentIdMatch = url.pathname.match(/\/docs\/([^/]+)\/comments\/([^/]+)$/);
    if (commentIdMatch) return this.handleCommentDeleteRequest(request, commentIdMatch[1]!, commentIdMatch[2]!);
    const commentsMatch = url.pathname.match(/\/docs\/([^/]+)\/comments$/);
    if (commentsMatch) return this.handleCommentsRequest(request, commentsMatch[1]!);
```

Also persist comments on the periodic checkpoint — update `persistAllNow` (from Task 2) to call `persistComments` alongside the Yjs state write:

```typescript
  async persistAllNow(): Promise<void> {
    for (const [docId, docRoom] of this.docs.entries()) {
      if (!docRoom.persistScheduled && this.sessions.size > 0) continue;
      docRoom.persistScheduled = false;
      await this.state.storage.put(docStorageKey(docId, "update"), Y.encodeStateAsUpdate(docRoom.doc));
      await this.persistComments(docId, docRoom);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- workspace-room.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

```bash
git add src/workspace-room.ts src/workspace-room.test.ts
git commit -m "feat: add per-document comment threads to WorkspaceRoom"
```

---

## Task 6: `WorkspaceRoom` document membership (add/remove)

**Files:**
- Modify: `src/workspace-room.ts`
- Test: `src/workspace-room.test.ts`

**Interfaces:**
- Consumes: `docIds`, `loadDocRoom` (Task 2).
- Produces: `handleDocsRequest(request)` (GET list / POST add / DELETE remove), routed at `/docs` in `fetch` — consumed by Task 7 (worker.ts) and Task 9-10 (client: seeding a freshly-created `WorkspaceRoom` with its first document, adding more later).

- [ ] **Step 1: Write failing tests**

Add to `src/workspace-room.test.ts`:

```typescript
describe("WorkspaceRoom document membership", () => {
  it("adding a doc makes it appear in the docs list and loadable", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ docId: "docA" }),
    });
    const res = await room.handleDocsRequest(request);
    expect(res.status).toBe(200);
    expect(room.docIds).toContain("docA");
  });

  it("a viewer can't add a document", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    const request = new Request("https://example.com/w/ws1/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docId: "docA" }),
    });
    const res = await room.handleDocsRequest(request);
    expect(res.status).toBe(403);
    expect(room.docIds).not.toContain("docA");
  });

  it("removing a doc drops it from the docs list", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    await room.state.storage.put("docs", ["docA", "docB"]);
    room.docIds = ["docA", "docB"];
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs?docId=docA", {
      method: "DELETE",
      headers: { Cookie: `mde_gh_session=${cookie}` },
    });
    const res = await room.handleDocsRequest(request);
    expect(res.status).toBe(204);
    expect(room.docIds).toEqual(["docB"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- workspace-room.test.ts`
Expected: FAIL — `room.handleDocsRequest is not a function`.

- [ ] **Step 3: Implement `handleDocsRequest`**

Add to `src/workspace-room.ts`:

```typescript
  // ---------- Document membership ----------

  async handleDocsRequest(request: Request): Promise<Response> {
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });

    if (request.method === "GET") return Response.json(this.docIds);

    if (request.method === "POST") {
      if (auth.role !== "editor") return new Response("Only an editor can add a document.", { status: 403 });
      let body: { docId?: unknown };
      try {
        body = await request.json();
      } catch (err) {
        return new Response("Invalid JSON.", { status: 400 });
      }
      if (typeof body.docId !== "string" || !body.docId) return new Response("Invalid docId.", { status: 400 });
      if (!this.docIds.includes(body.docId)) {
        this.docIds = [...this.docIds, body.docId];
        await this.state.storage.put("docs", this.docIds);
        await this.loadDocRoom(body.docId);
      }
      return Response.json(this.docIds);
    }

    if (request.method === "DELETE") {
      if (auth.role !== "editor") return new Response("Only an editor can remove a document.", { status: 403 });
      const docId = new URL(request.url).searchParams.get("docId");
      if (!docId) return new Response("Missing docId.", { status: 400 });
      this.docIds = this.docIds.filter((id) => id !== docId);
      await this.state.storage.put("docs", this.docIds);
      this.docs.delete(docId);
      return new Response(null, { status: 204 });
    }

    return new Response("Method not allowed", { status: 405 });
  }
```

Route it in `fetch`, adding above the version routes:

```typescript
    if (url.pathname.endsWith("/docs")) return this.handleDocsRequest(request);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- workspace-room.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

```bash
git add src/workspace-room.ts src/workspace-room.test.ts
git commit -m "feat: add document membership management to WorkspaceRoom"
```

---

## Task 7: `worker.ts` routing for `/api/workspace/...`

**Files:**
- Modify: `src/worker.ts`
- Test: none new (covered by Tasks 2-6's `WorkspaceRoom` tests directly; routing itself is thin enough that the existing `CollabRoom` routing in this file has no dedicated test either)

**Interfaces:**
- Consumes: `env.WORKSPACE_ROOM` (Task 2).
- Produces: live HTTP/WebSocket routes at `/api/workspace/<id>`, `/api/workspace/<id>/access`, `/api/workspace/<id>/docs`, `/api/workspace/<id>/docs/<docId>/versions[...]`, `/api/workspace/<id>/docs/<docId>/comments[...]` — consumed by the client starting Task 9.

- [ ] **Step 1: Add the new route regexes and dispatch, mirroring the existing `ROOM_*` pattern**

In `src/worker.ts`, add alongside the existing `ROOM_*` constants:

```typescript
const WORKSPACE_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})$/;
const WORKSPACE_ACCESS_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/access$/;
const WORKSPACE_DOCS_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/docs$/;
const WORKSPACE_DOC_VERSIONS_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/docs\/([A-Za-z0-9_-]{1,128})\/versions(\/.*)?$/;
const WORKSPACE_DOC_COMMENTS_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/docs\/([A-Za-z0-9_-]{1,128})\/comments(\/.*)?$/;
```

Add dispatch in `fetch`, right before the existing `roomAccessMatch` block:

```typescript
    const workspaceAccessMatch = url.pathname.match(WORKSPACE_ACCESS_PATH);
    if (workspaceAccessMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceAccessMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const workspaceDocsMatch = url.pathname.match(WORKSPACE_DOCS_PATH);
    if (workspaceDocsMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceDocsMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const workspaceDocVersionsMatch = url.pathname.match(WORKSPACE_DOC_VERSIONS_PATH);
    if (workspaceDocVersionsMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceDocVersionsMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const workspaceDocCommentsMatch = url.pathname.match(WORKSPACE_DOC_COMMENTS_PATH);
    if (workspaceDocCommentsMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceDocCommentsMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const workspaceMatch = url.pathname.match(WORKSPACE_PATH);
    if (workspaceMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const id = env.WORKSPACE_ROOM.idFromName(workspaceMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }
```

- [ ] **Step 2: Verify existing routing tests (if any) still pass, and typecheck**

Run: `npm test`
Expected: PASS, no regressions in existing worker/collab-room suites.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/worker.ts
git commit -m "feat: route /api/workspace/* to WorkspaceRoom"
```

---

## Task 8: `CollabRoom` migration endpoint + tombstone

**Files:**
- Modify: `src/collab-room.ts`
- Modify: `src/workspace-room.ts` (internal seed handler)
- Modify: `src/worker.ts` (route the new endpoint)
- Test: `src/collab-room.test.ts`, `src/workspace-room.test.ts`

**Interfaces:**
- Consumes: `CollabRoom` internals (existing), `WorkspaceRoom.docIds`/`loadDocRoom`/`handleAccessRequest`-adjacent storage (Task 2-6).
- Produces: `POST /api/collab/<docId>/migrate` (public), `POST` to an internal-only path on `WorkspaceRoom` used only by this migration call (not exposed to the client) — consumed by Task 12 (client migration trigger).

Since two Durable Objects can only talk to each other over `fetch()` (no direct method calls across instances), migration works by having `CollabRoom` open an internal `fetch()` call to a freshly-created `WorkspaceRoom` carrying its serialized state.

- [ ] **Step 1: Write failing tests**

Add to `src/collab-room.test.ts` (reuse this file's existing `fakeState`/`fakeEnv`/`sessionRequest` helpers):

```typescript
describe("CollabRoom.handleMigrateRequest", () => {
  it("creates a tombstone and returns a workspace id on first migration", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    room.doc.transact(() => room.doc.getText("content").insert(0, "hello"), "storage");

    const seeded: unknown[] = [];
    const fakeWorkspaceRoomFetch = async (req: Request) => {
      seeded.push(await req.json());
      return new Response(null, { status: 204 });
    };
    const envWithBinding = {
      ...fakeEnv,
      WORKSPACE_ROOM: { idFromName: (name: string) => name, get: () => ({ fetch: fakeWorkspaceRoomFetch }) },
    } as unknown as Env;
    room.env = envWithBinding;

    const res = await room.handleMigrateRequest(new Request("https://example.com/room1/migrate", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBeTruthy();
    expect(seeded).toHaveLength(1);

    const tombstone = await room.state.storage.get("migratedTo");
    expect(tombstone).toBe(body.workspaceId);
  });

  it("returns the existing tombstone on a second migration call instead of migrating again", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await room.state.storage.put("migratedTo", "ws-existing");
    const res = await room.handleMigrateRequest(new Request("https://example.com/room1/migrate", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe("ws-existing");
  });
});
```

Add to `src/workspace-room.test.ts`:

```typescript
describe("WorkspaceRoom.handleInternalSeedRequest", () => {
  it("seeds a document's Yjs state, access, snapshots, and comments from a migration payload", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const scratch = new Y.Doc();
    scratch.getText("content").insert(0, "migrated content");
    const update = Array.from(Y.encodeStateAsUpdate(scratch));

    const request = new Request("https://example.com/internal/seed", {
      method: "POST",
      body: JSON.stringify({
        docId: "docA",
        update,
        access: { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] },
        snapshots: [{ id: "s1", timestamp: 1000, content: "migrated content" }],
        comments: [],
      }),
    });
    const res = await room.handleInternalSeedRequest(request);
    expect(res.status).toBe(204);
    expect(room.docIds).toEqual(["docA"]);
    const docRoom = await room.loadDocRoom("docA");
    expect(docRoom.doc.getText("content").toString()).toBe("migrated content");
    expect(await room.getAccess()).toMatchObject({ owner: "alice" });
    expect(await room.getSnapshots("docA")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- collab-room.test.ts workspace-room.test.ts`
Expected: FAIL — `handleMigrateRequest`/`handleInternalSeedRequest` don't exist yet.

- [ ] **Step 3: Add `WORKSPACE_ROOM` to `CollabRoom`'s reachable `Env` and implement `handleMigrateRequest`**

`CollabRoom` already receives the full `Env` (it's typed `Env` in its constructor, `src/collab-room.ts:134-136`), so no signature change is needed there — Task 2 already added `WORKSPACE_ROOM` to `Env` itself.

In `src/collab-room.ts`, add near the other HTTP handlers (after `handleAccessRequest`):

```typescript
  // ---------- Migration to WorkspaceRoom ----------
  // Lazy, per-document — there's no server-side index of "every document
  // that has ever been shared" to bulk-migrate from (CollabRoom instances
  // are addressed by name with no registry), so this runs the first time
  // any collaborator opens a legacy shared document after this feature
  // ships. Idempotent via the `migratedTo` tombstone: a second caller
  // (another collaborator opening the same old link) gets the first
  // caller's result instead of creating a duplicate workspace.
  async handleMigrateRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const existingTombstone = await this.state.storage.get<string>("migratedTo");
    if (existingTombstone) return Response.json({ workspaceId: existingTombstone });

    const workspaceId = uid() + uid(); // wider than a doc id's own uid() to avoid any collision with existing workspace ids
    const access = await this.getAccess();
    const snapshots = await this.getSnapshots();
    const docId = new URL(request.url).pathname.split("/")[3]!; // /api/collab/<docId>/migrate

    const seedBody = {
      docId,
      update: Array.from(Y.encodeStateAsUpdate(this.doc)),
      access,
      snapshots,
      comments: this.commentThreads,
    };
    const workspaceRoomId = this.env.WORKSPACE_ROOM.idFromName(workspaceId);
    const res = await this.env.WORKSPACE_ROOM.get(workspaceRoomId).fetch(
      new Request("https://internal/internal/seed", { method: "POST", body: JSON.stringify(seedBody) })
    );
    if (!res.ok) return new Response("Migration failed.", { status: 500 });

    await this.state.storage.put("migratedTo", workspaceId);
    return Response.json({ workspaceId });
  }
```

Add the `Y` import already present at the top of `src/collab-room.ts` (it is — `import * as Y from "yjs";`, line 1) so no new import is needed there.

Route it in `CollabRoom.fetch`, adding alongside the other `endsWith` checks:

```typescript
    if (url.pathname.endsWith("/migrate")) return this.handleMigrateRequest(request);
```

- [ ] **Step 4: Implement `WorkspaceRoom.handleInternalSeedRequest`**

In `src/workspace-room.ts`, add:

```typescript
  // ---------- Internal: seeding from a CollabRoom migration ----------
  // Not part of the public API surface — only ever called by
  // CollabRoom.handleMigrateRequest's own internal fetch(), never reachable
  // from worker.ts's routing (see src/worker.ts's WORKSPACE_* patterns,
  // none of which match "/internal/...").
  async handleInternalSeedRequest(request: Request): Promise<Response> {
    let body: { docId?: unknown; update?: unknown; access?: unknown; snapshots?: unknown; comments?: unknown };
    try {
      body = await request.json();
    } catch (err) {
      return new Response("Invalid JSON.", { status: 400 });
    }
    if (typeof body.docId !== "string" || !Array.isArray(body.update)) {
      return new Response("Invalid seed payload.", { status: 400 });
    }
    const docId = body.docId;

    if (body.access) await this.state.storage.put("access", body.access);

    const docRoom = await this.loadDocRoom(docId);
    docRoom.doc.transact(() => Y.applyUpdate(docRoom.doc, new Uint8Array(body.update as number[]), "storage"), "storage");
    if (Array.isArray(body.snapshots)) {
      docRoom.snapshots = body.snapshots as Snapshot[];
      await this.state.storage.put(docStorageKey(docId, "snapshots"), body.snapshots);
    }
    if (Array.isArray(body.comments)) {
      docRoom.commentThreads = body.comments as CommentThread[];
      await this.persistComments(docId, docRoom);
    }

    if (!this.docIds.includes(docId)) {
      this.docIds = [...this.docIds, docId];
      await this.state.storage.put("docs", this.docIds);
    }
    await this.state.storage.put(docStorageKey(docId, "update"), Y.encodeStateAsUpdate(docRoom.doc));

    return new Response(null, { status: 204 });
  }
```

Route it in `fetch`, adding above the `/access` check:

```typescript
    if (url.pathname.endsWith("/internal/seed")) return this.handleInternalSeedRequest(request);
```

- [ ] **Step 5: Route the public migrate endpoint in `worker.ts`**

In `src/worker.ts`, add near the other `ROOM_*` constants:

```typescript
const ROOM_MIGRATE_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})\/migrate$/;
```

Add dispatch above the existing `roomAccessMatch` block:

```typescript
    const roomMigrateMatch = url.pathname.match(ROOM_MIGRATE_PATH);
    if (roomMigrateMatch) {
      const id = env.COLLAB_ROOM.idFromName(roomMigrateMatch[1]!);
      return env.COLLAB_ROOM.get(id).fetch(request);
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- collab-room.test.ts workspace-room.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

```bash
git add src/collab-room.ts src/workspace-room.ts src/worker.ts src/collab-room.test.ts src/workspace-room.test.ts
git commit -m "feat: add lazy per-document migration from CollabRoom to WorkspaceRoom"
```

---

## Task 9: Client `workspaceRoom` core (replaces the `room` singleton)

**Files:**
- Modify: `client/src/collab.ts`
- Test: none new for this task — the existing app already has no dedicated `collab.ts` unit-test file (browser-only WebSocket/CodeMirror wiring); verify this task by typecheck + the manual smoke steps in Step 5 (this matches how `collab.ts` has always been verified in this codebase, per its total absence from the test suite today).

**Interfaces:**
- Consumes: `WorkspaceRoom`'s wire protocol (Task 2), `/api/workspace/...` routes (Task 7), `Workspace.shared`/`remoteId` (Task 1).
- Produces: `workspaceRoom` singleton with multi-doc `Y.Doc` map; `joinWorkspace(workspaceId, { role })`; `bindActiveDoc(docId)`; `teardownWorkspace()`. Consumed by Tasks 10-13.

This is the largest client task: it replaces `collab.ts`'s single-document `room` object and its `joinRoom`/`teardown`/`connect`/`handleServerMessage`/`bindEditor` functions with workspace-scoped, multi-document equivalents. `Doc.shared`, join-link parsing (`/d/...` → `/w/...`), the Share modal wiring, and the migration trigger are intentionally deferred to Tasks 10-13 so this task can focus on the transport/binding core and stay reviewable on its own; the file will temporarily have unused old exports until those later tasks land — that's expected mid-plan, not a defect.

- [ ] **Step 1: Add the multiplexed message constants and `workspaceRoom` state**

In `client/src/collab.ts`, change:

```typescript
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
```

to:

```typescript
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_PRESENCE = 2;
```

Replace the `room` singleton declaration:

```typescript
const room = {
  id: null as string | null,
  ws: null as WebSocket | null,
  ydoc: null as Y.Doc | null,
  ytext: null as Y.Text | null,
  imagesMap: null as Y.Map<string> | null,
  awareness: null as awarenessProtocol.Awareness | null,
  undoManager: null as Y.UndoManager | null,
  reconnectTimer: null as ReturnType<typeof setTimeout> | null,
  reconnectDelay: 1000,
  ydocUpdateHandler: null as ((update: Uint8Array, origin: unknown) => void) | null,
};
```

with:

```typescript
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

- [ ] **Step 2: Replace `joinRoom`/`teardown` with `joinWorkspace`/`teardownWorkspace`**

Replace the entire `joinRoom` function (`client/src/collab.ts:142-193`) with:

```typescript
// Opens the one WebSocket for a whole shared workspace and creates a
// Y.Doc binding for every document currently in it — all of them start
// syncing immediately, not just whichever one ends up on screen (see
// bindActiveDoc, called separately once this resolves).
async function joinWorkspace(workspaceId: string, { role }: { role: string }): Promise<void> {
  teardownWorkspace();
  workspaceRoom.workspaceId = workspaceId;

  const docIds = await fetchWorkspaceDocIds(workspaceId);
  for (const docId of docIds) createDocBinding(docId, role);

  connectWorkspace();
}

function createDocBinding(docId: string, role: string): DocBinding {
  const existing = workspaceRoom.docs.get(docId);
  if (existing) return existing;

  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  const imagesMap = ydoc.getMap("images");
  imagesMap.observe((event, tr) => {
    if (tr.origin === "local") return;
    event.changes.keys.forEach((change, key) => {
      if (change.action === "delete") return;
      const dataUrl = imagesMap.get(key);
      if (dataUrl && workspaceRoom.activeDocId === docId) window.MDE.setDocImage(key, dataUrl);
    });
  });
  const awareness = new awarenessProtocol.Awareness(ydoc);

  const ydocUpdateHandler = (update: Uint8Array, origin: unknown) => {
    if (origin === "server") return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarString(encoder, docId);
    syncProtocol.writeUpdate(encoder, update);
    send(encoding.toUint8Array(encoder));
  };
  ydoc.on("update", ydocUpdateHandler);

  const binding: DocBinding = { ydoc, ytext, imagesMap, awareness, undoManager: null, ydocUpdateHandler, role };
  workspaceRoom.docs.set(docId, binding);
  return binding;
}

// Rebinds the editor to a different document already syncing within the
// active workspace — no connection/reconnection involved, only which
// Y.Doc CodeMirror's yCollab extension is attached to.
function bindActiveDoc(docId: string): void {
  const binding = workspaceRoom.docs.get(docId);
  if (!binding) return;
  workspaceRoom.activeDocId = docId;

  const undoManager = binding.undoManager || new Y.UndoManager(binding.ytext);
  binding.undoManager = undoManager;
  window.MDE.enterCollabMode([yCollab(binding.ytext, binding.awareness, { undoManager }), keymap.of(yUndoManagerKeymap)], undoManager);
  window.MDE.setReadOnly(binding.role !== "editor");

  const username = window.MDE.githubUsername;
  const identity = username ? { name: username, color: colorForUsername(username) } : getGuestIdentity();
  binding.awareness.setLocalState({ user: identity, role: binding.role, username });
  binding.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
    sendAwareness(docId, binding.awareness, added.concat(updated, removed));
    updatePresence();
  });

  sendPresence(docId);
}

function teardownWorkspace(): void {
  window.MDE.setReadOnly(false);
  window.MDE.exitCollabMode();
  if (workspaceRoom.reconnectTimer) {
    clearTimeout(workspaceRoom.reconnectTimer);
    workspaceRoom.reconnectTimer = null;
  }
  if (workspaceRoom.ws) {
    workspaceRoom.ws.onclose = null;
    workspaceRoom.ws.onerror = null;
    try { workspaceRoom.ws.close(); } catch (e) { /* already closed */ }
  }
  for (const binding of workspaceRoom.docs.values()) {
    binding.awareness.destroy();
    binding.ydoc.off("update", binding.ydocUpdateHandler);
    if (binding.undoManager) binding.undoManager.destroy();
    binding.ydoc.destroy();
  }
  workspaceRoom.docs.clear();
  workspaceRoom.workspaceId = null;
  workspaceRoom.ws = null;
  workspaceRoom.activeDocId = null;
  workspaceRoom.reconnectDelay = 1000;
}
```

Delete the old `bindEditor` function (`client/src/collab.ts:233-254`) and `seedImagesIntoRoom` (`:256-262`) — superseded by `createDocBinding`/`bindActiveDoc` above. (Seeding a brand-new workspace's first document from local content moves to Task 11's relocate-and-share flow, since that's the only remaining place content needs pushing in before a room has ever synced.)

- [ ] **Step 3: Replace the WebSocket transport functions**

Replace `connect`/`scheduleReconnect`/`handleServerMessage`/`onLocalAwarenessUpdate`/`sendAwareness`/`send` (`client/src/collab.ts:266-341`) with:

```typescript
function connectWorkspace(): void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/workspace/${encodeURIComponent(workspaceRoom.workspaceId!)}`);
  ws.binaryType = "arraybuffer";
  workspaceRoom.ws = ws;

  ws.onopen = () => {
    workspaceRoom.reconnectDelay = 1000;
    for (const [docId, binding] of workspaceRoom.docs.entries()) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      encoding.writeVarString(encoder, docId);
      syncProtocol.writeSyncStep1(encoder, binding.ydoc);
      send(encoding.toUint8Array(encoder));
      if (binding.awareness.getLocalState() !== null) sendAwareness(docId, binding.awareness, [binding.awareness.clientID]);
    }
    if (workspaceRoom.activeDocId) sendPresence(workspaceRoom.activeDocId);
  };

  ws.onmessage = (event) => handleServerMessage(new Uint8Array(event.data as ArrayBuffer));
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => ws.close();
}

function scheduleReconnect(): void {
  if (!workspaceRoom.workspaceId || workspaceRoom.reconnectTimer) return;
  workspaceRoom.reconnectTimer = setTimeout(() => {
    workspaceRoom.reconnectTimer = null;
    connectWorkspace();
  }, workspaceRoom.reconnectDelay);
  workspaceRoom.reconnectDelay = Math.min(workspaceRoom.reconnectDelay * 1.6, 10000);
}

function handleServerMessage(data: Uint8Array): void {
  const decoder = decoding.createDecoder(data);
  const messageType = decoding.readVarUint(decoder);

  if (messageType === MESSAGE_PRESENCE) {
    const username = decoding.readVarString(decoder);
    const docId = decoding.readVarString(decoder);
    handleRemotePresence(username, docId);
    return;
  }

  const docId = decoding.readVarString(decoder);
  const binding = workspaceRoom.docs.get(docId);
  if (!binding) return;

  if (messageType === MESSAGE_SYNC) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarString(encoder, docId);
    syncProtocol.readSyncMessage(decoder, encoder, binding.ydoc, "server");
    if (encoding.length(encoder) > 2) send(encoding.toUint8Array(encoder));
  } else if (messageType === MESSAGE_AWARENESS) {
    const update = decoding.readVarUint8Array(decoder);
    awarenessProtocol.applyAwarenessUpdate(binding.awareness, update, "server");
    if (docId === workspaceRoom.activeDocId) updatePresence();
  }
}

function sendAwareness(docId: string, awareness: awarenessProtocol.Awareness, clientIDs: number[]): void {
  if (clientIDs.length === 0) return;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarString(encoder, docId);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clientIDs));
  send(encoding.toUint8Array(encoder));
}

function sendPresence(docId: string): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_PRESENCE);
  encoding.writeVarString(encoder, "");
  encoding.writeVarString(encoder, docId);
  send(encoding.toUint8Array(encoder));
}

function send(bytes: Uint8Array): void {
  if (workspaceRoom.ws && workspaceRoom.ws.readyState === WebSocket.OPEN) workspaceRoom.ws.send(bytes as Uint8Array<ArrayBuffer>);
}
```

Note: `MESSAGE_PRESENCE`'s "who changed" signal isn't the username field sent from client→server (the server already knows the sender's session identity and fills it in on broadcast — see `WorkspaceRoom.broadcastPresence`, Task 2) — the client only ever sends `[""][docId]`, and only ever *receives* a populated username. `handleRemotePresence` (added in Task 13) is what actually consumes the received form; leave it as a forward reference (declared, implemented in Task 13) or a no-op stub for this task:

```typescript
function handleRemotePresence(_username: string, _docId: string): void {
  // Populated in Task 13 (presence-across-files UI).
}
```

- [ ] **Step 4: Fix remaining references to the old `room` object**

Search the rest of `client/src/collab.ts` for `room.` (the old singleton) and update each call site to work through `workspaceRoom`/`workspaceRoom.docs.get(workspaceRoom.activeDocId)` instead. At minimum:
- `window.MDE.onImageAdded` (`:59-61`): change `room.imagesMap`/`room.ydoc` to the active binding's `imagesMap`/`ydoc`.
- `syncShareStores` (`:627-635`): change `!!room.id` to `!!workspaceRoom.workspaceId`.
- `updatePresence` (`:637-650`): change `room.awareness` to the active binding's `awareness` (`workspaceRoom.docs.get(workspaceRoom.activeDocId)?.awareness`).

Leave `handleDocChanged`, `joinSharedLink`, `rejoinKnownRoom`, `computeMyRole`, and the Share-modal action exports (`setAccessMode`, `setRole`, `addPerson`, etc.) calling the now-removed `joinRoom`/`teardown` — Tasks 10-12 rewrite each of those call sites to call `joinWorkspace`/`bindActiveDoc`/`teardownWorkspace` instead, so leftover compile errors from this task alone are expected until those land. Confirm this is really the current source of every remaining error before moving on:

Run: `npx tsc --noEmit -p client/tsconfig.json 2>&1 | grep -v "app.ts\|Share.svelte"`
Expected: every remaining error's file/line is inside `client/src/collab.ts`'s `handleDocChanged`/`joinSharedLink`/`rejoinKnownRoom`/`setAccessMode`/`addPerson`/`setInviteRole`/`removeInvite` functions (or a caller of one of those) — not `createDocBinding`/`bindActiveDoc`/`connectWorkspace`/etc, which this task's own steps just finished. If an error shows up anywhere else, fix it now before moving on.

- [ ] **Step 5: Manual smoke test**

Run: `npm run build`
Expected: build succeeds (Vite will surface any remaining `room.` reference `esbuild` catches even where `tsc` might not, e.g. inside untyped `.js` interop).

This task alone isn't independently runnable end-to-end (the join-link/Share-modal call sites aren't rewired yet) — full manual verification happens at the end of Task 12. Skip live browser testing for this task; typecheck-clean plus a successful build is the bar here.

- [ ] **Step 6: Commit**

```bash
git add client/src/collab.ts
git commit -m "feat: replace single-document room with multi-doc workspaceRoom"
```

---

## Task 10: Client join flow — merge vs. new-workspace choice

**Files:**
- Create: `client/src/components/JoinWorkspaceModal.svelte`
- Create: `client/src/stores/joinWorkspace.ts`
- Modify: `client/src/main.ts` (mount the new component)
- Modify: `client/index.html` (add its mount div)
- Modify: `client/src/stores/workspaces.ts` (add `adoptSharedWorkspace`/`mergeSharedWorkspaceInto`)
- Modify: `client/src/stores/docs.ts` (add `importRemoteDocs` — merges a downloaded doc list into a local workspace with rename-on-collision)
- Modify: `client/src/collab.ts` (`init`, share-link parsing, `joinSharedLink` → new `/w/` format)
- Test: `client/src/stores/workspaces.test.ts`, `client/src/stores/docs.test.ts`

**Interfaces:**
- Consumes: `workspaceRoom.joinWorkspace`/`bindActiveDoc` (Task 9), `Workspace.shared`/`remoteId` (Task 1), `ensureUniqueName` (existing, `client/src/doc-naming.ts`).
- Produces: `client/src/stores/joinWorkspace.ts`'s `pendingJoin` store (drives the modal), `adoptSharedWorkspace(remoteId, name, docs)`, `mergeSharedWorkspaceInto(workspaceId, remoteId, docs)` — used only within this task's own flow.

- [ ] **Step 1: Write failing tests for the two adoption paths**

Add to `client/src/stores/workspaces.test.ts`:

```typescript
import { adoptSharedWorkspace, mergeSharedWorkspaceInto } from "./workspaces";

it("adoptSharedWorkspace creates a new local workspace tagged shared+remoteId", () => {
  const ws = adoptSharedWorkspace("room-xyz", "Team Docs");
  expect(ws.shared).toBe(true);
  expect(ws.remoteId).toBe("room-xyz");
  expect(ws.name).toBe("Team Docs");
  expect(get(workspacesStore).find((w) => w.id === ws.id)).toBeTruthy();
});

it("mergeSharedWorkspaceInto tags an existing workspace with shared+remoteId", () => {
  const existing = createWorkspace("My Notes");
  mergeSharedWorkspaceInto(existing.id, "room-xyz");
  const updated = get(workspacesStore).find((w) => w.id === existing.id);
  expect(updated?.shared).toBe(true);
  expect(updated?.remoteId).toBe("room-xyz");
});
```

(Add `import { get } from "svelte/store";` to the test file if not already imported.)

Add to `client/src/stores/docs.test.ts`:

```typescript
import { importRemoteDocs } from "./docs";

it("importRemoteDocs adds remote docs into the target workspace, renaming on name collision", () => {
  const ws = createWorkspace("Shared");
  createDoc({ id: "local-1", name: "Notes", workspaceId: ws.id });
  importRemoteDocs(ws.id, [{ id: "remote-1", name: "Notes", content: "remote content", updatedAt: 1, createdAt: 1 }]);

  const docs = get(docsStore).filter((d) => d.workspaceId === ws.id);
  expect(docs).toHaveLength(2);
  expect(docs.find((d) => d.id === "remote-1")?.name).toBe("Notes-2");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- workspaces.test.ts docs.test.ts`
Expected: FAIL — `adoptSharedWorkspace`/`mergeSharedWorkspaceInto`/`importRemoteDocs` don't exist.

- [ ] **Step 3: Implement the two workspace-adoption functions**

In `client/src/stores/workspaces.ts`, add after `createWorkspace`:

```typescript
// Opening a shared workspace link for the first time and choosing "add as
// a new workspace" — creates a fresh local Workspace record pointed at the
// remote room, distinct from anything the user already has.
export function adoptSharedWorkspace(remoteId: string, name: string): Workspace {
  const ws: Workspace = { id: uid(), name, createdAt: Date.now(), shared: true, remoteId };
  workspacesStore.update((all) => [ws, ...all]);
  setActiveWorkspaceId(ws.id);
  persistWorkspaces();
  return ws;
}

// Opening a shared workspace link and choosing "merge into an existing
// workspace" — the chosen local workspace keeps its own id/name but
// starts pointing at the remote room too.
export function mergeSharedWorkspaceInto(workspaceId: string, remoteId: string): void {
  workspacesStore.update((all) => all.map((w) => (w.id === workspaceId ? { ...w, shared: true, remoteId } : w)));
  persistWorkspaces();
}
```

- [ ] **Step 4: Implement `importRemoteDocs`**

In `client/src/stores/docs.ts`, add after `createDoc`:

```typescript
// Merges a shared workspace's document list into a local workspace —
// used both by the "merge into an existing workspace" join choice and by
// "add as a new workspace" (against the freshly-created empty workspace,
// where nothing can collide). Name collisions go through the same
// silent-suffix primitive used everywhere else in the app (create/
// rename/duplicate) rather than new conflict-resolution UI, per the
// design spec's Non-goals.
export function importRemoteDocs(workspaceId: string, remoteDocs: Pick<Doc, "id" | "name" | "content" | "updatedAt" | "createdAt">[]): void {
  docsStore.update((docs) => {
    const seen = new Set(docs.filter((d) => d.workspaceId === workspaceId).map((d) => d.name));
    const added = remoteDocs.map((rd) => {
      const name = nextAvailableName(rd.name || "Untitled", seen);
      seen.add(name);
      return { ...rd, name, workspaceId, shared: undefined } as Doc;
    });
    return [...added, ...docs];
  });
  persistDocs();
}
```

(`nextAvailableName` is already imported at the top of `docs.ts` from `./doc-naming` — no new import needed.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- workspaces.test.ts docs.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the join-prompt store**

Create `client/src/stores/joinWorkspace.ts`:

```typescript
import { writable } from "svelte/store";

export interface PendingJoin {
  remoteId: string;
  workspaceName: string;
  docs: { id: string; name: string; content: string; updatedAt: number; createdAt: number }[];
  landOnDocId: string;
}

// Set by collab.ts's joinSharedLink when a /w/<workspaceId>/<docId>/<mode>
// link resolves to a remoteId this browser hasn't seen before — cleared by
// JoinWorkspaceModal.svelte once the user picks "new" or "merge".
export const pendingJoin = writable<PendingJoin | null>(null);
```

- [ ] **Step 7: Build `JoinWorkspaceModal.svelte`**

Create `client/src/components/JoinWorkspaceModal.svelte` (same structural pattern as `RenameCollisionModal.svelte` — a `Modal` with a `footer` snippet, driven by one store):

```svelte
<script lang="ts">
  import Modal from "./Modal.svelte";
  import { pendingJoin } from "../stores/joinWorkspace";
  import { workspacesStore, adoptSharedWorkspace, mergeSharedWorkspaceInto, switchWorkspace } from "../stores/workspaces";
  import { importRemoteDocs, ensureActiveDocInWorkspace } from "../stores/docs";
  import { switchDoc } from "../stores/docs";

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
</script>

{#if $pendingJoin}
  <Modal title="Join shared workspace" labelledBy="joinWorkspaceTitle" onClose={cancel}>
    <p>"{$pendingJoin.workspaceName}" has been shared with you. Add it as a new workspace of its own, or merge its documents into one you already have?</p>

    <div class="menu-section-label">Merge into an existing workspace</div>
    <select bind:value={mergeTargetId} aria-label="Choose a workspace to merge into">
      <option value={null}>Choose a workspace…</option>
      {#each $workspacesStore as ws (ws.id)}
        <option value={ws.id}>{ws.name}</option>
      {/each}
    </select>

    {#snippet footer()}
      <button type="button" class="secondary-btn" onclick={cancel}>Cancel</button>
      <button type="button" class="secondary-btn" disabled={!mergeTargetId} onclick={merge}>Merge in</button>
      <button type="button" class="primary-btn" onclick={addAsNew}>Add as new workspace</button>
    {/snippet}
  </Modal>
{/if}
```

- [ ] **Step 8: Mount it**

In `client/index.html`, add near the other mount divs (e.g. right after `<div id="rename-collision-mount"></div>`):

```html
<div id="join-workspace-modal-mount"></div>
```

In `client/src/main.ts`, add the import alongside the other component imports and the mount call alongside the other `mount(...)` calls:

```typescript
import JoinWorkspaceModal from "./components/JoinWorkspaceModal.svelte";
```

```typescript
mount(JoinWorkspaceModal, { target: document.getElementById("join-workspace-modal-mount")! });
```

- [ ] **Step 9: Rewrite `joinSharedLink` to use the new link format and populate `pendingJoin`**

In `client/src/collab.ts`, change the share-link regex:

```typescript
const SHARE_PATH = /^\/d\/([A-Za-z0-9_-]{1,128})\/(?:view|review|edit)$/;
```

to:

```typescript
const SHARE_PATH = /^\/w\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{1,128})\/(?:view|review|edit)$/;
```

Update `init`'s match handling (`client/src/collab.ts:65-71`):

```typescript
  const shareUrlMatch = location.pathname.match(SHARE_PATH);
  if (shareUrlMatch) {
    history.replaceState(null, "", "/" + location.search + location.hash);
    joinSharedLink(shareUrlMatch[1]);
  } else {
    handleDocChanged(getActiveDoc());
  }
```

to:

```typescript
  const shareUrlMatch = location.pathname.match(SHARE_PATH);
  if (shareUrlMatch) {
    history.replaceState(null, "", "/" + location.search + location.hash);
    joinSharedLink(shareUrlMatch[1]!, shareUrlMatch[2]!);
  } else {
    handleDocChanged(getActiveDoc());
  }
```

Replace `joinSharedLink` (`client/src/collab.ts:83-109`) with:

```typescript
async function joinSharedLink(workspaceId: string, landOnDocId: string) {
  const localMatch = get(workspacesStore).find((w) => w.remoteId === workspaceId);
  const access = await fetchWorkspaceAccess(workspaceId);
  await window.MDE.githubSessionReady;
  const username = window.MDE.githubUsername;
  const role = computeMyRole(access, username);
  if (!role) {
    if (!username) {
      window.MDE.requireGithubSignIn("Sign in with GitHub to open this shared workspace.");
    } else {
      alert("You don't have access to this workspace. Ask the owner to invite your GitHub username, or share a link with general access turned on.");
    }
    return;
  }

  if (localMatch) {
    // Already joined this remote workspace before — just switch to it.
    switchWorkspace(localMatch.id);
    switchDoc(landOnDocId);
    await joinWorkspace(workspaceId, { role });
    bindActiveDoc(landOnDocId);
    return;
  }

  const docIds = await fetchWorkspaceDocIds(workspaceId);
  const docs = await Promise.all(docIds.map((id) => fetchRemoteDocContent(workspaceId, id)));
  pendingJoin.set({ remoteId: workspaceId, workspaceName: "Shared workspace", docs: docs.filter((d): d is NonNullable<typeof d> => !!d), landOnDocId });
}
```

Add the two new fetch helpers near `fetchAccess`/`putAccess` (`client/src/collab.ts:373-395`):

```typescript
async function fetchWorkspaceAccess(workspaceId: string): Promise<AccessRecord> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/access`);
    if (!res.ok) return { ...DEFAULT_ACCESS };
    return { ...DEFAULT_ACCESS, ...(await res.json()) };
  } catch (err) {
    return { ...DEFAULT_ACCESS };
  }
}

async function putWorkspaceAccess(workspaceId: string, body: unknown): Promise<AccessRecord | null> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/access`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return { ...DEFAULT_ACCESS, ...(await res.json()) };
  } catch (err) {
    return null;
  }
}

async function fetchWorkspaceDocIds(workspaceId: string): Promise<string[]> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/docs`);
    if (!res.ok) return [];
    return (await res.json()) as string[];
  } catch (err) {
    return [];
  }
}

// Fetches a document's current text via a throwaway sync handshake over a
// short-lived WebSocket — there's no plain HTTP "get current content"
// endpoint (the DO only speaks the Yjs sync protocol for content), so this
// opens one, waits for the first sync reply, and closes it again. Used
// only for the one-time "download the list to show in the join prompt"
// step; the real, persistent connection is opened afterward by
// joinWorkspace once the user has actually chosen to join.
async function fetchRemoteDocContent(workspaceId: string, docId: string): Promise<{ id: string; name: string; content: string; updatedAt: number; createdAt: number } | null> {
  return new Promise((resolve) => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/workspace/${encodeURIComponent(workspaceId)}`);
    ws.binaryType = "arraybuffer";
    const scratchDoc = new Y.Doc();
    let settled = false;
    const finish = (result: typeof scratchDoc extends never ? never : { id: string; name: string; content: string; updatedAt: number; createdAt: number } | null) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) { /* already closed */ }
      resolve(result);
    };
    ws.onopen = () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      encoding.writeVarString(encoder, docId);
      syncProtocol.writeSyncStep1(encoder, scratchDoc);
      ws.send(encoding.toUint8Array(encoder));
    };
    ws.onmessage = (event) => {
      const decoder = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer));
      const type = decoding.readVarUint(decoder);
      if (type !== MESSAGE_SYNC) return;
      const gotDocId = decoding.readVarString(decoder);
      if (gotDocId !== docId) return;
      syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), scratchDoc, "server");
      const now = Date.now();
      finish({ id: docId, name: "Shared document", content: scratchDoc.getText("content").toString(), updatedAt: now, createdAt: now });
    };
    ws.onerror = () => finish(null);
    setTimeout(() => finish(null), 5000);
  });
}
```

Update `rejoinKnownRoom` (`client/src/collab.ts:130-140`) to key off `Workspace.shared`/`remoteId` instead of `Doc.shared` — since `handleDocChanged` still reads `doc.shared` at this point in the plan, leave `handleDocChanged`/`rejoinKnownRoom` untouched here; Task 12 rewrites them together with the migration trigger (they're the same code path: "does this doc's *workspace* need reconnecting"). Add the necessary new imports at the top of `client/src/collab.ts`:

```typescript
import { get } from "svelte/store";
import { pendingJoin } from "./stores/joinWorkspace";
import { workspacesStore, switchWorkspace } from "./stores/workspaces";
import { switchDoc } from "./stores/docs";
```

- [ ] **Step 10: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: errors remaining should only be in `handleDocChanged`/`rejoinKnownRoom`/the Share-modal action exports (deferred to Tasks 11-12, same caveat as Task 9 Step 4). Confirm no error appears anywhere else, including inside the new `JoinWorkspaceModal.svelte`, `stores/joinWorkspace.ts`, `stores/workspaces.ts`, `stores/docs.ts`, or the new fetch helpers in `collab.ts`.

- [ ] **Step 11: Commit**

```bash
git add client/src/collab.ts client/src/components/JoinWorkspaceModal.svelte client/src/stores/joinWorkspace.ts client/src/stores/workspaces.ts client/src/stores/docs.ts client/src/stores/workspaces.test.ts client/src/stores/docs.test.ts client/src/main.ts client/index.html
git commit -m "feat: add merge-vs-new-workspace join flow for shared workspace links"
```

---

## Task 11: Client relocate-and-share flow

**Files:**
- Modify: `client/src/collab.ts` (`openShareModal`, `setAccessMode`, `setRole`, `addPerson`, `setInviteRole`, `removeInvite`, `buildShareLink`)
- Test: none new — this is UI-flow wiring over already-tested primitives (`moveDocToWorkspace`, `createWorkspace`, `confirmAction`); verified manually in Step 4.

**Interfaces:**
- Consumes: `moveDocToWorkspace` (existing, `client/src/stores/docs.ts:384-387`), `createWorkspace` (existing, `client/src/stores/workspaces.ts:74-80`), `confirmAction` (existing, `client/src/stores/confirmDialog.ts`), `joinWorkspace`/`bindActiveDoc` (Task 9), `putWorkspaceAccess`/`fetchWorkspaceAccess` (Task 10).
- Produces: rewritten Share-modal action exports, now operating against the active document's *workspace* instead of the document directly — consumed by `Share.svelte` (already calls these exact export names, unchanged).

This is where the spec's "sharing a document that isn't alone in its workspace relocates it first" behavior lives. `Share.svelte` itself needs no changes — it already calls `openShareModal`/`setAccessMode`/`setRole`/`addPerson`/`setInviteRole`/`removeInvite`/`buildShareLink`/`colorForUsername` by name; only their implementations in `collab.ts` change.

- [ ] **Step 1: Rewrite `openShareModal` to relocate-then-share**

Replace `openShareModal` (`client/src/collab.ts:472-484`) with:

```typescript
export async function openShareModal() {
  await window.MDE.githubSessionReady;
  if (!window.MDE.githubUsername) {
    window.MDE.requireGithubSignIn("Sharing needs a connected GitHub account. Sign in to continue.");
    return;
  }
  const doc = getActiveDoc();
  if (!doc) return;

  const siblingCount = get(docsStore).filter((d) => d.workspaceId === doc.workspaceId).length;
  let targetWorkspaceId = doc.workspaceId;
  if (siblingCount > 1) {
    const confirmed = await confirmAction(
      "Move to its own workspace?",
      "Sharing this document moves it into its own workspace so it can be shared. Continue?",
      "Continue",
      false
    );
    if (!confirmed) return;
    const ws = createWorkspace(doc.name || "Untitled");
    moveDocToWorkspace(doc.id, ws.id);
    targetWorkspaceId = ws.id;
  }

  shareModalOpen.set(true);
  currentAccess = await fetchWorkspaceAccess(targetWorkspaceId);
  syncShareStores();
}
```

Add the required imports at the top of `client/src/collab.ts`:

```typescript
import { docsStore, moveDocToWorkspace } from "./stores/docs";
import { createWorkspace } from "./stores/workspaces";
import { confirmAction } from "./stores/confirmDialog";
```

(`get`, `getActiveDoc`, `findDocById`, `createDoc`, `markActiveDocShared` are already imported per Task 9/10's edits — extend the existing `docs` import line rather than duplicating it, e.g. merge into the single `from "./stores/docs"` import.)

- [ ] **Step 2: Repoint the remaining Share-modal actions at the workspace**

Replace `setAccessMode` (`client/src/collab.ts:500-521`):

```typescript
export async function setAccessMode(mode: AccessMode, fallbackRole: string): Promise<boolean> {
  const doc = getActiveDoc();
  if (!doc) return false;
  const wantAnyone = mode !== "restricted";
  const access = await putWorkspaceAccess(doc.workspaceId, {
    generalAccess: wantAnyone ? "anyone" : "restricted",
    requireAccount: mode === "anyone-account",
    role: fallbackRole || (currentAccess && currentAccess.role) || "viewer",
    invited: currentAccess ? currentAccess.invited : [],
  });
  if (!access) {
    showToast("Couldn't update sharing settings", "error");
    return false;
  }
  currentAccess = access;
  workspacesStore.update((all) => all.map((w) => (w.id === doc.workspaceId ? { ...w, shared: wantAnyone || access.invited.length > 0 || w.shared, remoteId: w.remoteId || doc.workspaceId } : w)));
  persistWorkspaces();
  if ((wantAnyone || access.invited.length > 0) && !workspaceRoom.workspaceId) {
    await joinWorkspace(doc.workspaceId, { role: "editor" });
    bindActiveDoc(doc.id);
  }
  if (!wantAnyone && access.invited.length === 0) teardownWorkspace();
  syncShareStores();
  showToast(ACCESS_MODE_TOAST[mode], "info");
  return true;
}
```

Replace `setRole` (`:523-539`), `addPerson` (`:556-585`), `setInviteRole` (`:587-604`), `removeInvite` (`:606-623`) the same way: swap every `putAccess(doc.id, ...)` for `putWorkspaceAccess(doc.workspaceId, ...)`, and swap `getActiveDoc()`-then-`doc.id`-keyed room joins (`joinRoom(doc.id, ...)`) for `joinWorkspace(doc.workspaceId, ...)` + `bindActiveDoc(doc.id)`, and drop the now-removed `markActiveDocShared` calls (workspace `shared` is the source of truth going forward — see Task 12 for the last remaining legacy use of `Doc.shared`, which is migration detection only). For example, `addPerson` becomes:

```typescript
export async function addPerson(rawUsername: string) {
  const username = rawUsername.trim().replace(/^@/, "");
  if (!username) return;
  const doc = getActiveDoc();
  if (!doc) return;
  const existing = currentAccess ? currentAccess.invited : [];
  if (existing.some((p) => p.username === username)) return;
  const invited = [...existing, { username, role: "editor" }];
  const access = await putWorkspaceAccess(doc.workspaceId, {
    generalAccess: currentAccess ? currentAccess.generalAccess : "restricted",
    requireAccount: currentAccess ? currentAccess.requireAccount : false,
    role: currentAccess ? currentAccess.role : "viewer",
    invited,
  });
  if (access) {
    currentAccess = access;
    workspacesStore.update((all) => all.map((w) => (w.id === doc.workspaceId ? { ...w, shared: true, remoteId: w.remoteId || doc.workspaceId } : w)));
    persistWorkspaces();
    if (!workspaceRoom.workspaceId) {
      await joinWorkspace(doc.workspaceId, { role: "editor" });
      bindActiveDoc(doc.id);
    }
    syncShareStores();
    showToast(`Invited @${username}`, "success");
  } else {
    showToast("Couldn't invite that person", "error");
  }
}
```

Apply the equivalent `doc.id` → `doc.workspaceId` / `putAccess` → `putWorkspaceAccess` swap to `setRole`, `setInviteRole`, and `removeInvite` — none of the three touch room-joining logic (only `setAccessMode`/`addPerson` do, matching today's behavior where only those two ever call `joinRoom`).

Update `buildShareLink` (`:545-554`) to emit the new link format:

```typescript
export function buildShareLink(): string | null {
  const doc = getActiveDoc();
  if (!doc || !currentAccess) return null;
  const isAnyone = currentAccess.generalAccess === "anyone";
  if (!isAnyone && currentAccess.invited.length === 0) return null;
  const segment = isAnyone ? ROLE_TO_SEGMENT[currentAccess.role] || "view" : "edit";
  return `${location.origin}/w/${encodeURIComponent(doc.workspaceId)}/${encodeURIComponent(doc.id)}/${segment}`;
}
```

Add the missing `workspacesStore`/`persistWorkspaces` import (extend the existing `./stores/workspaces` import line from Task 10 rather than duplicating).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: remaining errors should now be confined to `handleDocChanged`/`rejoinKnownRoom` only (Task 12). Everything else in `collab.ts` should be clean.

- [ ] **Step 3: Manual smoke test**

Run: `npm run dev` (or the project's existing dev script — check `package.json`)

In a browser:
1. Create two documents in the same workspace.
2. Click Share on one of them — confirm the "moves it into its own workspace" dialog appears, confirm it, and verify (via the workspace switcher) a new workspace now exists containing only that document.
3. Turn on "Anyone with the link," copy the link, confirm it's shaped `/w/<id>/<id>/view`.
4. Create a third document already alone in its own workspace, click Share — confirm no relocation dialog appears this time (already alone).

- [ ] **Step 4: Commit**

```bash
git add client/src/collab.ts
git commit -m "feat: relocate a document into its own workspace when sharing it"
```

---

## Task 12: Client migration trigger + `Doc.shared` becomes legacy-only

**Files:**
- Modify: `client/src/types.ts` (repoint `Doc.shared`'s comment to legacy-only)
- Modify: `client/src/collab.ts` (`handleDocChanged`, `rejoinKnownRoom`)
- Modify: `client/src/stores/docs.ts` (`markActiveDocShared` stays only for clearing the legacy flag; remove its use as a "just shared" setter — already done implicitly by Task 11 no longer calling it)

**Interfaces:**
- Consumes: `POST /api/collab/<docId>/migrate` (Task 8), `adoptSharedWorkspace`/`importRemoteDocs` (Task 10), `joinWorkspace`/`bindActiveDoc` (Task 9).
- Produces: fully working legacy-link migration — no other task depends on this one.

- [ ] **Step 1: Update `Doc.shared`'s doc comment**

In `client/src/types.ts`, change:

```typescript
  // Set once a doc has ever been shared — its own id doubles as its collab
  // room id (see collab.ts), so this is just a local "try to rejoin on
  // load" flag, not the room id itself.
  shared?: boolean;
```

to:

```typescript
  // Legacy-only: set on documents shared before workspace-level sharing
  // shipped, under the old one-room-per-document model. New code never
  // sets this — a document's shared state now lives on its containing
  // Workspace (see Workspace.shared) — this flag exists only so
  // collab.ts's migration trigger knows to migrate an old document to its
  // own WorkspaceRoom the next time it's opened, then clears it.
  shared?: boolean;
```

- [ ] **Step 2: Rewrite `handleDocChanged`/`rejoinKnownRoom` to check workspace state first, falling back to legacy migration**

Replace `handleDocChanged` (`client/src/collab.ts:124-128`) and `rejoinKnownRoom` (`:130-140`) with:

```typescript
function handleDocChanged(doc: any) {
  teardownWorkspace();
  if (!doc) {
    syncShareStores();
    return;
  }
  const ws = get(workspacesStore).find((w) => w.id === doc.workspaceId);
  if (ws && ws.shared && ws.remoteId) {
    rejoinKnownWorkspace(ws.remoteId, doc.id);
  } else if (doc.shared) {
    migrateLegacyDoc(doc.id);
  } else {
    syncShareStores();
  }
}

async function rejoinKnownWorkspace(remoteId: string, docId: string) {
  await window.MDE.githubSessionReady;
  const access = await fetchWorkspaceAccess(remoteId);
  const role = computeMyRole(access, window.MDE.githubUsername);
  if (!role) return;
  await joinWorkspace(remoteId, { role });
  bindActiveDoc(docId);
  syncShareStores();
}

// A document still carrying the legacy per-document `shared` flag (see
// types.ts) — migrate its CollabRoom into a fresh WorkspaceRoom, adopt the
// resulting workspace locally (same shape as a fresh join, see Task 10's
// adoptSharedWorkspace), then clear the legacy flag so this never runs
// again for this document.
async function migrateLegacyDoc(docId: string) {
  try {
    const res = await fetch(`/api/collab/${encodeURIComponent(docId)}/migrate`, { method: "POST" });
    if (!res.ok) {
      syncShareStores();
      return;
    }
    const { workspaceId } = (await res.json()) as { workspaceId: string };
    const doc = findDocById(docId);
    if (!doc) return;

    const existingLocal = get(workspacesStore).find((w) => w.remoteId === workspaceId);
    const targetWorkspaceId = existingLocal ? existingLocal.id : adoptSharedWorkspace(workspaceId, doc.name || "Untitled").id;
    if (targetWorkspaceId !== doc.workspaceId) {
      // Fold this doc into the migrated workspace instead of leaving a
      // duplicate behind — the migrate endpoint already copied its
      // content server-side, so the local copy just needs to point at
      // the same workspace and drop the legacy flag.
      docsStore.update((docs) => docs.map((d) => (d.id === docId ? { ...d, workspaceId: targetWorkspaceId, shared: undefined } : d)));
      persistDocs();
    } else {
      docsStore.update((docs) => docs.map((d) => (d.id === docId ? { ...d, shared: undefined } : d)));
      persistDocs();
    }

    await rejoinKnownWorkspace(workspaceId, docId);
  } catch (err) {
    syncShareStores();
  }
}
```

Add the missing imports (extend existing import lines from `./stores/docs` and `./stores/workspaces` rather than duplicating):

```typescript
import { docsStore, findDocById, persistDocs } from "./stores/docs";
import { adoptSharedWorkspace } from "./stores/workspaces";
```

- [ ] **Step 3: Remove the now-fully-legacy `markActiveDocShared` calls from Task 9-11's leftover paths**

Search `client/src/collab.ts` for any remaining `markActiveDocShared(` call — there should be none left after Task 11's rewrite of `setAccessMode`/`addPerson` (both previously called it). If any remain, delete the call (workspace `shared` is now the only forward-looking signal). Leave `markActiveDocShared` itself defined in `client/src/stores/docs.ts:267-273` — it's still a valid, generically-useful primitive (sets/clears `doc.shared`), just no longer called from the sharing flow itself.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: no errors anywhere in `client/src/collab.ts` — this is the task that closes out every deferred error from Tasks 9-11.

- [ ] **Step 5: Manual smoke test — full join + migration flow**

Run: `npm run dev`, build if needed (`npm run build`) to also exercise the esbuild path.

1. Simulate a legacy shared doc: in browser dev tools, set a document's `shared: true` in `localStorage["mde:docs"]` directly (no real pre-migration data exists yet in dev, so this is the only way to test the path) and reload with that doc active.
2. Confirm it silently migrates: the workspace switcher should show a new workspace was created/adopted, and the Share modal (if opened) should show working access without any manual re-share.
3. Open a real `/w/<id>/<id>/view` link in a second browser profile (or incognito) signed in as a different GitHub account invited to the doc — confirm the `JoinWorkspaceModal` choice appears, and both "add as new" and "merge into an existing workspace" (create a throwaway local workspace first to merge into) each work and land on the correct document with live sync.

- [ ] **Step 6: Commit**

```bash
git add client/src/types.ts client/src/collab.ts
git commit -m "feat: migrate legacy per-document shares to WorkspaceRoom on load"
```

---

## Task 13: Version history & comments — repoint to workspace-scoped endpoints

**Files:**
- Modify: `client/src/history.ts`
- Modify: `client/src/comments.ts`
- Modify: `client/src/components/VersionHistory.svelte`
- Modify: `client/src/components/CommentsPanel.svelte`
- Test: none new — both files are thin fetch wrappers with no existing dedicated test file (matches `collab.ts`'s own precedent); verified via typecheck + the manual pass folded into Task 12 Step 5 (extend that pass to also open Version History and add a comment on a shared document).

**Interfaces:**
- Consumes: `/api/workspace/<id>/docs/<docId>/versions[...]`, `/api/workspace/<id>/docs/<docId>/comments[...]` (Tasks 4-5, 7).
- Produces: `listSharedVersions(workspaceId, docId)`, `getSharedVersionContent(workspaceId, docId, versionId)`, `restoreSharedVersion(workspaceId, docId, versionId)`, `listComments(workspaceId, docId)`, `createComment(workspaceId, docId, ...)`, `replyToComment`, `resolveComment`, `deleteComment` — all now two-id-scoped instead of one.

- [ ] **Step 1: Update `history.ts`'s shared-version functions**

In `client/src/history.ts`, find the three functions currently taking a single `roomId` (around lines 126, 136, 151 per earlier inspection — confirm exact names via `grep -n "roomId" client/src/history.ts` before editing) and change each signature from `(roomId: string, ...)` to `(workspaceId: string, docId: string, ...)`, and each fetch URL from `` `/api/collab/${encodeURIComponent(roomId)}/versions...` `` to `` `/api/workspace/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/versions...` ``. For example, the versions-list function becomes:

```typescript
export async function listSharedVersions(workspaceId: string, docId: string): Promise<VersionSummary[]> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/versions`);
    if (!res.ok) return [];
    return (await res.json()) as VersionSummary[];
  } catch (err) {
    return [];
  }
}
```

Apply the same two-id pattern to the version-content-fetch and restore functions.

- [ ] **Step 2: Update `comments.ts`'s functions**

In `client/src/comments.ts`, change every function's first parameter from `roomId: string` to `(workspaceId: string, docId: string)`, and every fetch URL from `` `/api/collab/${encodeURIComponent(roomId)}/comments...` `` to `` `/api/workspace/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/comments...` ``. For example:

```typescript
export async function listComments(workspaceId: string, docId: string): Promise<CommentThread[]> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/comments`);
    if (!res.ok) return [];
    return (await res.json()) as CommentThread[];
  } catch (err) {
    return [];
  }
}
```

Apply the same change to `createComment`, `replyToComment`, `resolveComment`, `deleteComment`.

- [ ] **Step 3: Update `VersionHistory.svelte`'s call sites**

In `client/src/components/VersionHistory.svelte`, change every `isShared` check from `!!doc.shared` to a lookup against the doc's workspace (`get(workspacesStore).find((w) => w.id === doc.workspaceId)?.shared`), and thread `doc.workspaceId` through to every `listSharedVersions`/`getSharedVersionContent`/`restoreSharedVersion` call alongside `doc.id`. Add `import { workspacesStore } from "../stores/workspaces";` and `import { get } from "svelte/store";` if not already present. For example, the versions-list call:

```typescript
const isShared = $workspacesStore.find((w) => w.id === doc.workspaceId)?.shared;
versions = isShared ? await listSharedVersions(doc.workspaceId, doc.id) : await listVersions(doc.id);
```

Apply the equivalent pattern to the version-content-fetch and restore call sites in the same file.

- [ ] **Step 4: Update `CommentsPanel.svelte`'s call sites**

Same pattern: change `ctx.isShared` (currently derived from `!!doc.shared`, line 22) to check the doc's workspace instead:

```typescript
const ctx = $derived.by(() => {
  const doc = getActiveDoc();
  if (!doc) return null;
  const isShared = !!$workspacesStore.find((w) => w.id === doc.workspaceId)?.shared;
  return { doc, isShared };
});
```

and thread `ctx.doc.workspaceId` through every `listComments`/`createComment`/`replyToComment`/`resolveComment`/`deleteComment` call alongside `ctx.doc.id`. Add `import { workspacesStore } from "../stores/workspaces";` if not already present.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Manual smoke test**

Run: `npm run dev`. On a shared document (from Task 12's smoke test), open Version History and confirm the list loads; open the Comments panel, add a comment, and confirm it round-trips (reload the page, confirm it's still there — proving it landed server-side, not just in local state).

- [ ] **Step 7: Commit**

```bash
git add client/src/history.ts client/src/comments.ts client/src/components/VersionHistory.svelte client/src/components/CommentsPanel.svelte
git commit -m "feat: repoint version history and comments to workspace-scoped endpoints"
```

---

## Task 14: Presence across files — doc-list indicator

**Files:**
- Create: `client/src/stores/workspacePresence.ts`
- Modify: `client/src/collab.ts` (`handleRemotePresence`, `sendPresence` call sites)
- Modify: `client/src/components/DocList.svelte`
- Modify: `client/src/style.css` (small indicator style)

**Interfaces:**
- Consumes: `MESSAGE_PRESENCE` wire messages (Task 2 server-side, Task 9 client stub).
- Produces: `workspacePresence` store (`Map<docId, {name: string; color: string}[]>`), rendered per row in `DocList.svelte`. Terminal task — nothing else depends on this.

- [ ] **Step 1: Create the presence store**

Create `client/src/stores/workspacePresence.ts`:

```typescript
import { writable } from "svelte/store";

export interface RemotePresenceEntry {
  username: string;
  color: string;
}

// Which documents (by id) each currently-connected collaborator has open,
// across the whole active shared workspace — not just the document you
// yourself have open. Populated by collab.ts's handleRemotePresence,
// cleared on every workspace teardown.
export const workspacePresence = writable<Map<string, RemotePresenceEntry[]>>(new Map());
```

- [ ] **Step 2: Implement `handleRemotePresence` in `collab.ts`**

Replace the Task 9 stub:

```typescript
function handleRemotePresence(_username: string, _docId: string): void {
  // Populated in Task 13 (presence-across-files UI).
}
```

with:

```typescript
// Tracks each remote session's current doc by username (good enough for
// this indicator's purpose — the doc list shows "who", not "which of
// their possibly-multiple tabs"). An empty docId means that user has
// disconnected or is no longer viewing anything in this workspace (see
// WorkspaceRoom.handleClose's own presence broadcast on disconnect).
const remotePresenceByUsername = new Map<string, string>();

function handleRemotePresence(username: string, docId: string): void {
  if (!username) return;
  if (docId) remotePresenceByUsername.set(username, docId);
  else remotePresenceByUsername.delete(username);

  const byDoc = new Map<string, { username: string; color: string }[]>();
  for (const [name, forDocId] of remotePresenceByUsername.entries()) {
    const list = byDoc.get(forDocId) || [];
    list.push({ username: name, color: colorForUsername(name) });
    byDoc.set(forDocId, list);
  }
  workspacePresence.set(byDoc);
}
```

Add the import at the top of `client/src/collab.ts`:

```typescript
import { workspacePresence } from "./stores/workspacePresence";
```

Clear it on teardown — in `teardownWorkspace` (Task 9), add as the first line of the function body:

```typescript
function teardownWorkspace(): void {
  remotePresenceByUsername.clear();
  workspacePresence.set(new Map());
  window.MDE.setReadOnly(false);
  ...
```

Send an updated presence message whenever the active document changes, not just on initial bind — in `bindActiveDoc` (Task 9), the existing trailing `sendPresence(docId);` call already covers this (it's called every time the active doc changes, per Task 12's `rejoinKnownWorkspace` calling `bindActiveDoc` on every doc switch within an already-connected workspace — confirm this holds; if `bindActiveDoc` is ever *not* re-invoked on a same-workspace doc switch, add a call to `sendPresence(docId)` at that switch's call site instead).

- [ ] **Step 3: Render the indicator in `DocList.svelte`**

In `client/src/components/DocList.svelte`, add the import:

```typescript
import { workspacePresence } from "../stores/workspacePresence";
```

Find the per-row template (the `{#each ... as doc}` loop) and add, inside each row, after the existing name/metadata markup:

```svelte
{#if ($workspacePresence.get(doc.id) || []).length > 0}
  <span class="doclist-presence">
    {#each ($workspacePresence.get(doc.id) || []).slice(0, 3) as p (p.username)}
      <span class="presence-avatar presence-avatar-sm" style:background={p.color} title={p.username}>{p.username.charAt(0).toUpperCase()}</span>
    {/each}
  </span>
{/if}
```

- [ ] **Step 4: Add the small-avatar style**

In `client/src/style.css`, add near the existing `.presence-avatar` rule (search for it to place this next to it):

```css
.doclist-presence {
  display: inline-flex;
  margin-left: 6px;
}
.presence-avatar-sm {
  width: 16px;
  height: 16px;
  font-size: 9px;
  margin-left: -4px;
  border: 1px solid var(--bg);
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Manual smoke test**

Run: `npm run dev`. With two browser sessions both connected to the same shared workspace (from Task 12/13's smoke tests) on different documents, confirm the doc list in each session shows a small avatar next to whichever document the *other* session currently has open, and that it disappears when that session closes its tab or switches away.

- [ ] **Step 7: Final full-suite verification**

Run: `npm test`
Expected: all tests pass, including every new test added across Tasks 1-13.

Run: `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p client/tsconfig.json`
Expected: no errors, server or client.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 8: Commit**

```bash
git add client/src/stores/workspacePresence.ts client/src/collab.ts client/src/components/DocList.svelte client/src/style.css
git commit -m "feat: show cross-document presence in the doc list"
```

---

## Self-Review Notes

**Spec coverage:**
- "Every document live simultaneously" → Task 2 (multiplexed protocol) + Task 9 (client opens one binding per doc, all connected at once).
- "Access control per-workspace" → Task 3 (server), Task 11 (client Share-modal actions repointed).
- "Single-document Share relocates first" → Task 11.
- "Join flow: new vs. merge" → Task 10.
- "Presence across files" → Task 14 (plus the `MESSAGE_PRESENCE` wire-level groundwork in Task 2/9).
- "Migration of already-shared documents" → Task 8 (server) + Task 12 (client trigger).
- "Version history / comments behavior unchanged, storage re-scoped" → Tasks 4-5 (server), Task 13 (client).
- "`/w/<workspaceId>/<docId>/<mode>` link format" → Task 10 (`SHARE_PATH`, `buildShareLink` in Task 11).
- "`CollabRoom` not deleted" → untouched by every task except Task 8's additive migration endpoint.
- "No new merge-conflict UI, reuse `ensureUniqueName`" → Task 10's `importRemoteDocs`.
- "One role per person per workspace" → enforced structurally: `AccessRecord` in `WorkspaceRoom` (Task 3) has no per-document role field at all, matching `CollabRoom`'s shape but workspace-scoped.

**Judgment calls made during planning (not fully specified in the spec's prose):**
1. **Cross-file presence transport.** The spec says awareness state "gains a `docId` field," which reads as extending the existing per-document `y-protocols` Awareness object. Implemented instead as a separate, workspace-level `MESSAGE_PRESENCE` message (Task 2/9/14) — each document keeps its own independent Awareness instance (required for correct Yjs relative-position cursor sync within that specific doc, unchanged from today), and a lightweight sibling message carries only "which doc is this session looking at right now," broadcast workspace-wide. This satisfies the spec's actual requirement ("the data is available... exact UI treatment left to implementation") without duplicating a `docId` field across every open document's separate awareness state for the same client.
2. **Migration payload transport.** The spec describes `CollabRoom` copying its state into a fresh `WorkspaceRoom` but doesn't specify the mechanism. Since two Durable Objects can only communicate via `fetch()` (no direct cross-instance method calls), Task 8 adds an internal-only `/internal/seed` endpoint on `WorkspaceRoom`, called only by `CollabRoom`'s own migration handler — never reachable through `worker.ts`'s public routing.
3. **`fetchRemoteDocContent` (Task 10).** The join prompt needs to show document names/content before the user has committed to joining, but there's no plain HTTP "read current content" endpoint (content only flows over the Yjs sync WebSocket protocol). Implemented as a short-lived scratch WebSocket connection that performs one sync handshake and closes — used only to populate the join-choice modal's preview list, torn down immediately after.
4. **Remote document "name" during migration/join.** Neither `CollabRoom` nor `WorkspaceRoom` stores a document's display name (only its Yjs `content` — the app's document title lives in the client-side `Doc.name` field, never sent to the server). `fetchRemoteDocContent`/`joinSharedLink` fall back to a generic "Shared document" placeholder name, matching the exact same fallback `joinSharedLink` already used pre-plan (`client/src/collab.ts:88`, `createDoc({ id: roomId, name: "Shared document" })`) — not a new gap introduced by this plan.
5. **Task 9's temporary unused-code state.** Tasks 9 and 10 leave some functions in `collab.ts` (`handleDocChanged`, `rejoinKnownRoom`) calling not-yet-updated helpers until Task 12. This is flagged explicitly in each task's steps (rather than silently left for the reviewer to discover) since the plan's task-by-task review gate would otherwise flag it as an incomplete task; it's an intentional, spec-driven sequencing choice — rewriting all call sites in one task would make Task 9 unreviewably large.

No spec requirements were found without a covering task.
