import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { getCookie, decryptSession, SESSION_COOKIE } from "./auth.js";
import type { Env } from "./env";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

// Sub-types within a MESSAGE_SYNC frame (see y-protocols/sync.js). Step1 is
// a read-only "what do you have" handshake; step2 and update both apply
// content to the doc, so those two are what read-only roles must be
// blocked from sending.
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

const PERSIST_KEY = "update";
const ACCESS_KEY = "access";
const PERSIST_DELAY_MS = 1000;

export type Role = "viewer" | "reviewer" | "editor";

export interface InvitedPerson {
  username: string;
  role: Role;
}

export interface AccessRecord {
  owner: string | null;
  generalAccess: "restricted" | "anyone";
  // Only meaningful when generalAccess is "anyone" — false (default)
  // means a fully public link, no account needed; true means any signed
  // -in GitHub account works without being individually invited.
  requireAccount: boolean;
  role: Role;
  invited: InvitedPerson[];
}

// username is null for anonymous sessions — only possible when the room's
// generalAccess is "anyone" and requireAccount is false (see authorize());
// restricted rooms, and "anyone" rooms with requireAccount set, always
// require a real signed-in identity.
type AuthResult = { ok: true; username: string | null; role: Role } | { ok: false; status: number; message: string };

interface SessionInfo {
  username: string | null;
  role: Role;
  awarenessIds: Set<number>;
}

const DEFAULT_ACCESS: AccessRecord = { owner: null, generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] };

// PUT /access's invited field — accepts either the old string[] shape
// (client always sending {username, role} now, but kept for robustness
// against stale clients) or the new {username, role}[] shape, and
// produces a deduped, capped, role-validated InvitedPerson[] either way.
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

// One CollabRoom instance == one shared document, addressed by the
// document's own client-generated id (so a share link is stable from the
// moment the doc exists, not a fresh random id minted only once sharing is
// turned on). Cloudflare guarantees a single instance per room name, so
// it's the natural point to hold both the authoritative Yjs doc AND the
// access-control record (owner / general access / invited usernames) —
// both checkpointed to the Durable Object's own built-in storage, no
// separate database involved.
export class CollabRoom {
  state: DurableObjectState;
  env: Env;
  sessions: Map<WebSocket, SessionInfo>;
  persistScheduled: boolean;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.persistScheduled = false;

    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => this.handleDocUpdate(update, origin));
    this.awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown
      ) => this.handleAwarenessUpdate(added, updated, removed, origin)
    );

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<ArrayBuffer>(PERSIST_KEY);
      if (stored) Y.applyUpdate(this.doc, new Uint8Array(stored), "storage");
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/access")) return this.handleAccessRequest(request);

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

  // ---------- Access control ----------

  async getAccess(): Promise<AccessRecord> {
    const stored = await this.state.storage.get<Record<string, unknown>>(ACCESS_KEY);
    if (!stored) return { ...DEFAULT_ACCESS };
    // invited used to be string[] (before per-person roles) — normalize
    // any leftover plain-string entries from rooms shared before this
    // field existed. They previously always resolved to "editor" (see the
    // old authorize()), so that's the role that preserves their existing
    // access exactly.
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

  // Who's allowed to open this room's WebSocket, and with what role. The
  // owner always gets full edit access to their own document regardless of
  // the general-access setting.
  async authorize(request: Request): Promise<AuthResult> {
    const session = await this.getSession(request);
    const access = await this.getAccess();
    if (!access.owner) {
      // Nobody has ever configured this room — treat it as private and
      // unreachable until the owner explicitly opens access via PUT
      // /access. (Ownership itself is claimed there, not here, so two
      // people racing to open a fresh link can't accidentally both become
      // "the owner".)
      return { ok: false, status: 403, message: "This document hasn't been shared." };
    }
    if (session && session.username === access.owner) {
      return { ok: true, username: session.username, role: "editor" };
    }
    if (access.generalAccess === "anyone") {
      if (access.requireAccount && (!session || !session.username)) {
        return { ok: false, status: 401, message: "Sign in with GitHub to join this document." };
      }
      // A public link (requireAccount false) needs no account at all —
      // session may be null here. Restricted (invite-only) rooms below
      // this still require a real signed-in identity, since that's the
      // only way to check the invited list.
      return { ok: true, username: session ? session.username : null, role: access.role };
    }
    if (!session || !session.username) {
      return { ok: false, status: 401, message: "Sign in with GitHub to join this document." };
    }
    const invited = access.invited.find((p) => p.username === session.username);
    if (invited) {
      return { ok: true, username: session.username, role: invited.role };
    }
    return { ok: false, status: 403, message: "You don't have access to this document." };
  }

  async handleAccessRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const access = await this.getAccess();
      return Response.json(access);
    }
    if (request.method === "PUT") {
      // Read the body before any other await — some runtimes tie the
      // request stream's lifetime to the incoming fetch call and it can go
      // away once other async work (cookie decryption, storage reads) has
      // run first.
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
      await this.state.storage.put(ACCESS_KEY, next);
      return Response.json(next);
    }
    return new Response("Method not allowed", { status: 405 });
  }

  // ---------- WebSocket session ----------

  handleSession(ws: WebSocket, username: string | null, role: Role): void {
    ws.accept();
    this.sessions.set(ws, { username, role, awarenessIds: new Set() });

    const syncEncoder = encoding.createEncoder();
    encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(syncEncoder, this.doc);
    ws.send(encoding.toUint8Array(syncEncoder));

    const states = this.awareness.getStates();
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(states.keys()))
      );
      ws.send(encoding.toUint8Array(awarenessEncoder));
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

    if (messageType === MESSAGE_SYNC) {
      // Peek the sync sub-type without consuming it — readSyncMessage below
      // needs to read it again itself.
      const savedPos = decoder.pos;
      const syncType = decoding.readVarUint(decoder);
      decoder.pos = savedPos;

      const isWrite = syncType === SYNC_STEP2 || syncType === SYNC_UPDATE;
      if (isWrite && session && session.role !== "editor") return; // read-only: drop silently

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
      if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
    } else if (messageType === MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, ws);
    }
  }

  handleClose(ws: WebSocket): void {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (session && session.awarenessIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(session.awarenessIds), null);
    }
    if (this.sessions.size === 0) this.persistNow();
  }

  handleDocUpdate(update: Uint8Array, origin: unknown): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.broadcast(encoding.toUint8Array(encoder), origin);
    if (origin !== "storage") this.schedulePersist();
  }

  handleAwarenessUpdate(added: number[], updated: number[], removed: number[], origin: unknown): void {
    const changed = added.concat(updated, removed);
    const session = origin instanceof WebSocket ? this.sessions.get(origin) : undefined;
    if (session) {
      added.concat(updated).forEach((id) => session.awarenessIds.add(id));
      removed.forEach((id) => session.awarenessIds.delete(id));
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
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

  async schedulePersist(): Promise<void> {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    await this.state.storage.setAlarm(Date.now() + PERSIST_DELAY_MS);
  }

  async alarm(): Promise<void> {
    this.persistScheduled = false;
    await this.persistNow();
  }

  async persistNow(): Promise<void> {
    await this.state.storage.put(PERSIST_KEY, Y.encodeStateAsUpdate(this.doc));
  }
}
