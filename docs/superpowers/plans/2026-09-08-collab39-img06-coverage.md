# COLLAB-39 + IMG-06 e2e coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two `e2e-collab` Playwright tests — COLLAB-39 (legacy `CollabRoom` → `WorkspaceRoom` migration, end-to-end) and IMG-06 (image placeholder position tracked across a collaborator's concurrent edit) — plus a Node-side legacy-room seeding helper, and update the coverage catalogue + changelog.

**Architecture:** Pure test additions on the existing `fix/e2e-collab-newdoc-race` branch. COLLAB-39 seeds a real `CollabRoom` from the Node side of the test (a `fetch` PUT to claim ownership + a raw `WebSocket` Yjs handshake to persist content), then drives a browser with a pre-seeded `localStorage` doc carrying the legacy `shared: true` flag and asserts `migrateLegacyDoc` runs transparently. IMG-06 makes the `FileReader` window deterministic with a per-page `addInitScript` stub, then has a second collaborator insert text above a live upload placeholder.

**Tech Stack:** Playwright (`@playwright/test`), the `collab` project (`wrangler dev` on `:8787` + the uncommitted dev-login patch, orchestrated by `tests/scripts/e2e-collab.sh`), Node 26 globals (`fetch`, `WebSocket`), `yjs` / `y-protocols` / `lib0` (already deps).

**Spec:** `docs/superpowers/specs/2026-09-08-collab39-img06-coverage-design.md`

## Global Constraints

- **No production-code change.** Only new files under `tests/e2e/collab/` plus edits to `docs/TEST-COVERAGE.md` and `CHANGELOG.md`. `src/worker.ts` must show clean `git status` before every commit — never `git add src/worker.ts` (the dev-login patch is applied locally by `enable-dev-login.sh` and must never be committed).
- **No new npm dependencies.** Use Node 26's global `WebSocket` and `fetch`; import `yjs` / `y-protocols/sync` / `lib0/encoding` / `lib0/decoding` (already in `package.json`).
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` and nothing else (no `Claude-Session:` line).
- **Test-only change** → the version bump stays at the flakiness fix's already-drafted `1.48.4`; this plan adds a bullet to that same `## [1.48.4]` CHANGELOG section and **no** `client/src/whats-new-entries.ts` entry.
- **`CollabRoom` wire format:** `[varUint MESSAGE_SYNC=0][ y-protocols/sync sub-message ]` — **no** `docId` string frame-prefix (that is `WorkspaceRoom`-only; see `tests/scripts/manual-testing/simulate-collaborator-ws.mjs` for the `WorkspaceRoom` version and strip the `writeVarString(encoder, DOC_ID)` / `readVarString(decoder)` calls).
- **Anonymous editor access:** `resolveRole` (`src/access-role.ts:27`) returns `"editor"` for a session-less connection when `access.generalAccess === "anyone" && !access.requireAccount && access.role === "editor"`. So the seeding WebSocket needs **no** cookie; only the `PUT /api/collab/<id>/access` that creates the access record needs one.
- **localStorage keys:** `mde:docs`, `mde:active` (`client/src/stores/docs.ts:32-33`); `mde:workspaces`, `mde:activeWorkspace` (`client/src/stores/workspaces.ts:13-14`).
- **Session cookie name:** `mde_gh_session` (`src/auth.ts:7`).

## Running the suite while iterating

The `collab` project needs `wrangler dev` on `:8787` serving a fresh build **plus** the dev-login patch. For a single-file iteration loop:

```bash
bash tests/scripts/manual-testing/enable-dev-login.sh
npm run build
npx wrangler dev --port 8787 &            # wait for "Ready on http://localhost:8787"
npx playwright test --project=collab tests/e2e/collab/<file>.spec.ts --workers=1
# when done:
kill %1; lsof -ti:8787 | xargs kill -9 2>/dev/null
bash tests/scripts/manual-testing/disable-dev-login.sh
```

Re-run `npm run build` after any `client/src` change (there are none in this plan) — the helper/spec files are picked up by Playwright directly, no rebuild needed. Final verification uses `npm run test:e2e:collab` (full project, does its own patch+build+wrangler lifecycle).

---

## File Structure

