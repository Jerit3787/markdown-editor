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

  // Membership (Task 6) is enforced at the HTTP add/remove-document layer,
  // not here — a message for a docId this instance hasn't seen yet is
  // loaded (and remembered in `docIds`) on first touch rather than
  // dropped, since access control (Task 3, editor-role check) already
  // gates who can write into this workspace's DO at all.
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
    if (!this.docIds.includes(docId)) {
      this.docIds.push(docId);
      void this.state.storage.put("docs", this.docIds);
    }
    return docRoom;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/access")) return this.handleAccessRequest(request);
    if (url.pathname.endsWith("/docs")) return this.handleDocsRequest(request);
    if (url.pathname.endsWith("/internal/seed")) return this.handleInternalSeedRequest(request);

    const replyMatch = url.pathname.match(/\/docs\/([^/]+)\/comments\/([^/]+)\/reply$/);
    if (replyMatch) return this.handleCommentReplyRequest(request, replyMatch[1]!, replyMatch[2]!);
    const resolveMatch = url.pathname.match(/\/docs\/([^/]+)\/comments\/([^/]+)\/resolve$/);
    if (resolveMatch) return this.handleCommentResolveRequest(request, resolveMatch[1]!, resolveMatch[2]!);
    const commentIdMatch = url.pathname.match(/\/docs\/([^/]+)\/comments\/([^/]+)$/);
    if (commentIdMatch) return this.handleCommentDeleteRequest(request, commentIdMatch[1]!, commentIdMatch[2]!);
    const commentsMatch = url.pathname.match(/\/docs\/([^/]+)\/comments$/);
    if (commentsMatch) return this.handleCommentsRequest(request, commentsMatch[1]!);

    const restoreMatch = url.pathname.match(/\/docs\/([^/]+)\/versions\/([^/]+)\/restore$/);
    if (restoreMatch) return this.handleVersionRestoreRequest(request, restoreMatch[1]!, restoreMatch[2]!);
    const versionMatch = url.pathname.match(/\/docs\/([^/]+)\/versions\/([^/]+)$/);
    if (versionMatch) return this.handleVersionContentRequest(request, versionMatch[1]!, versionMatch[2]!);
    const versionsListMatch = url.pathname.match(/\/docs\/([^/]+)\/versions$/);
    if (versionsListMatch) return this.handleVersionsListRequest(request, versionsListMatch[1]!);

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

  // Returns its promise (rather than firing-and-forgetting internally) so
  // callers that need the doc-load to have actually landed — tests, and
  // Task 8's migration seeding — can await it. The real WebSocket
  // `addEventListener("message", ...)` path below doesn't await it either
  // way, same as a DOM event handler never awaits a listener's return value.
  async handleMessage(ws: WebSocket, data: unknown): Promise<void> {
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

      await this.withDocRoom(docId, (docRoom) => {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        encoding.writeVarString(encoder, docId);
        // The docId prefix's own encoded length varies with the string, so
        // "was anything appended" has to be measured from this baseline —
        // a fixed byte-count threshold (as CollabRoom's single-doc version
        // uses, where the prefix is always exactly 1 byte) would either
        // under- or over-fire depending on docId length.
        const baseLength = encoding.length(encoder);
        syncProtocol.readSyncMessage(decoder, encoder, docRoom.doc, ws);
        if (encoding.length(encoder) > baseLength) ws.send(encoding.toUint8Array(encoder));
      });
    } else if (messageType === MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      await this.withDocRoom(docId, (docRoom) => {
        awarenessProtocol.applyAwarenessUpdate(docRoom.awareness, update, ws);
      });
    }
  }

  async withDocRoom(docId: string, fn: (docRoom: DocRoom) => void): Promise<void> {
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
    this.refreshCommentAnchors(docRoom, docRoom.doc.getText("content").toString());
    this.schedulePersist(docId, docRoom);
    if (origin !== "restore") void this.maybeSnapshot(docId, docRoom);
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
      await this.persistComments(docId, docRoom);
    }
  }

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
}
