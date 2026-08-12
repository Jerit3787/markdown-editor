import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import { CollabRoom, normalizeInvited, type AccessRecord } from "./collab-room";
import { encryptSession } from "./auth";
import type { Env } from "./env";

const MESSAGE_SYNC = 0;

// Minimal in-memory stand-in for DurableObjectState — CollabRoom only ever
// touches .storage.{get,put,setAlarm} and .blockConcurrencyWhile, so that's
// all this needs to implement. Using the real class under test against this
// fake, rather than re-implementing its logic in the test, is what makes
// these tests meaningful.
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

const fakeEnv = { SESSION_SECRET: "test-secret-key-not-real" } as unknown as Env;

async function sessionRequest(username: string | null): Promise<Request> {
  if (username === null) return new Request("https://example.com/room1");
  const cookie = await encryptSession(fakeEnv, { token: "gh-token", username });
  return new Request("https://example.com/room1", { headers: { Cookie: `mde_gh_session=${cookie}` } });
}

async function putAccess(room: CollabRoom, username: string, body: Record<string, unknown>): Promise<Response> {
  const cookie = await encryptSession(fakeEnv, { token: "gh-token", username });
  const request = new Request("https://example.com/room1/access", {
    method: "PUT",
    headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return room.handleAccessRequest(request);
}

describe("normalizeInvited", () => {
  it("keeps a valid {username, role} entry", () => {
    expect(normalizeInvited([{ username: "alice", role: "editor" }])).toEqual([{ username: "alice", role: "editor" }]);
  });

  it("dedupes by username, keeping the first occurrence", () => {
    const result = normalizeInvited([
      { username: "alice", role: "viewer" },
      { username: "alice", role: "editor" },
    ]);
    expect(result).toEqual([{ username: "alice", role: "viewer" }]);
  });

  it("trims whitespace and skips empty usernames", () => {
    const result = normalizeInvited([{ username: "  bob  ", role: "editor" }, { username: "   ", role: "editor" }]);
    expect(result).toEqual([{ username: "bob", role: "editor" }]);
  });

  it("defaults an invalid or missing role to editor", () => {
    const result = normalizeInvited([{ username: "alice", role: "owner" }, { username: "bob" }]);
    expect(result).toEqual([
      { username: "alice", role: "editor" },
      { username: "bob", role: "editor" },
    ]);
  });

  it("treats a legacy plain-string entry as an editor invite", () => {
    expect(normalizeInvited(["carol"])).toEqual([{ username: "carol", role: "editor" }]);
  });

  it("caps the list at 100 entries", () => {
    const raw = Array.from({ length: 150 }, (_, i) => ({ username: `user${i}`, role: "viewer" }));
    expect(normalizeInvited(raw)).toHaveLength(100);
  });
});

describe("CollabRoom.getAccess", () => {
  it("returns the default record when nothing has been stored", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await expect(room.getAccess()).resolves.toEqual({
      owner: null,
      generalAccess: "restricted",
      requireAccount: false,
      role: "viewer",
      invited: [],
    });
  });

  it("migrates a legacy string[] invited list to {username, role: editor}[]", async () => {
    const state = fakeState();
    await state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: ["bob"] });
    const room = new CollabRoom(state, fakeEnv);
    const access = await room.getAccess();
    expect(access.invited).toEqual([{ username: "bob", role: "editor" }]);
  });
});