- **Create `tests/e2e/collab/support/legacy-room.ts`** — Node-side helpers: `mintDevSession(username)` returns a raw `mde_gh_session` cookie value; `seedLegacyCollabRoom({ docId, ownerCookie, content, name? })` creates the access record and persists `content` into the room's Y.Doc over a raw WebSocket. Responsibility: everything needed to stand up a populated legacy `CollabRoom` from a test, and nothing else.
- **Create `tests/e2e/collab/legacy-migration.spec.ts`** — one test, `COLLAB-39: …`. Responsibility: the end-to-end migration assertion (trigger, content carry-over, local adopt, live sync on the migrated room).
- **Create `tests/e2e/collab/image-marker-concurrent.spec.ts`** — one test, `IMG-06: …`. Responsibility: the placeholder-position-tracking assertion under a concurrent remote edit.
- **Modify `docs/TEST-COVERAGE.md`** — flip two rows to `covered`, drop the `## Deferred` IMG-06 row, recount the subsystem table.
- **Modify `CHANGELOG.md`** — one bullet into the existing `## [1.48.4]` `### Changed` list.

---

## Task 1: `legacy-room.ts` seeding helper + a harness smoke test

**Files:**
- Create: `tests/e2e/collab/support/legacy-room.ts`
- Create (temporary, deleted in Step 6): `tests/e2e/collab/_legacy-harness-smoke.spec.ts`

**Interfaces:**
- Consumes: Node globals `fetch`, `WebSocket`; `yjs`, `y-protocols/sync`, `lib0/encoding`, `lib0/decoding`.
- Produces:
  - `mintDevSession(username: string): Promise<string>` — the raw cookie **value** (no `mde_gh_session=` prefix, no attributes).
  - `seedLegacyCollabRoom(opts: { docId: string; ownerCookie: string; content: string; name?: string }): Promise<void>` — resolves once the server has acknowledged the content write.
  - `BASE_HTTP = "http://localhost:8787"`, `BASE_WS = "ws://localhost:8787"` (module constants; the spec files may re-use `BASE` from `./support/collab` for the HTTP one).

- [ ] **Step 1: Write the helper**

Create `tests/e2e/collab/support/legacy-room.ts`:

```ts
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
export async function seedLegacyCollabRoom(opts: {
  docId: string;
  ownerCookie: string;
  content: string;
  name?: string;
}): Promise<void> {
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
      try { ws.close(); } catch {}
      reject(new Error("seedLegacyCollabRoom: server never echoed the seeded content within 10s"));
    }, 10_000);

    ws.onerror = () => { clearTimeout(timer); reject(new Error("seedLegacyCollabRoom: websocket error")); };

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
```

- [ ] **Step 2: Write a throwaway smoke test proving seed + migrate carries content**

Create `tests/e2e/collab/_legacy-harness-smoke.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { mintDevSession, seedLegacyCollabRoom } from "./support/legacy-room";

const BASE = "http://localhost:8787";

test("harness: a seeded CollabRoom migrates and carries its content", async () => {
  const docId = `legacy-smoke-${Date.now().toString(36)}`;
  const cookie = await mintDevSession("legacy-smoke-owner");
  await seedLegacyCollabRoom({ docId, ownerCookie: cookie, content: "SMOKE CONTENT", name: "Smoke" });

  const migrate = await fetch(`${BASE}/api/collab/${docId}/migrate`, { method: "POST" });
  expect(migrate.ok).toBe(true);
  const { workspaceId } = (await migrate.json()) as { workspaceId: string };
  expect(workspaceId).toBeTruthy();

  // The migrated WorkspaceRoom now serves this doc — fetch its id list.
  const docs = await fetch(`${BASE}/api/workspace/${workspaceId}/docs`).then((r) => r.json());
  expect(docs).toContain(docId);
});
```

- [ ] **Step 3: Run the smoke test**

```bash
bash tests/scripts/manual-testing/enable-dev-login.sh && npm run build
npx wrangler dev --port 8787 &   # wait for ready
npx playwright test --project=collab tests/e2e/collab/_legacy-harness-smoke.spec.ts --workers=1
```

Expected: **1 passed**. If `seedLegacyCollabRoom` times out, the server isn't persisting the write before close — widen: after the `readSyncMessage` that carries our echo, wait one extra `await new Promise(r => setTimeout(r, 200))` before `ws.close()`, or drop the "echo" gate and just `setTimeout(300)` after sending. If `GET /workspace/<id>/docs` 404s or omits `docId`, `handleMigrateRequest`'s `/internal/seed` failed — inspect the migrate response body.

