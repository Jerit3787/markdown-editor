import { describe, it, expect, vi, afterEach } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { WorkspaceRoom } from "../../src/workspace-room";
import type { AccessRecord, DocRoom } from "../../src/workspace-room";
import { encryptSession } from "../../src/auth";
import type { Env } from "../../src/env";
import { getSuggestionsMap, recordInsertSuggestion, recordDeleteSuggestion, listResolvedSuggestions } from "../../src/suggestions";
import {
  getCommentsMap,
  listResolvedCommentThreads,
  createCommentThread,
  addCommentReply,
  resolveCommentThread,
  deleteCommentThread,
  addSuggestionReply,
} from "../../src/comments-doc";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_WORKSPACE_META = 3;

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
      delete: async (keyOrKeys: string | string[]) => {
        const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
        let count = 0;
        for (const k of keys) if (store.delete(k)) count++;
        return count;
      },
      deleteAll: async () => {
        store.clear();
      },
      setAlarm: async () => {},
      deleteAlarm: async () => {},
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

  it("registers a new docId as a workspace member on its first sync frame (persisted)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const clientWs = { send: () => {} } as unknown as WebSocket;
    room.sessions.set(clientWs, { username: "alice", role: "editor", viewingDocId: null });

    const scratch = new Y.Doc();
    scratch.getText("content").insert(0, "brand new doc");
    await room.handleMessage(clientWs, encodeSyncUpdate("docNew", Y.encodeStateAsUpdate(scratch)));

    expect(room.docIds).toContain("docNew");
    expect(await room.state.storage.get("docs")).toContain("docNew");
  });

  it("loading a doc room (e.g. to read its version history) does NOT make the doc a workspace member", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", {
      owner: "alice",
      generalAccess: "anyone",
      requireAccount: false,
      role: "editor",
      invited: [],
    });

    await room.loadDocRoom("never-synced");

    expect(room.docIds).not.toContain("never-synced");
    expect((await room.state.storage.get<string[]>("docs")) ?? []).not.toContain("never-synced");
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

  it("turnstile: authorize() itself no longer gates — the anon 'anyone' role still resolves", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    const res = await room.authorize(new Request("https://example.com/api/workspace/ws1"));
    expect(res).toEqual({ ok: true, username: null, role: "viewer" });
  });
});

describe("WorkspaceRoom.requireJoinTicket", () => {
  const anyoneAccess = { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] };

  it("anonymous on an 'anyone' link needs a valid ticket when configured", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", anyoneAccess);

    const noTicket = await room.requireJoinTicket(new Request("https://example.com/api/workspace/ws1"));
    expect(noTicket).toEqual({ ok: false, status: 401, message: "turnstile-required" });

    const { mintJoinTicket } = await import("../../src/turnstile");
    const good = await mintJoinTicket("ws1", "test-secret-key-not-real", Date.now());
    const withTicket = await room.requireJoinTicket(new Request(`https://example.com/api/workspace/ws1?ticket=${encodeURIComponent(good)}`));
    expect(withTicket).toEqual({ ok: true });
  });

  it("a ticket for another workspace is rejected", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", anyoneAccess);
    const { mintJoinTicket } = await import("../../src/turnstile");
    const wrong = await mintJoinTicket("other-ws", "test-secret-key-not-real", Date.now());
    const res = await room.requireJoinTicket(new Request(`https://example.com/api/workspace/ws1?ticket=${encodeURIComponent(wrong)}`));
    expect(res.ok).toBe(false);
  });

  it("a signed-in visitor bypasses the ticket check", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", anyoneAccess);
    const cookie = await encryptSession(fakeEnvWithTurnstile, { token: "t", username: "carol" });
    const res = await room.requireJoinTicket(new Request("https://example.com/api/workspace/ws1", { headers: { Cookie: `mde_gh_session=${cookie}` } }));
    expect(res).toEqual({ ok: true });
  });

  it("no check when TURNSTILE_SECRET_KEY is unset", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", anyoneAccess);
    const res = await room.requireJoinTicket(new Request("https://example.com/api/workspace/ws1"));
    expect(res).toEqual({ ok: true });
  });

  it("no check on a restricted link — the existing role check already stops anon there", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const res = await room.requireJoinTicket(new Request("https://example.com/api/workspace/ws1"));
    expect(res).toEqual({ ok: true });
  });

  it("no check on a ?preview=1 socket — the throwaway pre-join snapshot fetch stays open", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", anyoneAccess);
    const res = await room.requireJoinTicket(new Request("https://example.com/api/workspace/ws1?preview=1"));
    expect(res).toEqual({ ok: true });
  });
});

describe("WorkspaceRoom websocket session role", () => {
  // The Node unit env can't construct the `101` upgrade Response, but
  // handleSession runs before that — inspect the session it created.
  async function rolesAfterUpgrade(query: string) {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });
    await room.fetch(new Request(`https://example.com/api/workspace/ws1${query}`, { headers: { Upgrade: "websocket" } })).catch(() => {});
    return [...(room as unknown as { sessions: Map<unknown, { role: string }> }).sessions.values()].map((s) => s.role);
  }

  it("pins a ?preview=1 socket to viewer even on an 'anyone can edit' workspace (MDE-01)", async () => {
    expect(await rolesAfterUpgrade("?preview=1")).toEqual(["viewer"]);
  });

  it("a normal socket keeps its resolved role", async () => {
    expect(await rolesAfterUpgrade("")).toEqual(["editor"]);
  });

  it("re-resolves the role against current access after the join-ticket await, not the stale authorize() result (MDE-16)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    // Storage says restricted / no anon access — but authorize() is faked
    // to have resolved 'editor' just before the owner locked it down.
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    (room as unknown as { authorize: () => Promise<unknown> }).authorize = async () => ({ ok: true, username: null, role: "editor" });

    const res = await room.fetch(new Request("https://example.com/api/workspace/ws1", { headers: { Upgrade: "websocket" } })).catch((e) => e as Error);

    expect((res as Response).status).toBe(403);
    expect(room.sessions.size).toBe(0);
  });
});

const fakeEnvWithTurnstile = {
  SESSION_SECRET: "test-secret-key-not-real",
  TURNSTILE_SECRET_KEY: "test-turnstile-secret",
} as unknown as Env;

function joinTicketReq(opts: { workspaceId?: string; cookie?: string; body?: unknown } = {}): Request {
  const wsId = opts.workspaceId ?? "ws1";
  return new Request(`https://example.com/api/workspace/${wsId}/join-ticket`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.cookie ? { Cookie: `mde_gh_session=${opts.cookie}` } : {}),
    },
    body: JSON.stringify(opts.body ?? { token: "widget-token" }),
  });
}

