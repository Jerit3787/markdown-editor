import { describe, it, expect, beforeEach } from "vitest";
import { CollabRoom } from "../../src/collab-room";
import { encryptSession } from "../../src/auth";
import type { Env } from "../../src/env";

// Minimal in-memory stand-in for DurableObjectState — the CollabRoom shim
// only touches .storage.{get,put} and .blockConcurrencyWhile. Using the
// real class under test against this fake, rather than re-implementing its
// logic, is what makes these tests meaningful.
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

// The /access endpoint that used to claim ownership + set the access
// record is gone (the shim has no PUT /access) — seed the record straight
// into storage instead, same as workspace-room.test.ts does.
async function putAccess(room: CollabRoom, owner: string, body: Record<string, unknown>): Promise<void> {
  await room.state.storage.put("access", {
    owner,
    generalAccess: body.generalAccess ?? "restricted",
    requireAccount: body.requireAccount ?? false,
    role: body.role ?? "viewer",
    invited: body.invited ?? [],
  });
}

async function authedRequest(username: string, path: string, init?: RequestInit): Promise<Request> {
  const cookie = await encryptSession(fakeEnv, { token: "gh-token", username });
  return new Request(`https://example.com${path}`, {
    ...init,
    headers: { ...(init?.headers || {}), Cookie: `mde_gh_session=${cookie}` },
  });
}

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

describe("CollabRoom.handleMigrateRequest", () => {
  it("rejects a caller with no access to the legacy room (MDE-04)", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const anon = await room.handleMigrateRequest(new Request("https://example.com/room1/migrate", { method: "POST" }));
    expect(anon.status).toBe(401);
    const stranger = await room.handleMigrateRequest(await authedRequest("mallory", "/room1/migrate", { method: "POST" }));
    expect(stranger.status).toBe(403);
    expect(await room.state.storage.get("migratedTo")).toBeUndefined();
  });

  it("creates a tombstone and returns a workspace id on first migration", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    room.doc.transact(() => room.doc.getText("content").insert(0, "hello"), "storage");

    const seeded: unknown[] = [];
    const fakeWorkspaceRoomFetch = async (req: Request) => {
      seeded.push(await req.json());
      return new Response(null, { status: 204 });
    };
    room.env = {
      ...fakeEnv,
      WORKSPACE_ROOM: { idFromName: (name: string) => name, get: () => ({ fetch: fakeWorkspaceRoomFetch }) },
    } as unknown as Env;

    const res = await room.handleMigrateRequest(await authedRequest("alice", "/room1/migrate", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBeTruthy();
    expect(seeded).toHaveLength(1);

    const tombstone = await room.state.storage.get("migratedTo");
    expect(tombstone).toBe(body.workspaceId);
  });

  it("forwards the doc's meta.name to the seed so the migrated workspace/doc aren't left as placeholders", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    room.doc.transact(() => {
      room.doc.getText("content").insert(0, "hello");
      room.doc.getMap<string>("meta").set("name", "Meeting Notes");
    }, "storage");

    const seeded: Array<{ docName?: string }> = [];
    room.env = {
      ...fakeEnv,
      WORKSPACE_ROOM: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (req: Request) => {
            seeded.push(await req.json());
            return new Response(null, { status: 204 });
          },
        }),
      },
    } as unknown as Env;

    await room.handleMigrateRequest(await authedRequest("alice", "/room1/migrate", { method: "POST" }));
    expect(seeded[0]!.docName).toBe("Meeting Notes");
  });

  it("forwards an empty docName when the legacy room never had a name", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    room.doc.transact(() => room.doc.getText("content").insert(0, "hello"), "storage");

    const seeded: Array<{ docName?: string }> = [];
    room.env = {
      ...fakeEnv,
      WORKSPACE_ROOM: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (req: Request) => {
            seeded.push(await req.json());
            return new Response(null, { status: 204 });
          },
        }),
      },
    } as unknown as Env;

    await room.handleMigrateRequest(await authedRequest("alice", "/room1/migrate", { method: "POST" }));
    expect(seeded[0]!.docName).toBe("");
  });

  it("returns the existing tombstone on a second migration call from someone with access, instead of migrating again", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "restricted", role: "viewer", invited: [] });
    await room.state.storage.put("migratedTo", "ws-existing");
    const res = await room.handleMigrateRequest(await authedRequest("alice", "/room1/migrate", { method: "POST" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaceId: string };
    expect(body.workspaceId).toBe("ws-existing");
  });

  it("does NOT hand the tombstone to an unauthenticated / outsider caller (MDE-24)", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "restricted", role: "viewer", invited: [] });
    await room.state.storage.put("migratedTo", "ws-secret");

    const anon = await room.handleMigrateRequest(new Request("https://example.com/room1/migrate", { method: "POST" }));
    expect(anon.status).toBe(401);
    const stranger = await room.handleMigrateRequest(await authedRequest("mallory", "/room1/migrate", { method: "POST" }));
    expect(stranger.status).toBe(403);
  });

  it("a public 'anyone with link' legacy room still hands the tombstone to an anon caller", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    await room.state.storage.put("migratedTo", "ws-public");
    const res = await room.handleMigrateRequest(new Request("https://example.com/room1/migrate", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { workspaceId: string }).workspaceId).toBe("ws-public");
  });

  it("410s every legacy endpoint except /migrate — before OR after a migration (the surface is gone, not gated)", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });

    const gone = async () => {
      for (const path of ["/room1/access", "/room1/versions", "/room1/comments/x/reply"]) {
        expect((await room.fetch(await authedRequest("alice", path, { method: "GET" }))).status).toBe(410);
      }
      expect((await room.fetch(new Request("https://example.com/room1", { headers: { Upgrade: "websocket" } }))).status).toBe(410);
    };

    await gone(); // never migrated

    room.doc.transact(() => room.doc.getText("content").insert(0, "legacy"), "storage");
    room.env = {
      ...fakeEnv,
      WORKSPACE_ROOM: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) },
    } as unknown as Env;
    const mig = await room.handleMigrateRequest(await authedRequest("alice", "/room1/migrate", { method: "POST" }));
    const { workspaceId } = (await mig.json()) as { workspaceId: string };

    await gone(); // after migration

    // /migrate still answers (discovery)
    const again = await room.fetch(await authedRequest("alice", "/room1/migrate", { method: "POST" }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { workspaceId: string }).workspaceId).toBe(workspaceId);
  });

  it("410s a room that was already migrated in a previous instance (tombstone warmed from storage)", async () => {
    const state = fakeState();
    const room1 = new CollabRoom(state, fakeEnv);
    await room1.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    await room1.state.storage.put("migratedTo", "ws-prev");

    const room2 = new CollabRoom(state, fakeEnv);
    await new Promise((r) => setTimeout(r, 0)); // let the constructor's blockConcurrencyWhile drain
    const res = await room2.fetch(new Request("https://example.com/room1", { headers: { Upgrade: "websocket" } }));
    expect(res.status).toBe(410);
    const disc = await room2.fetch(await authedRequest("alice", "/room1/migrate", { method: "POST" }));
    expect(((await disc.json()) as { workspaceId: string }).workspaceId).toBe("ws-prev");
  });
});