- [ ] **Step 4: Verify `src/worker.ts` is still clean, then leave dev-login enabled for Task 2/3**

```bash
git status --porcelain src/worker.ts   # must be empty
```

- [ ] **Step 5: Delete the smoke test**

```bash
rm tests/e2e/collab/_legacy-harness-smoke.spec.ts
```

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/collab/support/legacy-room.ts
git commit -m "$(cat <<'EOF'
test(e2e-collab): legacy CollabRoom seeding helper

mintDevSession + seedLegacyCollabRoom — stands up a populated legacy
single-document CollabRoom (PUT /access to claim ownership, then a raw
WebSocket Yjs handshake to persist content) so a browser test can drive
the migrate-on-open path. No docId frame-prefix (CollabRoom, not
WorkspaceRoom); the seeding socket is anonymous (generalAccess anyone).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: COLLAB-39 — `legacy-migration.spec.ts`

**Files:**
- Create: `tests/e2e/collab/legacy-migration.spec.ts`

**Interfaces:**
- Consumes: `mintDevSession`, `seedLegacyCollabRoom` (Task 1); `signInAsDevUser` (`./support/dev-login`); `dismissWhatsNew`, `joinSharedWorkspace`, `editorText`, `expectEditorContains`, `BASE` (`./support/collab`).
- Produces: nothing (leaf test).

- [ ] **Step 1: Spike — confirm a pre-seeded `shared: true` doc round-trips through the store loaders**

Run this throwaway check (inline in a scratch spec or `node`-driven page) to decide the setup path:

```ts
// scratch: does the store keep `shared: true` on a pre-seeded doc?
await page.addInitScript(() => {
  const now = Date.now();
  localStorage.setItem("mde:workspaces", JSON.stringify([{ id: "ws-x", name: "W", createdAt: now, updatedAt: now }]));
  localStorage.setItem("mde:docs", JSON.stringify([{ id: "d-x", name: "D", workspaceId: "ws-x", content: "", shared: true, createdAt: now, updatedAt: now }]));
  localStorage.setItem("mde:active", "d-x");
  localStorage.setItem("mde:activeWorkspace", "ws-x");
});
await page.goto(BASE);
await page.waitForFunction(() => (window as any).MDE?.getEditor);
const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("mde:docs")!)[0].shared);
console.log("shared kept after load:", kept);
```

- If `kept === true` → use the pre-seeded-`localStorage` path (Step 2 below as written).
- If the loader strips unknown/legacy fields → use the fallback: in a `page.evaluate` dynamic import, `createWorkspace` + `createDoc` via the store modules, then `docsStore.update(...)` to set `shared: true` on that one doc + `persistDocs()`, then `page.reload()`. Adjust Step 2 accordingly. Record which path in a one-line comment at the top of the spec.

(`client/src/stores/docs.ts` loader — check whether it spreads the parsed record or reconstructs it field-by-field.)

- [ ] **Step 2: Write the test**

Create `tests/e2e/collab/legacy-migration.spec.ts` (pre-seeded-`localStorage` path shown; swap in the fallback from Step 1 if needed):