describe("WorkspaceRoom.handleJoinTicket", () => {
  afterEach(() => vi.unstubAllGlobals());
  const okAccess = { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] };

  it("returns { enabled: false } when TURNSTILE_SECRET_KEY is unset", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", okAccess);
    const res = await room.handleJoinTicket(joinTicketReq());
    expect(await res.json()).toEqual({ enabled: false });
  });

  it("returns { skip: true } for a signed-in visitor and never calls siteverify", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", okAccess);
    const cookie = await encryptSession(fakeEnvWithTurnstile, { token: "t", username: "bob" });
    const res = await room.handleJoinTicket(joinTicketReq({ cookie }));
    expect(await res.json()).toEqual({ skip: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mints a workspace-scoped ticket when the token verifies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
    );
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", okAccess);
    const res = await room.handleJoinTicket(joinTicketReq({ workspaceId: "ws1" }));
    const body = (await res.json()) as { ticket: string };
    expect(typeof body.ticket).toBe("string");
    const { verifyJoinTicket } = await import("../../src/turnstile");
    expect(await verifyJoinTicket(body.ticket, "ws1", "test-secret-key-not-real", Date.now())).toBe(true);
    expect(await verifyJoinTicket(body.ticket, "ws2", "test-secret-key-not-real", Date.now())).toBe(false);
  });

  it("403 turnstile-failed when the token does not verify", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 200 })),
    );
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", okAccess);
    const res = await room.handleJoinTicket(joinTicketReq());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "turnstile-failed" });
  });

  it("400 when the body has no token", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    await room.state.storage.put("access", okAccess);
    const res = await room.handleJoinTicket(joinTicketReq({ body: {} }));
    expect(res.status).toBe(400);
  });

  it("405 on a non-POST", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithTurnstile);
    const res = await room.handleJoinTicket(new Request("https://example.com/api/workspace/ws1/join-ticket"));
    expect(res.status).toBe(405);
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

  it("downgrades and revokes live sessions when the owner changes access (MDE-02)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", {
      owner: "alice",
      generalAccess: "anyone",
      requireAccount: false,
      role: "editor",
      invited: [{ username: "bob", role: "editor" }],
    });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });

    const bobWs = { send: () => {}, close: vi.fn() } as unknown as WebSocket;
    const anonWs = { send: () => {}, close: vi.fn() } as unknown as WebSocket;
    room.sessions.set(bobWs, { username: "bob", role: "editor", viewingDocId: null });
    room.sessions.set(anonWs, { username: null, role: "editor", viewingDocId: null });

    // Downgrade bob to reviewer and close the public link entirely.
    await room.handleAccessRequest(
      new Request("https://example.com/w/ws1/access", {
        method: "PUT",
        headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
        body: JSON.stringify({ generalAccess: "restricted", role: "viewer", invited: [{ username: "bob", role: "reviewer" }] }),
      }),
    );

    expect(room.sessions.get(bobWs)?.role).toBe("reviewer");
    expect(room.sessions.has(anonWs)).toBe(false); // anon lost all access → socket closed + dropped
    expect(anonWs.close as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(4403, "Access revoked");
  });

  it("keeps a ?preview=1 socket pinned to viewer through an access change (MDE-11)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });

    const previewWs = { send: () => {}, close: vi.fn() } as unknown as WebSocket;
    room.sessions.set(previewWs, { username: null, role: "viewer", viewingDocId: null, isPreview: true });

    await room.handleAccessRequest(
      new Request("https://example.com/w/ws1/access", {
        method: "PUT",
        headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
        body: JSON.stringify({ generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] }),
      }),
    );

    expect(room.sessions.get(previewWs)?.role).toBe("viewer"); // NOT re-resolved to editor
    expect(room.sessions.has(previewWs)).toBe(true);
  });

  it("still closes a preview socket that loses all access", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });

    const previewWs = { send: () => {}, close: vi.fn() } as unknown as WebSocket;
    room.sessions.set(previewWs, { username: null, role: "viewer", viewingDocId: null, isPreview: true });

    await room.handleAccessRequest(
      new Request("https://example.com/w/ws1/access", {
        method: "PUT",
        headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
        body: JSON.stringify({ generalAccess: "restricted", role: "viewer", invited: [] }),
      }),
    );

    expect(room.sessions.has(previewWs)).toBe(false);
    expect(previewWs.close as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(4403, "Access revoked");
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

describe("WorkspaceRoom DELETE /api/workspace/:id (owner revoke)", () => {
  const OWNER_ACCESS = { owner: "alice", generalAccess: "anyone" as const, requireAccount: false, role: "editor" as const, invited: [] };

  async function deleteRequest(username: string | null): Promise<Request> {
    const init: RequestInit = { method: "DELETE" };
    if (username !== null) {
      const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username });
      init.headers = { Cookie: `mde_gh_session=${cookie}` };
    }
    return new Request("https://example.com/api/workspace/ws1", init);
  }

  it("lets the owner delete: 204, then every route 410s", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", OWNER_ACCESS);

    const del = await room.fetch(await deleteRequest("alice"));
    expect(del.status).toBe(204);

    const access = await room.fetch(new Request("https://example.com/api/workspace/ws1/access"));
    expect(access.status).toBe(410);

    const upgrade = await room.fetch(new Request("https://example.com/api/workspace/ws1", { headers: { Upgrade: "websocket" } }));
    expect(upgrade.status).toBe(410);
  });

  it("persists the tombstone across a reconstruct", async () => {
    const state = fakeState();
    const room1 = new WorkspaceRoom(state, fakeEnvWithSecret);
    await room1.state.storage.put("access", OWNER_ACCESS);
    await room1.fetch(await deleteRequest("alice"));

    const room2 = new WorkspaceRoom(state, fakeEnvWithSecret);
    await new Promise((r) => setTimeout(r, 0)); // let the constructor's blockConcurrencyWhile drain
    const access = await room2.fetch(new Request("https://example.com/api/workspace/ws1/access"));
    expect(access.status).toBe(410);
  });

  it("refuses a non-owner editor: 403, room still live", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { ...OWNER_ACCESS, generalAccess: "restricted", invited: [{ username: "bob", role: "editor" }] });

    const del = await room.fetch(await deleteRequest("bob"));
    expect(del.status).toBe(403);

    const access = await room.fetch(new Request("https://example.com/api/workspace/ws1/access"));
    expect(access.status).toBe(200);
  });

  it("refuses an unauthenticated caller on a restricted workspace: 401", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { ...OWNER_ACCESS, generalAccess: "restricted" });
    const del = await room.fetch(await deleteRequest(null));
    expect(del.status).toBe(401);
  });

  it("broadcasts MESSAGE_WORKSPACE_DELETED to live sessions and closes them", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", OWNER_ACCESS);
    const sent: ArrayBuffer[] = [];
    let closed = false;
    const ws = {
      send: (d: ArrayBuffer) => sent.push(d),
      close: () => {
        closed = true;
      },
    } as unknown as WebSocket;
    room.sessions.set(ws, { username: "bob", role: "editor", viewingDocId: null });

    await room.fetch(await deleteRequest("alice"));

    expect(closed).toBe(true);
    expect(room.sessions.size).toBe(0);
    const gotDeletedFrame = sent.some((buf) => decoding.readVarUint(decoding.createDecoder(new Uint8Array(buf))) === 5);
    expect(gotDeletedFrame).toBe(true);
  });

  it("a persist alarm scheduled just before DELETE does not resurrect document content (MDE-08)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", OWNER_ACCESS);

    // An edit lands and schedules the debounced persist.
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.getText("content").insert(0, "secret content");
    await room.schedulePersist("docA", docRoom);
    expect(docRoom.persistScheduled).toBe(true);

    await room.fetch(await deleteRequest("alice"));
    expect(await room.state.storage.get("doc:docA:update")).toBeUndefined();

    // The alarm fires afterward — it must be a no-op now.
    await room.alarm();
    expect(await room.state.storage.get("doc:docA:update")).toBeUndefined();
    expect(room.docs.size).toBe(0);
  });

  it("a snapshot in flight when DELETE lands does not resurrect doc:*:snapshots (MDE-14)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", OWNER_ACCESS);
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.getText("content").insert(0, "secret content");

    await room.fetch(await deleteRequest("alice"));
    expect(await room.state.storage.get("doc:docA:snapshots")).toBeUndefined();

    // A maybeSnapshot() call that was queued before the wipe now runs.
    await room.maybeSnapshot("docA", docRoom, Date.now());
    expect(await room.state.storage.get("doc:docA:snapshots")).toBeUndefined();
  });

  it("forceSnapshot bails on a deleted workspace and the restore handler 410s (MDE-18)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", OWNER_ACCESS);
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.getText("content").insert(0, "v1 content");
    const first = await room.forceSnapshot("docA", docRoom, "v1 content", 1000, "alice");
    expect(first).not.toBeNull();

    await room.fetch(await deleteRequest("alice"));
    expect(await room.state.storage.get("doc:docA:snapshots")).toBeUndefined();

    // A forceSnapshot() from a restore request that was in flight during DELETE.
    expect(await room.forceSnapshot("docA", docRoom, "v2 content", 2000, "alice")).toBeNull();
    expect(await room.state.storage.get("doc:docA:snapshots")).toBeUndefined();

    // And the HTTP restore path returns 410 rather than a bogus 200.
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const restore = new Request("https://example.com/w/ws1/docs/docA/versions/restore-content", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "resurrected" }),
    });
    expect((await room.fetch(restore)).status).toBe(410);
  });

  it("a session-less socket's write frame is rejected, not applied (MDE-17)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "committed");

    let closeCode: number | undefined;
    const orphanWs = { send: () => {}, close: (c: number) => (closeCode = c) } as unknown as WebSocket;
    // orphanWs is NOT in room.sessions — e.g. reconcileSessionRoles just dropped it.

    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(docRoom.doc));
    scratch.getText("content").delete(0, 9);
    await room.handleMessage(orphanWs, encodeSyncUpdate("doc1", Y.encodeStateAsUpdate(scratch, Y.encodeStateVector(docRoom.doc))));

    expect(docRoom.doc.getText("content").toString()).toBe("committed"); // untouched
    expect(closeCode).toBe(4401);
  });

  it("re-checks the tombstone before accepting a websocket (handshake TOCTOU, MDE-19)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", OWNER_ACCESS);
    // Simulate DELETE landing during the handshake's authorize() await.
    const realAuthorize = room.authorize.bind(room);
    (room as unknown as { authorize: (r: Request) => Promise<unknown> }).authorize = async (r: Request) => {
      const out = await realAuthorize(r);
      (room as unknown as { deleted: boolean }).deleted = true;
      return out;
    };

    const res = await room.fetch(new Request("https://example.com/api/workspace/ws1", { headers: { Upgrade: "websocket" } })).catch((e) => e as Error);

    expect((res as Response).status).toBe(410);
    expect(room.sessions.size).toBe(0);
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
    const created = (await room.forceSnapshot("docA", docRoom, "forced content", 2000))!;
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

