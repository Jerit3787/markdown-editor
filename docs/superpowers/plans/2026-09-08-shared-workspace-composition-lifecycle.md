# Shared-workspace composition & lifecycle — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship E1 + F3 + F4 from `ROADMAP.md` → Active: repo-synced-and-shared workspaces keep their repo-pulled docs; deleting a shared workspace warns with role-aware copy; deleting it as owner hard-revokes remote access.

**Architecture:** Server gains a `deleted` tombstone flag on `WorkspaceRoom`, a `DELETE /api/workspace/:id` endpoint (owner-only), `410` on every route once deleted, and a `MESSAGE_WORKSPACE_DELETED` broadcast that closes sessions. The client gains a `Workspace.mirrored` flag (set when joining), a `repoDocSyncHook` seam so repo-pull results are seeded into a connected shared room, role-aware delete copy in `WorkspaceSwitcher`, and a `"deleted"` `WorkspaceAccessBanner` state.

**Tech Stack:** TypeScript, Svelte 5, Cloudflare Workers + Durable Objects, Yjs, `lib0` encoding, Vitest (`unit` + `components` projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-shared-workspace-composition-lifecycle-design.md`

## Global Constraints

- **Never `git add src/worker.ts` blindly** — check `git status` is clean of the dev-login patch first; use explicit `git add <paths>`.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` only. Never a `Claude-Session:` link.
- Two `tsconfig`s checked separately (`npm run typecheck`): `src/**`+`tests/src/**` full strict; `client/src/**`+`tests/client/src/**` looser.
- Server tests → `tests/src/*.test.ts` (`vi.stubGlobal` for `fetch`); client logic → `tests/client/src/*.test.ts`; component tests → `tests/client/src/components/*.test.ts` **only** (routes to the `components` browser project).
- `collab.test.ts` pattern: `// @vitest-environment jsdom`, `import "fake-indexeddb/auto"`, `MockWebSocket` + `vi.stubGlobal("fetch", ...)` per `describe`, `handleDocChanged(undefined)` to reset the `workspaceRoom` singleton in `beforeEach`.
- New wire message type: `MESSAGE_WORKSPACE_DELETED = 5` — the same integer in **both** `client/src/collab.ts` and `src/workspace-room.ts`.
- User-facing change → **minor** version bump (`1.49.0` — note the Google Drive branch also targets `1.49.0` but is unmerged; this ships first, so it takes `1.49.0` and the Drive branch rebases to `1.50.0` later). `package.json` + both `package-lock.json` `"version"` fields hand-edited, new `CHANGELOG.md` section, new `whats-new-entries.ts` entry **with a real committed screenshot** in `client/public/whats-new/`.
- Hold the version bump + whats-new entry until the final task (do them right before opening the PR). `CHANGELOG.md` may be edited along the way under a provisional heading.

---

## File Structure

**Server**
- `src/workspace-room.ts` (modify) — `MESSAGE_WORKSPACE_DELETED`, `deleted` field + load, `fetch()` 410 guard + DELETE route, `handleDeleteRequest()`.
- `src/worker.ts` (modify) — allow `DELETE` through the bare `WORKSPACE_PATH` route.

**Client — types & stores**
- `client/src/types.ts` (modify) — `Workspace.mirrored?`, `AccessRecord.deleted?`.
- `client/src/stores/workspaces.ts` (modify) — `adoptSharedWorkspace` / `previewSharedWorkspace` set `mirrored: true`.
- `client/src/stores/share.ts` (modify) — `WorkspaceAccessDeniedReason` gains `"deleted"`.
- `client/src/stores/docs.ts` (modify) — `repoDocSyncHook`; `upsertDocFromRepo` returns `{ id, created }`; `removeDocsByRepoPaths` returns removed ids.

**Client — collab**
- `client/src/collab.ts` (modify) — `MESSAGE_WORKSPACE_DELETED = 5`; `fetchWorkspaceAccess` detects 410; `handleServerMessage` branch; `handleWorkspaceGone(reason)` (live + on-load); `replaceBindingContent()`; `handleRepoDocsChanged()` + hook wiring in `init()`.
- `client/src/repo-sync.ts` (modify) — `pullFromRepo` accumulates created/updated/deleted ids and calls the hook.

**Client — components**
- `client/src/components/WorkspaceSwitcher.svelte` (modify) — role-aware `remove()`.
- `client/src/components/WorkspaceAccessBanner.svelte` (modify) — `"deleted"` branch.

**Tests**
- `tests/src/workspace-room.test.ts` (modify)
- `tests/client/src/collab.test.ts` (modify)
- `tests/client/src/repo-sync.test.ts` (modify)
- `tests/client/src/stores/workspaces.test.ts` (modify)
- `tests/client/src/components/WorkspaceSwitcher.test.ts` (create or modify)
- `tests/client/src/components/WorkspaceAccessBanner.test.ts` (create)
- `tests/e2e/collab/workspace-delete-revoke.spec.ts` (create)

**Docs / release**
- `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/public/whats-new/<name>.png`, `ROADMAP.md`, `docs/TEST-COVERAGE.md`.

---

## Task 1: `Workspace.mirrored` flag + `AccessRecord.deleted`

**Files:**
- Modify: `client/src/types.ts`
- Modify: `client/src/stores/workspaces.ts:117-140` (`adoptSharedWorkspace`, `previewSharedWorkspace`)
- Test: `tests/client/src/stores/workspaces.test.ts`

**Interfaces:**
- Produces: `Workspace.mirrored?: boolean` — `true` iff this record is a mirror of a workspace someone else owns (set only by `adoptSharedWorkspace` / `previewSharedWorkspace`). `AccessRecord.deleted?: boolean` — client-only, set by `fetchWorkspaceAccess` on a `410`.

- [ ] **Step 1: Write the failing test**

In `tests/client/src/stores/workspaces.test.ts`, add:

```ts
import { adoptSharedWorkspace, previewSharedWorkspace, promoteEphemeralWorkspace, createWorkspace, workspacesStore } from "../../../../client/src/stores/workspaces";
import { get } from "svelte/store";

test("adoptSharedWorkspace marks the workspace as a mirror", () => {
  const ws = adoptSharedWorkspace("remote-1", "Team Docs");
  expect(ws.mirrored).toBe(true);
});

test("previewSharedWorkspace marks the workspace as a mirror", () => {
  const ws = previewSharedWorkspace("remote-2", "Team Docs");
  expect(ws.mirrored).toBe(true);
});

test("promoteEphemeralWorkspace keeps the mirror flag", () => {
  const ws = previewSharedWorkspace("remote-3", "Team Docs");
  promoteEphemeralWorkspace(ws.id);
  expect(get(workspacesStore).find((w) => w.id === ws.id)?.mirrored).toBe(true);
});

test("createWorkspace does not set the mirror flag", () => {
  const ws = createWorkspace("Mine");
  expect(ws.mirrored).toBeUndefined();
});
```

(Match the file's existing import style / `beforeEach` reset if present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/src/stores/workspaces.test.ts`
Expected: the `adoptSharedWorkspace` / `previewSharedWorkspace` tests FAIL (`mirrored` is `undefined`).

- [ ] **Step 3: Add the type fields**

In `client/src/types.ts`, inside `interface AccessRecord`, after `workspaceName?: string;`:

```ts
  // Client-only: set by collab.ts's fetchWorkspaceAccess when the room
  // responds 410 Gone (the owner deleted the workspace). The server never
  // sends this — the status code is the signal.
  deleted?: boolean;
```

In `interface Workspace`, after the `ephemeral?: boolean;` block:

```ts
  // Set when this record is a *mirror* of a workspace someone else owns —
  // created by adoptSharedWorkspace / previewSharedWorkspace on joining a
  // share link. Absent for a workspace this user owns, and absent for one
  // they merged a share into (mergeSharedWorkspaceInto) — that record is
  // still fundamentally theirs. Drives WorkspaceSwitcher's delete copy and
  // collab.ts's "owner deleted this" teardown (remove a mirror entirely,
  // only sever a merged one).
  mirrored?: boolean;
```

- [ ] **Step 4: Set the flag in the two join helpers**

In `client/src/stores/workspaces.ts`, `adoptSharedWorkspace`:

```ts
export function adoptSharedWorkspace(remoteId: string, name: string): Workspace {
  const ws: Workspace = { id: uid(), name, createdAt: Date.now(), updatedAt: Date.now(), shared: true, remoteId, mirrored: true };
```

`previewSharedWorkspace`:

```ts
  const ws: Workspace = { id: uid(), name, createdAt: Date.now(), updatedAt: Date.now(), shared: true, remoteId, ephemeral: true, mirrored: true };
```

(`promoteEphemeralWorkspace` already spreads `...w`, so `mirrored` carries through — no change, the test just pins it.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/client/src/stores/workspaces.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` — expected clean.

```bash
git add client/src/types.ts client/src/stores/workspaces.ts tests/client/src/stores/workspaces.test.ts
git commit -m "$(cat <<'EOF'
feat(workspace): mark joined workspaces as mirrors; AccessRecord.deleted

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Server — `deleted` tombstone, 410 guard, `DELETE` endpoint

**Files:**
- Modify: `src/workspace-room.ts` — constants (~line 33), constructor (~line 147-162), `fetch()` (~line 283), new `handleDeleteRequest`.
- Modify: `src/worker.ts:68-75` (bare `WORKSPACE_PATH` route).
- Test: `tests/src/workspace-room.test.ts`

**Interfaces:**
- Consumes: `this.getAccess()` → `AccessRecord`, `this.authorize(request)`, `this.broadcast(bytes, exceptWs)`, `this.sessions` (`Map<WebSocket, SessionInfo>`), `this.state.storage`.
- Produces: `DELETE /api/workspace/:id` → `204` (owner), `403` (non-owner), `401` (no session). After it, every route on that room → `410`. A live session receives a `[MESSAGE_WORKSPACE_DELETED]` frame (single varuint, no docId) then a `close(1000)`.

- [ ] **Step 1: Write the failing server tests**

In `tests/src/workspace-room.test.ts`, following the file's existing helper style (it drives `room.fetch(new Request(...))` against a `WorkspaceRoom` built on a mock `DurableObjectState`; copy the nearest existing `describe`'s setup), add:

```ts
describe("DELETE /api/workspace/:id (owner revoke)", () => {
  it("lets the owner delete: 204, then every route 410s", async () => {
    const room = await makeRoom({ access: { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] } });
    const del = await room.fetch(authed("https://x/api/workspace/w1", "alice", { method: "DELETE" }));
    expect(del.status).toBe(204);

    const access = await room.fetch(new Request("https://x/api/workspace/w1/access"));
    expect(access.status).toBe(410);
    const upgrade = await room.fetch(new Request("https://x/api/workspace/w1", { headers: { Upgrade: "websocket" } }));
    expect(upgrade.status).toBe(410);
  });

  it("refuses a non-owner editor: 403, room still live", async () => {
    const room = await makeRoom({ access: { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] } });
    const del = await room.fetch(authed("https://x/api/workspace/w1", "bob", { method: "DELETE" }));
    expect(del.status).toBe(403);
    const access = await room.fetch(new Request("https://x/api/workspace/w1/access"));
    expect(access.status).toBe(200);
  });

  it("refuses an unauthenticated caller: 401", async () => {
    const room = await makeRoom({ access: { owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] } });
    const del = await room.fetch(new Request("https://x/api/workspace/w1", { method: "DELETE" }));
    expect(del.status).toBe(401);
  });
});
```

If the file lacks `makeRoom` / `authed` helpers, use whatever the existing tests use to (a) construct a room with a stored `access` record and (b) attach a session cookie for a username. Name the helpers to match.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/src/workspace-room.test.ts -t "owner revoke"`
Expected: FAIL — `DELETE` currently falls through to the `426 Expected websocket` path (or 200-ish), no 410.

- [ ] **Step 3: Add the message constant**

In `src/workspace-room.ts`, after `const MESSAGE_COMMENTS = 4;`:

```ts
// Broadcast once, to every live session, when the owner deletes the
// workspace (handleDeleteRequest). Single varuint, no docId — like a
// bare MESSAGE_WORKSPACE_META greeting. The client tears down and drops
// its local mirror; sessions are closed right after the broadcast.
const MESSAGE_WORKSPACE_DELETED = 5;
```

- [ ] **Step 4: Add the `deleted` field + load it**

In the class fields block (near `name: string;`):

```ts
  deleted: boolean;
```

In the constructor, initialise before `blockConcurrencyWhile`:

```ts
    this.deleted = false;
```

Inside the `blockConcurrencyWhile` callback, after `this.name = (await this.state.storage.get<string>("name")) || "";`:

```ts
      this.deleted = (await this.state.storage.get<boolean>("deleted")) === true;
```

- [ ] **Step 5: Add the 410 guard + DELETE route in `fetch()`**

In `src/workspace-room.ts`, `async fetch(request: Request): Promise<Response>`, immediately after `const url = new URL(request.url);`:

```ts
    if (this.deleted) return new Response("This workspace has been deleted.", { status: 410 });
    if (request.method === "DELETE" && /\/api\/workspace\/[^/]+$/.test(url.pathname)) {
      return this.handleDeleteRequest(request);
    }
```

- [ ] **Step 6: Implement `handleDeleteRequest`**

Add as a method (place it next to `handleMetaRequest`):

```ts
  async handleDeleteRequest(request: Request): Promise<Response> {
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    const access = await this.getAccess();
    if (!access.owner || access.owner !== auth.username) {
      return new Response("Only the workspace owner can delete it.", { status: 403 });
    }

    this.deleted = true;
    await this.state.storage.put("deleted", true);

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_WORKSPACE_DELETED);
    this.broadcast(encoding.toUint8Array(encoder), null);
    for (const ws of Array.from(this.sessions.keys())) {
      try {
        ws.close(1000, "workspace deleted");
      } catch {
        /* already closed */
      }
    }
    this.sessions.clear();

    // Free storage — the room is a tombstone now; only the `deleted` flag
    // needs to survive (a DO can't delete itself, so any later request
    // re-reads it and 410s).
    await this.state.storage.deleteAll();
    await this.state.storage.put("deleted", true);
    return new Response(null, { status: 204 });
  }
```

- [ ] **Step 7: Allow `DELETE` through the worker route**

In `src/worker.ts`, the `workspaceMatch` block:

```ts
    const workspaceMatch = url.pathname.match(WORKSPACE_PATH);
    if (workspaceMatch) {
      if (request.method !== "DELETE" && request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const id = env.WORKSPACE_ROOM.idFromName(workspaceMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }
```

- [ ] **Step 8: Run tests + typecheck**

Run: `npx vitest run tests/src/workspace-room.test.ts`
Expected: PASS (new + existing).
Run: `npm run typecheck` — expected clean (root/server strict).

- [ ] **Step 9: Commit** (explicit paths — `src/worker.ts` must be otherwise clean)

```bash
git status   # confirm src/worker.ts has ONLY the intended change
git add src/workspace-room.ts src/worker.ts tests/src/workspace-room.test.ts
git commit -m "$(cat <<'EOF'
feat(workspace-room): DELETE endpoint hard-revokes a shared workspace

Owner-only DELETE /api/workspace/:id sets a persisted `deleted` tombstone,
broadcasts MESSAGE_WORKSPACE_DELETED, closes all sessions, and wipes
storage. Every route on a deleted room returns 410.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Client — `fetchWorkspaceAccess` detects 410

**Files:**
- Modify: `client/src/collab.ts` — `fetchWorkspaceAccess` (~line 1168), `MESSAGE_WORKSPACE_DELETED` constant (~line 71).
- Test: `tests/client/src/collab.test.ts`

**Interfaces:**
- Produces: `fetchWorkspaceAccess(id)` resolves `{ ...DEFAULT_ACCESS, deleted: true }` when the room responds `410`; unchanged otherwise.
- Produces: `const MESSAGE_WORKSPACE_DELETED = 5;` in `collab.ts`.

- [ ] **Step 1: Write the failing test**

In `tests/client/src/collab.test.ts`, in the `decideJoinTarget` area or a small new `describe("fetchWorkspaceAccess")` — but `fetchWorkspaceAccess` isn't exported. Instead test it via observable behaviour in Task 5. For this task, add only a compile-level guard: extend an existing `handleServerMessage`-style test in Task 5. **Skip a standalone test here** — mark Step 1 done, the behaviour is covered by Task 5's "gone on load" test.

- [ ] **Step 2: Add the constant**

In `client/src/collab.ts`, after `const MESSAGE_COMMENTS = 4;`:

```ts
const MESSAGE_WORKSPACE_DELETED = 5;
```

- [ ] **Step 3: Detect 410 in `fetchWorkspaceAccess`**

```ts
async function fetchWorkspaceAccess(workspaceId: string): Promise<AccessRecord> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/access`);
    if (res.status === 410) return { ...DEFAULT_ACCESS, deleted: true };
    if (!res.ok) return { ...DEFAULT_ACCESS };
    return { ...DEFAULT_ACCESS, ...(await res.json()) };
  } catch (err) {
    return { ...DEFAULT_ACCESS };
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck` — expected clean.

- [ ] **Step 5: Commit**

```bash
git add client/src/collab.ts
git commit -m "$(cat <<'EOF'
feat(collab): fetchWorkspaceAccess flags a 410 as deleted

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Client — `share.ts` `"deleted"` reason + `WorkspaceAccessBanner` branch

**Files:**
- Modify: `client/src/stores/share.ts` — `WorkspaceAccessDeniedReason`.
- Modify: `client/src/components/WorkspaceAccessBanner.svelte`.
- Test: `tests/client/src/components/WorkspaceAccessBanner.test.ts` (create)

**Interfaces:**
- Produces: `WorkspaceAccessDeniedReason = "no-session" | "no-access" | "deleted"`. Setting `workspaceAccessDenied.set("deleted")` renders a no-action "deleted by its owner" banner.

- [ ] **Step 1: Write the failing component test**

Create `tests/client/src/components/WorkspaceAccessBanner.test.ts`:

```ts
import { test, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import WorkspaceAccessBanner from "../../../../client/src/components/WorkspaceAccessBanner.svelte";
import { workspaceAccessDenied } from "../../../../client/src/stores/share";

beforeEach(() => {
  workspaceAccessDenied.set(null);
});

test("renders nothing when no reason is set", async () => {
  const screen = render(WorkspaceAccessBanner);
  await expect.poll(() => screen.container.textContent?.trim()).toBe("");
});

test("shows a no-action 'deleted by its owner' banner for the deleted reason", async () => {
  const screen = render(WorkspaceAccessBanner);
  workspaceAccessDenied.set("deleted");
  await expect.poll(() => screen.container.textContent).toContain("deleted by its owner");
  expect(screen.container.querySelector("button")).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project=components tests/client/src/components/WorkspaceAccessBanner.test.ts`
Expected: the `deleted` test FAILS (no such branch).

- [ ] **Step 3: Extend the union**

In `client/src/stores/share.ts`:

```ts
export type WorkspaceAccessDeniedReason = "no-session" | "no-access" | "deleted";
```

- [ ] **Step 4: Add the banner branch**

In `client/src/components/WorkspaceAccessBanner.svelte`, after the `no-access` block:

```svelte
{:else if $workspaceAccessDenied === "deleted"}
  <div class="workspace-access-banner" role="alert">
    <span>This shared workspace was deleted by its owner. You no longer have access to it.</span>
  </div>
{/if}
```

- [ ] **Step 5: Run tests + typecheck + commit**

Run: `npx vitest run --project=components tests/client/src/components/WorkspaceAccessBanner.test.ts` — PASS.
Run: `npm run typecheck` — clean.

```bash
git add client/src/stores/share.ts client/src/components/WorkspaceAccessBanner.svelte tests/client/src/components/WorkspaceAccessBanner.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): 'deleted by its owner' workspace-access banner state

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Client — `MESSAGE_WORKSPACE_DELETED` handler + gone-on-load

**Files:**
- Modify: `client/src/collab.ts` — `handleServerMessage` (~line 1025), new `handleWorkspaceGone`, wire into `joinSharedLink` (~line 250) and `rejoinKnownWorkspace` (~line 400).
- Test: `tests/client/src/collab.test.ts`

**Interfaces:**
- Consumes: `teardownWorkspace()`, `deleteWorkspaceRecord(id)` (`stores/workspaces`), `removeDocById(id)` (`stores/docs`), `persistWorkspaces()`, `workspacesStore`, `docsStore`, `workspaceAccessDenied`, `showToast`.
- Produces: `handleWorkspaceGone(localWorkspaceId: string)` — tears down; if the local record is `mirrored`, removes it and its docs and sets `workspaceAccessDenied="deleted"`; otherwise (a merged workspace) clears `shared`/`remoteId` and toasts, keeping docs.

- [ ] **Step 1: Write the failing tests**

In `tests/client/src/collab.test.ts`, add a `describe` modelled on the existing "incoming workspace meta sync" block (same `MockWebSocket` + fetch stub + `handleDocChanged` setup). Import `handleServerMessage` if exported, else drive it through `MockWebSocket.instances[0].onmessage`. Also import `workspacesStore`, `docsStore`, `workspaceAccessDenied`.

```ts
describe("owner-deleted-the-workspace teardown", () => {
  const MESSAGE_WORKSPACE_DELETED = 5;

  function sendWorkspaceDeleted() {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_WORKSPACE_DELETED);
    MockWebSocket.instances[0].onmessage!({ data: encoding.toUint8Array(encoder).buffer } as MessageEvent);
  }

  // ...setup() connecting as editor to remote "remote-del", local ws
  //    { id: "local-del", remoteId: "remote-del", shared: true, mirrored: true }
  //    with docs docA/docB in it (copy the meta-sync describe's setup)...

  it("removes a mirrored workspace and its docs, and shows the deleted banner", async () => {
    const { ws, docA, docB } = await setup("del1", { mirrored: true });
    sendWorkspaceDeleted();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(get(workspacesStore).find((w) => w.id === ws.id)).toBeUndefined();
    expect(get(docsStore).find((d) => d.id === docA.id)).toBeUndefined();
    expect(get(docsStore).find((d) => d.id === docB.id)).toBeUndefined();
    expect(get(workspaceAccessDenied)).toBe("deleted");
    expect(workspaceRoom.workspaceId).toBeNull();
  });

  it("keeps a merged workspace's docs but severs its live link", async () => {
    const { ws, docA } = await setup("del2", { mirrored: false });
    sendWorkspaceDeleted();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const local = get(workspacesStore).find((w) => w.id === ws.id);
    expect(local).toBeDefined();
    expect(local?.shared).toBeUndefined();
    expect(local?.remoteId).toBeUndefined();
    expect(get(docsStore).find((d) => d.id === docA.id)).toBeDefined();
    expect(get(workspaceAccessDenied)).not.toBe("deleted");
  });
});
```

For the "gone on load" path, add to the existing `joinSharedLink` test area (the file already has share-link join tests). Stub `fetch` so `/access` returns `{ status: 410 }`:

```ts
it("opening a share link for a deleted workspace tears down and shows the banner", async () => {
  // fetch stub: url.includes("/access") -> { ok: false, status: 410, json: async () => ({}) }
  // pre-seed a local mirrored workspace pointing at that remoteId + a doc
  // call joinSharedLink(remoteId, docId) (export it or drive through init's SHARE_PATH branch)
  // assert: local workspace + doc removed, workspaceAccessDenied === "deleted"
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/client/src/collab.test.ts -t "owner-deleted"`
Expected: FAIL (no handler for message type 5).

- [ ] **Step 3: Implement `handleWorkspaceGone`**

In `client/src/collab.ts`, near `applyWorkspaceMeta`:

```ts
// The owner deleted this shared workspace (a live MESSAGE_WORKSPACE_DELETED
// frame, or a 410 from the access fetch on reconnect / share-link open).
// Tear down the connection, then: a *mirror* of the owner's workspace is
// removed entirely (deletion is also the owner's tool for cutting off
// access) with a banner; a workspace the user *merged* a share into keeps
// its documents (their own library) and only loses the live link.
function handleWorkspaceGone(localWorkspaceId: string): void {
  const local = get(workspacesStore).find((w) => w.id === localWorkspaceId);
  teardownWorkspace();
  if (!local) return;
  if (local.mirrored) {
    const docIds = get(docsStore).filter((d) => d.workspaceId === local.id).map((d) => d.id);
    deleteWorkspaceRecord(local.id);
    for (const id of docIds) removeDocById(id);
    workspaceAccessDenied.set("deleted");
  } else {
    workspacesStore.update((all) =>
      all.map((w) => (w.id === local.id ? { ...w, shared: undefined, remoteId: undefined, updatedAt: Date.now() } : w)),
    );
    persistWorkspaces();
    showToast(`"${local.name}" is no longer shared — its owner deleted the shared workspace. Your local copy is kept.`, "info");
  }
}
```

Add `deleteWorkspaceRecord`, `persistWorkspaces` to the `./stores/workspaces` import if not already present; `removeDocById` is already imported; `showToast` — check the existing import (`./stores/toast`).

- [ ] **Step 4: Handle the live message**

In `handleServerMessage`, after the `MESSAGE_WORKSPACE_META` block, before `const docId = decoding.readVarString(decoder);`:

```ts
  if (messageType === MESSAGE_WORKSPACE_DELETED) {
    const remoteId = workspaceRoom.workspaceId;
    const local = remoteId ? get(workspacesStore).find((w) => w.remoteId === remoteId) : null;
    if (local) handleWorkspaceGone(local.id);
    else teardownWorkspace();
    return;
  }
```

- [ ] **Step 5: Handle the on-load / reconnect path**

In `joinSharedLink`, right after `const access = await fetchWorkspaceAccess(workspaceId);` and the `await window.MDE.githubSessionReady;` line:

```ts
  if (access.deleted) {
    const local = get(workspacesStore).find((w) => w.remoteId === workspaceId);
    if (local) handleWorkspaceGone(local.id);
    else workspaceAccessDenied.set("deleted");
    return;
  }
```

In `rejoinKnownWorkspace`, right after `const access = await fetchWorkspaceAccess(remoteId);` (and its generation guard):

```ts
  if (access.deleted) {
    const local = get(workspacesStore).find((w) => w.remoteId === remoteId);
    if (local) handleWorkspaceGone(local.id);
    else workspaceAccessDenied.set("deleted");
    return;
  }
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run tests/client/src/collab.test.ts`
Expected: PASS (new + existing — watch the "incoming workspace meta sync" and share-link tests especially).
Run: `npm run typecheck` — clean.

- [ ] **Step 7: Commit**

```bash
git add client/src/collab.ts tests/client/src/collab.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): tear down when the owner deletes a shared workspace

A live MESSAGE_WORKSPACE_DELETED frame or a 410 on the access fetch now
tears down the connection; a mirrored workspace is removed entirely with
a 'deleted by its owner' banner, a merged one keeps its docs and only
loses the live link.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Client — `WorkspaceSwitcher.remove()` role-aware confirm + owner DELETE

**Files:**
- Modify: `client/src/components/WorkspaceSwitcher.svelte` — `remove()`.
- Test: `tests/client/src/components/WorkspaceSwitcher.test.ts`

**Interfaces:**
- Consumes: `confirmAction(title, body)`, `window.MDE.githubUsername`, `fetch`, `teardownWorkspace` (needs exposing — it's already exported from `collab.ts` per `export { handleDocChanged, workspaceRoom, teardownWorkspace }`), `removeDocById`, `deleteWorkspaceRecord`, `ensureActiveDocInWorkspace`.
- Behaviour: private workspace → unchanged copy, local delete. `mirrored` → "Remove your local copy" copy, local delete, no fetch. `shared && !mirrored` → fetch `/access`; if `owner === githubUsername` → owner copy ("revokes access for everyone…") + `DELETE /api/workspace/:remoteId` then local delete; else → "Remove from this device" copy + local delete only.

- [ ] **Step 1: Write the failing component test**

Create/extend `tests/client/src/components/WorkspaceSwitcher.test.ts`. Model on existing component tests (`window.MDE = new Proxy({}, { get: () => vi.fn() })`, seed `workspacesStore` / `docsStore`, mock `confirmAction` via the `confirmDialog` store or `vi.mock`). Key cases:

```ts
test("delete: private workspace uses the plain confirm copy and no network call", async () => {
  // seed a non-shared workspace with 2 docs; stub confirmAction -> true; spy fetch
  // click its delete button
  // expect confirm title "Delete \"...\"?" body contains "2 documents"
  // expect fetch NOT called; workspace + docs gone from the stores
});

test("delete: a mirrored workspace says 'removes your local copy' and makes no network call", async () => {
  // seed { shared: true, mirrored: true }; stub confirm -> true; spy fetch
  // expect body contains "removes your local copy"; fetch NOT called; removed locally
});

test("delete: owner of a shared workspace warns about collaborators and DELETEs the room", async () => {
  // window.MDE.githubUsername = "alice"
  // fetch stub: /access GET -> { ok:true, json: () => ({ owner: "alice", ... }) }; DELETE -> { ok:true, status:204 }
  // seed { shared: true, remoteId: "r1" } (no mirrored); stub confirm -> true
  // expect confirm body contains "everyone you've shared it with"
  // expect fetch called with "/api/workspace/r1" { method: "DELETE" }
  // expect workspace removed locally
});

test("delete: a merged shared workspace (not owner) removes locally without promising a revoke", async () => {
  // githubUsername = "bob"; /access GET -> owner "alice"; DELETE -> 403
  // expect body contains "stays available to its owner"; local removal happens
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project=components tests/client/src/components/WorkspaceSwitcher.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite `remove()`**

In `client/src/components/WorkspaceSwitcher.svelte`, add to the script imports:

```ts
  import { pushWorkspaceRename, teardownWorkspace } from "../collab";
```

Replace `remove()`:

```ts
  async function remove(id: string, name: string, e: MouseEvent) {
    e.stopPropagation();
    const ws = $workspacesStore.find((w) => w.id === id);
    if (!ws) return;
    const count = docCounts.get(id) || 0;
    const docsPhrase = count > 0 ? `${count} document${count === 1 ? "" : "s"}` : "no documents";

    // Resolve owner-vs-merger for a shared workspace that isn't a pure
    // mirror (both an owner and a merger have shared && !mirrored).
    let iAmOwner = false;
    if (ws.shared && !ws.mirrored && ws.remoteId) {
      try {
        const res = await fetch(`/api/workspace/${encodeURIComponent(ws.remoteId)}/access`);
        if (res.ok) {
          const access = await res.json();
          iAmOwner = !!access.owner && access.owner === window.MDE.githubUsername;
        } else {
          iAmOwner = true; // best guess; the server's DELETE is the real gate (403s a non-owner harmlessly)
        }
      } catch {
        iAmOwner = true;
      }
    }

    let title = `Delete "${name}"?`;
    let body: string;
    if (ws.mirrored) {
      title = `Remove "${name}"?`;
      body = "This removes your local copy. You can open it again from the share link unless the owner has revoked access.";
    } else if (ws.shared && iAmOwner) {
      body = `This is a shared workspace. Deleting it revokes access for everyone you've shared it with and removes its ${docsPhrase} for them too. This can't be undone.`;
    } else if (ws.shared) {
      title = `Remove "${name}"?`;
      body = `This removes your workspace and its ${docsPhrase} from this device. The shared workspace itself stays available to its owner and other collaborators.`;
    } else {
      body = count > 0 ? `This also deletes its ${docsPhrase}. This can't be undone.` : "This can't be undone.";
    }

    if (!(await confirmAction(title, body))) return;

    if (ws.shared && iAmOwner && ws.remoteId) {
      try {
        const res = await fetch(`/api/workspace/${encodeURIComponent(ws.remoteId)}`, { method: "DELETE" });
        if (res.status === 403) {
          showToast("Removed from this device. You weren't the owner, so the shared workspace still exists for others.", "info");
        } else if (!res.ok && res.status !== 410) {
          showToast("Couldn't reach the server to revoke sharing — removed locally; collaborators may keep access until the room is cleaned up.", "error");
        }
      } catch {
        showToast("Couldn't reach the server to revoke sharing — removed locally.", "error");
      }
      teardownWorkspace();
    } else if (ws.shared) {
      teardownWorkspace();
    }

    const docIds = $docsStore.filter((d) => d.workspaceId === id).map((d) => d.id);
    docIds.forEach(removeDocById);
    deleteWorkspaceRecord(id);
    if ($activeWorkspaceIdStore) ensureActiveDocInWorkspace($activeWorkspaceIdStore);
    close();
  }
```

Add `import { showToast } from "../stores/toast";` if not present.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run --project=components tests/client/src/components/WorkspaceSwitcher.test.ts` — PASS.
Run: `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/WorkspaceSwitcher.svelte tests/client/src/components/WorkspaceSwitcher.test.ts
git commit -m "$(cat <<'EOF'
feat(workspace): role-aware delete confirm + owner revokes the shared room

Deleting a shared workspace now spells out the consequence: an owner sees
"revokes access for everyone", a collaborator dropping a mirror sees
"removes your local copy". The owner's delete also fires
DELETE /api/workspace/:id to revoke the room.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: E1 — `repoDocSyncHook` seam in `stores/docs.ts` + `repo-sync.ts`

**Files:**
- Modify: `client/src/stores/docs.ts` — `repoDocSyncHook`; `upsertDocFromRepo` return type; `removeDocsByRepoPaths` return type.
- Modify: `client/src/repo-sync.ts` — `pullFromRepo` bucketing + hook call.
- Test: `tests/client/src/repo-sync.test.ts`

**Interfaces:**
- Produces: `export const repoDocSyncHook: { onRepoDocsChanged?: (c: { workspaceId: string; created: string[]; updated: string[]; deleted: string[] }) => void } = {};`
- Produces: `upsertDocFromRepo(...) : { id: string; created: boolean }`.
- Produces: `removeDocsByRepoPaths(workspaceId, repoPaths): string[]` (ids removed).
- Consumes (repo-sync): the above; `pullFromRepo` collects buckets across `fetchAndApply` + `applyResolved` and fires `repoDocSyncHook.onRepoDocsChanged` once per apply.

- [ ] **Step 1: Write the failing test**

In `tests/client/src/repo-sync.test.ts` (which already stubs `/api/repo/*` fetches and drives `pullFromRepo` — copy the nearest pull test), add:

```ts
import { repoDocSyncHook } from "../../../client/src/stores/docs";

it("pullFromRepo reports created / updated / deleted doc ids to repoDocSyncHook", async () => {
  const seen: any[] = [];
  repoDocSyncHook.onRepoDocsChanged = (c) => seen.push(c);
  // ...set up a workspace with one existing repo-linked doc ("keep.md"),
  //    a tree that adds "new.md", updates "keep.md", and drops "gone.md"
  //    (whose local doc exists)...
  const { plan, applyResolved } = await pullFromRepo(wsId, repoLink, new Set());
  await applyResolved({});

  expect(seen).toHaveLength(1);
  expect(seen[0].workspaceId).toBe(wsId);
  expect(seen[0].created.length).toBe(1);
  expect(seen[0].updated.length).toBe(1);
  expect(seen[0].deleted.length).toBe(1);
  repoDocSyncHook.onRepoDocsChanged = undefined;
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/client/src/repo-sync.test.ts -t "repoDocSyncHook"`
Expected: FAIL — `repoDocSyncHook` doesn't exist.

- [ ] **Step 3: Add the hook + change return types in `stores/docs.ts`**

Near `docRemovalHook`:

```ts
// collab.ts's init() sets onRepoDocsChanged once; repo-sync.ts's
// pullFromRepo calls it after applying a pull so a repo-linked workspace
// that is ALSO live-shared can propagate its owner's pulled/updated/
// deleted docs into the WorkspaceRoom (otherwise applyWorkspaceMeta
// deletes them — they were never registered). No-op unless that workspace
// is the connected shared room and this session is its editor.
export const repoDocSyncHook: {
  onRepoDocsChanged?: (change: { workspaceId: string; created: string[]; updated: string[]; deleted: string[] }) => void;
} = {};
```

`upsertDocFromRepo` — change signature to `): { id: string; created: boolean } {` and return in both branches:

```ts
  const existing = docsInWorkspace(workspaceId).find((d) => d.repoPath === repoPath);
  if (existing) {
    updateDoc(existing.id, { /* unchanged */ });
    persistDocs();
    return { id: existing.id, created: false };
  }
  // ...build `doc`, dedupe name, docsStore.update...
  persistDocs();
  return { id: doc.id, created: true };