```ts
import { test, expect } from "@playwright/test";
import { signInAsDevUser } from "./support/dev-login";
import { dismissWhatsNew, joinSharedWorkspace, editorText, expectEditorContains, BASE } from "./support/collab";
import { mintDevSession, seedLegacyCollabRoom } from "./support/legacy-room";

// COLLAB-39: a document still carrying the pre-workspace per-document
// `shared: true` flag migrates its legacy CollabRoom into a fresh
// WorkspaceRoom the moment it's opened — transparently, before live sync
// attaches — and the migrated room then works like any other shared
// workspace. Only the server halves (handleMigrateRequest tombstone,
// /internal/seed) were covered before, at integration level.
test("COLLAB-39: a legacy per-document shared doc migrates to a WorkspaceRoom on open", async ({ browser }) => {
  const docId = `legacy-${Date.now().toString(36)}`;
  const ownerCookie = await mintDevSession("legacy-owner-e2e");
  await seedLegacyCollabRoom({ docId, ownerCookie, content: "LEGACY SHARED CONTENT", name: "Legacy Doc" });

  const ownerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  await signInAsDevUser(owner, "legacy-owner-e2e");
  await owner.addInitScript((id) => {
    const now = Date.now();
    localStorage.setItem("mde:workspaces", JSON.stringify([{ id: "legacy-ws-local", name: "Old Workspace", createdAt: now, updatedAt: now }]));
    localStorage.setItem("mde:docs", JSON.stringify([{ id, name: "Legacy Doc", workspaceId: "legacy-ws-local", content: "", shared: true, createdAt: now, updatedAt: now }]));
    localStorage.setItem("mde:active", id);
    localStorage.setItem("mde:activeWorkspace", "legacy-ws-local");
  }, docId);

  await owner.goto(BASE);
  await owner.waitForFunction(() => window.MDE && typeof window.MDE.getEditor === "function", { timeout: 15000 });
  await dismissWhatsNew(owner);

  // Migration ran: the editor shows the room's content, not the empty
  // local record.
  await expect.poll(() => editorText(owner), { timeout: 15000 }).toBe("LEGACY SHARED CONTENT");

  // The legacy flag is cleared and the doc now lives in an adopted
  // workspace that has a remoteId.
  const migrated = await expect.poll(
    () =>
      owner.evaluate(() => {
        const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
        const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
        const d = docs.find((x: { id: string }) => x.name === "Legacy Doc");
        const ws = d && wss.find((w: { id: string }) => w.id === d.workspaceId);
        return { shared: d?.shared ?? null, remoteId: ws?.remoteId ?? null };
      }),
    { timeout: 15000 },
  );
  // expect.poll returns the last value; assert on it:
  const state = await owner.evaluate(() => {
    const docs = JSON.parse(localStorage.getItem("mde:docs") || "[]");
    const wss = JSON.parse(localStorage.getItem("mde:workspaces") || "[]");
    const d = docs.find((x: { id: string }) => x.name === "Legacy Doc");
    const ws = d && wss.find((w: { id: string }) => w.id === d.workspaceId);
    return { shared: d?.shared ?? null, remoteId: ws?.remoteId ?? null };
  });
  expect(state.shared).toBeNull();
  expect(typeof state.remoteId).toBe("string");
  expect(state.remoteId!.length).toBeGreaterThan(0);

  // Live sync works on the migrated room: a second collaborator joins by
  // the modern /w/<remoteId>/<docId>/edit link and sees content + a live
  // edit.
  const viewerCtx = await browser.newContext();
  const viewer = await viewerCtx.newPage();
  await signInAsDevUser(viewer, "legacy-viewer-e2e");
  await joinSharedWorkspace(viewer, `${BASE}/w/${state.remoteId}/${docId}/edit`);
  await expectEditorContains(viewer, "LEGACY SHARED CONTENT");

  await owner.evaluate(() => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ changes: { from: cm.state.doc.length, insert: " + edit" } });
  });
  await expectEditorContains(viewer, "LEGACY SHARED CONTENT + edit");

  await ownerCtx.close();
  await viewerCtx.close();
});
```

Simplify the doubled `migrated` / `state` reads from the draft above into a single `expect.poll(...).toMatchObject(...)` if `expect.poll` object-matching is available in the pinned Playwright (`^1.62`); otherwise keep an explicit poll-then-read. Decide when writing.

- [ ] **Step 3: Run it**

```bash
npx playwright test --project=collab tests/e2e/collab/legacy-migration.spec.ts --workers=1
```

Expected: **1 passed**. Common failures:
- Editor stays empty → `migrateLegacyDoc` didn't fire. Check `handleDocChanged`'s branch order: it needs `ws.shared` **falsy** and `ws.remoteId` **falsy** on the seeded workspace, and `doc.shared === true`. If the store loader added a `shared`/`remoteId` to the workspace, that's the Step 1 fallback trigger.
- Editor shows `""` not the content, migration ran → the `/internal/seed` carried an empty doc. Means `seedLegacyCollabRoom` didn't actually persist; revisit Task 1 Step 3.
- Viewer never sees content → the `remoteId` read is wrong, or `joinSharedWorkspace`'s "Add as new workspace" button text changed. Cross-check against `live-sync.spec.ts`.

- [ ] **Step 4: Verify `src/worker.ts` clean + commit**

