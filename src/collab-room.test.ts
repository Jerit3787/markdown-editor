import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import { CollabRoom, normalizeInvited, type AccessRecord, type Snapshot, type CommentThread } from "./collab-room";
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

async function authedRequest(username: string, path: string, init?: RequestInit): Promise<Request> {
  const cookie = await encryptSession(fakeEnv, { token: "gh-token", username });
  return new Request(`https://example.com${path}`, {
    ...init,
    headers: { ...(init?.headers || {}), Cookie: `mde_gh_session=${cookie}` },
  });
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

// Every content mutation below is wrapped in transact(fn, "storage") — the
// same origin the constructor's own disk-load path already uses to mean
// "not a live edit" (see handleDocUpdate). Without it, the constructor's
// doc.on("update", ...) listener fires handleDocUpdate for the mutation
// itself, which calls the real (un-awaited, real-Date.now()) maybeSnapshot
// in parallel with these tests' own explicit, timestamp-controlled calls —
// racing them and making snapshot counts non-deterministic.
describe("CollabRoom version snapshots", () => {
  it("does not snapshot before the throttle window elapses", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    room.doc.transact(() => room.doc.getText("content").insert(0, "hello"), "storage");
    await room.maybeSnapshot(1_000);
    room.doc.transact(() => room.doc.getText("content").insert(5, " world"), "storage");
    await room.maybeSnapshot(1_000 + 4 * 60 * 1000); // 4 min later
    expect(await room.getSnapshots()).toHaveLength(1);
  });

  it("snapshots again once the throttle window elapses and content changed", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    room.doc.transact(() => room.doc.getText("content").insert(0, "hello"), "storage");
    await room.maybeSnapshot(1_000);
    room.doc.transact(() => room.doc.getText("content").insert(5, " world"), "storage");
    await room.maybeSnapshot(1_000 + 6 * 60 * 1000); // 6 min later
    const snapshots = await room.getSnapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]!.content).toBe("hello world");
  });

  it("does not snapshot if content is unchanged, even past the throttle window", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    room.doc.transact(() => room.doc.getText("content").insert(0, "hello"), "storage");
    await room.maybeSnapshot(1_000);
    await room.maybeSnapshot(1_000 + 6 * 60 * 1000);
    expect(await room.getSnapshots()).toHaveLength(1);
  });

  it("prunes the oldest snapshot past the 50 cap", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    for (let i = 0; i < 51; i++) {
      room.doc.transact(() => {
        const t = room.doc.getText("content");
        t.delete(0, t.length);
        t.insert(0, `v${i}`);
      }, "storage");
      await room.maybeSnapshot(1_000 + i * 6 * 60 * 1000);
    }
    const snapshots = await room.getSnapshots();
    expect(snapshots).toHaveLength(50);
    expect(snapshots[0]!.content).toBe("v1"); // v0 pruned
    expect(snapshots[49]!.content).toBe("v50");
  });

  it("forceSnapshot always appends, bypassing the throttle", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    room.doc.transact(() => room.doc.getText("content").insert(0, "hello"), "storage");
    await room.maybeSnapshot(1_000);
    await room.forceSnapshot("restored content", 1_001);
    const snapshots = await room.getSnapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]!.content).toBe("restored content");
  });
});