```

(Move the single trailing `persistDocs()` into each branch, or keep it after and just `return` the value — either works; keep one `persistDocs()`.)

`removeDocsByRepoPaths` — return the ids:

```ts
export function removeDocsByRepoPaths(workspaceId: string, repoPaths: string[]): string[] {
  const paths = new Set(repoPaths);
  const toRemove = docsInWorkspace(workspaceId).filter((d) => d.repoPath && paths.has(d.repoPath));
  for (const doc of toRemove) removeDocById(doc.id);
  return toRemove.map((d) => d.id);
}
```

- [ ] **Step 4: Bucket + fire the hook in `pullFromRepo`**

In `client/src/repo-sync.ts`, add the import: `repoDocSyncHook` to the `./stores/docs` import list.

Inside `pullFromRepo`, before `async function fetchAndApply(...)`:

```ts
  const created: string[] = [];
  const updated: string[] = [];
```

In `fetchAndApply`, change the `upsertDocFromRepo(...)` call site:

```ts
    const result = upsertDocFromRepo(workspaceId, repoPath, {
      name: docSlug,
      content: resolved.content,
      images: Object.keys(resolved.images).length ? resolved.images : undefined,
      repoSha: sha,
    });
    (result.created ? created : updated).push(result.id);
```

After the `for (const create ...) / for (const update ...)` loops and `removeDocsByRepoPaths(...)`:

```ts
  const deleted = removeDocsByRepoPaths(
    workspaceId,
    plan.deletions.map((d) => d.repoPath),
  );
  setWorkspaceLastSynced(workspaceId, Date.now());
  repoDocSyncHook.onRepoDocsChanged?.({ workspaceId, created: [...created], updated: [...updated], deleted });