```bash
git status --porcelain src/worker.ts   # empty
git add tests/e2e/collab/legacy-migration.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e-collab): COLLAB-39 — legacy doc migrates to a WorkspaceRoom on open

Seeds a legacy CollabRoom, opens a browser with a pre-seeded doc carrying
the old per-document `shared: true` flag, and asserts migrateLegacyDoc
runs transparently: the room's content shows (not the empty local
record), the flag clears, the adopted workspace gets a remoteId, and a
second collaborator gets live sync on the migrated room.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: IMG-06 — `image-marker-concurrent.spec.ts`

**Files:**
- Create: `tests/e2e/collab/image-marker-concurrent.spec.ts`

**Interfaces:**
- Consumes: `ownerWithDoc`, `shareAnyoneLink`, `joinSharedWorkspace`, `editorText`, `expectEditorContains` (`./support/collab`).
- Produces: nothing (leaf test).

- [ ] **Step 1: Write the test**

Create `tests/e2e/collab/image-marker-concurrent.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { ownerWithDoc, shareAnyoneLink, joinSharedWorkspace, editorText, expectEditorContains } from "./support/collab";

// A 1×1 transparent PNG — same fixture the local image specs use.
const PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// IMG-06: while `![Encoding raced.png…]()` sits in the editor during the
// FileReader read, imageMarkerField (a CM6 DecorationSet that
// .map(tr.changes)es every transaction) must remap the placeholder when a
// COLLABORATOR's insertion lands above it, so the real ![alt](key) swaps
// in at the shifted position. IMG-07 covers only the single-editor "switch
// away mid-read → drop it" half. The FileReader window is made
// deterministic with a per-page stub rather than raced.
test("IMG-06: an upload placeholder tracks its position across a collaborator's concurrent insert", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  // Test-only, editor A's page only: defer FileReader.onload by 1.5s so
  // B's edit reliably lands inside the read window. readImageAsDataURL
  // sets `onload` before calling readAsDataURL, so wrapping it here works.
  await a.addInitScript(() => {
    const Real = window.FileReader;
    class SlowFileReader extends Real {
      readAsDataURL(blob: Blob) {
        const orig = this.onload;
        this.onload = (e: ProgressEvent<FileReader>) => setTimeout(() => orig && (orig as any).call(this, e), 1500);
        super.readAsDataURL(blob);
      }
    }
    (window as any).FileReader = SlowFileReader;
  });

  await ownerWithDoc(a, "imgmark-a-e2e", "LINE1\nLINE2\nLINE3");
  const url = await shareAnyoneLink(a, "Editor");
  await joinSharedWorkspace(b, url);
  await expectEditorContains(b, "LINE3");
  await expectEditorContains(a, "LINE1"); // A settled in collab mode

  // A starts an upload at end-of-doc.
  await a.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const cm = window.MDE.getEditor();
    window.MDE.insertImageWithUpload!(new File([bytes], "raced.png", { type: "image/png" }), cm.state.doc.length);
  }, PIXEL_PNG_BASE64);
  await expect.poll(() => editorText(a)).toContain("![Encoding raced.png…]()");

  // During the 1.5s stubbed read, B inserts a 7-char prefix at offset 0.
  await b.evaluate(() => {
    const cm = window.MDE.getEditor();
    cm.dispatch({ changes: { from: 0, insert: "PREFIX " } });
  });
  await expectEditorContains(a, "PREFIX LINE1"); // remote insert reached A before the read resolves

  // Read resolves → the swap-in lands at the SHIFTED tail (contiguous with
  // LINE3), not 7 chars early where the pre-insert offset would have put
  // it.
  await expect.poll(() => editorText(a), { timeout: 15000 }).toBe("PREFIX LINE1\nLINE2\nLINE3![raced](raced.png)");
  expect(await editorText(a)).not.toContain("Encoding");

  // B converges to the same text.
  await expect.poll(() => editorText(b), { timeout: 15000 }).toBe("PREFIX LINE1\nLINE2\nLINE3![raced](raced.png)");

  await aCtx.close();
  await bCtx.close();
});
```

- [ ] **Step 2: Run it**

```bash
npx playwright test --project=collab tests/e2e/collab/image-marker-concurrent.spec.ts --workers=1
```

Expected: **1 passed**. Common failures:
- `![Encoding raced.png…]()` never appears → the `FileReader` subclass broke the read entirely (e.g. `super.readAsDataURL` binding). Simplify the stub to wrap on the instance via a getter/setter for `onload`, or patch `FileReader.prototype.readAsDataURL` directly with `const p = FileReader.prototype.readAsDataURL; FileReader.prototype.readAsDataURL = function (b) { … }`.
- Final text has the link 7 chars early (`PREFIX LINE1\nLINE2\nLINE![raced](raced.png)3`) → **this is the regression the test exists to catch**; if it shows up, the bug is real and pre-existing — stop and report per systematic-debugging, don't "fix" the test.
- `ownerWithDoc` typing `"LINE1\nLINE2\nLINE3"` produces list-continuation or auto-indent → replace that call's content with `""` and set the three lines via `a.evaluate(() => cm.dispatch({ changes: { from: 0, insert: "LINE1\nLINE2\nLINE3" } }))` before sharing.
- Timing still flaky on a slow runner → raise the stub delay to `2500` (still well under the 15s `expect` timeout).

- [ ] **Step 3: Verify `src/worker.ts` clean + commit**

```bash
git status --porcelain src/worker.ts   # empty
git add tests/e2e/collab/image-marker-concurrent.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e-collab): IMG-06 — image placeholder tracks position across a collaborator's edit