describe("CollabRoom comment threads", () => {
  it("creates a thread with one comment", () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    const thread = room.createThread(0, 5, "hello", "alice", "nice greeting");
    expect(room.getComments()).toHaveLength(1);
    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]!.author).toBe("alice");
    expect(thread.orphaned).toBe(false);
    expect(thread.resolved).toBe(false);
  });

  it("survives two overlapping creates without losing either", () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    // Simulates concurrent requests: both mutate the in-memory
    // commentThreads field directly, with no read-from-storage gap that
    // could let one overwrite the other.
    room.createThread(0, 5, "hello", "alice", "comment A");
    room.createThread(6, 11, "world", "bob", "comment B");
    expect(room.getComments()).toHaveLength(2);
  });

  it("adds a reply to an existing thread", () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    const thread = room.createThread(0, 5, "hello", "alice", "first");
    room.addReply(thread.id, "bob", "reply");
    expect(room.getComments()[0]!.comments).toHaveLength(2);
  });

  it("addReply returns null for an unknown thread", () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    expect(room.addReply("nope", "bob", "reply")).toBeNull();
  });

  it("resolves and reopens a thread", () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    const thread = room.createThread(0, 5, "hello", "alice", "first");
    room.resolveThread(thread.id, true);
    expect(room.getComments()[0]!.resolved).toBe(true);
    room.resolveThread(thread.id, false);
    expect(room.getComments()[0]!.resolved).toBe(false);
  });

  it("deleteThread allows the starting author", () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    const thread = room.createThread(0, 5, "hello", "alice", "first");
    expect(room.deleteThread(thread.id, "alice", false)).toBe("deleted");
    expect(room.getComments()).toHaveLength(0);
  });

  it("deleteThread allows the document owner", () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    const thread = room.createThread(0, 5, "hello", "alice", "first");
    expect(room.deleteThread(thread.id, "owner", true)).toBe("deleted");
  });

  it("deleteThread rejects a non-author non-owner", () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    const thread = room.createThread(0, 5, "hello", "alice", "first");
    expect(room.deleteThread(thread.id, "bob", false)).toBe("forbidden");
    expect(room.getComments()).toHaveLength(1);
  });

  it("deleteThread returns not_found for an unknown id", () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    expect(room.deleteThread("nope", "alice", false)).toBe("not_found");
  });

  it("refreshCommentAnchors relocates a moved quote and marks a missing one orphaned", () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    room.createThread(0, 5, "hello", "alice", "first");
    room.refreshCommentAnchors("say hello there");
    expect(room.getComments()[0]).toMatchObject({ from: 4, to: 9, orphaned: false });
    room.refreshCommentAnchors("nothing matches here");
    expect(room.getComments()[0]!.orphaned).toBe(true);
  });
});

describe("GET/POST /room1/comments", () => {
  it("rejects an unshared room", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    const res = await room.fetch(new Request("https://example.com/room1/comments"));
    expect(res.status).toBe(403);
  });

  it("creates a thread and returns it", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "reviewer", invited: [] });
    const req = await authedRequest("alice", "/room1/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: 0, to: 5, quote: "hello", body: "nice" }),
    });
    const res = await room.fetch(req);
    expect(res.status).toBe(200);
    const thread = (await res.json()) as CommentThread;
    expect(thread.comments[0]!.body).toBe("nice");
  });

  it("rejects a viewer's attempt to create a comment", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    const req = await authedRequest("bob", "/room1/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: 0, to: 5, quote: "hello", body: "nice" }),
    });
    const res = await room.fetch(req);
    expect(res.status).toBe(403);
  });

  it("rejects an empty comment body", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "reviewer", invited: [] });
    const req = await authedRequest("alice", "/room1/comments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: 0, to: 5, quote: "hello", body: "   " }),
    });
    const res = await room.fetch(req);
    expect(res.status).toBe(400);
  });

  it("lists created threads", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "reviewer", invited: [] });
    room.createThread(0, 5, "hello", "alice", "first");
    const res = await room.fetch(new Request("https://example.com/room1/comments"));
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });
});

describe("POST /room1/comments/:id/reply and /resolve", () => {
  it("replies to a thread", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "reviewer", invited: [] });
    const thread = room.createThread(0, 5, "hello", "alice", "first");
    const req = await authedRequest("bob", `/room1/comments/${thread.id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "reply" }),
    });
    const res = await room.fetch(req);
    expect(res.status).toBe(200);
    const updated = (await res.json()) as CommentThread;
    expect(updated.comments).toHaveLength(2);
  });

  it("returns 404 replying to an unknown thread", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "reviewer", invited: [] });
    const req = await authedRequest("alice", "/room1/comments/nope/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "reply" }),
    });
    const res = await room.fetch(req);
    expect(res.status).toBe(404);
  });

  it("resolves a thread", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "reviewer", invited: [] });
    const thread = room.createThread(0, 5, "hello", "alice", "first");
    const req = await authedRequest("alice", `/room1/comments/${thread.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: true }),
    });
    const res = await room.fetch(req);
    expect(res.status).toBe(200);
    expect(((await res.json()) as CommentThread).resolved).toBe(true);
  });
});