```

In `applyResolved` (the conflict-resolution path), fire the hook again for the ids it added. `fetchAndApply` already pushes into the function-scoped `created`/`updated` arrays, so track how far the hook has already reported and send only the new slice:

```ts
  // declared next to `const created` / `const updated`, above fetchAndApply:
  let hookReportedCreated = 0;
  let hookReportedUpdated = 0;
  function fireRepoHook(): void {
    repoDocSyncHook.onRepoDocsChanged?.({
      workspaceId,
      created: created.slice(hookReportedCreated),
      updated: updated.slice(hookReportedUpdated),
      deleted: [],
    });
    hookReportedCreated = created.length;
    hookReportedUpdated = updated.length;
  }
```

Then: after the initial pull's `removeDocsByRepoPaths` + `setWorkspaceLastSynced`, call `fireRepoHook()` but pass the `deleted` ids on that first call:

```ts
  const deleted = removeDocsByRepoPaths(workspaceId, plan.deletions.map((d) => d.repoPath));
  setWorkspaceLastSynced(workspaceId, Date.now());
  repoDocSyncHook.onRepoDocsChanged?.({ workspaceId, created: created.slice(), updated: updated.slice(), deleted });
  hookReportedCreated = created.length;
  hookReportedUpdated = updated.length;
```

And at the end of `applyResolved`, after its `for` loop:

```ts
    fireRepoHook();
