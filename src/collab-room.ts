import * as Y from "yjs";
import { getCookie, decryptSession, SESSION_COOKIE } from "./auth.js";
import type { Env } from "./env";
import { resolveRole } from "./access-role";
import type { Role, InvitedPerson, AccessRecord } from "./access-role";

export type { Role, InvitedPerson, AccessRecord };

const PERSIST_KEY = "update";
const ACCESS_KEY = "access";
const SNAPSHOTS_KEY = "snapshots";
const COMMENTS_KEY = "comments";

// These three shapes are kept only because the /internal/seed body this
// shim forwards is typed with them, and WorkspaceRoom's seed handler
// consumes that exact shape.
export interface Snapshot {
  id: string;
  timestamp: number;
  content: string;
  images?: Record<string, string>;
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

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

type AuthResult = { ok: true; username: string | null; role: Role } | { ok: false; status: number; message: string };

const DEFAULT_ACCESS: AccessRecord = { owner: null, generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] };

// The legacy one-Durable-Object-per-document collaboration room, now a
// MIGRATION-ONLY SHIM. Live editing, version history and comment threads
// all moved to WorkspaceRoom in the workspace pivot; the current client
// (client/src/collab.ts's migrateLegacyDoc) only ever calls
// POST /api/collab/<id>/migrate, then talks exclusively to WorkspaceRoom.
// This class exists solely so an old single-document share link can still
// be migrated: it loads whatever doc / access / snapshots / comment
// threads were last checkpointed here and forwards them to a fresh
// WorkspaceRoom via /internal/seed, then writes a `migratedTo` tombstone.
// Nothing else here mutates state. See
// docs/superpowers/specs/2026-09-10-collabroom-migration-shim-design.md.
export class CollabRoom {
  state: DurableObjectState;
  env: Env;
  doc: Y.Doc;
  commentThreads: CommentThread[];
  migratedTo: string | null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.doc = new Y.Doc();
    this.commentThreads = [];
    this.migratedTo = null;

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<ArrayBuffer>(PERSIST_KEY);
      if (stored) Y.applyUpdate(this.doc, new Uint8Array(stored), "storage");
      this.commentThreads = (await this.state.storage.get<CommentThread[]>(COMMENTS_KEY)) || [];
      this.migratedTo = (await this.state.storage.get<string>("migratedTo")) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.endsWith("/migrate")) return this.handleMigrateRequest(request);
    // Every other /api/collab/* endpoint was removed with the workspace
    // pivot's teardown (the router no longer forwards them either) — a
    // stale client hitting one just needs to reload and migrate.
    return new Response("This legacy document endpoint is gone — reload to migrate to a workspace.", { status: 410 });
  }

  async getAccess(): Promise<AccessRecord> {
    const stored = await this.state.storage.get<Record<string, unknown>>(ACCESS_KEY);
    if (!stored) return { ...DEFAULT_ACCESS };
    // invited used to be string[] (before per-person roles) — a leftover
    // plain-string entry always resolved to "editor" in the old
    // authorize(), so that's the role that preserves its access exactly.
    const rawInvited = Array.isArray(stored.invited) ? stored.invited : [];
    const invited: InvitedPerson[] = rawInvited.map((entry) => (typeof entry === "string" ? { username: entry, role: "editor" } : (entry as InvitedPerson)));
    return { ...DEFAULT_ACCESS, ...stored, invited } as AccessRecord;
  }

  async getSnapshots(): Promise<Snapshot[]> {
    const stored = await this.state.storage.get<Snapshot[]>(SNAPSHOTS_KEY);
    return stored || [];
  }

  async getSession(request: Request) {
    const cookie = getCookie(request, SESSION_COOKIE);
    if (!cookie) return null;
    return decryptSession(this.env, cookie);
  }

  // "Has any access to the legacy room" — the gate on triggering a
  // migration: an outsider must not be able to force DO allocation + a
  // tombstone on a room they can't reach (MDE-04).
  async authorize(request: Request): Promise<AuthResult> {
    const session = await this.getSession(request);
    const access = await this.getAccess();
    if (!access.owner) return { ok: false, status: 403, message: "This document hasn't been shared." };
    const role = resolveRole(access, session?.username ?? null);
    if (!role) {
      if (!session || !session.username) return { ok: false, status: 401, message: "Sign in with GitHub to join this document." };
      return { ok: false, status: 403, message: "You don't have access to this document." };
    }
    return { ok: true, username: session?.username ?? null, role };
  }

  // Lazy, per-document migration into a WorkspaceRoom — there's no
  // registry of legacy room names to bulk-migrate from, so this runs the
  // first time a collaborator opens an old shared link. Idempotent via the
  // `migratedTo` tombstone: a second caller gets the first's workspace id.
  async handleMigrateRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    // Authorize BEFORE looking at the tombstone: returning `{ workspaceId }`
    // to an unauthenticated caller lets someone who only knows an old
    // legacy docId pivot to GET /api/workspace/<id>/access and read the
    // (private) document's title + access policy (MDE-24). A public
    // "anyone with link" legacy room still authorizes an anon caller, so
    // its own migration + discovery keep working.
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });

    const existingTombstone = this.migratedTo ?? (await this.state.storage.get<string>("migratedTo"));
    if (existingTombstone) {
      this.migratedTo = existingTombstone;
      return Response.json({ workspaceId: existingTombstone });
    }

    const workspaceId = uid() + uid(); // wider than a doc id's uid() to avoid colliding with existing workspace ids
    const access = await this.getAccess();
    const snapshots = await this.getSnapshots();
    const docId = new URL(request.url).pathname.split("/")[3]!; // /api/collab/<docId>/migrate

    // A modern client that connected to this legacy room before the pivot
    // may have written a name into the Y.Doc's `meta` map — carry it
    // forward so the migrated workspace/doc aren't left as placeholders.
    const docName = (this.doc.getMap<string>("meta").get("name") || "").trim();

    const seedBody = {
      docId,
      docName,
      update: Array.from(Y.encodeStateAsUpdate(this.doc)),
      access,
      snapshots,
      comments: this.commentThreads,
    };
    const workspaceRoomId = this.env.WORKSPACE_ROOM.idFromName(workspaceId);
    const res = await this.env.WORKSPACE_ROOM.get(workspaceRoomId).fetch(
      new Request("https://internal/internal/seed", { method: "POST", body: JSON.stringify(seedBody) }),
    );
    if (!res.ok) return new Response("Migration failed.", { status: 500 });

    // A concurrent /migrate for the same room may have won the race while
    // the seed subrequest above was in flight — if so, adopt its result
    // (our freshly-seeded WorkspaceRoom is unreferenced and gets no
    // traffic) rather than overwriting the tombstone with a second id.
    const raced = await this.state.storage.get<string>("migratedTo");
    if (raced) {
      this.migratedTo = raced;
      return Response.json({ workspaceId: raced });
    }
    await this.state.storage.put("migratedTo", workspaceId);
    this.migratedTo = workspaceId;
    return Response.json({ workspaceId });
  }

  // A legacy room may still have a persist alarm scheduled from before
  // this shim shipped. There is nothing left to persist — absorb it.
  async alarm(): Promise<void> {}
}