describe("CollabRoom.authorize", () => {
  let room: CollabRoom;

  beforeEach(() => {
    room = new CollabRoom(fakeState(), fakeEnv);
  });

  it("rejects everyone when the room has never been shared (no owner set)", async () => {
    const result = await room.authorize(await sessionRequest("alice"));
    expect(result).toEqual({ ok: false, status: 403, message: "This document hasn't been shared." });
  });

  it("always gives the owner editor access, regardless of the general-access setting", async () => {
    await putAccess(room, "alice", { generalAccess: "restricted", role: "viewer", invited: [] });
    const result = await room.authorize(await sessionRequest("alice"));
    expect(result).toEqual({ ok: true, username: "alice", role: "editor" });
  });

  it("lets an anonymous visitor in when the link is public (anyone, no account required)", async () => {
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    const result = await room.authorize(await sessionRequest(null));
    expect(result).toEqual({ ok: true, username: null, role: "viewer" });
  });

  it("requires sign-in when the link is 'anyone with an account'", async () => {
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: true, role: "editor", invited: [] });
    const result = await room.authorize(await sessionRequest(null));
    expect(result).toEqual({ ok: false, status: 401, message: "Sign in with GitHub to join this document." });
  });

  it("admits a signed-in visitor once 'anyone with an account' is set, with the configured role", async () => {
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: true, role: "editor", invited: [] });
    const result = await room.authorize(await sessionRequest("bob"));
    expect(result).toEqual({ ok: true, username: "bob", role: "editor" });
  });

  it("rejects an anonymous visitor when the room is restricted", async () => {
    await putAccess(room, "alice", { generalAccess: "restricted", role: "viewer", invited: [] });
    const result = await room.authorize(await sessionRequest(null));
    expect(result).toEqual({ ok: false, status: 401, message: "Sign in with GitHub to join this document." });
  });

  it("rejects a signed-in visitor who isn't on the invited list of a restricted room", async () => {
    await putAccess(room, "alice", { generalAccess: "restricted", role: "viewer", invited: [{ username: "bob", role: "editor" }] });
    const result = await room.authorize(await sessionRequest("carol"));
    expect(result).toEqual({ ok: false, status: 403, message: "You don't have access to this document." });
  });

  it("admits an invited visitor with their own assigned role, not the room default", async () => {
    await putAccess(room, "alice", { generalAccess: "restricted", role: "viewer", invited: [{ username: "bob", role: "reviewer" }] });
    const result = await room.authorize(await sessionRequest("bob"));
    expect(result).toEqual({ ok: true, username: "bob", role: "reviewer" });
  });
});

describe("CollabRoom.handleAccessRequest", () => {
  it("GET returns the current access record", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    const res = await room.handleAccessRequest(new Request("https://example.com/room1/access"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AccessRecord;
    expect(body.owner).toBeNull();
  });

  it("PUT without a session is rejected", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    const res = await room.handleAccessRequest(
      new Request("https://example.com/room1/access", { method: "PUT", body: "{}" })
    );
    expect(res.status).toBe(401);
  });

  it("the first PUT claims ownership for whoever sent it", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    const res = await putAccess(room, "alice", { generalAccess: "restricted", role: "viewer", invited: [] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AccessRecord;
    expect(body.owner).toBe("alice");
  });

  it("rejects a PUT from anyone other than the existing owner", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "restricted", role: "viewer", invited: [] });
    const res = await putAccess(room, "mallory", { generalAccess: "anyone", role: "editor", invited: [] });
    expect(res.status).toBe(403);
    // and the room's access record is unchanged
    const access = await room.getAccess();
    expect(access.owner).toBe("alice");
    expect(access.generalAccess).toBe("restricted");
  });

  it("normalizes the invited list on write", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", {
      generalAccess: "restricted",
      role: "viewer",
      invited: [{ username: "bob", role: "editor" }, { username: "bob", role: "viewer" }],
    });
    const access = await room.getAccess();
    expect(access.invited).toEqual([{ username: "bob", role: "editor" }]);
  });

  it("rejects invalid JSON with a 400", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    const cookie = await encryptSession(fakeEnv, { token: "gh-token", username: "alice" });
    const res = await room.handleAccessRequest(
      new Request("https://example.com/room1/access", {
        method: "PUT",
        headers: { Cookie: `mde_gh_session=${cookie}` },
        body: "not json",
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("CollabRoom.handleMessage — read-only enforcement", () => {
  function syncUpdateMessage(update: Uint8Array): ArrayBuffer {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    return encoding.toUint8Array(encoder).buffer as ArrayBuffer;
  }

  it("drops a write from a viewer session without applying it to the document", () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    const scratch = new Y.Doc();
    scratch.getText("content").insert(0, "hello");
    const update = Y.encodeStateAsUpdate(scratch);

    const fakeWs = {} as WebSocket;
    room.sessions.set(fakeWs, { username: "viewer-user", role: "viewer", awarenessIds: new Set() });

    room.handleMessage(fakeWs, syncUpdateMessage(update));

    expect(room.doc.getText("content").toString()).toBe("");
  });

  it("applies a write from an editor session to the document", () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    const scratch = new Y.Doc();
    scratch.getText("content").insert(0, "hello");
    const update = Y.encodeStateAsUpdate(scratch);

    const fakeWs = {} as WebSocket;
    room.sessions.set(fakeWs, { username: "editor-user", role: "editor", awarenessIds: new Set() });

    room.handleMessage(fakeWs, syncUpdateMessage(update));

    expect(room.doc.getText("content").toString()).toBe("hello");
  });
});