Deterministic 1.5s FileReader stub on editor A; collaborator B inserts a
prefix at offset 0 during the read; asserts the ![raced](raced.png)
swap-in follows the shifted placeholder to the tail instead of landing at
the stale pre-insert offset, and that B converges.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Catalogue + changelog

**Files:**
- Modify: `docs/TEST-COVERAGE.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Flip the two `gap` rows to `covered` in `docs/TEST-COVERAGE.md`**

IMG-06 row (§5 Images table). Find:

```
| IMG-06 | The `![Encoding name…]()` placeholder is replaced in place once the `FileReader` resolves, its position tracked across concurrent edits | e2e-collab | gap | —                                | still deferred — needs a second live editor typing during the `FileReader` window (a hard timing setup). Single-editor half covered by IMG-07; see `## Deferred` |
```

Change to:

```
| IMG-06 | The `![Encoding name…]()` placeholder is replaced in place once the `FileReader` resolves, its position tracked across concurrent edits | e2e-collab | covered | `tests/e2e/collab/image-marker-concurrent.spec.ts` | deterministic 1.5s `FileReader` stub on editor A; a collaborator's prefix insert shifts the live placeholder and the `![raced](raced.png)` swap-in follows it to the tail. Single-editor drop-on-switch is IMG-07 |
```

COLLAB-39 row (§10 Workspace collab table). Find:

```
| COLLAB-39 | Legacy `CollabRoom` single-doc share link transparently migrates to a fresh `WorkspaceRoom` on open, before live sync attaches — end-to-end | e2e-collab | gap  | —                                                     | still deferred — needs a manufactured `/api/collab` room with WS-seeded content, then `/d/<id>` opened by a fresh visitor. `handleMigrateRequest` tombstone + the name-forwarding path are integration-covered (`collab-room.test.ts`, `workspace-room.test.ts`) |
```

Change to:

```
| COLLAB-39 | Legacy `CollabRoom` single-doc share link transparently migrates to a fresh `WorkspaceRoom` on open, before live sync attaches — end-to-end | e2e-collab | covered | `tests/e2e/collab/legacy-migration.spec.ts` | raw-WS-seeded legacy `CollabRoom` + a fresh visitor opening a `shared: true` doc; asserts content carry-over, the flag clearing, the adopted-workspace `remoteId`, and live sync on the migrated room. `handleMigrateRequest` tombstone also integration-covered (`collab-room.test.ts`) |
```

- [ ] **Step 2: Remove the IMG-06 row from `## Deferred`**

Delete this row from the `## Deferred` table (keep the VER-08 and GIST-05 rows):

```
| IMG-06 | The `![Encoding name…]()` placeholder tracks its position as a collaborator's concurrent edits land during the `FileReader` window | `e2e-collab`, deferred to the §10 phase — needs a second live editor making edits while the file reads. The single-editor half (a doc switch mid-read drops the pending image, `if (!range) return`) is covered by IMG-07. |
```

- [ ] **Step 3: Recount the subsystem-totals table**