```

A second `onRepoDocsChanged` call carrying ids the first already reported would still be safe (Task 8 guards `!workspaceRoom.docs.has(id)` for creates and no-ops a missing binding), but the slice tracking keeps it clean.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/client/src/repo-sync.test.ts`
Expected: PASS (new + existing — `upsertDocFromRepo`'s new return type shouldn't break existing callers since they ignored the void return).
Run: `npm run typecheck` — clean (client project).

- [ ] **Step 6: Commit**

```bash
git add client/src/stores/docs.ts client/src/repo-sync.ts tests/client/src/repo-sync.test.ts
git commit -m "$(cat <<'EOF'
feat(repo-sync): report pulled/updated/deleted doc ids via repoDocSyncHook

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: E1 — collab.ts hook handler + `replaceBindingContent`

**Files:**
- Modify: `client/src/collab.ts` — `replaceBindingContent()` helper, `handleRepoDocsChanged()`, wire in `init()`.
- Test: `tests/client/src/collab.test.ts`

**Interfaces:**
- Consumes: `repoDocSyncHook` (`./stores/docs`), `workspaceRoom`, `seedNewDocBinding`, `pushWorkspaceDocDelete`, `findDocById`, `getSuggestionsMap`-free `binding.ytext` / `binding.metaMap` / `binding.imagesMap`, `EMPTY_CITATIONS`.
- Produces: `handleRepoDocsChanged({ workspaceId, created, updated, deleted })` — no-op unless `workspaceRoom.role === "editor"` and the local workspace's `remoteId === workspaceRoom.workspaceId`; then seeds new bindings, replaces content of updated ones, and `pushWorkspaceDocDelete`s removed ones.

- [ ] **Step 1: Write the failing tests**

In `tests/client/src/collab.test.ts`, new `describe` (connect as editor to a shared workspace, same setup style as "discovering a document created by another collaborator"). Import `repoDocSyncHook` from `stores/docs`.

```ts
describe("repo pull propagates into a connected shared workspace", () => {
  // setup(): connect as editor to remote "remote-repo", local ws
  //   { id: "ws-repo", remoteId: "remote-repo", shared: true, repoLink: {...} }
  //   with one doc already synced.

  it("seeds a newly repo-pulled doc into the room", async () => {
    const { ws } = await setup();
    docsStore.update((d) => [...d, { id: "pulled-1", name: "Pulled", content: "hi", updatedAt: 0, createdAt: 0, workspaceId: ws.id, repoPath: "pulled.md" }]);
    repoDocSyncHook.onRepoDocsChanged!({ workspaceId: ws.id, created: ["pulled-1"], updated: [], deleted: [] });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(workspaceRoom.docs.has("pulled-1")).toBe(true);
    expect(workspaceRoom.docs.get("pulled-1")!.ytext.toString()).toBe("hi");
  });

  it("does nothing when the workspace is not the connected room", async () => {
    await setup();
    repoDocSyncHook.onRepoDocsChanged!({ workspaceId: "some-other-ws", created: ["x"], updated: [], deleted: [] });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(workspaceRoom.docs.has("x")).toBe(false);
  });

  it("pushes a repo-deleted doc's removal to the room", async () => {
    const { ws } = await setup();
    // ...a doc "syncedDoc" already in workspaceRoom.docs...
    const fetchSpy = fetch as unknown as { mock: { calls: any[][] } };
    fetchSpy.mock.calls.length = 0;
    repoDocSyncHook.onRepoDocsChanged!({ workspaceId: ws.id, created: [], updated: [], deleted: ["syncedDoc"] });
    expect(fetchSpy.mock.calls.some(([u, i]) => String(u).includes("/docs?docId=syncedDoc") && i?.method === "DELETE")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/client/src/collab.test.ts -t "repo pull propagates"`
Expected: FAIL (`repoDocSyncHook.onRepoDocsChanged` is undefined in jsdom — `init()` never ran; the handler doesn't exist yet).

- [ ] **Step 3: Add `replaceBindingContent`**

In `client/src/collab.ts`, next to `seedNewDocBinding`:

```ts
// Overwrites a synced binding's content + meta wholesale from a plain Doc
// record — used when a repo pull is authoritative for that file (a clean
// update, or a "theirs" conflict resolution). Yjs merges it as an
// ordinary local edit, so collaborators get it like any other change.
function replaceBindingContent(binding: DocBinding, doc: Doc): void {
  binding.ydoc.transact(() => {
    if (binding.ytext.length) binding.ytext.delete(0, binding.ytext.length);
    if (doc.content) binding.ytext.insert(0, doc.content);
    binding.metaMap.set("name", doc.name || "Untitled");
    binding.metaMap.set("metadata", JSON.stringify(doc.metadata ?? []));
    binding.metaMap.set("citations", JSON.stringify(doc.citations ?? EMPTY_CITATIONS));
    if (doc.images) Object.entries(doc.images).forEach(([key, dataUrl]) => binding.imagesMap.set(key, dataUrl));
  }, "local");
}
```

- [ ] **Step 4: Add `handleRepoDocsChanged` + wire it up**

```ts
function handleRepoDocsChanged({ workspaceId, created, updated, deleted }: { workspaceId: string; created: string[]; updated: string[]; deleted: string[] }): void {
  const ws = get(workspacesStore).find((w) => w.id === workspaceId);
  // Owner-only: only an editor connected to THIS workspace's room. A
  // non-editor has no repoLink anyway; a different workspace's pull is
  // irrelevant to the current connection.
  if (!ws?.remoteId || ws.remoteId !== workspaceRoom.workspaceId || workspaceRoom.role !== "editor") return;
  for (const id of created) {
    const doc = findDocById(id);
    if (doc && !workspaceRoom.docs.has(id)) seedNewDocBinding(id, doc, "editor");
  }
  for (const id of updated) {
    const binding = workspaceRoom.docs.get(id);
    const doc = findDocById(id);
    if (binding && doc) replaceBindingContent(binding, doc);
  }
  for (const id of deleted) {
    if (workspaceRoom.docs.has(id)) pushWorkspaceDocDelete(id, workspaceId);
  }
}
```

In `init()`, next to `docRemovalHook.onRemoved = pushWorkspaceDocDelete;`:

```ts
  repoDocSyncHook.onRepoDocsChanged = handleRepoDocsChanged;
```

Add `repoDocSyncHook` to the `./stores/docs` import.

- [ ] **Step 5: Run tests + full client suite + typecheck**

Run: `npx vitest run tests/client/src/collab.test.ts` — PASS.
Run: `npm test` — expected all green.
Run: `npm run typecheck` — clean.

- [ ] **Step 6: Commit**

```bash
git add client/src/collab.ts tests/client/src/collab.test.ts
git commit -m "$(cat <<'EOF'
feat(collab): seed repo-pulled docs into a connected shared workspace

repoDocSyncHook now registers the owner's repo-pull results with the
WorkspaceRoom (create -> seedNewDocBinding, update -> wholesale content
replace, delete -> pushWorkspaceDocDelete), so applyWorkspaceMeta stops
deleting repo docs that were never in the server docOrder.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: E1 regression test + E2E coverage

**Files:**
- Modify: `tests/client/src/collab.test.ts` — regression test for the original churn.
- Create: `tests/e2e/collab/workspace-delete-revoke.spec.ts`.
- Modify: `docs/TEST-COVERAGE.md` — new rows under §12 (collab) / a new §15.

- [ ] **Step 1: Write the E1 regression test**

In `tests/client/src/collab.test.ts`, in the "incoming workspace meta sync" describe (which already tests `applyWorkspaceMeta` doc removal):

```ts
it("repo-pulled docs survive a workspace-meta frame once the repo hook has seeded them", async () => {
  const { ws } = await setup("meta-repo");
  // a repo-pulled doc, not yet in the room
  docsStore.update((d) => [...d, { id: "repo-doc", name: "Repo Doc", content: "x", updatedAt: 0, createdAt: 0, workspaceId: ws.id, repoPath: "r.md" }]);

  // Before the hook: a meta frame excluding it would delete it (old bug).
  // After Task 8: the hook seeds it first.
  repoDocSyncHook.onRepoDocsChanged!({ workspaceId: ws.id, created: ["repo-doc"], updated: [], deleted: [] });
  for (let i = 0; i < 5; i++) await Promise.resolve();

  // Now a meta frame whose docOrder DOES include it (the server learned of
  // it via the seed's sync-step1) leaves it alone.
  sendWorkspaceMeta("Old Name", [`doc-meta-repo-a`, `doc-meta-repo-b`, "repo-doc"]);
  expect(get(docsStore).find((d) => d.id === "repo-doc")).toBeDefined();
  expect(workspaceRoom.docs.has("repo-doc")).toBe(true);
});
```

- [ ] **Step 2: Write the E2E spec**

Create `tests/e2e/collab/workspace-delete-revoke.spec.ts`, modelled on `live-collab.spec.ts` (uses `ownerWithDoc`, `shareAnyoneLink`, `joinSharedWorkspace` from `./support/collab`):

```ts
import { test, expect } from "@playwright/test";
import { ownerWithDoc, shareAnyoneLink, joinSharedWorkspace, BASE } from "./support/collab";

test("owner deleting a shared workspace revokes it for a connected collaborator", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await aCtx.newPage();
  const b = await bCtx.newPage();

  await ownerWithDoc(a, "del-owner-e2e", "shared body");
  const url = await shareAnyoneLink(a, "Editor");
  await joinSharedWorkspace(b, url);
  await expect(b.locator("#editor-mount .cm-content")).toContainText("shared body");

  // Owner deletes the workspace via the switcher.
  await a.click(".workspace-switcher-trigger");
  await a.click('.workspace-row button[aria-label="Delete workspace"]');
  await a.click('button:has-text("Delete")'); // ConfirmDialog

  // Collaborator: banner appears, workspace gone from their sidebar.
  await expect(b.locator(".workspace-access-banner")).toContainText("deleted by its owner", { timeout: 15000 });

  // Re-opening the link now shows the deleted banner too.
  await b.goto(url);
  await expect(b.locator(".workspace-access-banner")).toContainText("deleted by its owner", { timeout: 15000 });

  await aCtx.close();
  await bCtx.close();
});
```

Check `./support/collab` exports `joinSharedWorkspace` (it does — used by `live-collab.spec.ts`); adjust selectors against the real DOM if the run shows mismatches.

- [ ] **Step 3: Run the suites**

Run: `npx vitest run tests/client/src/collab.test.ts` — PASS.
Run: `npm run test:e2e:collab` — PASS (27 existing + 1 new). If the sandbox browser cache is stale, apply the `playwright.config.ts` `executablePath` workaround from `CLAUDE.md`, run, then revert it before committing.

- [ ] **Step 4: Update `docs/TEST-COVERAGE.md`**

Add rows for: `DELETE /api/workspace/:id` owner/non-owner/anon (server), `MESSAGE_WORKSPACE_DELETED` mirror-removal + merged-sever (client), `fetchWorkspaceAccess` 410, `WorkspaceSwitcher` delete-copy variants, `WorkspaceAccessBanner` deleted state, `repoDocSyncHook` create/update/delete + the churn regression, and the new e2e. Follow the table's existing column format; cite this plan's spec in the "source" column.

- [ ] **Step 5: Commit**

```bash
git add tests/client/src/collab.test.ts tests/e2e/collab/workspace-delete-revoke.spec.ts docs/TEST-COVERAGE.md
git commit -m "$(cat <<'EOF'
test: E1 churn regression + workspace-delete-revoke e2e + coverage rows

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Full verification, release plumbing, PR

**Files:**
- Modify: `CHANGELOG.md`, `package.json`, `package-lock.json` (×2 version fields), `client/src/whats-new-entries.ts`, `client/public/whats-new/<name>.png`, `ROADMAP.md`.

- [ ] **Step 1: Full local verification**

```bash
npm test
npm run typecheck
npm run format:check
npm run build
npm run test:e2e:local
npm run test:e2e:collab
```

All green. Fix anything red before proceeding (return to the owning task; don't paper over).

- [ ] **Step 2: `CHANGELOG.md`**

New section at the top:

```markdown
## [1.49.0] - <YYYY-MM-DD>

### Added

- **Deleting a shared workspace now revokes access.** As the owner, deleting a shared workspace removes it for everyone you shared it with — the link stops working, connected collaborators are disconnected and their local copy is removed, with a banner explaining why. The delete confirmation spells out the consequence, and differs for a workspace you own versus one shared with you.

### Fixed

- **A workspace that is both repo-synced and live-shared no longer loses its repo-pulled documents.** Pulling from the linked repo created documents the collaboration room never knew about, so the next workspace-metadata sync deleted them locally and the next pull re-created them — sidebar rows would vanish and rebuild, and needed several clicks to open. The owner's pull results now register with the room.
```

- [ ] **Step 3: Capture the What's New screenshot**

Build + serve locally, drive a quick Playwright script (or reuse `tests/scripts/manual-testing/capture-*.mjs` as a template) to screenshot the delete confirmation dialog for a shared workspace (owner copy) — or the "deleted by its owner" banner. Save to `client/public/whats-new/shared-workspace-delete-revoke.png`. **A real screenshot — never a placeholder** (`WhatsNew.svelte` renders it with no fallback).

- [ ] **Step 4: `whats-new-entries.ts`**

Append to `WHATS_NEW_ENTRIES` (oldest-first):

```ts
  {
    version: "1.49.0",
    date: "<YYYY-MM-DD>",
    category: "Collaboration",
    title: "Deleting a shared workspace revokes access",
    body: "Deleting a shared workspace you own now removes it for everyone you shared it with — the link stops working and collaborators are disconnected. The confirmation dialog spells this out, and reads differently for a workspace shared *with* you (which just drops your local copy).",
    screenshot: "shared-workspace-delete-revoke.png",
  },
```

Match the exact field names/shape of the existing entries.

- [ ] **Step 5: Version bump**

`package.json`: `"version": "1.49.0"`. `package-lock.json`: both `"version": "1.49.0"` (lines ~3 and ~9). Hand-edit; do not regenerate.

- [ ] **Step 6: `ROADMAP.md`**

Under **Active → Shared-workspace correctness**: mark **E1**, **F3**, **F4** shipped (v1.49.0), or move the whole sub-section's shipped items into a one-line note pointing at CHANGELOG. Copy the spec's Non-goals into a "deferred" note per the project convention (multi-party repo sync; soft-delete/undo; export-before-delete).

- [ ] **Step 7: Format + final suite**

```bash
npm run format
npm test && npm run typecheck && npm run build
```

- [ ] **Step 8: Commit + PR**

```bash
git add CHANGELOG.md package.json package-lock.json client/src/whats-new-entries.ts client/public/whats-new/shared-workspace-delete-revoke.png ROADMAP.md
git commit -m "$(cat <<'EOF'
chore: release 1.49.0 — shared-workspace delete revoke + repo/share compose

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push -u origin feat/shared-workspace-composition-lifecycle
```

Open a PR against `master`. Body: summarise E1 (repo/share compose), F3 (delete copy), F4 (server revoke + client teardown); note the new `DELETE /api/workspace/:id` endpoint and `MESSAGE_WORKSPACE_DELETED = 5` wire addition; link the spec. Wait for CI green. **Note in the PR:** the Google Drive branch (`feat/google-drive-sync`) currently also targets `1.49.0` and will need to rebase to `1.50.0` after this merges.

---

## Self-review notes (addressed)

- **Spec coverage:** E1 → Tasks 7-9; F3 → Task 6; F4 server → Task 2, client teardown → Tasks 3-5, banner → Task 4; `mirrored` flag → Task 1. All spec sections mapped.
- **Type consistency:** `handleWorkspaceGone(localWorkspaceId)` used identically in Task 5 steps 3-5. `repoDocSyncHook.onRepoDocsChanged` signature identical in Tasks 7 & 8. `upsertDocFromRepo` new return `{ id, created }` consumed in Task 7 step 4.
- **`MESSAGE_WORKSPACE_DELETED = 5`** stated in Global Constraints and repeated in Task 2 (server) and Task 3 (client).
- **Task 7 step 4** now spells out `fireRepoHook()` with `hookReportedCreated/Updated` index tracking rather than pseudo-code.
- **Placeholder scan:** no "TBD"/"handle edge cases"/"similar to Task N". Task 3 step 1 deliberately has no standalone test (`fetchWorkspaceAccess` is unexported) — covered by Task 5's gone-on-load test, stated explicitly.
