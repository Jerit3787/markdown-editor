import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { WorkspaceRoom } from "../../src/workspace-room";
import type { AccessRecord } from "../../src/workspace-room";
import { encryptSession } from "../../src/auth";
import type { Env } from "../../src/env";
import { getSuggestionsMap, recordInsertSuggestion, listResolvedSuggestions } from "../../src/suggestions";

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

function encodeAwarenessFrame(docId: string, update: Uint8Array): ArrayBuffer {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarString(encoder, docId);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder).buffer as ArrayBuffer;
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

  // Regression test for a real bug reported live: repeatedly switching
  // documents in a shared workspace made the presence avatar count creep
  // up before eventually dropping back down. Root cause (one of three
  // contributing bugs, this one server-side): unlike the legacy CollabRoom,
  // WorkspaceRoom.handleClose never removed a disconnected session's Yjs
  // awareness states, so every abandoned connection left a phantom entry
  // sitting in DocRoom.awareness until the Durable Object itself evicted.
  it("removes a session's awareness state for a doc when its socket closes", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const clientWs = { send: () => {} } as unknown as WebSocket;
    const otherSent: ArrayBuffer[] = [];
    const otherWs = { send: (data: ArrayBuffer) => otherSent.push(data) } as unknown as WebSocket;
    room.sessions.set(clientWs, { username: "alice", role: "editor", viewingDocId: "docA" });
    room.sessions.set(otherWs, { username: "bob", role: "editor", viewingDocId: "docA" });

    // alice's client announces presence on docA, same as bindActiveDoc's
    // awareness.setLocalState(...) -> sendAwareness(...) does.
    const localAwareness = new awarenessProtocol.Awareness(new Y.Doc());
    localAwareness.setLocalState({ user: { name: "alice" } });
    const update = awarenessProtocol.encodeAwarenessUpdate(localAwareness, [localAwareness.clientID]);
    await room.handleMessage(clientWs, encodeAwarenessFrame("docA", update));

    const docRoom = room.docs.get("docA")!;
    expect(docRoom.awareness.getStates().size).toBe(1);
    otherSent.length = 0; // clear the broadcast from the join itself

    room.handleClose(clientWs);

    expect(docRoom.awareness.getStates().size).toBe(0);
    // The removal itself must also reach the remaining collaborator —
    // otherwise their own presence bar keeps showing the stale avatar.
    // handleClose sends this (via handleAwarenessUpdate's broadcast, fired
    // synchronously from removeAwarenessStates) before its own separate
    // MESSAGE_PRESENCE broadcast, so among possibly several frames sent
    // during close, find the awareness one specifically rather than
    // assuming position.
    const awarenessFrame = otherSent.map(decodeEnvelope).find((f) => f.type === MESSAGE_AWARENESS);
    expect(awarenessFrame).toBeDefined();
    expect(awarenessFrame!.docId).toBe("docA");
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

  // GET stays readable without authorization on purpose — the join flow
  // needs generalAccess/role before the visitor has any access at all —
  // but the roster is not part of that decision, so an outsider gets it
  // blanked rather than the endpoint getting locked. See
  // src/access-visibility.ts.
  it("blanks the owner and invite roster for a GET from someone with no access", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", {
      owner: "alice",
      generalAccess: "restricted",
      requireAccount: false,
      role: "viewer",
      invited: [{ username: "bob", role: "reviewer" }],
    });

    const res = await room.handleAccessRequest(new Request("https://example.com/w/ws1/access"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as AccessRecord;
    expect(body.owner).toBeNull();
    expect(body.invited).toEqual([]);
    // The join flow's own inputs still come through untouched.
    expect(body.generalAccess).toBe("restricted");
    expect(body.role).toBe("viewer");
  });

  it("returns the full roster to the owner", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", {
      owner: "alice",
      generalAccess: "restricted",
      requireAccount: false,
      role: "viewer",
      invited: [{ username: "bob", role: "reviewer" }],
    });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });

    const res = await room.handleAccessRequest(new Request("https://example.com/w/ws1/access", { headers: { Cookie: `mde_gh_session=${cookie}` } }));

    const body = (await res.json()) as AccessRecord;
    expect(body.owner).toBe("alice");
    expect(body.invited).toEqual([{ username: "bob", role: "reviewer" }]);
  });

  it("returns the full roster to an invited collaborator", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", {
      owner: "alice",
      generalAccess: "restricted",
      requireAccount: false,
      role: "viewer",
      invited: [{ username: "bob", role: "reviewer" }],
    });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "bob" });

    const res = await room.handleAccessRequest(new Request("https://example.com/w/ws1/access", { headers: { Cookie: `mde_gh_session=${cookie}` } }));

    const body = (await res.json()) as AccessRecord;
    expect(body.owner).toBe("alice");
    expect(body.invited).toEqual([{ username: "bob", role: "reviewer" }]);
  });
});

