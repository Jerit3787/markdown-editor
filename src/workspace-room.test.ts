import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { WorkspaceRoom } from "./workspace-room";
import type { AccessRecord } from "./workspace-room";
import { encryptSession } from "./auth";
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
  it("routes an update for docA to docA's Y.Doc without touching docB", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    // A first-contact message for a new doc now also gets a reciprocal
    // step1 reply from the server (see the regression test below) — this
    // fake WS just needs to tolerate that, not inspect it.
    const fakeWs = { send: () => {} } as unknown as WebSocket;
    room.sessions.set(fakeWs, { username: "alice", role: "editor", viewingDocId: null });

    const scratch = new Y.Doc();
    scratch.getText("content").insert(0, "hello docA");
    const update = Y.encodeStateAsUpdate(scratch);

    await room.handleMessage(fakeWs, encodeSyncUpdate("docA", update));

    expect(room.docs.get("docA")?.doc.getText("content").toString()).toBe("hello docA");
    expect(room.docs.has("docB")).toBe(false);
  });

  it("broadcasts a docA update to other sessions with docA's id in the envelope, not to a fresh session for docB", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const sentByReceiver: ArrayBuffer[] = [];
    const receiverWs = { send: (data: ArrayBuffer) => sentByReceiver.push(data) } as unknown as WebSocket;
    // The sender also gets its own reciprocal step1 reply for this new
    // doc (see the regression test below) — only receiverWs's inbox is
    // asserted on here, so the sender just needs a no-op send().
    const senderWs = { send: () => {} } as unknown as WebSocket;
    room.sessions.set(receiverWs, { username: "bob", role: "editor", viewingDocId: null });
    room.sessions.set(senderWs, { username: "alice", role: "editor", viewingDocId: null });

    const scratch = new Y.Doc();
    scratch.getText("content").insert(0, "hi");
    const update = Y.encodeStateAsUpdate(scratch);
    await room.handleMessage(senderWs, encodeSyncUpdate("docA", update));

    expect(sentByReceiver.length).toBeGreaterThan(0);
    const { type, docId } = decodeEnvelope(sentByReceiver[sentByReceiver.length - 1]!);
    expect(type).toBe(MESSAGE_SYNC);
    expect(docId).toBe("docA");
  });

  it("keeps two documents' content independent within the same room", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const fakeWs = { send: () => {} } as unknown as WebSocket;
    room.sessions.set(fakeWs, { username: "alice", role: "editor", viewingDocId: null });

    const scratchA = new Y.Doc();
    scratchA.getText("content").insert(0, "A content");
    const scratchB = new Y.Doc();
    scratchB.getText("content").insert(0, "B content");

    await room.handleMessage(fakeWs, encodeSyncUpdate("docA", Y.encodeStateAsUpdate(scratchA)));
    await room.handleMessage(fakeWs, encodeSyncUpdate("docB", Y.encodeStateAsUpdate(scratchB)));

    expect(room.docs.get("docA")?.doc.getText("content").toString()).toBe("A content");
    expect(room.docs.get("docB")?.doc.getText("content").toString()).toBe("B content");
  });

  // Regression test for a real bug found via live testing: a client
  // joining a brand-new doc room (one this WorkspaceRoom instance has
  // never seen before) only ever sent step1 — which pulls the SERVER's
  // content down to the CLIENT, never the other direction — so a
  // freshly-seeded client's own content was silently never transmitted.
  // The fix: on first contact with a docId, the server also sends its
  // own step1 back, completing the reciprocal handshake that pulls the
  // client's content up (same as CollabRoom's single-doc model got for
  // free from always proactively step1-ing on connect).
  it("pulls a freshly-seeded client's content up to the server on first contact with a new doc", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const sent: ArrayBuffer[] = [];
    const clientWs = { send: (data: ArrayBuffer) => sent.push(data) } as unknown as WebSocket;
    room.sessions.set(clientWs, { username: "alice", role: "editor", viewingDocId: null });

    // Client's local doc already has real, pre-seeded content — never
    // told to the server before now.
    const clientDoc = new Y.Doc();
    clientDoc.getText("content").insert(0, "seeded content that must reach the server");

    // Client's first contact with this docId: a plain step1 (its own
    // state vector), exactly what connectWorkspace()'s ws.onopen sends.
    const step1Encoder = encoding.createEncoder();
    encoding.writeVarUint(step1Encoder, MESSAGE_SYNC);
    encoding.writeVarString(step1Encoder, "docA");
    syncProtocol.writeSyncStep1(step1Encoder, clientDoc);
    await room.handleMessage(clientWs, encoding.toUint8Array(step1Encoder).buffer as ArrayBuffer);

    // Server should have replied with its OWN step1 (a second, separate
    // frame — not appended to any step2 reply), asking the client what
    // IT has that the server doesn't.
    expect(sent.length).toBeGreaterThan(0);
    const serverStep1 = decodeEnvelope(sent[sent.length - 1]!);
    expect(serverStep1.type).toBe(MESSAGE_SYNC);
    expect(serverStep1.docId).toBe("docA");
    const syncSubType = decoding.readVarUint(serverStep1.decoder);
    expect(syncSubType).toBe(0); // SYNC_STEP1

    // Client replies to the server's step1 with its own step2, carrying
    // its seeded content — exactly what handleServerMessage does.
    const replyEncoder = encoding.createEncoder();
    encoding.writeVarUint(replyEncoder, MESSAGE_SYNC);
    encoding.writeVarString(replyEncoder, "docA");
    const rewound = decoding.createDecoder(new Uint8Array(sent[sent.length - 1]!));
    decoding.readVarUint(rewound);
    decoding.readVarString(rewound);
    syncProtocol.readSyncMessage(rewound, replyEncoder, clientDoc, "server");
    await room.handleMessage(clientWs, encoding.toUint8Array(replyEncoder).buffer as ArrayBuffer);

    expect(room.docs.get("docA")?.doc.getText("content").toString()).toBe("seeded content that must reach the server");
  });
});

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
    const body = (await res.json()) as AccessRecord;
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
