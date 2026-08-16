import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { WorkspaceRoom } from "./workspace-room";
import type { Env } from "./env";

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

describe("WorkspaceRoom multiplexed sync", () => {
  it("routes an update for docA to docA's Y.Doc without touching docB", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    const fakeWs = {} as WebSocket;
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
    const senderWs = {} as WebSocket;
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
    const fakeWs = {} as WebSocket;
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
});