Open the table at the top of `docs/TEST-COVERAGE.md` (the `| Subsystem | Covered | Partial | Gap | Total |` one). For **every** subsystem row, count its `covered` / `partial` / `gap` rows in that subsystem's detail table and write the true numbers; then sum the columns into the `**Total**` row. Known effects of this change: §5 Images gap `1 → 0` (covered `18 → 19`); §10 Workspace collab gap `1 → 0` (covered `44 → 45`). Also fix any **pre-existing** drift you find (the current `**Total**` says `308 / 3 / 3` but only 2 `gap` and 2 `partial` rows exist across all detail tables — reconcile every row, don't just apply the two deltas). The `Gap` column total must end at **0**.

- [ ] **Step 4: Fix the prose to match**

In the paragraph that begins `~93% of enumerated scenarios have a test asserting their outcome` (just below the table): update the percentages/counts to the recounted numbers, and rewrite the "the N remaining gaps are, by design:" sentence to say there are **no** `gap` rows left and that GIST-05 is the sole remaining `partial` (a real isomorphic-git push — creates a gist per run; smart-HTTP push has no test double). Remove the now-stale "queued for Bucket B" / MOB-12 / COLLAB-31 gap phrasing if it implies open gaps that no longer exist; keep COLLAB-31 described as a `partial`.

Also update the line-coverage / test-count sentence near the top only if it cites a gap count; leave the raw `npm run test:coverage` percentages alone (not re-measured here).

- [ ] **Step 5: Add the CHANGELOG bullet**

In `CHANGELOG.md`, under the existing `## [1.48.4] - 2026-09-08` → `### Changed` list (which already has the flakiness-suite bullet), append:

```
- **Test coverage — the two long-deferred `e2e-collab` gaps are closed.** COLLAB-39 drives the legacy single-document → workspace migration end-to-end: a raw-WebSocket-seeded `CollabRoom`, then a fresh visitor opening a document still carrying the old per-document `shared` flag — asserting the content carries over, the workspace is adopted locally, and live sync works on the migrated room. IMG-06 covers an image-upload placeholder keeping its place when a collaborator types above it mid-encode. No catalogued `gap` rows remain; GIST-05 (a real gist push, which would create a gist every run) stays a documented partial.
```

- [ ] **Step 6: Format check + commit**

```bash
npm run format:check   # if it flags the md files: npm run format, re-stage
git add docs/TEST-COVERAGE.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: mark COLLAB-39 + IMG-06 covered; recount coverage table

Both e2e-collab gap rows flip to covered; the IMG-06 Deferred row is
removed. Recounts the subsystem-totals table from the detail rows
(fixing pre-existing drift) — zero gap rows remain, GIST-05 is the lone
partial. Adds the matching CHANGELOG bullet to the existing 1.48.4
section.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Revert dev-login, confirm the tree is clean**

```bash
bash tests/scripts/manual-testing/disable-dev-login.sh
kill %1 2>/dev/null; lsof -ti:8787 | xargs kill -9 2>/dev/null || true
git status --porcelain          # only expected: untracked TODO.md / .vitest/ from before
git diff HEAD src/worker.ts      # empty
```

- [ ] **Step 2: Run the full collab suite via its own harness**

```bash
npm run test:e2e:collab
```

Expected: all collab specs pass (the 25 existing + 2 new = 27). If the browser cache lag bites (`Executable doesn't exist`), apply the `CLAUDE.md` sandbox workaround (`executablePath` under `playwright.config.ts` `use`), run, then revert it before committing.

- [ ] **Step 3: Typecheck + unit + local e2e (nothing here should touch them, but confirm)**

```bash
npm run typecheck
npm test
npx playwright test --project=local
```

Expected: all green — no `src/` change means unit/local are unaffected; this is a regression backstop.

- [ ] **Step 4: Push the branch and open the PR**

Only now (per `CLAUDE.md` "hold the actual bump until told to actually ship") apply the `1.48.4` version bump if it isn't already on the branch:

```bash
grep '"version"' package.json    # if still 1.48.3, hand-edit to 1.48.4 in
                                 # package.json line 4 + package-lock.json lines 3 and ~9
```

Then:

