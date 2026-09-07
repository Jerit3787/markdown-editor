import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

const BASE_HTTP = "http://localhost:8787";
const BASE_WS = "ws://localhost:8787";
const MESSAGE_SYNC = 0;

// Mints a real, validly-encrypted session cookie for `username` via the
// local-only /api/dev/login route (added by the dev-login patch that the
// `collab` Playwright project already depends on). Returns just the
// cookie value, for use as `Cookie: mde_gh_session=<value>`.
export async function mintDevSession(username: string): Promise<string> {
  const res = await fetch(`${BASE_HTTP}/api/dev/login?username=${encodeURIComponent(username)}`);
  if (!res.ok) throw new Error(`dev-login failed: ${res.status}`);
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("mde_gh_session="));
  if (!setCookie) throw new Error("dev-login response had no mde_gh_session cookie");
  return setCookie.slice("mde_gh_session=".length).split(";")[0];
}

// Stands up a legacy single-document CollabRoom with known content, the
// way a user who shared a document before workspace-level sharing shipped
// would have left it. Two steps:
//   1. PUT /api/collab/<docId>/access as `ownerCookie`'s user — claims
//      ownership (CollabRoom.authorize 403s until an owner exists) and
//      opens general "anyone/editor" access so the seeding socket below
//      needs no cookie of its own (resolveRole → "editor" for anon).
//   2. Open ws://…/api/collab/<docId>, answer the server's opening
//      SYNC_STEP1 with our full state (that reply IS the content write),
//      then round-trip our own SYNC_STEP1 and resolve only once the
//      server echoes our text back — proving it persisted before we close.
export async function seedLegacyCollabRoom(opts: { docId: string; ownerCookie: string; content: string; name?: string }): Promise<void> {
  const { docId, ownerCookie, content, name = "Legacy Doc" } = opts;

  const putRes = await fetch(`${BASE_HTTP}/api/collab/${encodeURIComponent(docId)}/access`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: `mde_gh_session=${ownerCookie}` },
    body: JSON.stringify({ generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] }),
  });
  if (!putRes.ok) throw new Error(`PUT /access failed: ${putRes.status} ${await putRes.text()}`);

  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getText("content").insert(0, content);
    doc.getMap("meta").set("name", name);
  });

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${BASE_WS}/api/collab/${encodeURIComponent(docId)}`);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      reject(new Error("seedLegacyCollabRoom: server never echoed the seeded content within 10s"));
    }, 10_000);

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("seedLegacyCollabRoom: websocket error"));
    };

    ws.onopen = () => {
      // Push our whole state up-front as an update (belt-and-braces
      // alongside the step2 reply below).
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, Y.encodeStateAsUpdate(doc));
      ws.send(encoding.toUint8Array(enc));
      // Ask for the server's state so we can detect when our write landed.
      const s1 = encoding.createEncoder();
      encoding.writeVarUint(s1, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(s1, doc);
      ws.send(encoding.toUint8Array(s1));
    };

    ws.onmessage = (ev) => {
      const decoder = decoding.createDecoder(new Uint8Array(ev.data as ArrayBuffer));
      const type = decoding.readVarUint(decoder);
      if (type !== MESSAGE_SYNC) return;
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MESSAGE_SYNC);
      const base = encoding.length(reply);
      // Applies the server's step1/step2/update into `doc` and, for a
      // step1, writes our step2 answer into `reply`.
      syncProtocol.readSyncMessage(decoder, reply, doc, "seed");
      if (encoding.length(reply) > base) ws.send(encoding.toUint8Array(reply));
      if (doc.getText("content").toString() === content) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    };
  });
}