const SNAPSHOT_INTERVAL_MS = 30 * 1000;

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
});

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

describe("WorkspaceRoom.handleVersionRestoreContentRequest", () => {
  it("replaces the doc's content and records a new snapshot", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.transact(() => docRoom.doc.getText("content").insert(0, "old content"), "storage");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs/docA/versions/restore-content", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "restored content" }),
    });
    const res = await room.handleVersionRestoreContentRequest(request, "docA");
    expect(res.status).toBe(200);
    expect(docRoom.doc.getText("content").toString()).toBe("restored content");
    const snapshots = await room.getSnapshots("docA");
    expect(snapshots[snapshots.length - 1]!.content).toBe("restored content");
  });

  it("rejects a non-editor", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", {
      owner: "alice",
      generalAccess: "restricted",
      requireAccount: false,
      role: "viewer",
      invited: [{ username: "bob", role: "reviewer" }],
    });
    await room.loadDocRoom("docA");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "bob" });
    const request = new Request("https://example.com/w/ws1/docs/docA/versions/restore-content", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "restored content" }),
    });
    const res = await room.handleVersionRestoreContentRequest(request, "docA");
    expect(res.status).toBe(403);
  });

  it("rejects a request with no content", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    await room.loadDocRoom("docA");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs/docA/versions/restore-content", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await room.handleVersionRestoreContentRequest(request, "docA");
    expect(res.status).toBe(400);
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

describe("reviewer writes", () => {
  function fakeSession(role: "viewer" | "reviewer" | "editor") {
    return { username: "bob", role, viewingDocId: null };
  }

  function scratchUpdateWith(text: string): Uint8Array {
    const scratch = new Y.Doc();
    scratch.getText("content").insert(0, text);
    return Y.encodeStateAsUpdate(scratch);
  }

  it("a reviewer's update now applies instead of being dropped", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    const docRoom = await room.loadDocRoom("doc1");
    await room.handleMessage(ws, encodeSyncUpdate("doc1", scratchUpdateWith("hello")));

    expect(docRoom.doc.getText("content").toString()).toBe("hello");
  });

  it("a viewer's update is still dropped", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    (room as any).sessions.set(ws, fakeSession("viewer"));

    const docRoom = await room.loadDocRoom("doc1");
    await room.handleMessage(ws, encodeSyncUpdate("doc1", scratchUpdateWith("hello")));

    expect(docRoom.doc.getText("content").toString()).toBe("");
  });

  it("auto-wraps a reviewer's raw, unsuggested insert into a suggestion entry server-side", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    const docRoom = await room.loadDocRoom("doc1");
    await room.handleMessage(ws, encodeSyncUpdate("doc1", scratchUpdateWith("hello")));

    const list = listResolvedSuggestions(docRoom.doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "insert", author: "bob", from: 0, to: 5 });
  });

  it("does not double-wrap a reviewer's update that already includes its own suggestion entry", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    const docRoom = await room.loadDocRoom("doc1");
    const scratch = new Y.Doc();
    scratch.getText("content").insert(0, "hello");
    recordInsertSuggestion(scratch, 0, 5, "bob");
    await room.handleMessage(ws, encodeSyncUpdate("doc1", Y.encodeStateAsUpdate(scratch)));

    expect(listResolvedSuggestions(docRoom.doc)).toHaveLength(1);
  });

  it("converges to one suggestion even when a reviewer's ytext insert and its own suggestion entry arrive as two separate updates", async () => {
    // Reproduces a real bug only a genuine networked run surfaced: a real
    // browser client never sends the ytext insert and its suggestion-map
    // entry as one combined update the way the test above does.
    // y-codemirror.next's ySync plugin writes the ytext change via its
    // own doc.transact() call the instant CM6 dispatches; suggestion-
    // editor.ts's suggestionInsertListener records the suggestion entry
    // afterward, from a separate EditorView.updateListener, via a SECOND,
    // independent doc.transact() call — so a correctly-behaving reviewer
    // client always emits two separate Yjs updates for one keystroke,
    // never one. The first (ytext-only) update reaches this room's
    // ytext.observe before the second (suggestion-only) update has
    // arrived, so the server's own reconciliation auto-wraps it — then
    // the client's own suggestion entry arrives right behind it. Without
    // dedup, both entries survive, leaving two overlapping suggestions
    // covering the identical range.
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    (room as any).sessions.set(ws, fakeSession("reviewer"));
    const docRoom = await room.loadDocRoom("doc1");

    const client = new Y.Doc();
    const beforeInsert = Y.encodeStateVector(client);
    client.getText("content").insert(0, "hello");
    const afterInsert = Y.encodeStateVector(client);
    const insertUpdate = Y.encodeStateAsUpdate(client, beforeInsert);
    recordInsertSuggestion(client, 0, 5, "bob");
    const suggestionUpdate = Y.encodeStateAsUpdate(client, afterInsert);

    await room.handleMessage(ws, encodeSyncUpdate("doc1", insertUpdate));
    expect(listResolvedSuggestions(docRoom.doc)).toHaveLength(1); // server's own reconciliation already wrapped it

    await room.handleMessage(ws, encodeSyncUpdate("doc1", suggestionUpdate));
    expect(listResolvedSuggestions(docRoom.doc)).toHaveLength(1); // must converge, not double up
  });

  it("merges overlapping-but-not-identical same-author insert suggestions, not just exact duplicates", async () => {
    // Across several rapid keystrokes, the client-vs-server race above
    // doesn't always leave two IDENTICAL ranges: each side's own
    // contiguous-extend logic (recordInsertSuggestion's "does an existing
    // entry's `to` already match this insert's `from`") can pick a
    // DIFFERENT one of the two duplicate candidates to extend, so the
    // pair drifts into overlapping-but-not-equal ranges instead — this
    // reproduces that end state directly (three suggestion entries for
    // the same author covering [5,6), [5,7), and [6,8), all overlapping
    // or touching) rather than re-deriving it keystroke by keystroke.
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "hello world");

    recordInsertSuggestion(docRoom.doc, 5, 6, "bob");
    recordInsertSuggestion(docRoom.doc, 5, 7, "bob");
    recordInsertSuggestion(docRoom.doc, 6, 8, "bob");

    const list = listResolvedSuggestions(docRoom.doc);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "insert", author: "bob", from: 5, to: 8 });
  });

  it("an editor's write is never reconciled into a suggestion", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    (room as any).sessions.set(ws, fakeSession("editor"));

    const docRoom = await room.loadDocRoom("doc1");
    await room.handleMessage(ws, encodeSyncUpdate("doc1", scratchUpdateWith("hello")));

    expect(getSuggestionsMap(docRoom.doc).size).toBe(0);
  });
});