describe("Snapshot authorship", () => {
  function scratchUpdateWith(text: string): Uint8Array {
    const scratch = new Y.Doc();
    scratch.getText("content").insert(0, text);
    return Y.encodeStateAsUpdate(scratch);
  }
  function sessionWs(room: WorkspaceRoom, username: string | null): WebSocket {
    const ws = { send: () => {} } as unknown as WebSocket;
    (room as unknown as { sessions: Map<WebSocket, unknown> }).sessions.set(ws, { username, role: "editor", viewingDocId: null });
    return ws;
  }

  const setContent = (docRoom: { doc: Y.Doc }, text: string) =>
    docRoom.doc.transact(() => {
      const t = docRoom.doc.getText("content");
      t.delete(0, t.length);
      t.insert(0, text);
    }, "storage");

  it("handleDocUpdate accumulates each editing session's username into pendingAuthors, first-seen order", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const alice = sessionWs(room, "alice");
    const bob = sessionWs(room, "bob");
    const anon = sessionWs(room, null);
    const docRoom = await room.loadDocRoom("d1");
    docRoom.lastSnapshotAt = Date.now(); // suppress the first-edit auto-capture so accumulation is observable

    await room.handleMessage(alice, encodeSyncUpdate("d1", scratchUpdateWith("a")));
    await room.handleMessage(bob, encodeSyncUpdate("d1", scratchUpdateWith("a b")));
    await room.handleMessage(anon, encodeSyncUpdate("d1", scratchUpdateWith("a b c")));
    await room.handleMessage(alice, encodeSyncUpdate("d1", scratchUpdateWith("a b c d")));

    expect([...docRoom.pendingAuthors]).toEqual(["alice", "bob"]); // anon (null username) contributes nothing
  });

  it("maybeSnapshot flushes pendingAuthors onto the snapshot and clears it", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const docRoom = await room.loadDocRoom("d1");
    setContent(docRoom, "content");
    docRoom.pendingAuthors = new Set(["alice", "bob"]);

    await room.maybeSnapshot("d1", docRoom, 1000);

    expect((await room.getSnapshots("d1")).at(-1)!.authors).toEqual(["alice", "bob"]);
    expect(docRoom.pendingAuthors.size).toBe(0);
  });

  it("a snapshot with no recorded authors leaves the field undefined", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const docRoom = await room.loadDocRoom("d1");
    setContent(docRoom, "content");
    await room.maybeSnapshot("d1", docRoom, 1000);
    expect((await room.getSnapshots("d1")).at(-1)!.authors).toBeUndefined();
  });

  it("carries authors from a throttled (skipped) capture into the next real one", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const docRoom = await room.loadDocRoom("d1");

    setContent(docRoom, "one");
    docRoom.pendingAuthors.add("alice");
    await room.maybeSnapshot("d1", docRoom, 1000); // captures [alice], clears

    setContent(docRoom, "two");
    docRoom.pendingAuthors.add("bob");
    await room.maybeSnapshot("d1", docRoom, 1000 + 5000); // < 30s -> skipped, pendingAuthors keeps {bob}

    setContent(docRoom, "three");
    docRoom.pendingAuthors.add("carol");
    await room.maybeSnapshot("d1", docRoom, 1000 + 35000); // captures [bob, carol]

    const snaps = await room.getSnapshots("d1");
    expect(snaps.map((s) => s.authors)).toEqual([["alice"], ["bob", "carol"]]);
  });

  it("forceSnapshot records the given author", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const docRoom = await room.loadDocRoom("d1");
    const snap = (await room.forceSnapshot("d1", docRoom, "restored", 2000, "carol"))!;
    expect(snap.authors).toEqual(["carol"]);
  });

  it("the versions list returns authors, [] for a legacy author-less snapshot", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    await room.state.storage.put("doc:d1:snapshots", [
      { id: "s1", timestamp: 1, content: "a" },
      { id: "s2", timestamp: 2, content: "b", authors: ["alice"] },
    ]);
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const res = await room.handleVersionsListRequest(
      new Request("https://example.com/w/ws1/docs/d1/versions", { headers: { Cookie: `mde_gh_session=${cookie}` } }),
      "d1",
    );
    const list = (await res.json()) as Array<{ id: string; authors: string[] }>;
    expect(list.find((x) => x.id === "s1")!.authors).toEqual([]);
    expect(list.find((x) => x.id === "s2")!.authors).toEqual(["alice"]);
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
    const oldSnap = (await room.forceSnapshot("docA", docRoom, "old content", 1000))!;
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
    const snapNoImages = (await room.forceSnapshot("docA", docRoom, "no images here", 1000))!;
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

describe("WorkspaceRoom.handleWikilinkRenameRequest", () => {
  it("rejects a request with no session on a restricted workspace", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    await room.loadDocRoom("docA");
    const request = new Request("https://example.com/w/ws1/docs/docA/wikilink-rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldName: "Old", newName: "New" }),
    });
    const res = await room.handleWikilinkRenameRequest(request, "docA");
    expect(res.status).toBe(401);
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
    const request = new Request("https://example.com/w/ws1/docs/docA/wikilink-rename", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ oldName: "Old", newName: "New" }),
    });
    const res = await room.handleWikilinkRenameRequest(request, "docA");
    expect(res.status).toBe(403);
  });

  it("rejects a request missing oldName or newName", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    await room.loadDocRoom("docA");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs/docA/wikilink-rename", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ oldName: "Old" }),
    });
    const res = await room.handleWikilinkRenameRequest(request, "docA");
    expect(res.status).toBe(400);
  });

  it("rewrites the room's live content and returns changed: true", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.transact(() => docRoom.doc.getText("content").insert(0, "See [[Old]] here"), "storage");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs/docA/wikilink-rename", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ oldName: "Old", newName: "New" }),
    });
    const res = await room.handleWikilinkRenameRequest(request, "docA");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean };
    expect(body.changed).toBe(true);
    expect(docRoom.doc.getText("content").toString()).toBe("See [[New]] here");
  });

  it("leaves a [[Old]] inside a code span untouched", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.transact(() => docRoom.doc.getText("content").insert(0, "`[[Old]]` and [[Old]]"), "storage");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs/docA/wikilink-rename", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ oldName: "Old", newName: "New" }),
    });
    const res = await room.handleWikilinkRenameRequest(request, "docA");
    expect(res.status).toBe(200);
    expect(docRoom.doc.getText("content").toString()).toBe("`[[Old]]` and [[New]]");
  });

  it("returns changed: false and doesn't transact when the name isn't present", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const docRoom = await room.loadDocRoom("docA");
    docRoom.doc.transact(() => docRoom.doc.getText("content").insert(0, "unrelated content"), "storage");
    let updateFired = false;
    docRoom.doc.on("update", () => {
      updateFired = true;
    });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const request = new Request("https://example.com/w/ws1/docs/docA/wikilink-rename", {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ oldName: "Old", newName: "New" }),
    });
    const res = await room.handleWikilinkRenameRequest(request, "docA");
    const body = (await res.json()) as { changed: boolean };
    expect(body.changed).toBe(false);
    expect(docRoom.doc.getText("content").toString()).toBe("unrelated content");
    expect(updateFired).toBe(false);
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
    const decoder = decoding.createDecoder(new Uint8Array(sent[0]!));
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_WORKSPACE_META);
    decoding.readVarString(decoder); // name, irrelevant here
    const count = decoding.readVarUint(decoder);
    const ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push(decoding.readVarString(decoder));
    expect(ids).toEqual(["docB"]);
  });
});

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

  it("rejects a non-owner editor and an anonymous visitor on a public 'anyone can edit' workspace (MDE-10)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", {
      owner: "alice",
      generalAccess: "anyone",
      requireAccount: false,
      role: "editor",
      invited: [{ username: "bob", role: "editor" }],
    });
    const mk = (cookie?: string) =>
      room.handleMetaRequest(
        new Request("https://example.com/w/ws1/meta", {
          method: "PUT",
          headers: { ...(cookie ? { Cookie: `mde_gh_session=${cookie}` } : {}), "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Hijacked", repoLinked: true }),
        }),
      );
    expect((await mk(await encryptSession(fakeEnvWithSecret, { token: "t", username: "bob" }))).status).toBe(403);
    expect((await mk()).status).toBe(403);
    expect(room.name).toBe("");
    expect(room.repoLinked).toBe(false);
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
    expect(await res.json()).toEqual({ name: "Renamed Workspace", repoLinked: false });
    expect(room.name).toBe("Renamed Workspace");
    expect(await room.state.storage.get("name")).toBe("Renamed Workspace");
  });

  it("accepts a repoLinked flag from an editor and carries it in the next meta frame", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });
    room.docIds = ["docA", "docB"];
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const res = await room.handleMetaRequest(
      new Request("https://example.com/w/ws1/meta", {
        method: "PUT",
        headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
        body: JSON.stringify({ repoLinked: true }),
      }),
    );
    expect(res.status).toBe(200);
    expect(room.repoLinked).toBe(true);
    expect(await room.state.storage.get("repoLinked")).toBe(true);

    const dec = decoding.createDecoder(room.encodeWorkspaceMeta());
    expect(decoding.readVarUint(dec)).toBe(MESSAGE_WORKSPACE_META);
    decoding.readVarString(dec); // name
    const n = decoding.readVarUint(dec);
    for (let i = 0; i < n; i++) decoding.readVarString(dec);
    expect(decoding.readVarUint(dec)).toBe(1); // trailing repoLinked
  });

  it("still accepts a name-only PUT and rejects an empty body", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "alice" });
    const mk = (body: unknown) =>
      room.handleMetaRequest(
        new Request("https://example.com/w/ws1/meta", {
          method: "PUT",
          headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    expect((await mk({ name: "Renamed" })).status).toBe(200);
    expect((await mk({})).status).toBe(400);
  });

  it("rejects a non-editor's repoLinked PUT", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "gh-token", username: "carol" });
    const res = await room.handleMetaRequest(
      new Request("https://example.com/w/ws1/meta", {
        method: "PUT",
        headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
        body: JSON.stringify({ repoLinked: true }),
      }),
    );
    expect(res.status).toBe(403);
    expect(room.repoLinked).toBe(false);
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
    const decoder = decoding.createDecoder(new Uint8Array(sent[0]!));
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
    const state = fakeState();
    await state.storage.put("name", "My Shared Workspace");
    const room = new WorkspaceRoom(state, fakeEnvWithSecret);
    await room.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    // The constructor's own blockConcurrencyWhile load of "name" is
    // fire-and-forget from the fakeState() stub (unlike a real Durable
    // Object, it doesn't actually block requests until it settles) — wait
    // a macrotask tick so it's guaranteed to have applied before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const res = await room.handleAccessRequest(new Request("https://example.com/w/ws1/access"));
    const body = (await res.json()) as AccessRecord & { workspaceName: string };
    expect(body.workspaceName).toBe("My Shared Workspace");
  });

  it("a freshly-connected session is greeted with the current workspace meta", async () => {
    const state = fakeState();
    await state.storage.put("name", "Greeted Workspace");
    await state.storage.put("docs", ["docA"]);
    const room = new WorkspaceRoom(state, fakeEnvWithSecret);
    // Same settling wait as above — the constructor also needs to finish
    // loading docA's DocRoom before handleSession can greet it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sent: ArrayBuffer[] = [];
    const ws = { send: (m: ArrayBuffer) => sent.push(m), accept: () => {}, addEventListener: () => {} } as unknown as WebSocket;

    room.handleSession(ws, "alice", "editor");

    // One sync-step1 frame for docA, then the meta greeting.
    const metaFrame = sent[sent.length - 1]!;
    const decoder = decoding.createDecoder(new Uint8Array(metaFrame));
    expect(decoding.readVarUint(decoder)).toBe(MESSAGE_WORKSPACE_META);
    expect(decoding.readVarString(decoder)).toBe("Greeted Workspace");
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

  it("names the workspace and the document after a migration payload's docName when neither is set", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const scratch = new Y.Doc();
    scratch.getText("content").insert(0, "body");
    const request = new Request("https://example.com/internal/seed", {
      method: "POST",
      body: JSON.stringify({
        docId: "docA",
        docName: "Release Notes",
        update: Array.from(Y.encodeStateAsUpdate(scratch)),
        access: { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] },
      }),
    });
    const res = await room.handleInternalSeedRequest(request);
    expect(res.status).toBe(204);
    expect(await room.state.storage.get("name")).toBe("Release Notes");
    const docRoom = await room.loadDocRoom("docA");
    expect(docRoom.doc.getMap("meta").get("name")).toBe("Release Notes");
  });

  it("does not overwrite a meta.name the migrated Y.Doc already carries", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const scratch = new Y.Doc();
    scratch.getText("content").insert(0, "body");
    scratch.getMap("meta").set("name", "Real Name");
    const request = new Request("https://example.com/internal/seed", {
      method: "POST",
      body: JSON.stringify({
        docId: "docA",
        docName: "Fallback Name",
        update: Array.from(Y.encodeStateAsUpdate(scratch)),
      }),
    });
    await room.handleInternalSeedRequest(request);
    const docRoom = await room.loadDocRoom("docA");
    expect(docRoom.doc.getMap("meta").get("name")).toBe("Real Name");
    // The workspace had no name of its own, so the payload's docName still lands there.
    expect(await room.state.storage.get("name")).toBe("Fallback Name");
  });

  it("leaves names alone when the migration payload carries no docName", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    const scratch = new Y.Doc();
    scratch.getText("content").insert(0, "body");
    const request = new Request("https://example.com/internal/seed", {
      method: "POST",
      body: JSON.stringify({ docId: "docA", update: Array.from(Y.encodeStateAsUpdate(scratch)) }),
    });
    await room.handleInternalSeedRequest(request);
    expect(await room.state.storage.get("name")).toBeUndefined();
    const docRoom = await room.loadDocRoom("docA");
    expect(docRoom.doc.getMap("meta").get("name")).toBeUndefined();
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

  it("the merge observer carries every merged suggestion's reply thread onto the survivor (MDE-09)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "hello world");
    const map = getSuggestionsMap(docRoom.doc);

    recordInsertSuggestion(docRoom.doc, 5, 6, "bob");
    const id1 = listResolvedSuggestions(docRoom.doc)[0]!.id;
    map.set(id1, { ...map.get(id1)!, replies: [{ id: "a", author: "carol", body: "first", createdAt: 1 }] });
    recordInsertSuggestion(docRoom.doc, 7, 9, "bob");
    const id2 = listResolvedSuggestions(docRoom.doc).find((s) => s.from === 7)!.id;
    map.set(id2, { ...map.get(id2)!, replies: [{ id: "b", author: "dave", body: "second", createdAt: 2 }] });
    // an entry bridging [5,6) and [7,9) forces the cluster to merge
    recordInsertSuggestion(docRoom.doc, 6, 7, "bob");

    const list = listResolvedSuggestions(docRoom.doc);
    expect(list).toHaveLength(1);
    const survivor = map.get(list[0]!.id) as { replies?: { body: string }[] };
    expect((survivor.replies ?? []).map((r) => r.body).sort()).toEqual(["first", "second"]);
  });

  it("an editor's write is never reconciled into a suggestion", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    (room as any).sessions.set(ws, fakeSession("editor"));

    const docRoom = await room.loadDocRoom("doc1");
    await room.handleMessage(ws, encodeSyncUpdate("doc1", scratchUpdateWith("hello")));

    expect(getSuggestionsMap(docRoom.doc).size).toBe(0);
  });

  // Sync a client Y.Doc to the room, mutate it, send the diff as `ws`.
  async function reviewerApply(room: WorkspaceRoom, ws: WebSocket, mutate: (client: Y.Doc) => void) {
    const docRoom = await room.loadDocRoom("doc1");
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(docRoom.doc));
    const before = Y.encodeStateVector(client);
    mutate(client);
    await room.handleMessage(ws, encodeSyncUpdate("doc1", Y.encodeStateAsUpdate(client, before)));
    return docRoom;
  }

  it("reverts a reviewer's raw deletion of committed text (MDE-05)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "the quick brown fox");
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    await reviewerApply(room, ws, (c) => c.getText("content").delete(4, 12)); // "quick brown "

    expect(docRoom.doc.getText("content").toString()).toBe("the quick brown fox");
    expect(getSuggestionsMap(docRoom.doc).size).toBe(0);
  });

  it("allows a reviewer to delete inside their own pending insert (D2)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "start end");
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    await reviewerApply(room, ws, (c) => c.getText("content").insert(5, " MIDDLE"));
    await reviewerApply(room, ws, (c) => c.getText("content").delete(9, 3)); // "DLE" of " MIDDLE"

    expect(docRoom.doc.getText("content").toString()).toBe("start MID end");
  });

  it("allows a reviewer to withdraw their own pending insert (delete text + entry in one txn)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "start end");
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    await reviewerApply(room, ws, (c) => c.getText("content").insert(5, " NEW"));
    const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;

    await reviewerApply(room, ws, (c) => {
      const s = listResolvedSuggestions(c).find((x) => x.id === sid)!;
      c.transact(() => {
        c.getText("content").delete(s.from, s.to - s.from);
        getSuggestionsMap(c).delete(sid);
      });
    });

    expect(docRoom.doc.getText("content").toString()).toBe("start end");
    expect(getSuggestionsMap(docRoom.doc).size).toBe(0);
  });

  it("an editor's raw deletion is untouched by the reviewer guard", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "the quick brown fox");
    (room as any).sessions.set(ws, fakeSession("editor"));

    await reviewerApply(room, ws, (c) => c.getText("content").delete(4, 12));

    expect(docRoom.doc.getText("content").toString()).toBe("the fox");
  });

  it("reverts a reviewer deleting their own insert entry while the text stays (self-accept) (MDE-06)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "start end");
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    await reviewerApply(room, ws, (c) => c.getText("content").insert(5, " NEW"));
    const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;

    await reviewerApply(room, ws, (c) => getSuggestionsMap(c).delete(sid)); // text " NEW" left behind

    expect(getSuggestionsMap(docRoom.doc).has(sid)).toBe(true);
    expect(listResolvedSuggestions(docRoom.doc)[0]).toMatchObject({ kind: "insert", author: "bob" });
  });

  it("reverts a reviewer deleting another author's suggestion entry (MDE-06)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "hello world");
    recordInsertSuggestion(docRoom.doc, 0, 5, "alice");
    const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;
    (room as any).sessions.set(ws, fakeSession("reviewer")); // bob

    await reviewerApply(room, ws, (c) => getSuggestionsMap(c).delete(sid));

    expect(getSuggestionsMap(docRoom.doc).has(sid)).toBe(true);
  });

  it("allows a reviewer to withdraw their own DELETE-kind suggestion (no text change)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "hello world");
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    await reviewerApply(room, ws, (c) => recordDeleteSuggestion(c, 0, 5, "bob"));
    const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;
    await reviewerApply(room, ws, (c) => getSuggestionsMap(c).delete(sid));

    expect(getSuggestionsMap(docRoom.doc).has(sid)).toBe(false);
  });

  it("an editor accepting an insert (delete entry, keep text) is untouched", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "start NEW end");
    recordInsertSuggestion(docRoom.doc, 5, 9, "bob");
    const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;
    (room as any).sessions.set(ws, fakeSession("editor"));

    await reviewerApply(room, ws, (c) => getSuggestionsMap(c).delete(sid));

    expect(getSuggestionsMap(docRoom.doc).has(sid)).toBe(false);
    expect(docRoom.doc.getText("content").toString()).toBe("start NEW end");
  });

  it("reverts a reviewer re-targeting a suggestion entry's kind/range/author", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "hello world");
    recordInsertSuggestion(docRoom.doc, 0, 5, "bob");
    const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    await reviewerApply(room, ws, (c) => {
      const m = getSuggestionsMap(c);
      const e = m.get(sid)!;
      m.set(sid, { ...e, kind: "delete" });
    });

    expect(getSuggestionsMap(docRoom.doc).get(sid)).toMatchObject({ kind: "insert" });
  });

  it("reverts a client-added suggestion entry with a forged author (MDE-15)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "hello world");
    (room as any).sessions.set(ws, fakeSession("reviewer")); // bob

    await reviewerApply(room, ws, (c) => recordInsertSuggestion(c, 0, 5, "alice"));

    expect(getSuggestionsMap(docRoom.doc).size).toBe(0);
  });

  it("reverts a client-added suggestion entry pre-populated with a fake discussion thread (MDE-15)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "hello world");
    (room as any).sessions.set(ws, fakeSession("reviewer")); // bob

    await reviewerApply(room, ws, (c) => {
      recordInsertSuggestion(c, 0, 5, "bob");
      const id = listResolvedSuggestions(c)[0]!.id;
      const m = getSuggestionsMap(c);
      m.set(id, { ...m.get(id)!, replies: [{ id: "x", author: "alice", body: "Approved and merged", createdAt: 1 }] });
    });

    expect(getSuggestionsMap(docRoom.doc).size).toBe(0);
  });

  it("keeps a genuine self-authored suggestion a reviewer's client adds (MDE-15)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "hello world");
    (room as any).sessions.set(ws, fakeSession("reviewer")); // bob

    await reviewerApply(room, ws, (c) => recordInsertSuggestion(c, 0, 5, "bob"));

    expect(listResolvedSuggestions(docRoom.doc)).toMatchObject([{ author: "bob", kind: "insert" }]);
  });

  // ── MDE-13: raw reviewer delta + repair reach peers as ONE merged frame ──

  function syncFramesFor(frames: ArrayBuffer[]): ArrayBuffer[] {
    return frames.filter((b) => decoding.readVarUint(decoding.createDecoder(new Uint8Array(b))) === MESSAGE_SYNC);
  }

  // A peer synced to the room doc's state, whose outbound frames are captured.
  function attachPeer(room: WorkspaceRoom, docRoom: DocRoom): { doc: Y.Doc; frames: ArrayBuffer[] } {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(docRoom.doc));
    const frames: ArrayBuffer[] = [];
    const peerWs = { send: (d: ArrayBuffer) => frames.push(d) } as unknown as WebSocket;
    (room as any).sessions.set(peerWs, { username: "carol", role: "editor", viewingDocId: null });
    return { doc, frames };
  }

  function applyFrameToPeer(frame: ArrayBuffer, peer: Y.Doc): void {
    const dec = decoding.createDecoder(new Uint8Array(frame));
    decoding.readVarUint(dec); // MESSAGE_SYNC
    decoding.readVarString(dec); // docId
    syncProtocol.readSyncMessage(dec, encoding.createEncoder(), peer, "peer");
  }

  it("a reviewer's committed-text delete reaches peers as ONE merged frame, already repaired (MDE-13)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "the quick brown fox");
    (room as any).sessions.set(ws, fakeSession("reviewer"));
    const peer = attachPeer(room, docRoom);

    await reviewerApply(room, ws, (c) => c.getText("content").delete(4, 12)); // "quick brown "

    const syncFrames = syncFramesFor(peer.frames);
    expect(syncFrames).toHaveLength(1); // NOT the raw delete then the repair

    applyFrameToPeer(syncFrames[0]!, peer.doc);
    expect(peer.doc.getText("content").toString()).toBe("the quick brown fox");
    expect(docRoom.doc.getText("content").toString()).toBe("the quick brown fox");
  });

  it("a clean reviewer insert (no repair) still converges on a peer via the merged frame", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "start end");
    (room as any).sessions.set(ws, fakeSession("reviewer"));
    const peer = attachPeer(room, docRoom);

    await reviewerApply(room, ws, (c) => c.getText("content").insert(5, " NEW"));

    const syncFrames = syncFramesFor(peer.frames);
    expect(syncFrames).toHaveLength(1);

    applyFrameToPeer(syncFrames[0]!, peer.doc);
    expect(peer.doc.getText("content").toString()).toBe("start NEW end");
    expect(docRoom.doc.getText("content").toString()).toBe("start NEW end");
  });

  it("an editor's write still broadcasts immediately, one frame, excluding the sender", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    await room.loadDocRoom("doc1");
    (room as any).sessions.set(ws, fakeSession("editor"));

    const except: unknown[] = [];
    const realBroadcast = room.broadcast.bind(room);
    room.broadcast = (msg: Uint8Array, ex: unknown) => {
      except.push(ex);
      return realBroadcast(msg, ex);
    };

    await reviewerApply(room, ws, (c) => c.getText("content").insert(0, "hello"));

    expect(except).toEqual([ws]); // one broadcast, sender excluded — unchanged behaviour
  });

  it("clears the deferred buffer even if the sync frame throws", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    encoding.writeVarString(enc, "doc1");
    encoding.writeVarUint(enc, 99); // not a valid sync sub-type
    await room.handleMessage(ws, encoding.toUint8Array(enc).buffer as ArrayBuffer).catch(() => {});

    expect((docRoom as unknown as { deferredUpdates: unknown }).deferredUpdates).toBeNull();
  });

  // ── anchor rebinding after a reverted reviewer delete (MDE-13 follow-up) ──

  it("rebinds a comment anchor collapsed by a reviewer's reverted delete", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "the quick brown fox jumps");
    createCommentThread(docRoom.doc, 4, 9, "quick", "alice", "note"); // "quick" is [4,9)
    const cid = [...getCommentsMap(docRoom.doc).keys()][0]!;
    (room as any).sessions.set(ws, fakeSession("reviewer")); // bob

    // hostile reviewer deletes [4,12) — swallows the whole comment anchor
    await reviewerApply(room, ws, (c) => c.getText("content").delete(4, 12));

    expect(docRoom.doc.getText("content").toString()).toBe("the quick brown fox jumps");
    // resolve WITHOUT the quote fallback (no `content` arg) — proves the
    // stored relative positions themselves are correct, not just recoverable
    const threads = listResolvedCommentThreads(docRoom.doc);
    expect(threads).toHaveLength(1);
    expect(threads.find((t) => t.id === cid)).toMatchObject({ from: 4, to: 9 });
  });

  it("rebinds a suggestion anchor collapsed by a reviewer's reverted delete (no quote to fall back on)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "the quick brown fox jumps");
    recordDeleteSuggestion(docRoom.doc, 4, 9, "carol"); // a delete-suggestion on "quick"
    const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;
    (room as any).sessions.set(ws, fakeSession("reviewer")); // bob

    await reviewerApply(room, ws, (c) => c.getText("content").delete(4, 12)); // swallows "quick"

    expect(docRoom.doc.getText("content").toString()).toBe("the quick brown fox jumps");
    const s = listResolvedSuggestions(docRoom.doc).find((x) => x.id === sid);
    expect(s).toMatchObject({ from: 4, to: 9 });
  });

  it("shifts a rebound comment anchor by a reviewer's kept insert when a same-frame delete is reverted", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "the quick brown fox jumps");
    createCommentThread(docRoom.doc, 4, 9, "quick", "alice", "note"); // "quick" is [4,9)
    const cid = [...getCommentsMap(docRoom.doc).keys()][0]!;
    (room as any).sessions.set(ws, fakeSession("reviewer")); // bob

    // one frame: delete [4,12) (contains the comment anchor, reverted) AND
    // insert "NEW " at 0 (kept, auto-wrapped as a suggestion)
    await reviewerApply(room, ws, (c) => {
      c.transact(() => {
        c.getText("content").delete(4, 12);
        c.getText("content").insert(0, "NEW ");
      });
    });

    expect(docRoom.doc.getText("content").toString()).toBe("NEW the quick brown fox jumps");
    const t = listResolvedCommentThreads(docRoom.doc).find((x) => x.id === cid)!;
    // "quick" is 4 chars further along; resolve without the quote fallback
    expect(docRoom.doc.getText("content").toString().slice(t.from, t.to)).toBe("quick");
    expect(t).toMatchObject({ from: 8, to: 13 });
  });

  it("does not rewrite any anchor when the reviewer only inserted (rebind pass never runs)", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, "the quick brown fox");
    createCommentThread(docRoom.doc, 10, 15, "brown", "alice", "note");
    const cid = [...getCommentsMap(docRoom.doc).keys()][0]!;
    const beforeFrom = JSON.stringify(getCommentsMap(docRoom.doc).get(cid)!.from);
    (room as any).sessions.set(ws, fakeSession("reviewer"));

    await reviewerApply(room, ws, (c) => c.getText("content").insert(0, "AA "));

    // the anchor's stored relative position is byte-for-byte unchanged
    expect(JSON.stringify(getCommentsMap(docRoom.doc).get(cid)!.from)).toBe(beforeFrom);
    // and it still points at "brown" (relative positions tracked the shift)
    const t = listResolvedCommentThreads(docRoom.doc, docRoom.doc.getText("content").toString()).find((x) => x.id === cid)!;
    expect(docRoom.doc.getText("content").toString().slice(t.from, t.to)).toBe("brown");
  });
});

