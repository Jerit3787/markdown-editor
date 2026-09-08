# Request edit access (CV2-5) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A joined `viewer` / `reviewer` asks the workspace owner for edit access; the owner approves/denies from the Share dialog; the requester's editor surface unlocks live (no reload).

**Architecture:** New `WorkspaceRoom` endpoints (`POST /access-request`, `POST /access-request/:username`) + a `"accessRequests"` DO storage key. Two new WebSocket frame types: `MESSAGE_ACCESS_REQUEST` (owner sees a toast) and `MESSAGE_ACCESS_CHANGED` (every client re-fetches `/access` and rejoins the workspace if its own resolved role changed — the reconnect is what grants the new server-side write permission). `GET /access` redacts the request list to the owner only. Client adds a `RequestAccessModal`, a Requests section + badge in `Share.svelte`, and the `#shareBtn` click dispatches to one or the other.

**Tech Stack:** TypeScript, Cloudflare Durable Objects, Svelte 5, Vitest (`unit` + `components`), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-request-access-design.md`

## Global Constraints

- **Continue on branch `docs/cv2-5-request-access-spec`** (holds the spec; PR #186). Rename the PR in the final task.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` only. PR body ends `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **`src/worker.ts` is NOT touched** by this plan (routes live in `src/workspace-room.ts`). Still: `git status` before every `git add`, add explicit paths, never stage `src/worker.ts`. After Task 3, run `git apply --check tests/scripts/manual-testing/dev-login.patch` to confirm it still applies (per `project_dev_login_patch_fragility` — the patch targets `worker.ts`, so it should be fine, but verify).
- Root `tsconfig.json` (strict) covers `src/**` + `tests/src/**`; `client/tsconfig.json` (lax) covers `client/src/**` + `tests/client/src/**`.
- **Two `AccessRequest` type definitions**, hand-synced: `src/access-role.ts` (Worker) and `client/src/types.ts` (client) — same convention `AccessRecord` already follows.
- Version bump / CHANGELOG `whats-new` entry are the **final task**.
- Wire-frame numbering: existing `MESSAGE_*` are 0–5. New: `MESSAGE_ACCESS_REQUEST = 6`, `MESSAGE_ACCESS_CHANGED = 7`. Both docId-less (like `MESSAGE_WORKSPACE_META` / `_DELETED`) — handled with an early `return` in the client before the shared `docId` read.

---

## File Structure

**Modify:**
- `src/access-role.ts` — `AccessRequest` interface.
- `client/src/types.ts` — `AccessRequest` interface (hand-synced copy) + `AccessRecord` gains optional `accessRequests?` / `myAccessRequestPending?`.
- `src/workspace-room.ts` — storage key + 2 endpoints + 2 frame constants + broadcasts + `GET /access` redaction + `PUT /access` broadcast.
- `client/src/collab.ts` — frame handlers, `handleAccessChanged`, `myAccessRequestPending` seeding, owner nudge, `requestAccessFromOwner` / `approveAccessRequest` / `denyAccessRequest`, `#shareBtn` click dispatch, `teardownWorkspace` nudge-set reset.
- `client/src/stores/share.ts` — `myAccessRequestPending`, `requestAccessModalOpen`.
- `client/src/components/Share.svelte` — Requests section, badge `$effect`, `#shareBtn` title copy.
- `client/index.html` — `#shareRequestBadge` inside `#shareBtn`; `#request-access-modal-mount`.
- `client/src/main.ts` — mount `RequestAccessModal`.

**Create:**
- `client/src/components/RequestAccessModal.svelte`
- `tests/client/src/components/RequestAccessModal.test.ts`
- `tests/e2e/collab/request-access.spec.ts`
- `tests/scripts/manual-testing/capture-request-access-screenshot.mjs`, `client/public/whats-new/request-access.png`

**Extend tests:** `tests/src/workspace-room.test.ts`, `tests/src/access-visibility.test.ts`, `tests/client/src/collab.test.ts`, `tests/client/src/components/Share.test.ts`.

---

## Task 1: `AccessRequest` type + storage helper

**Files:**
- Modify: `src/access-role.ts`, `client/src/types.ts`, `src/workspace-room.ts`
- Test: `tests/src/workspace-room.test.ts`

**Interfaces:**
- Produces:
  - `AccessRequest { username: string; message: string; createdAt: number }` — in both `src/access-role.ts` and `client/src/types.ts`.
  - `WorkspaceRoom.getAccessRequests(): Promise<AccessRequest[]>` — reads storage key `"accessRequests"`, returns `[]` when unset.
  - `client/src/types.ts` `AccessRecord` gains `accessRequests?: AccessRequest[]` and `myAccessRequestPending?: boolean` (both optional — only present on the owner's / requester's `GET /access`).

- [ ] **Step 1: Write the failing test** — `tests/src/workspace-room.test.ts`

```ts
describe("WorkspaceRoom.getAccessRequests", () => {
  it("returns [] when nothing is stored, and the stored list otherwise", async () => {
    const room = new WorkspaceRoom(fakeState(), fakeEnv);
    expect(await room.getAccessRequests()).toEqual([]);
    await room.state.storage.put("accessRequests", [{ username: "bob", message: "pls", createdAt: 1 }]);
    expect(await room.getAccessRequests()).toEqual([{ username: "bob", message: "pls", createdAt: 1 }]);
  });
});
```

- [ ] **Step 2: Run — expect failure** (`getAccessRequests` undefined)

- [ ] **Step 3: Implement**

`src/access-role.ts`, after `InvitedPerson`:
```ts
export interface AccessRequest {
  username: string;
  message: string; // "" when none
  createdAt: number;
}
```

`client/src/types.ts` — add the same interface near `InvitedPerson`, and:
```ts
export interface AccessRecord {
  // ...existing...
  invited: InvitedPerson[];
  // Present only on the owner's own GET /access (the roster of pending
  // requests) / a requester's own GET /access (just the boolean).
  accessRequests?: AccessRequest[];
  myAccessRequestPending?: boolean;
}
```

`src/workspace-room.ts` — export the re-export line already there (`export type { Role, InvitedPerson, AccessRecord }`) → add `AccessRequest`. Then, next to `getAccess()`:
```ts
async getAccessRequests(): Promise<AccessRequest[]> {
  const stored = await this.state.storage.get<AccessRequest[]>("accessRequests");
  return Array.isArray(stored) ? stored : [];
}
```

- [ ] **Step 4: Typecheck + test + commit**

Run: `npm run typecheck` — clean. `npx vitest run tests/src/workspace-room.test.ts -t "getAccessRequests"` — PASS.

```bash
git add src/access-role.ts client/src/types.ts src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): AccessRequest type + WorkspaceRoom.getAccessRequests (CV2-5)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `POST /access-request` (the requester) + `MESSAGE_ACCESS_REQUEST`

**Files:**
- Modify: `src/workspace-room.ts`
- Test: `tests/src/workspace-room.test.ts`

**Interfaces:**
- Consumes: `getAccess()`, `getAccessRequests()`, `authorize()`, `broadcast()`, `getSession()`.
- Produces: `MESSAGE_ACCESS_REQUEST = 6`; a route `POST /api/workspace/:id/access-request` → `handleAccessRequestSubmit(request)`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("WorkspaceRoom POST /access-request", () => {
  async function room(role: "viewer" | "reviewer" | "editor") {
    const r = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await r.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role, invited: [] });
    return r;
  }
  function req(cookie: string | null, body: unknown) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cookie) headers.Cookie = `mde_gh_session=${cookie}`;
    return new Request("https://x/api/workspace/w1/access-request", { method: "POST", headers, body: JSON.stringify(body) });
  }

  it("a viewer's request is stored and broadcast as MESSAGE_ACCESS_REQUEST", async () => {
    const r = await room("viewer");
    const sent: ArrayBuffer[] = [];
    const ws = { send: (m: ArrayBuffer) => sent.push(m), accept() {}, addEventListener() {} } as unknown as WebSocket;
    r.handleSession(ws, "alice", "editor"); // owner connected
    sent.length = 0;
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "t", username: "bob" });
    const res = await r.fetch(req(cookie, { message: "  need to fix a typo  " }));
    expect(res.status).toBe(200);
    expect(await r.getAccessRequests()).toEqual([{ username: "bob", message: "need to fix a typo", createdAt: expect.any(Number) }]);
    const frame = new Uint8Array(sent.at(-1)!);
    const d = decoding.createDecoder(frame);
    expect(decoding.readVarUint(d)).toBe(6); // MESSAGE_ACCESS_REQUEST
    expect(decoding.readVarString(d)).toBe("bob");
    expect(decoding.readVarString(d)).toBe("need to fix a typo");
  });

  it("re-requesting replaces the prior entry", async () => {
    const r = await room("viewer");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "t", username: "bob" });
    await r.fetch(req(cookie, { message: "first" }));
    await r.fetch(req(cookie, { message: "second" }));
    const list = await r.getAccessRequests();
    expect(list).toHaveLength(1);
    expect(list[0]!.message).toBe("second");
  });

  it("an editor gets 400, an outsider 403/401", async () => {
    const rEditor = await room("editor");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "t", username: "bob" });
    expect((await rEditor.fetch(req(cookie, {}))).status).toBe(400);

    const rRestricted = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await rRestricted.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    expect((await rRestricted.fetch(req(cookie, {}))).status).toBe(403); // bob not invited → no role
    expect((await rRestricted.fetch(req(null, {}))).status).toBe(401); // no session
  });

  it("caps the message at 500 chars", async () => {
    const r = await room("reviewer");
    const cookie = await encryptSession(fakeEnvWithSecret, { token: "t", username: "bob" });
    await r.fetch(req(cookie, { message: "x".repeat(1000) }));
    expect((await r.getAccessRequests())[0]!.message).toHaveLength(500);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

`src/workspace-room.ts`:
- Add `const MESSAGE_ACCESS_REQUEST = 6;` with the other constants.
- Route in `fetch()` (before the WebSocket-upgrade fallthrough, near the other `url.pathname.endsWith` checks — but note `/access-request` and `/access-request/:username` both start with the `/access` prefix; check the more specific ones first):
  ```ts
  const accessRequestActionMatch = url.pathname.match(/\/access-request\/([^/]+)$/);
  if (accessRequestActionMatch) return this.handleAccessRequestAction(request, decodeURIComponent(accessRequestActionMatch[1]!)); // Task 3
  if (url.pathname.endsWith("/access-request")) return this.handleAccessRequestSubmit(request);
  ```
  Place these **above** `if (url.pathname.endsWith("/access")) return this.handleAccessRequest(request);` (so `/access-request` doesn't fall into `/access`... actually `.endsWith("/access")` is false for `/access-request`, so order doesn't strictly matter — but keep them adjacent and grouped).
- Handler:
  ```ts
  async handleAccessRequestSubmit(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    if (auth.role === "editor") return new Response("You already have edit access.", { status: 400 });
    if (!auth.username) return new Response("Sign in with GitHub first.", { status: 401 });

    let body: { message?: unknown };
    try { body = await request.json(); } catch { body = {}; }
    const message = (typeof body.message === "string" ? body.message : "").trim().slice(0, 500);

    const requests = await this.getAccessRequests();
    const next = requests.filter((r) => r.username !== auth.username);
    next.push({ username: auth.username, message, createdAt: Date.now() });
    await this.state.storage.put("accessRequests", next);

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_ACCESS_REQUEST);
    encoding.writeVarString(encoder, auth.username);
    encoding.writeVarString(encoder, message);
    this.broadcast(encoding.toUint8Array(encoder), null);

    return Response.json({ ok: true });
  }
  ```
  Note: `authorize()` returns `role: "editor"` for the owner too, so the owner hits the 400 branch — fine.

- [ ] **Step 4: Typecheck + test + commit**

`npm run typecheck` (strict) — clean. `npx vitest run tests/src/workspace-room.test.ts -t "access-request"` — PASS.

```bash
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): POST /access-request — a viewer/reviewer asks for edit access (CV2-5)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `POST /access-request/:username` (owner approve/deny) + `MESSAGE_ACCESS_CHANGED`

**Files:**
- Modify: `src/workspace-room.ts`
- Test: `tests/src/workspace-room.test.ts`

**Interfaces:**
- Produces: `MESSAGE_ACCESS_CHANGED = 7`; `handleAccessRequestAction(request, username)`; `PUT /access` also broadcasts `MESSAGE_ACCESS_CHANGED`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("WorkspaceRoom POST /access-request/:username (owner)", () => {
  async function seeded() {
    const r = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await r.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] });
    await r.state.storage.put("accessRequests", [{ username: "bob", message: "", createdAt: 1 }]);
    return r;
  }
  const ownerCookie = () => encryptSession(fakeEnvWithSecret, { token: "t", username: "alice" });
  function action(cookie: string, username: string, body: unknown) {
    return new Request(`https://x/api/workspace/w1/access-request/${username}`, {
      method: "POST", headers: { Cookie: `mde_gh_session=${cookie}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  }

  it("approve adds the invite, clears the request, broadcasts MESSAGE_ACCESS_CHANGED", async () => {
    const r = await seeded();
    const sent: ArrayBuffer[] = [];
    const ws = { send: (m: ArrayBuffer) => sent.push(m), accept() {}, addEventListener() {} } as unknown as WebSocket;
    r.handleSession(ws, "carol", "viewer");
    sent.length = 0;
    const res = await r.fetch(action(await ownerCookie(), "bob", { action: "approve" }));
    expect(res.status).toBe(200);
    expect((await r.getAccess()).invited).toEqual([{ username: "bob", role: "editor" }]);
    expect(await r.getAccessRequests()).toEqual([]);
    expect(decoding.readVarUint(decoding.createDecoder(new Uint8Array(sent.at(-1)!)))).toBe(7);
  });

  it("approve honours an explicit role", async () => {
    const r = await seeded();
    await r.fetch(action(await ownerCookie(), "bob", { action: "approve", role: "reviewer" }));
    expect((await r.getAccess()).invited).toEqual([{ username: "bob", role: "reviewer" }]);
  });

  it("deny just clears the request", async () => {
    const r = await seeded();
    await r.fetch(action(await ownerCookie(), "bob", { action: "deny" }));
    expect(await r.getAccessRequests()).toEqual([]);
    expect((await r.getAccess()).invited).toEqual([]);
  });

  it("non-owner → 403; unknown username → 404", async () => {
    const r = await seeded();
    const carol = await encryptSession(fakeEnvWithSecret, { token: "t", username: "carol" });
    expect((await r.fetch(action(carol, "bob", { action: "deny" }))).status).toBe(403);
    expect((await r.fetch(action(await ownerCookie(), "nobody", { action: "deny" }))).status).toBe(404);
  });

  it("PUT /access also broadcasts MESSAGE_ACCESS_CHANGED", async () => {
    const r = await seeded();
    const sent: ArrayBuffer[] = [];
    const ws = { send: (m: ArrayBuffer) => sent.push(m), accept() {}, addEventListener() {} } as unknown as WebSocket;
    r.handleSession(ws, "carol", "viewer");
    sent.length = 0;
    await r.fetch(new Request("https://x/api/workspace/w1/access", {
      method: "PUT", headers: { Cookie: `mde_gh_session=${await ownerCookie()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ generalAccess: "anyone", role: "reviewer", invited: [] }),
    }));
    expect(sent.some((m) => decoding.readVarUint(decoding.createDecoder(new Uint8Array(m))) === 7)).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

- `const MESSAGE_ACCESS_CHANGED = 7;`
- A small helper `broadcastAccessChanged()`:
  ```ts
  broadcastAccessChanged(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_ACCESS_CHANGED);
    this.broadcast(encoding.toUint8Array(encoder), null);
  }
  ```
- `handleAccessRequestAction(request, username)`:
  ```ts
  async handleAccessRequestAction(request: Request, username: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const session = await this.getSession(request);
    const access = await this.getAccess();
    if (!session?.username || session.username !== access.owner) {
      return new Response("Only the owner can respond to access requests.", { status: 403 });
    }
    let body: { action?: unknown; role?: unknown };
    try { body = await request.json(); } catch { body = {}; }
    const action = body.action === "approve" ? "approve" : body.action === "deny" ? "deny" : null;
    if (!action) return new Response("action must be 'approve' or 'deny'.", { status: 400 });

    const requests = await this.getAccessRequests();
    if (!requests.some((r) => r.username === username)) return new Response("No such pending request.", { status: 404 });
    await this.state.storage.put("accessRequests", requests.filter((r) => r.username !== username));

    if (action === "approve") {
      const role: Role = (["viewer", "reviewer", "editor"] as const).includes(body.role as Role) ? (body.role as Role) : "editor";
      const invited = access.invited.filter((p) => p.username !== username);
      invited.push({ username, role });
      await this.state.storage.put("access", { ...access, invited });
    }
    this.broadcastAccessChanged();
    return Response.json({ ok: true });
  }
  ```
- In `handleAccessRequest`'s `PUT` branch, after `await this.state.storage.put("access", next);` add `this.broadcastAccessChanged();`.

- [ ] **Step 4: Typecheck + test + full worker test + commit**

`npm run typecheck` — clean. `npx vitest run tests/src/workspace-room.test.ts` — PASS.
Run: `git apply --check tests/scripts/manual-testing/dev-login.patch` — still applies (routes are in workspace-room.ts, not worker.ts).

```bash
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): owner approves/denies access requests; MESSAGE_ACCESS_CHANGED broadcast (CV2-5)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `GET /access` redaction — request list is owner-only

**Files:**
- Modify: `src/workspace-room.ts`
- Test: `tests/src/workspace-room.test.ts`, `tests/src/access-visibility.test.ts`

**Interfaces:**
- Produces: `GET /access` response includes `accessRequests: AccessRequest[]` for the owner; `myAccessRequestPending: boolean` for an authenticated non-owner; **neither** for an outsider.

- [ ] **Step 1: Write the failing tests** — `tests/src/workspace-room.test.ts`

```ts
describe("GET /access — access-request visibility", () => {
  async function seeded() {
    const r = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await r.state.storage.put("access", { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [{ username: "bob", role: "viewer" }] });
    await r.state.storage.put("accessRequests", [{ username: "bob", message: "hi", createdAt: 1 }]);
    return r;
  }
  const get = (cookie?: string) => new Request("https://x/api/workspace/w1/access", cookie ? { headers: { Cookie: `mde_gh_session=${cookie}` } } : {});

  it("owner sees the full accessRequests list", async () => {
    const r = await seeded();
    const body = await (await r.fetch(get(await encryptSession(fakeEnvWithSecret, { token: "t", username: "alice" })))).json();
    expect(body.accessRequests).toEqual([{ username: "bob", message: "hi", createdAt: 1 }]);
    expect(body.myAccessRequestPending).toBeUndefined();
  });

  it("an invited non-owner sees only myAccessRequestPending (bool), not the list", async () => {
    const r = await seeded();
    const body = await (await r.fetch(get(await encryptSession(fakeEnvWithSecret, { token: "t", username: "bob" })))).json();
    expect(body.accessRequests).toBeUndefined();
    expect(body.myAccessRequestPending).toBe(true);
  });

  it("an outsider sees neither field (and the redacted roster)", async () => {
    const r = new WorkspaceRoom(fakeState(), fakeEnvWithSecret);
    await r.state.storage.put("access", { owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    await r.state.storage.put("accessRequests", [{ username: "bob", message: "hi", createdAt: 1 }]);
    const body = await (await r.fetch(get())).json();
    expect(body.accessRequests).toBeUndefined();
    expect(body.myAccessRequestPending).toBeUndefined();
    expect(body.owner).toBeNull(); // redactAccessForOutsider unchanged
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement** — `handleAccessRequest`'s `GET` branch

```ts
if (request.method === "GET") {
  const access = await this.getAccess();
  const auth = await this.authorize(request);
  const base = auth.ok ? access : redactAccessForOutsider(access);
  const extra: Record<string, unknown> = {};
  if (auth.ok && auth.username && auth.username === access.owner) {
    extra.accessRequests = await this.getAccessRequests();
  } else if (auth.ok && auth.username) {
    const requests = await this.getAccessRequests();
    extra.myAccessRequestPending = requests.some((r) => r.username === auth.username);
  }
  return Response.json({ ...base, ...extra, workspaceName: this.name });
}
```

- [ ] **Step 4: Typecheck + test + commit**

`npm run typecheck` — clean. `npx vitest run tests/src/workspace-room.test.ts tests/src/access-visibility.test.ts` — PASS.

```bash
git add src/workspace-room.ts tests/src/workspace-room.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): GET /access exposes accessRequests to the owner only (CV2-5)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Client — wire handlers, `handleAccessChanged` rejoin, request/approve/deny wrappers, owner nudge

**Files:**
- Modify: `client/src/collab.ts`, `client/src/stores/share.ts`
- Test: `tests/client/src/collab.test.ts`

**Interfaces:**
- Consumes: `MESSAGE_ACCESS_REQUEST = 6`, `MESSAGE_ACCESS_CHANGED = 7`; `fetchWorkspaceAccess`, `computeMyRole`, `rejoinKnownWorkspace`, `syncShareStores`, `showToast`, `collabIsOwner`.
- Produces (exported from `collab.ts`):
  - `requestAccessFromOwner(remoteId: string, message: string): Promise<boolean>` — `POST /access-request`.
  - `approveAccessRequest(remoteId: string, username: string, role: Role): Promise<boolean>` / `denyAccessRequest(remoteId: string, username: string): Promise<boolean>` — `POST /access-request/:username`.
  - `stores/share.ts`: `myAccessRequestPending` (writable bool), `requestAccessModalOpen` (writable bool).

- [ ] **Step 1: Write the failing tests** — `tests/client/src/collab.test.ts` (in / near the `collab-mode role publishing` describe, which already has the `setup(role, suffix)` helper + `MockWebSocket`)

```ts
it("CV2-5: MESSAGE_ACCESS_REQUEST toasts only for the owner", async () => {
  const { doc } = setup("editor", "ar1"); // githubUsername "alice" === owner → collabIsOwner true
  handleDocChanged(doc);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const toastSpy = vi.spyOn(await import("../../../client/src/stores/toast"), "showToast");
  // craft a MESSAGE_ACCESS_REQUEST frame and feed it through the socket
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 6);
  encoding.writeVarString(enc, "bob");
  encoding.writeVarString(enc, "hi");
  MockWebSocket.instances.at(-1)!.onmessage!({ data: encoding.toUint8Array(enc).buffer } as MessageEvent);
  expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining("bob"), expect.anything());
});

it("CV2-5: MESSAGE_ACCESS_CHANGED re-fetches access and rejoins when my role changed", async () => {
  const { doc } = setup("viewer", "ar2", { username: "bob" });
  handleDocChanged(doc);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(get(collabRole)).toBe("viewer");
  // now the access endpoint should report bob as an editor
  (global.fetch as any).mockImplementation(async (url: string) => {
    if (url.includes("/access")) return { ok: true, json: async () => ({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [{ username: "bob", role: "editor" }], myAccessRequestPending: false }) };
    if (url.includes("/docs")) return { ok: true, json: async () => [doc.id] };
    return { ok: false, json: async () => ({}) };
  });
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 7);
  MockWebSocket.instances.at(-1)!.onmessage!({ data: encoding.toUint8Array(enc).buffer } as MessageEvent);
  await expect.poll(() => get(collabRole)).toBe("editor");
});
```

(Adjust to the file's actual `MockWebSocket` shape — it may expose `onmessage` differently; model on an existing test that feeds a frame, e.g. the workspace-meta / deleted tests.)

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

`client/src/stores/share.ts`:
```ts
export const myAccessRequestPending = writable(false);
export const requestAccessModalOpen = writable(false);
```

`client/src/collab.ts`:
- Constants: `const MESSAGE_ACCESS_REQUEST = 6; const MESSAGE_ACCESS_CHANGED = 7;`
- Import `myAccessRequestPending` from `./stores/share`; `showToast` from `./stores/toast` (check if already imported).
- Module-level: `const ownerNudgedRemoteIds = new Set<string>();`
- In `handleServerMessage`, **before** `const docId = decoding.readVarString(decoder);`:
  ```ts
  if (messageType === MESSAGE_ACCESS_REQUEST) {
    const username = decoding.readVarString(decoder);
    decoding.readVarString(decoder); // message — not shown in the toast
    if (get(collabIsOwner)) showToast(`${username} requested edit access`, "info");
    return;
  }
  if (messageType === MESSAGE_ACCESS_CHANGED) {
    const remoteId = workspaceRoom.workspaceId;
    const local = remoteId ? get(workspacesStore).find((w) => w.remoteId === remoteId) : null;
    if (local && remoteId) void handleAccessChanged(local, remoteId);
    return;
  }
  ```
- `handleAccessChanged`:
  ```ts
  async function handleAccessChanged(local: Workspace, remoteId: string): Promise<void> {
    const access = await fetchWorkspaceAccess(remoteId);
    currentAccess = access;
    syncShareStores();
    myAccessRequestPending.set(access.myAccessRequestPending ?? false);
    maybeNudgeOwnerAboutRequests(remoteId, access); // see below

    const newRole = computeMyRole(access, window.MDE.githubUsername);
    if (newRole !== workspaceRoom.role) {
      if (newRole && (newRole === "editor" || workspaceRoom.role === "viewer")) {
        showToast("Your access to this workspace changed", "info");
      }
      const docId = workspaceRoom.activeDocId ?? get(docsStore).find((d) => d.workspaceId === local.id)?.id;
      if (docId) await rejoinKnownWorkspace(remoteId, docId);
    }
  }
  ```
- `maybeNudgeOwnerAboutRequests(remoteId, access)`:
  ```ts
  function maybeNudgeOwnerAboutRequests(remoteId: string, access: AccessRecord): void {
    if (!get(collabIsOwner) || ownerNudgedRemoteIds.has(remoteId)) return;
    const n = access.accessRequests?.length ?? 0;
    if (n === 0) return;
    ownerNudgedRemoteIds.add(remoteId);
    showToast(`${n} ${n === 1 ? "person is" : "people are"} waiting for edit access — open Share to review`, "info");
  }
  ```
  Also call `maybeNudgeOwnerAboutRequests` wherever the owner's `currentAccess` first lands after a join — i.e. at the end of `joinWorkspace` / `rejoinKnownWorkspace` once `currentAccess` is set, or in `syncShareStores` guarded by a "have I nudged" check (the `Set` already guards it, so calling it from `syncShareStores` is safe and simplest).
- `teardownWorkspace()` end: `myAccessRequestPending.set(false); ownerNudgedRemoteIds.clear();`
- Wrappers (near `addPerson` / `removeInvite`):
  ```ts
  export async function requestAccessFromOwner(remoteId: string, message: string): Promise<boolean> {
    const res = await fetch(`/api/workspace/${remoteId}/access-request`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }),
    });
    return res.ok;
  }
  export async function approveAccessRequest(remoteId: string, username: string, role: Role): Promise<boolean> {
    const res = await fetch(`/api/workspace/${remoteId}/access-request/${encodeURIComponent(username)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve", role }),
    });
    if (res.ok) { currentAccess = await fetchWorkspaceAccess(remoteId); syncShareStores(); }
    return res.ok;
  }
  export async function denyAccessRequest(remoteId: string, username: string): Promise<boolean> {
    const res = await fetch(`/api/workspace/${remoteId}/access-request/${encodeURIComponent(username)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "deny" }),
    });
    if (res.ok) { currentAccess = await fetchWorkspaceAccess(remoteId); syncShareStores(); }
    return res.ok;
  }
  ```
- `fetchWorkspaceAccess` currently returns `AccessRecord`; make sure it passes through `accessRequests` / `myAccessRequestPending` (it likely just `res.json()`s — confirm it doesn't strip unknown fields; if it maps explicitly, add the two).

- [ ] **Step 4: Typecheck + tests + commit**

`npm run typecheck` — clean. `npx vitest run --project=unit tests/client/src/collab.test.ts` — PASS.

```bash
git add client/src/collab.ts client/src/stores/share.ts tests/client/src/collab.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): client access-request handlers, live rejoin on role change, owner nudge (CV2-5)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `RequestAccessModal` + `#shareBtn` dispatch + badge markup

**Files:**
- Create: `client/src/components/RequestAccessModal.svelte`, `tests/client/src/components/RequestAccessModal.test.ts`
- Modify: `client/index.html`, `client/src/main.ts`, `client/src/collab.ts` (the `#shareBtn` click listener)

**Interfaces:**
- Consumes: `requestAccessModalOpen`, `myAccessRequestPending` (`stores/share`); `requestAccessFromOwner`, `workspaceRoom` remoteId (via a small exported getter or `get(workspacesStore)`); `showToast`.
- Produces: clicking a greyed `#shareBtn` (viewer/reviewer) opens `RequestAccessModal`; `#shareRequestBadge` element exists inside `#shareBtn`.

- [ ] **Step 1: Write the failing test** — `tests/client/src/components/RequestAccessModal.test.ts`

```ts
import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import RequestAccessModal from "../../../../client/src/components/RequestAccessModal.svelte";
import { requestAccessModalOpen, myAccessRequestPending } from "../../../../client/src/stores/share";

beforeEach(() => {
  requestAccessModalOpen.set(false);
  myAccessRequestPending.set(false);
  window.MDE = { githubUsername: "bob" } as unknown as typeof window.MDE;
});

test("renders the note field + buttons when open, sends on submit", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
  requestAccessModalOpen.set(true);
  const screen = await render(RequestAccessModal);
  await screen.getByRole("textbox").fill("need to fix a typo");
  await screen.getByRole("button", { name: /send request/i }).click();
  await expect.poll(() => (global.fetch as any).mock.calls.length).toBeGreaterThan(0);
  const [, opts] = (global.fetch as any).mock.calls[0];
  expect(JSON.parse(opts.body).message).toBe("need to fix a typo");
});
```

(If `RequestAccessModal` needs a workspace remoteId to build the URL, stub it — e.g. mount a `fakeSharedWorkspace` into `workspacesStore` + `activeWorkspaceIdStore`, matching how `collab.test.ts` does it, or expose `workspaceRoom.workspaceId` via a tiny `getShareRemoteId()` export.)

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

`client/src/components/RequestAccessModal.svelte` — model on a small existing modal (e.g. `GithubSignInModal.svelte` / `ShareChoiceModal.svelte`): a `Modal` titled "Request edit access", a `<textarea aria-label="Add a note to the owner (optional)">`, a "Send request" primary button + "Cancel". On send: `const ok = await requestAccessFromOwner(remoteId, note); if (ok) { myAccessRequestPending.set(true); requestAccessModalOpen.set(false); showToast("Request sent to the owner", "info"); } else showToast("Couldn't send the request", "error");`. `remoteId` from `get(workspacesStore).find(w => w.id === get(activeWorkspaceIdStore))?.remoteId` (or a getter).

`client/index.html` — inside `#shareBtn`, after the label span:
```html
<span id="shareRequestBadge" class="comment-badge" hidden></span>
```
And a mount point near the other modal mounts:
```html
<div id="request-access-modal-mount"></div>
```

`client/src/main.ts` — `mount(RequestAccessModal, { target: document.getElementById("request-access-modal-mount")! });`

`client/src/collab.ts` — the `#shareBtn` click listener (currently `addEventListener("click", openShareModal)` around line 1489):
```ts
document.getElementById("shareBtn")!.addEventListener("click", () => {
  const role = workspaceRoom.role;
  if (role === "viewer" || role === "reviewer") {
    if (get(myAccessRequestPending)) { showToast("Your access request is still pending", "info"); return; }
    requestAccessModalOpen.set(true);
    return;
  }
  void openShareModal();
});
```
(`openShareModal` keeps its own viewer/reviewer early-return as a backstop.)

- [ ] **Step 4: Build + typecheck + tests + commit**

`npm run typecheck` — clean. `npm run build` — succeeds. `npx vitest run --project=components tests/client/src/components/RequestAccessModal.test.ts` — PASS.

```bash
git add client/src/components/RequestAccessModal.svelte tests/client/src/components/RequestAccessModal.test.ts client/index.html client/src/main.ts client/src/collab.ts
git commit -m "$(cat <<'EOF'
feat(collab): RequestAccessModal — greyed Share button opens it for a viewer/reviewer (CV2-5)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `Share.svelte` — Requests section + badge + button copy

**Files:**
- Modify: `client/src/components/Share.svelte`
- Test: `tests/client/src/components/Share.test.ts`

**Interfaces:**
- Consumes: `shareAccess` (now carries `accessRequests?`), `collabIsOwner`, `approveAccessRequest`, `denyAccessRequest`, `myAccessRequestPending`.
- Produces: a "Requests" section for an owner with pending requests; `#shareRequestBadge` reflects the count; the greyed `#shareBtn` `title` reads "Request edit access" / "Edit access requested" for a non-editor.

- [ ] **Step 1: Write the failing test** — `tests/client/src/components/Share.test.ts`

```ts
test("CV2-5: an owner with pending requests sees a Requests section; Approve calls the wrapper", async () => {
  const approve = vi.fn(async () => true);
  vi.doMock("../../../../client/src/collab", async (orig) => ({ ...(await orig()), approveAccessRequest: approve }));
  // ...set shareAccess with accessRequests: [{ username: "bob", message: "hi", createdAt: 1 }],
  //    enterCollabRoom(..., "editor", true) so collabIsOwner is true, render Share...
  // expect a row with "bob" and "hi"; click Approve → approve called with (remoteId, "bob", "editor")
});

test("CV2-5: a viewer/reviewer's greyed #shareBtn title reads 'Request edit access'", async () => {
  // #shareBtn in the DOM; enterCollabRoom(..., "viewer", false); render Share
  // expect #shareBtn.title === "Request edit access"; set myAccessRequestPending → "Edit access requested"
});
```

(Match the file's existing mount pattern; `vi.doMock` for `collab` may be awkward — alternative: pass the approve/deny handlers as they are and assert the `fetch` call, or spy on the module. Use whichever the file already does for `setAccessMode` etc.)

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Implement**

`Share.svelte`:
- Import `approveAccessRequest`, `denyAccessRequest` from `../collab`; `collabIsOwner` from `../stores/collabMode`; `myAccessRequestPending` from `../stores/share`.
- `const accessRequests = $derived(access.accessRequests ?? []);`
- `let requestRole: Record<string, string> = $state({});` (per-username role select, default "editor").
- Requests section, rendered just before `<div class="menu-section-label">People with access</div>` when `$collabIsOwner && accessRequests.length`:
  ```svelte
  <div class="menu-section-label">Requests</div>
  <div class="share-people-list">
    {#each accessRequests as req (req.username)}
      <div class="share-person share-request">
        <span class="presence-avatar" style:background="var(--text-dim)">{initial(req.username)}</span>
        <span class="share-person-name">
          {req.username}
          {#if req.message}<span class="modal-hint share-request-note">{req.message}</span>{/if}
        </span>
        <select class="share-role-select" aria-label={`Grant ${req.username}`} bind:value={requestRole[req.username]}>
          <option value="viewer">Viewer</option><option value="reviewer">Reviewer</option><option value="editor" selected>Editor</option>
        </select>
        <button type="button" class="primary-btn share-request-approve" onclick={() => approveAccessRequest(remoteId, req.username, requestRole[req.username] || "editor")}>Approve</button>
        <button type="button" class="share-person-remove" aria-label={`Deny ${req.username}`} onclick={() => denyAccessRequest(remoteId, req.username)}><svg class="icon"><use href="#icon-x"></use></svg></button>
      </div>
    {/each}
  </div>
  <div class="menu-divider"></div>
  ```
  `remoteId` — from `get(workspacesStore)` lookup or a `collab.ts` getter (same one Task 6 uses).
- Badge `$effect`:
  ```ts
  $effect(() => {
    const badge = document.getElementById("shareRequestBadge");
    if (!badge) return;
    const n = $collabIsOwner ? accessRequests.length : 0;
    badge.hidden = n === 0;
    badge.textContent = n > 9 ? "9+" : String(n);
  });
  ```
- Extend the CV2-2 `$effect` that sets `#shareBtn` `title`: when the button is `disabled` and `nonEditor`, `btn.title = $myAccessRequestPending ? "Edit access requested" : "Request edit access"` (instead of the access-summary `hint`, which stays for the Viewing-mode-editor case).
- A little CSS (`_share-workspace.scss`): `.share-request-note { display: block; }`, `.share-request-approve { padding: 4px 10px; }` — keep minimal.

- [ ] **Step 4: Build + typecheck + tests + commit**

`npm run typecheck`, `npm run build`, `npx vitest run --project=components tests/client/src/components/Share.test.ts` — all green.

```bash
git add client/src/components/Share.svelte client/src/styles/_share-workspace.scss tests/client/src/components/Share.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): Share dialog Requests section + badge; request-access button copy (CV2-5)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Release — 1.X.0

**Files:**
- Modify: `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `package.json`, `package-lock.json`, `docs/TEST-COVERAGE.md`, `ROADMAP.md`
- Create: `tests/e2e/collab/request-access.spec.ts`, `tests/scripts/manual-testing/capture-request-access-screenshot.mjs`, `client/public/whats-new/request-access.png`

- [ ] **Step 1: e2e** — `tests/e2e/collab/request-access.spec.ts`

Model on `tests/e2e/collab/mode-switcher.spec.ts`'s two-context helpers (`ownerWithDoc`, `shareAnyoneLink`, `joinSharedWorkspace`):

```
owner A shares as Viewer → B joins
B: #shareBtn is disabled/greyed; clicking it opens RequestAccessModal; type a note; Send
A: sees a toast; opens Share → a "Requests" row for B with the note
A: Approve
B: within a few seconds, #formatMenuBtn becomes visible / #editorPane appears (role bumped to editor live, no reload)
```

- [ ] **Step 2: Full local verification**

```bash
npm test
npm run typecheck
npm run format        # re-stage anything touched
npm run build
npm run test:e2e:local
npm run test:e2e:collab
```
All green. `git diff --quiet src/worker.ts`.

- [ ] **Step 3: Screenshot** — `tests/scripts/manual-testing/capture-request-access-screenshot.mjs`

Model on `capture-collab-chrome-v2-screenshot.mjs` (dev-login, two contexts). Capture the **owner's** Share dialog open with one pending request row (avatar + "cv2-requester" + a short note + the role select + Approve/Deny). Save `client/public/whats-new/request-access.png`. Real screenshot; `enable/disable-dev-login.sh`; verify `git diff --quiet src/worker.ts` after.

- [ ] **Step 4: `CHANGELOG.md`** — next minor (`git log origin/master` to confirm the number):

```markdown
## [1.X.0] - <YYYY-MM-DD>

### Added

- **Request edit access.** On a shared document you can only view or comment on, the Share button now lets you ask the owner for edit access, with an optional note. The owner sees the request in the Share dialog (and a badge on the button) and can approve it at any level or decline it — and if they approve while you're still in the document, your editing tools unlock right away, no reload.

### Changed

- **A change to your role in a shared workspace now takes effect immediately** instead of on the next reload.
```

- [ ] **Step 5: `whats-new-entries.ts`** (append; `version` = new `__APP_VERSION__`):

```ts
  {
    version: "1.X.0",
    title: "Ask for Edit Access",
    description:
      "Viewing or commenting on a shared document and need to make a change? The Share button now lets you request edit access from the owner, with an optional note. They approve or decline from the Share dialog — and an approval unlocks your editing tools on the spot.",
    screenshot: "/whats-new/request-access.png",
    category: "Collaboration",
  },
```

- [ ] **Step 6: Version bump** — `package.json` + both `package-lock.json` `"version"` fields.

- [ ] **Step 7: `docs/TEST-COVERAGE.md`** — new COLLAB rows: `POST /access-request` (roles, broadcast, cap, replace); owner approve/deny + `MESSAGE_ACCESS_CHANGED`; `GET /access` request-visibility redaction; client frame handlers + live rejoin + owner nudge; `RequestAccessModal`; Share Requests section + badge; the e2e.

- [ ] **Step 8: `ROADMAP.md`** — under "Collab-mode chrome v2": **CV2-5 → shipped v1.X.0** (PR #186) with a one-line summary. In the "Google Docs parity — features we don't have yet" list, remove the "Request edit access" bullet (now done, minus the email nudge — note that). Add the "cancel a pending request" follow-up to the deferred list.

- [ ] **Step 9: Format + final run**

```bash
npm run format
npm test && npm run typecheck && npm run build
```

- [ ] **Step 10: Commit + push**

```bash
git status   # src/worker.ts must NOT appear
git add CHANGELOG.md client/src/whats-new-entries.ts client/public/whats-new/request-access.png package.json package-lock.json docs/TEST-COVERAGE.md ROADMAP.md tests/e2e/collab/request-access.spec.ts tests/scripts/manual-testing/capture-request-access-screenshot.mjs
git commit -m "$(cat <<'EOF'
chore: release 1.X.0 — request edit access (CV2-5)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push origin docs/cv2-5-request-access-spec
```

- [ ] **Step 11: Finalise PR #186** — retitle `feat(collab): request edit access (CV2-5) — v1.X.0`, update the body with the implementation. Wait for CI green. Ready to merge on user confirmation.

---

## Self-review notes (addressed)

- **Spec coverage:** data model → Task 1; `POST /access-request` + `MESSAGE_ACCESS_REQUEST` → Task 2; owner approve/deny + `MESSAGE_ACCESS_CHANGED` + `PUT /access` broadcast → Task 3; `GET /access` redaction → Task 4; client handlers + `handleAccessChanged` rejoin + owner nudge + wrappers → Task 5; `RequestAccessModal` + `#shareBtn` dispatch + badge markup → Task 6; Share Requests section + badge + button copy → Task 7; rollout → Task 8. Non-goals (cancel-request, denied-outsider, email) — nothing built.
- **Type consistency:** `AccessRequest { username; message; createdAt }` identical in `src/access-role.ts` and `client/src/types.ts`. `MESSAGE_ACCESS_REQUEST = 6` / `MESSAGE_ACCESS_CHANGED = 7` identical in `src/workspace-room.ts` and `client/src/collab.ts`. Wrapper signatures (`requestAccessFromOwner(remoteId, message)`, `approveAccessRequest(remoteId, username, role)`, `denyAccessRequest(remoteId, username)`) — defined in Task 5, consumed in Tasks 6 (request) and 7 (approve/deny).
- **Frame back-compat:** both new types handled with an early `return` before the shared `docId` read in `handleServerMessage` — an old client that predates them would mis-read, but the client ships with the same deploy as the Worker (same as `MESSAGE_WORKSPACE_META` / `_DELETED` were added).
- **The rejoin:** `handleAccessChanged` calls `rejoinKnownWorkspace` (existing) only when `computeMyRole` differs from `workspaceRoom.role`; `rejoinKnownWorkspace` → `joinWorkspace` → `teardownWorkspace()` first, so it's safe to call while connected.
- **Redaction:** Task 4's tests explicitly assert an invited non-owner and an outsider never receive `accessRequests`; only `myAccessRequestPending: boolean` for the authed non-owner.
- **`dev-login.patch`:** routes are in `src/workspace-room.ts`, not `src/worker.ts` — Task 3 Step 4 verifies `git apply --check` still passes.
- **Placeholder scan:** no "TBD". Tasks 5/6/7 Step 1 note where a test-harness detail ("match the file's `MockWebSocket` shape" / "`vi.doMock` may be awkward") should follow an existing sibling test rather than inventing a pattern — each points at the specific file/function to copy.
- **Component project:** `RequestAccessModal` and `Share` both already have (or will get) `components`-project tests mounting small components — no `Editor.svelte` mount.
