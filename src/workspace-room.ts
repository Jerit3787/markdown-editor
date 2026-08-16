import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { getCookie, decryptSession, SESSION_COOKIE } from "./auth.js";
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
  async authorize(_request: Request): Promise<{ ok: true; username: string | null; role: Role } | { ok: false; status: number; message: string }> {
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