describe("WorkspaceRoom comments (Y.Doc)", () => {
  function fakeSession(username: string, role: "viewer" | "reviewer" | "editor") {
    return { username, role, viewingDocId: null };
  }

  async function roomWithDoc(text: string, access?: AccessRecord) {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    if (access) {
      await room.state.storage.put("access", access);
      (room as any).cachedAccess = await room.getAccess();
    }
    const ws = { send: () => {} } as unknown as WebSocket;
    const docRoom = await room.loadDocRoom("doc1");
    docRoom.doc.getText("content").insert(0, text);
    return { room, ws, docRoom };
  }

  // Apply a client-authored change to the doc's `comments` map the way a
  // real WS sync frame would (transaction origin === ws), so the server's
  // observer runs against it.
  async function applyFrom(room: WorkspaceRoom, ws: WebSocket, docRoom: any, mutate: (client: Y.Doc) => void) {
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(docRoom.doc));
    const before = Y.encodeStateVector(client);
    mutate(client);
    await room.handleMessage(ws, encodeSyncUpdate("doc1", Y.encodeStateAsUpdate(client, before)));
  }

  it("a reviewer's new thread survives", async () => {
    const { room, ws, docRoom } = await roomWithDoc("hello world");
    (room as any).sessions.set(ws, fakeSession("bob", "reviewer"));
    await applyFrom(room, ws, docRoom, (c) => createCommentThread(c, 0, 5, "hello", "bob", "q?", 1));
    expect(listResolvedCommentThreads(docRoom.doc)).toHaveLength(1);
  });

  it("a thread claiming a different author is reverted (deleted)", async () => {
    const { room, ws, docRoom } = await roomWithDoc("hello world");
    (room as any).sessions.set(ws, fakeSession("bob", "reviewer"));
    await applyFrom(room, ws, docRoom, (c) => createCommentThread(c, 0, 5, "hello", "eve", "q?", 1));
    expect(listResolvedCommentThreads(docRoom.doc)).toHaveLength(0);
  });

  it("a reply appended under someone else's name is reverted to the prior state", async () => {
    const { room, ws, docRoom } = await roomWithDoc("hello world");
    (room as any).sessions.set(ws, fakeSession("bob", "reviewer"));
    await applyFrom(room, ws, docRoom, (c) => createCommentThread(c, 0, 5, "hello", "bob", "q?", 1));
    const tid = listResolvedCommentThreads(docRoom.doc)[0]!.id;
    await applyFrom(room, ws, docRoom, (c) => addCommentReply(c, tid, "eve", "hi", 2));
    expect(listResolvedCommentThreads(docRoom.doc)[0]!.replies).toHaveLength(1);
  });

  it("a self-authored reply append is kept", async () => {
    const { room, ws, docRoom } = await roomWithDoc("hello world");
    (room as any).sessions.set(ws, fakeSession("bob", "reviewer"));
    await applyFrom(room, ws, docRoom, (c) => createCommentThread(c, 0, 5, "hello", "bob", "q?", 1));
    const tid = listResolvedCommentThreads(docRoom.doc)[0]!.id;
    await applyFrom(room, ws, docRoom, (c) => addCommentReply(c, tid, "bob", "and more", 2));
    expect(listResolvedCommentThreads(docRoom.doc)[0]!.replies.map((r) => r.body)).toEqual(["q?", "and more"]);
  });

  it("a resolve toggle from any non-viewer is kept", async () => {
    const { room, ws, docRoom } = await roomWithDoc("hello world");
    (room as any).sessions.set(ws, fakeSession("bob", "reviewer"));
    await applyFrom(room, ws, docRoom, (c) => createCommentThread(c, 0, 5, "hello", "bob", "q?", 1));
    const tid = listResolvedCommentThreads(docRoom.doc)[0]!.id;
    (room as any).sessions.set(ws, fakeSession("carol", "editor"));
    await applyFrom(room, ws, docRoom, (c) => resolveCommentThread(c, tid, true));
    expect(listResolvedCommentThreads(docRoom.doc)[0]!.resolved).toBe(true);
  });

  it("deleting a thread the session neither started nor owns is reverted", async () => {
    const access: AccessRecord = {
      owner: "alice",
      generalAccess: "restricted",
      requireAccount: false,
      role: "viewer",
      invited: [
        { username: "bob", role: "reviewer" },
        { username: "carol", role: "editor" },
      ],
    };
    const { room, ws, docRoom } = await roomWithDoc("hello world", access);
    (room as any).sessions.set(ws, fakeSession("carol", "editor"));
    await applyFrom(room, ws, docRoom, (c) => createCommentThread(c, 0, 5, "hello", "carol", "q?", 1));
    const tid = listResolvedCommentThreads(docRoom.doc)[0]!.id;
    (room as any).sessions.set(ws, fakeSession("bob", "reviewer"));
    await applyFrom(room, ws, docRoom, (c) => deleteCommentThread(c, tid));
    expect(listResolvedCommentThreads(docRoom.doc)).toHaveLength(1);
  });

  it("the workspace owner can delete any thread", async () => {
    const access: AccessRecord = {
      owner: "alice",
      generalAccess: "restricted",
      requireAccount: false,
      role: "viewer",
      invited: [{ username: "carol", role: "editor" }],
    };
    const { room, ws, docRoom } = await roomWithDoc("hello world", access);
    (room as any).sessions.set(ws, fakeSession("carol", "editor"));
    await applyFrom(room, ws, docRoom, (c) => createCommentThread(c, 0, 5, "hello", "carol", "q?", 1));
    const tid = listResolvedCommentThreads(docRoom.doc)[0]!.id;
    (room as any).sessions.set(ws, fakeSession("alice", "editor"));
    await applyFrom(room, ws, docRoom, (c) => deleteCommentThread(c, tid));
    expect(listResolvedCommentThreads(docRoom.doc)).toHaveLength(0);
  });

  it("a viewer's comment write never applies (isWrite gate)", async () => {
    const { room, ws, docRoom } = await roomWithDoc("hello world");
    (room as any).sessions.set(ws, fakeSession("carol", "viewer"));
    await applyFrom(room, ws, docRoom, (c) => createCommentThread(c, 0, 5, "hello", "carol", "q?", 1));
    expect(listResolvedCommentThreads(docRoom.doc)).toHaveLength(0);
  });

  it("D3: a foreign-authored reply appended to a suggestion is reverted", async () => {
    const { room, ws, docRoom } = await roomWithDoc("hello world");
    (room as any).sessions.set(ws, fakeSession("bob", "reviewer"));
    recordInsertSuggestion(docRoom.doc, 0, 5, "bob");
    const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;
    await applyFrom(room, ws, docRoom, (c) => addSuggestionReply(c, sid, "eve", "not yours", 5));
    const entry = getSuggestionsMap(docRoom.doc).get(sid) as { replies?: unknown[] };
    expect(entry.replies ?? []).toHaveLength(0);
  });

  it("seeds legacy stored comment threads into the Y.Doc on first load", async () => {
    const state = fakeState();
    const room = new WorkspaceRoom(state, fakeEnv);
    const seedDoc = new Y.Doc();
    seedDoc.getText("content").insert(0, "the quick brown fox");
    await state.storage.put("doc:doc1:update", Y.encodeStateAsUpdate(seedDoc));
    await state.storage.put("doc:doc1:comments", [
      {
        id: "t1",
        from: 4,
        to: 9,
        quote: "quick",
        orphaned: false,
        resolved: false,
        comments: [{ id: "c1", author: "alice", body: "why quick?", createdAt: 1 }],
      },
    ]);

    const docRoom = await room.loadDocRoom("doc1");
    const threads = listResolvedCommentThreads(docRoom.doc);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: "t1", quote: "quick", from: 4, to: 9, resolved: false });
    expect(threads[0]!.replies).toEqual([{ id: "c1", author: "alice", body: "why quick?", createdAt: 1 }]);
  });

  it("does not re-seed over a live edit when the doc's comments map is already populated", async () => {
    const state = fakeState();
    const seedDoc = new Y.Doc();
    seedDoc.getText("content").insert(0, "the quick brown fox");
    const legacy = [
      {
        id: "t1",
        from: 4,
        to: 9,
        quote: "quick",
        orphaned: false,
        resolved: false,
        comments: [{ id: "c1", author: "alice", body: "why?", createdAt: 1 }],
      },
    ];
    await state.storage.put("doc:doc1:update", Y.encodeStateAsUpdate(seedDoc));
    await state.storage.put("doc:doc1:comments", legacy);

    const room1 = new WorkspaceRoom(state, fakeEnv);
    const dr1 = await room1.loadDocRoom("doc1");
    const tid = listResolvedCommentThreads(dr1.doc)[0]!.id;
    resolveCommentThread(dr1.doc, tid, true); // a collaborator resolved it after migration
    await state.storage.put("doc:doc1:update", Y.encodeStateAsUpdate(dr1.doc)); // persisted

    const room2 = new WorkspaceRoom(state, fakeEnv);
    const dr2 = await room2.loadDocRoom("doc1");
    const threads = listResolvedCommentThreads(dr2.doc);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.resolved).toBe(true); // the legacy key's resolved:false did NOT clobber it
  });

  it("D3: a self-authored reply on a suggestion is kept", async () => {
    const { room, ws, docRoom } = await roomWithDoc("hello world");
    (room as any).sessions.set(ws, fakeSession("bob", "reviewer"));
    recordInsertSuggestion(docRoom.doc, 0, 5, "bob");
    const sid = listResolvedSuggestions(docRoom.doc)[0]!.id;
    await applyFrom(room, ws, docRoom, (c) => addSuggestionReply(c, sid, "bob", "mine", 5));
    const entry = getSuggestionsMap(docRoom.doc).get(sid) as { replies?: { body: string }[] };
    expect((entry.replies ?? []).map((r) => r.body)).toEqual(["mine"]);
  });
});

