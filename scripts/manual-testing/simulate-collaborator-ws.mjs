// Simulates a second collaborator at the raw WebSocket/Yjs protocol level
// (no browser needed) — connects to a WorkspaceRoom, runs the full sync
// handshake for one document, prints its resulting content, then appends
// a live edit and holds the connection open briefly so a real browser
// tab watching the same document can observe it arrive live.
//
// Useful for isolating server-side WorkspaceRoom protocol behavior from
// any client-side (browser) code — see two-user-live-sync.mjs for a
// full two-real-browser test instead.
//
// Usage: node scripts/manual-testing/simulate-collaborator-ws.mjs <workspaceId> <docId> <sessionCookie>
// Get a sessionCookie via the local-only /api/dev/login route — see README.md.
import WebSocket from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const WORKSPACE_ID = process.argv[2];
const DOC_ID = process.argv[3];
const COOKIE = process.argv[4];

if (!WORKSPACE_ID || !DOC_ID || !COOKIE) {
  console.error("Usage: node simulate-collaborator-ws.mjs <workspaceId> <docId> <sessionCookie>");
  process.exit(1);
}

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_PRESENCE = 2;

const ws = new WebSocket(`ws://localhost:8787/api/workspace/${WORKSPACE_ID}`, {
  headers: { Cookie: `mde_gh_session=${COOKIE}` },
});

const doc = new Y.Doc();
const awareness = new awarenessProtocol.Awareness(doc);

function sendSync(fn) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarString(encoder, DOC_ID);
  fn(encoder);
  ws.send(encoding.toUint8Array(encoder));
}

ws.on("open", () => {
  console.log("connected");
  sendSync((encoder) => syncProtocol.writeSyncStep1(encoder, doc));

  const presenceEncoder = encoding.createEncoder();
  encoding.writeVarUint(presenceEncoder, MESSAGE_PRESENCE);
  encoding.writeVarString(presenceEncoder, "");
  encoding.writeVarString(presenceEncoder, DOC_ID);
  ws.send(encoding.toUint8Array(presenceEncoder));
});

ws.on("message", (data) => {
  const decoder = decoding.createDecoder(new Uint8Array(data));
  const type = decoding.readVarUint(decoder);
  if (type === MESSAGE_PRESENCE) {
    console.log("got presence message");
    return;
  }
  const gotDocId = decoding.readVarString(decoder);
  if (gotDocId !== DOC_ID) return;
  if (type === MESSAGE_SYNC) {
    const replyEncoder = encoding.createEncoder();
    encoding.writeVarUint(replyEncoder, MESSAGE_SYNC);
    encoding.writeVarString(replyEncoder, DOC_ID);
    const baseLength = encoding.length(replyEncoder);
    syncProtocol.readSyncMessage(decoder, replyEncoder, doc, "server");
    if (encoding.length(replyEncoder) > baseLength) ws.send(encoding.toUint8Array(replyEncoder));
    console.log("doc content after sync:", JSON.stringify(doc.getText("content").toString()));

    setTimeout(() => {
      const text = doc.getText("content");
      doc.transact(() => {
        text.insert(text.length, "\n\n[live edit from simulate-collaborator-ws.mjs]");
      }, "local");
      sendSync((encoder) => syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(doc)));
      console.log("sent live edit");
    }, 500);
  }
});

ws.on("error", (err) => console.error("error", err));

// Stay connected for 12s so a real browser tab can see presence + the
// live edit, then exit.
setTimeout(() => {
  console.log("closing");
  ws.close();
  process.exit(0);
}, 12000);