```bash
git push -u origin fix/e2e-collab-newdoc-race
gh pr create --base master --title "e2e-collab: fix chronic flakiness + close COLLAB-39 / IMG-06" --body "$(cat <<'EOF'
## What

Three things, all `e2e-collab`:

1. **Root-cause fix for the chronic `e2e-collab` flakiness.** `onBeforeDocLoad`
   was wired straight to `teardownWorkspace` — a carryover from the
   one-Durable-Object-per-document era. In the current one-room-per-workspace
   design it tore the single multiplexed WebSocket down on *every* document
   switch, so `handleDocChanged`'s "same connected workspace, just rebind"
   fast path was unreachable and every switch did a full HTTP refetch +
   reconnect. For a document created moments after sharing was enabled, that
   rejoin path bound its still-empty Y.Doc over the editor and wiped
   freshly-typed content — the actual bug behind the `readonly-and-editing-mode`
   / `live-sync` "second document created mid-session" flakes (not test
   timing). Now the teardown is skipped when the load stays in the connected
   workspace; `handleDocChanged` still tears down in every branch that
   genuinely leaves the room. The specs pass under `--repeat-each` and run
   ~10× faster.

2. **COLLAB-39** — legacy `CollabRoom` → `WorkspaceRoom` migration, end-to-end.
   A new Node-side helper seeds a populated legacy room over a raw WebSocket;
   the test opens a browser with a doc still carrying the old per-document
   `shared` flag and asserts `migrateLegacyDoc` runs transparently (content
   carry-over, flag clearing, adopted-workspace `remoteId`, live sync on the
   migrated room).

3. **IMG-06** — an image-upload placeholder keeps its position when a
   collaborator inserts text above it during the `FileReader` window
   (deterministic `FileReader`-delay stub instead of racing the read).

## Coverage

`docs/TEST-COVERAGE.md`: both gap rows → covered; subsystem table recounted
(fixes pre-existing drift). **No `gap` rows remain**; GIST-05 (a real gist
push) is the lone documented partial.

## Versioning

Patch bump to **1.48.4** — test-only + an internal sync-race fix, no
user-facing feature. `CHANGELOG.md` `### Fixed` + `### Changed`; no
`whats-new` entry.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Watch CI to green, then merge with a merge commit**

Per `CLAUDE.md`: wait for `.github/workflows/test.yml` green, merge the PR (real merge commit, not squash), then nothing else by hand — `auto-tag.yml` tags `v1.48.4` and cuts the release, Cloudflare auto-deploys from `master`.

---

## Self-Review

**1. Spec coverage.**
- Spec "New file `support/legacy-room.ts`" (`mintDevSession` + `seedLegacyCollabRoom`) → Task 1.
- Spec "New file `legacy-migration.spec.ts`" (COLLAB-39, steps 1–9) → Task 2 (trigger, content, flag clear, `remoteId`, live sync all asserted).
- Spec "New file `image-marker-concurrent.spec.ts`" (IMG-06, steps 1–10) → Task 3.
- Spec "`docs/TEST-COVERAGE.md`" (rows, Deferred, recount, prose) → Task 4 Steps 1–4.
- Spec "`CHANGELOG.md`" (fold into `1.48.4`) → Task 4 Step 5.
- Spec non-goal "no production code change" → Global Constraints + a `git status src/worker.ts` check in Tasks 1–3 and Task 5.
- Spec risk "CollabRoom storage never resets" → per-run `docId` in Task 2 Step 2 / Task 1 Step 2.
- Spec risk "pre-seeded localStorage may be normalised" → Task 2 Step 1 spike + documented fallback.
- Spec risk "FileReader stub assumes onload set before readAsDataURL" → Task 3 Step 2 fallback (patch the prototype).

**2. Placeholder scan.** The two "decide when writing" notes (Task 2 Step 2's `expect.poll` object-match; Task 3's fixture) are bounded choices with a stated default, not missing content. Task 2 Step 1 and Task 1 Step 3 are real spikes with explicit branch outcomes. No "TBD", no "add error handling", every code step has literal code.

**3. Type consistency.** `mintDevSession(username: string): Promise<string>` and `seedLegacyCollabRoom({ docId, ownerCookie, content, name? }): Promise<void>` are used with exactly that shape in Task 1 Step 2, Task 2 Step 2. `editorText` / `expectEditorContains` / `joinSharedWorkspace` / `ownerWithDoc` / `shareAnyoneLink` / `dismissWhatsNew` / `BASE` are all real exports of `tests/e2e/collab/support/collab.ts` (verified). `signInAsDevUser` is the real export of `./support/dev-login`. `window.MDE.insertImageWithUpload` matches `client/src/types.ts:254`.