describe("WorkspaceRoom.getAccessRequests (CV2-5)", () => {
  it("returns [] when nothing is stored, and the stored list otherwise", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    expect(await room.getAccessRequests()).toEqual([]);
    await room.state.storage.put("accessRequests", [{ username: "bob", message: "pls", createdAt: 1 }]);
    expect(await room.getAccessRequests()).toEqual([{ username: "bob", message: "pls", createdAt: 1 }]);
  });
});

describe("WorkspaceRoom POST /access-request (CV2-5, requester)", () => {
  async function roomWithRole(role: "viewer" | "reviewer" | "editor") {
    const r = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await r.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role, invited: [] });
    return r;
  }
  function submitReq(cookie: string | null, body: unknown) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cookie) headers.Cookie = `mde_gh_session=${cookie}`;
    return new Request("https://x/api/workspace/w1/access-request", { method: "POST", headers, body: JSON.stringify(body) });
  }

  it("a viewer's request is stored and sent as MESSAGE_ACCESS_REQUEST to the owner's socket only (MDE-20)", async () => {
    const r = await roomWithRole("viewer");
    const ownerSent: ArrayBuffer[] = [];
    const peerSent: ArrayBuffer[] = [];
    const ownerWs = { send: (m: ArrayBuffer) => ownerSent.push(m), accept() {}, addEventListener() {} } as unknown as WebSocket;
    const peerWs = { send: (m: ArrayBuffer) => peerSent.push(m), accept() {}, addEventListener() {} } as unknown as WebSocket;
    r.handleSession(ownerWs, "alice", "editor"); // alice is the owner
    r.handleSession(peerWs, null, "viewer"); // an anonymous eavesdropper
    ownerSent.length = 0;
    peerSent.length = 0;
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "t", username: "bob" });
    const res = await r.fetch(submitReq(cookie, { message: "  need to fix a typo  " }));
    expect(res.status).toBe(200);
    const list = await r.getAccessRequests();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ username: "bob", message: "need to fix a typo" });

    // The owner got the frame …
    const d = decoding.createDecoder(new Uint8Array(ownerSent.at(-1)!));
    expect(decoding.readVarUint(d)).toBe(6);
    expect(decoding.readVarString(d)).toBe("bob");
    expect(decoding.readVarString(d)).toBe("need to fix a typo");
    // … the anonymous peer got nothing — no username / note on the wire.
    expect(peerSent.some((b) => decoding.readVarUint(decoding.createDecoder(new Uint8Array(b))) === 6)).toBe(false);
  });

  it("re-requesting replaces the prior entry", async () => {
    const r = await roomWithRole("viewer");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "t", username: "bob" });
    await r.fetch(submitReq(cookie, { message: "first" }));
    await r.fetch(submitReq(cookie, { message: "second" }));
    const list = await r.getAccessRequests();
    expect(list).toHaveLength(1);
    expect(list[0]!.message).toBe("second");
  });

  it("an editor gets 400; an outsider 403; no session 401", async () => {
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "t", username: "bob" });
    expect((await (await roomWithRole("editor")).fetch(submitReq(cookie, {}))).status).toBe(400);
    const restricted = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await restricted.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    expect((await restricted.fetch(submitReq(cookie, {}))).status).toBe(403);
    expect((await restricted.fetch(submitReq(null, {}))).status).toBe(401);
  });

  it("caps the message at 500 chars", async () => {
    const r = await roomWithRole("reviewer");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "t", username: "bob" });
    await r.fetch(submitReq(cookie, { message: "x".repeat(1000) }));
    expect((await r.getAccessRequests())[0]!.message).toHaveLength(500);
  });
});

