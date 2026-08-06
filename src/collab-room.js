import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const PERSIST_KEY = "update";
const PERSIST_DELAY_MS = 1000;

// One CollabRoom instance == one shared document. Cloudflare guarantees a
// single instance per room name, so it's the natural point to hold the
// authoritative Yjs doc in memory and relay updates between connected
// clients. State is checkpointed to the Durable Object's own built-in
// storage (not a separate database) so a room survives eviction/restarts.
export class CollabRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // WebSocket -> { awarenessIds: Set<number> }
    this.persistScheduled = false;

    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null);

    this.doc.on("update", (update, origin) => this.handleDocUpdate(update, origin));
    this.awareness.on("update", ({ added, updated, removed }, origin) =>
      this.handleAwarenessUpdate(added, updated, removed, origin)
    );

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get(PERSIST_KEY);
      if (stored) Y.applyUpdate(this.doc, new Uint8Array(stored), "storage");
    });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  handleSession(ws) {
    ws.accept();
    this.sessions.set(ws, { awarenessIds: new Set() });

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

    ws.addEventListener("message", (event) => this.handleMessage(ws, event.data));
    ws.addEventListener("close", () => this.handleClose(ws));
    ws.addEventListener("error", () => this.handleClose(ws));
  }

  handleMessage(ws, data) {
    if (typeof data === "string") return;
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const messageType = decoding.readVarUint(decoder);

    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
      if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
    } else if (messageType === MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, ws);
    }
  }

  handleClose(ws) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (session && session.awarenessIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(session.awarenessIds), null);
    }
    if (this.sessions.size === 0) this.persistNow();
  }

  handleDocUpdate(update, origin) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.broadcast(encoding.toUint8Array(encoder), origin);
    if (origin !== "storage") this.schedulePersist();
  }

  handleAwarenessUpdate(added, updated, removed, origin) {
    const changed = added.concat(updated, removed);
    const session = this.sessions.get(origin);
    if (session) {
      added.concat(updated).forEach((id) => session.awarenessIds.add(id));
      removed.forEach((id) => session.awarenessIds.delete(id));
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
    this.broadcast(encoding.toUint8Array(encoder), origin);
  }

  broadcast(message, exceptWs) {
    for (const ws of this.sessions.keys()) {
      if (ws === exceptWs) continue;
      try {
        ws.send(message);
      } catch (err) {
        this.sessions.delete(ws);
      }
    }
  }

  async schedulePersist() {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    await this.state.storage.setAlarm(Date.now() + PERSIST_DELAY_MS);
  }

  async alarm() {
    this.persistScheduled = false;
    await this.persistNow();
  }

  async persistNow() {
    await this.state.storage.put(PERSIST_KEY, Y.encodeStateAsUpdate(this.doc));
  }
}