describe("DELETE /room1/comments/:id", () => {
  it("allows the starting author to delete", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "reviewer", invited: [] });
    const thread = room.createThread(0, 5, "hello", "alice", "first");
    const req = await authedRequest("alice", `/room1/comments/${thread.id}`, { method: "DELETE" });
    const res = await room.fetch(req);
    expect(res.status).toBe(204);
    expect(room.getComments()).toHaveLength(0);
  });

  it("rejects a non-author non-owner", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "reviewer", invited: [] });
    const thread = room.createThread(0, 5, "hello", "alice", "first");
    const req = await authedRequest("bob", `/room1/comments/${thread.id}`, { method: "DELETE" });
    const res = await room.fetch(req);
    expect(res.status).toBe(403);
    expect(room.getComments()).toHaveLength(1);
  });

  it("allows the document owner to delete any thread", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "reviewer", invited: [] });
    const thread = room.createThread(0, 5, "hello", "bob", "first");
    const req = await authedRequest("alice", `/room1/comments/${thread.id}`, { method: "DELETE" });
    const res = await room.fetch(req);
    expect(res.status).toBe(204);
  });
});

describe("GET /room1/versions", () => {
  it("rejects an unshared room", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    const res = await room.fetch(new Request("https://example.com/room1/versions"));
    expect(res.status).toBe(403);
  });

  it("lists snapshot summaries without content, newest first", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    room.doc.transact(() => room.doc.getText("content").insert(0, "v1"), "storage");
    await room.maybeSnapshot(1_000);
    room.doc.transact(() => room.doc.getText("content").insert(2, "-v2"), "storage");
    await room.maybeSnapshot(1_000 + 6 * 60 * 1000);

    const res = await room.fetch(new Request("https://example.com/room1/versions"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; timestamp: number; content?: string }>;
    expect(body).toHaveLength(2);
    expect(body[0]!.timestamp).toBeGreaterThan(body[1]!.timestamp);
    expect(body[0]!.content).toBeUndefined();
  });
});

describe("GET /room1/versions/:id", () => {
  it("returns 404 for an unknown id", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    const res = await room.fetch(new Request("https://example.com/room1/versions/nope"));
    expect(res.status).toBe(404);
  });

  it("returns the snapshot's content", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    room.doc.transact(() => room.doc.getText("content").insert(0, "hello"), "storage");
    await room.maybeSnapshot(1_000);
    const [snap] = await room.getSnapshots();
    const res = await room.fetch(new Request(`https://example.com/room1/versions/${snap!.id}`));
    expect(res.status).toBe(200);
    expect((await res.json()) as Snapshot).toMatchObject({ id: snap!.id, content: "hello" });
  });
});

describe("POST /room1/versions/:id/restore", () => {
  it("rejects a non-editor role", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    room.doc.transact(() => room.doc.getText("content").insert(0, "v1"), "storage");
    await room.maybeSnapshot(1_000);
    const [snap] = await room.getSnapshots();
    const req = await authedRequest("bob", `/room1/versions/${snap!.id}/restore`, { method: "POST" });
    const res = await room.fetch(req);
    expect(res.status).toBe(403);
  });

  it("applies the restored content to the live doc and force-writes a new snapshot", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "restricted", role: "viewer", invited: [] });
    room.doc.transact(() => room.doc.getText("content").insert(0, "v1"), "storage");
    await room.maybeSnapshot(1_000);
    room.doc.transact(() => room.doc.getText("content").insert(2, "-v2"), "storage");
    await room.maybeSnapshot(1_000 + 6 * 60 * 1000);
    const [v1] = await room.getSnapshots();

    // alice is the room's owner (set by the putAccess call above), so she
    // has editor access regardless of the room's general role.
    const req = await authedRequest("alice", `/room1/versions/${v1!.id}/restore`, { method: "POST" });
    const res = await room.fetch(req);
    expect(res.status).toBe(200);
    expect(room.doc.getText("content").toString()).toBe("v1");

    const after = await room.getSnapshots();
    expect(after).toHaveLength(3); // v1, v1-v2, restored-v1
    expect(after[2]!.content).toBe("v1");
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