describe("WorkspaceRoom POST /access-request/:username (CV2-5, owner)", () => {
  async function seededRoom() {
    const r = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await r.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    await r.state.storage.put("accessRequests", [{ username: "bob", message: "", createdAt: 1 }]);
    return r;
  }
  const ownerCookie = () => encryptSession(fakeEnvWithSecret, { token: "t", username: "alice" });
  function actionReq(cookie: string, username: string, body: unknown) {
    return new Request(`https://x/api/workspace/w1/access-request/${username}`, {
      method: "POST",
      headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("approve adds the invite, clears the request, broadcasts MESSAGE_ACCESS_CHANGED", async () => {
    const r = await seededRoom();
    const sent: ArrayBuffer[] = [];
    const ws = { send: (m: ArrayBuffer) => sent.push(m), accept() {}, addEventListener() {} } as unknown as WebSocket;
    r.handleSession(ws, "carol", "viewer");
    sent.length = 0;
    const res = await r.fetch(actionReq(await ownerCookie(), "bob", { action: "approve" }));
    expect(res.status).toBe(200);
    expect((await r.getAccess()).invited).toEqual([{ username: "bob", role: "editor" }]);
    expect(await r.getAccessRequests()).toEqual([]);
    expect(decoding.readVarUint(decoding.createDecoder(new Uint8Array(sent.at(-1)!)))).toBe(7);
  });

  it("approve honours an explicit role", async () => {
    const r = await seededRoom();
    await r.fetch(actionReq(await ownerCookie(), "bob", { action: "approve", role: "reviewer" }));
    expect((await r.getAccess()).invited).toEqual([{ username: "bob", role: "reviewer" }]);
  });

  it("deny just clears the request", async () => {
    const r = await seededRoom();
    await r.fetch(actionReq(await ownerCookie(), "bob", { action: "deny" }));
    expect(await r.getAccessRequests()).toEqual([]);
    expect((await r.getAccess()).invited).toEqual([]);
  });

  it("non-owner → 403; unknown username → 404; bad action → 400", async () => {
    const r = await seededRoom();
    const carol = await encryptSession(fakeEnvWithSecret, { token: "t", username: "carol" });
    expect((await r.fetch(actionReq(carol, "bob", { action: "deny" }))).status).toBe(403);
    expect((await r.fetch(actionReq(await ownerCookie(), "nobody", { action: "deny" }))).status).toBe(404);
    expect((await r.fetch(actionReq(await ownerCookie(), "bob", { action: "wat" }))).status).toBe(400);
  });

  it("PUT /access also broadcasts MESSAGE_ACCESS_CHANGED", async () => {
    const r = await seededRoom();
    const sent: ArrayBuffer[] = [];
    const ws = { send: (m: ArrayBuffer) => sent.push(m), accept() {}, addEventListener() {} } as unknown as WebSocket;
    r.handleSession(ws, "carol", "viewer");
    sent.length = 0;
    await r.fetch(
      new Request("https://x/api/workspace/w1/access", {
        method: "PUT",
        headers: { Cookie: `mde_gh_session=${await ownerCookie()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ generalAccess: "anyone", role: "reviewer", invited: [] }),
      }),
    );
    expect(sent.some((m) => decoding.readVarUint(decoding.createDecoder(new Uint8Array(m))) === 7)).toBe(true);
  });
});

describe("GET /access — access-request visibility (CV2-5)", () => {
  async function seededRoom() {
    const r = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await r.state.storage.put("access", {
      owner: "alice",
      generalAccess: "anyone",
      requireAccount: false,
      role: "viewer",
      invited: [{ username: "bob", role: "viewer" }],
    });
    await r.state.storage.put("accessRequests", [{ username: "bob", message: "hi", createdAt: 1 }]);
    return r;
  }
  const getReq = (cookie?: string) => new Request("https://x/api/workspace/w1/access", cookie ? { headers: { Cookie: `mde_gh_session=${cookie}` } } : {});

  it("the owner sees the full accessRequests list", async () => {
    const r = await seededRoom();
    const body = (await (await r.fetch(getReq(await encryptSession(fakeEnvWithSecret, { token: "t", username: "alice" })))).json()) as Record<string, unknown>;
    expect(body.accessRequests).toEqual([{ username: "bob", message: "hi", createdAt: 1 }]);
    expect(body.myAccessRequestPending).toBeUndefined();
  });

  it("an invited non-owner sees only myAccessRequestPending (bool), not the list", async () => {
    const r = await seededRoom();
    const body = (await (await r.fetch(getReq(await encryptSession(fakeEnvWithSecret, { token: "t", username: "bob" })))).json()) as Record<string, unknown>;
    expect(body.accessRequests).toBeUndefined();
    expect(body.myAccessRequestPending).toBe(true);
  });

  it("an outsider sees neither field (and the redacted roster)", async () => {
    const r = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await r.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    await r.state.storage.put("accessRequests", [{ username: "bob", message: "hi", createdAt: 1 }]);
    const body = (await (await r.fetch(getReq())).json()) as Record<string, unknown>;
    expect(body.accessRequests).toBeUndefined();
    expect(body.myAccessRequestPending).toBeUndefined();
    expect(body.owner).toBeNull();
  });
});
