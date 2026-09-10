# CollabRoom → migration-only shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the legacy `CollabRoom` Durable Object to a migration-only shim — it can be read and migrated into a `WorkspaceRoom`, nothing else — so there is no live-collaboration or HTTP-mutation surface left for a security audit to find parity gaps in.

**Architecture:** The current client only ever calls `POST /api/collab/<id>/migrate` (then talks exclusively to `WorkspaceRoom`). Delete `worker.ts`'s four other `/api/collab/*` routes and gut `collab-room.ts` down to: constructor + storage load, `authorize`/`getAccess`/`getSession`/`getSnapshots` reads, `fetch` (→ `/migrate` or `410`), and `handleMigrateRequest`. Delete the e2e that depended on writing to a legacy room.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, Yjs (`yjs` only — the sync/awareness protocol imports go), Vitest (`unit` project), Playwright (`e2e-collab`).

**Spec:** `docs/superpowers/specs/2026-09-10-collabroom-migration-shim-design.md` (e2e seed decision: **option A** — delete `legacy-migration.spec.ts` + `legacy-room.ts`).

## Global Constraints

- Do **not** touch `src/worker.ts`'s top-of-file region — the import block and the start of `fetch`. `dev-login.patch` (e2e-collab / e2e-github) patches there. The CollabRoom route constants (~line 9–13) and dispatch (~line 92–123) are clear of it.
- The `CollabRoom` **class, DO binding, and SQLite migration stay** (`wrangler.jsonc` `COLLAB_ROOM`, `migrations` `v1`). `src/worker.ts:1` keeps `export { CollabRoom } from "./collab-room.js";`. This plan does NOT delete the class or the binding.
- No new npm dependency.
- `scripts/check-no-dev-login.mjs` must keep passing — no `/api/dev/login` / `DEV_LOGIN_PATH` string enters `src/**`.
- `tests/src/**` is full-strict TS + `noUncheckedIndexedAccess`.
- Ships as a **patch** release (`1.62.x` — the next free patch after whatever is current; check `package.json`): `CHANGELOG.md` `### Changed`, **no** `whats-new-entries.ts` entry, **no** screenshot. Version bump is the last step before the PR.
- Branch: `chore/collabroom-migration-shim` off current `master`. The spec is committed on `docs/collabroom-shim-spec` (`d0bfb27`) — branch from it or cherry-pick it.
- `npm run format` before every commit; CI runs `npm run format:check`.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. Never a `Claude-Session:` link. PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Accepted coverage delta

Deleting `legacy-migration.spec.ts` (COLLAB-39) drops the only **end-to-end** exercise of the client's `migrateLegacyDoc` orchestration (adopt workspace, clear `shared` flag, rejoin, name-heal). The **server** migration — the part that can actually regress — keeps its five `handleMigrateRequest` integration tests plus `WorkspaceRoom`'s `/internal/seed` tests. `migrateLegacyDoc` is an unexported function in `client/src/collab.ts` and `collab.ts` init never runs under jsdom, so a faithful unit test isn't cheap; this delta is accepted, noted in `TEST-COVERAGE.md`, and can be revisited if a migration bug ever slips through.

---

## Task 1: Reduce CollabRoom to a migration shim

**Files:**
- Modify: `src/worker.ts` — delete 4 route consts + 4 dispatch blocks (keep `ROOM_MIGRATE_PATH` + its block)
- Rewrite: `src/collab-room.ts` — 722 lines → the ~135-line shim below
- Modify: `tests/src/collab-room.test.ts` — rewrite the `putAccess` helper; delete the describe blocks for removed methods; keep `getAccess` / `authorize` / `handleMigrateRequest`
- Modify: `tests/src/worker.test.ts` — the `/api/collab/... comments` dispatch test → `/migrate`
- Delete: `tests/e2e/collab/legacy-migration.spec.ts`, `tests/e2e/collab/support/legacy-room.ts`
- Modify: `docs/TEST-COVERAGE.md` — trim the CollabRoom rows (done here so the task's own coverage claims stay true; final count reconciliation is Task 2)

**Interfaces:**
- Consumes: `WorkspaceRoom`'s internal `POST /internal/seed` endpoint (unchanged — body `{ docId, docName, update: number[], access, snapshots, comments }`).
- Produces:
  - `class CollabRoom` with public: `state`, `env`, `doc: Y.Doc`, `commentThreads: CommentThread[]`, `migratedTo: string | null`, `fetch(request): Promise<Response>`, `handleMigrateRequest(request): Promise<Response>`, `authorize(request): Promise<AuthResult>`, `getAccess(): Promise<AccessRecord>`, `getSnapshots(): Promise<Snapshot[]>`, `getSession(request)`.
  - Still exported: `type { Role, InvitedPerson, AccessRecord }`, `interface Snapshot`, `interface CommentReply`, `interface CommentThread`.
  - **No longer exported / removed:** `normalizeInvited`, `interface SessionInfo`, and every `handle*Request` except `handleMigrateRequest`, plus `handleSession`/`handleMessage`/`handleClose`/`broadcast`/`handleDocUpdate`/`handleAwarenessUpdate`/`reconcileSessionRoles`/`maybeSnapshot`/`forceSnapshot`/`createThread`/`addReply`/`resolveThread`/`deleteThread`/`refreshCommentAnchors`/`persistComments`/`persistNow`/`schedulePersist`/`alarm`/`imagesFromDoc`.

### Steps

- [ ] **Step 1: Delete the four non-migrate routes in `src/worker.ts`**

Delete these route constants (they're around line 9–13; leave `ROOM_MIGRATE_PATH`):

```ts
const ROOM_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})$/;
const ROOM_ACCESS_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})\/access$/;
const ROOM_VERSIONS_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})\/versions(\/.*)?$/;
const ROOM_COMMENTS_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})\/comments(\/.*)?$/;
```

Delete these four dispatch blocks (around line 98–123), leaving only the `roomMigrateMatch` block:

```ts
    const roomAccessMatch = url.pathname.match(ROOM_ACCESS_PATH);
    if (roomAccessMatch) {
      const id = env.COLLAB_ROOM.idFromName(roomAccessMatch[1]!);
      return env.COLLAB_ROOM.get(id).fetch(request);
    }

    const roomVersionsMatch = url.pathname.match(ROOM_VERSIONS_PATH);
    if (roomVersionsMatch) {
      const id = env.COLLAB_ROOM.idFromName(roomVersionsMatch[1]!);
      return env.COLLAB_ROOM.get(id).fetch(request);
    }

    const roomCommentsMatch = url.pathname.match(ROOM_COMMENTS_PATH);
    if (roomCommentsMatch) {
      const id = env.COLLAB_ROOM.idFromName(roomCommentsMatch[1]!);
      return env.COLLAB_ROOM.get(id).fetch(request);
    }

    const roomMatch = url.pathname.match(ROOM_PATH);
    if (roomMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const id = env.COLLAB_ROOM.idFromName(roomMatch[1]!);
      return env.COLLAB_ROOM.get(id).fetch(request);
    }
```

The `roomMigrateMatch` block stays exactly as is. Leave `export { CollabRoom } from "./collab-room.js";` on line 1.

- [ ] **Step 2: Verify nothing else references the removed worker routes / exports**

Run:
```bash
grep -rn "ROOM_PATH\|ROOM_ACCESS_PATH\|ROOM_VERSIONS_PATH\|ROOM_COMMENTS_PATH" src/
grep -rn "normalizeInvited" src/ client/src/ | grep -v "workspace-room.ts"
grep -rn 'from "./collab-room\|from "../../src/collab-room\|from "../collab-room' src/ client/ tests/
```
Expected: first two return nothing (or only comments); the third returns only `src/worker.ts:1` and `tests/src/collab-room.test.ts:5`. If `normalizeInvited` shows a real importer outside the test, STOP — it must move to a shared module first; raise it.

- [ ] **Step 3: Replace `src/collab-room.ts` with the shim**

Replace the **entire file** with:

```ts
import * as Y from "yjs";
import { getCookie, decryptSession, SESSION_COOKIE } from "./auth.js";
import type { Env } from "./env";
import { resolveRole } from "./access-role";
import type { Role, InvitedPerson, AccessRecord } from "./access-role";

export type { Role, InvitedPerson, AccessRecord };

const PERSIST_KEY = "update";
const ACCESS_KEY = "access";
const SNAPSHOTS_KEY = "snapshots";
const COMMENTS_KEY = "comments";

// These three shapes are kept only because the /internal/seed body this
// shim forwards is typed with them, and WorkspaceRoom's seed handler
// consumes that exact shape.
export interface Snapshot {
  id: string;
  timestamp: number;
  content: string;
  images?: Record<string, string>;
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

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

type AuthResult = { ok: true; username: string | null; role: Role } | { ok: false; status: number; message: string };

const DEFAULT_ACCESS: AccessRecord = { owner: null, generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] };

// The legacy one-Durable-Object-per-document collaboration room, now a
// MIGRATION-ONLY SHIM. Live editing, version history and comment threads
// all moved to WorkspaceRoom in the workspace pivot; the current client
// (client/src/collab.ts's migrateLegacyDoc) only ever calls
// POST /api/collab/<id>/migrate, then talks exclusively to WorkspaceRoom.
// This class exists solely so an old single-document share link can still
// be migrated: it loads whatever doc / access / snapshots / comment
// threads were last checkpointed here and forwards them to a fresh
// WorkspaceRoom via /internal/seed, then writes a `migratedTo` tombstone.
// Nothing else here mutates state. See
// docs/superpowers/specs/2026-09-10-collabroom-migration-shim-design.md.
export class CollabRoom {
  state: DurableObjectState;
  env: Env;
  doc: Y.Doc;
  commentThreads: CommentThread[];
  migratedTo: string | null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.doc = new Y.Doc();
    this.commentThreads = [];
    this.migratedTo = null;

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<ArrayBuffer>(PERSIST_KEY);
      if (stored) Y.applyUpdate(this.doc, new Uint8Array(stored), "storage");
      this.commentThreads = (await this.state.storage.get<CommentThread[]>(COMMENTS_KEY)) || [];
      this.migratedTo = (await this.state.storage.get<string>("migratedTo")) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.endsWith("/migrate")) return this.handleMigrateRequest(request);
    // Every other /api/collab/* endpoint was removed with the workspace
    // pivot's teardown (the router no longer forwards them either) — a
    // stale client hitting one just needs to reload and migrate.
    return new Response("This legacy document endpoint is gone — reload to migrate to a workspace.", { status: 410 });
  }

  async getAccess(): Promise<AccessRecord> {
    const stored = await this.state.storage.get<Record<string, unknown>>(ACCESS_KEY);
    if (!stored) return { ...DEFAULT_ACCESS };
    // invited used to be string[] (before per-person roles) — a leftover
    // plain-string entry always resolved to "editor" in the old
    // authorize(), so that's the role that preserves its access exactly.
    const rawInvited = Array.isArray(stored.invited) ? stored.invited : [];
    const invited: InvitedPerson[] = rawInvited.map((entry) => (typeof entry === "string" ? { username: entry, role: "editor" } : (entry as InvitedPerson)));
    return { ...DEFAULT_ACCESS, ...stored, invited } as AccessRecord;
  }

  async getSnapshots(): Promise<Snapshot[]> {
    const stored = await this.state.storage.get<Snapshot[]>(SNAPSHOTS_KEY);
    return stored || [];
  }

  async getSession(request: Request) {
    const cookie = getCookie(request, SESSION_COOKIE);
    if (!cookie) return null;
    return decryptSession(this.env, cookie);
  }

  // "Has any access to the legacy room" — the gate on triggering a
  // migration: an outsider must not be able to force DO allocation + a
  // tombstone on a room they can't reach (MDE-04).
  async authorize(request: Request): Promise<AuthResult> {
    const session = await this.getSession(request);
    const access = await this.getAccess();
    if (!access.owner) return { ok: false, status: 403, message: "This document hasn't been shared." };
    const role = resolveRole(access, session?.username ?? null);
    if (!role) {
      if (!session || !session.username) return { ok: false, status: 401, message: "Sign in with GitHub to join this document." };
      return { ok: false, status: 403, message: "You don't have access to this document." };
    }
    return { ok: true, username: session?.username ?? null, role };
  }

  // Lazy, per-document migration into a WorkspaceRoom — there's no
  // registry of legacy room names to bulk-migrate from, so this runs the
  // first time a collaborator opens an old shared link. Idempotent via the
  // `migratedTo` tombstone: a second caller gets the first's workspace id.
  async handleMigrateRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const existingTombstone = this.migratedTo ?? (await this.state.storage.get<string>("migratedTo"));
    if (existingTombstone) {
      this.migratedTo = existingTombstone;
      return Response.json({ workspaceId: existingTombstone });
    }

    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });

    const workspaceId = uid() + uid(); // wider than a doc id's uid() to avoid colliding with existing workspace ids
    const access = await this.getAccess();
    const snapshots = await this.getSnapshots();
    const docId = new URL(request.url).pathname.split("/")[3]!; // /api/collab/<docId>/migrate

    // A modern client that connected to this legacy room before the pivot
    // may have written a name into the Y.Doc's `meta` map — carry it
    // forward so the migrated workspace/doc aren't left as placeholders.
    const docName = (this.doc.getMap<string>("meta").get("name") || "").trim();

    const seedBody = {
      docId,
      docName,
      update: Array.from(Y.encodeStateAsUpdate(this.doc)),
      access,
      snapshots,
      comments: this.commentThreads,
    };
    const workspaceRoomId = this.env.WORKSPACE_ROOM.idFromName(workspaceId);
    const res = await this.env.WORKSPACE_ROOM.get(workspaceRoomId).fetch(
      new Request("https://internal/internal/seed", { method: "POST", body: JSON.stringify(seedBody) }),
    );
    if (!res.ok) return new Response("Migration failed.", { status: 500 });

    await this.state.storage.put("migratedTo", workspaceId);
    this.migratedTo = workspaceId;
    return Response.json({ workspaceId });
  }

  // A legacy room may still have a persist alarm scheduled from before
  // this shim shipped. There is nothing left to persist — absorb it.
  async alarm(): Promise<void> {}
}
```

Note the deliberate keeps: `alarm()` (no-op — a pre-shim `setAlarm` may still fire), `getSnapshots` (read-only, forwarded to the seed), `commentThreads` (read-only), the three exported interfaces.

- [ ] **Step 4: `npm run typecheck` — expect failures only in the CollabRoom test**

Run: `npm run typecheck`
Expected: `src/**` clean. `tests/src/collab-room.test.ts` fails (imports `normalizeInvited`, references removed methods) — Step 5 fixes it. If `src/worker.ts` or any other `src/` file fails, a route/export was missed — fix before moving on.

- [ ] **Step 5: Rewrite `tests/src/collab-room.test.ts`**

Change the import (line 5) to drop `normalizeInvited`, and drop the now-unused protocol imports at the top (`syncProtocol`, `encoding` — check what's still referenced by kept tests and keep only those):

```ts
import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";
import { CollabRoom, type AccessRecord, type Snapshot, type CommentThread } from "../../src/collab-room";
import { encryptSession } from "../../src/auth";
import type { Env } from "../../src/env";
```

Rewrite the `putAccess` helper (it used to `PUT /access`, which is gone) to seed the access record straight into storage — matching how `workspace-room.test.ts` does it — and return `void`:

```ts
async function putAccess(room: CollabRoom, owner: string, body: Record<string, unknown>): Promise<void> {
  await room.state.storage.put("access", {
    owner,
    generalAccess: body.generalAccess ?? "restricted",
    requireAccount: body.requireAccount ?? false,
    role: body.role ?? "viewer",
    invited: body.invited ?? [],
  });
}
```

**Delete these entire `describe` blocks** (every one tests a method the shim no longer has):
- `describe("normalizeInvited", …)`
- `describe("CollabRoom version snapshots", …)`
- `describe("CollabRoom.handleVersionRestoreRequest — images", …)`
- `describe("CollabRoom comment threads", …)`
- `describe("GET/POST /room1/comments", …)`
- `describe("POST /room1/comments/:id/reply and /resolve", …)`
- `describe("DELETE /room1/comments/:id", …)`
- `describe("GET /room1/versions", …)`
- `describe("GET /room1/versions/:id", …)`
- `describe("POST /room1/versions/:id/restore", …)`
- `describe("CollabRoom.handleAccessRequest", …)`
- `describe("CollabRoom.handleMessage — read-only enforcement", …)`
- `describe("CollabRoom.reconcileSessionRoles (MDE-23)", …)`

**Keep** `describe("CollabRoom.getAccess", …)` and `describe("CollabRoom.authorize", …)` unchanged (their `putAccess` calls now hit the rewritten helper).

**In `describe("CollabRoom.handleMigrateRequest", …)`**, keep every test, with two edits to the v1.62.7 additions:

1. The test `it("410s every request except /migrate once migrated, and closes live sessions (MDE-22)", …)` — remove the `room.sessions` setup and the `closed` / `room.sessions.size` assertions (no `sessions` on the shim). Rename to `it("410s every request except /migrate, and /migrate still answers after migrating", …)` and keep the rest:

```ts
  it("410s every request except /migrate, and /migrate still answers after migrating", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    room.doc.transact(() => room.doc.getText("content").insert(0, "legacy"), "storage");
    room.env = {
      ...fakeEnv,
      WORKSPACE_ROOM: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
      },
    } as unknown as Env;

    const mig = await room.handleMigrateRequest(await authedRequest("alice", "/room1/migrate", { method: "POST" }));
    const { workspaceId } = (await mig.json()) as { workspaceId: string };

    // /migrate still answers (discovery)
    const again = await room.fetch(await authedRequest("alice", "/room1/migrate", { method: "POST" }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { workspaceId: string }).workspaceId).toBe(workspaceId);

    // everything else is 410 (before OR after migration — the endpoints are just gone)
    for (const path of ["/room1/access", "/room1/versions", "/room1/comments"]) {
      const res = await room.fetch(await authedRequest("alice", path, { method: "GET" }));
      expect(res.status).toBe(410);
    }
    const wsRes = await room.fetch(new Request("https://example.com/room1", { headers: { Upgrade: "websocket" } }));
    expect(wsRes.status).toBe(410);
  });
```

2. Keep `it("410s a room that was already migrated in a previous instance (tombstone warmed from storage)", …)` as-is (it only calls `room2.fetch` and `room2.fetch(/migrate)` — both still valid).

Add one new test in the same block, asserting the endpoints are gone even **before** any migration:

```ts
  it("410s a legacy endpoint that was never migrated (the surface is gone, not gated)", async () => {
    const room = new CollabRoom(fakeState(), fakeEnv);
    await putAccess(room, "alice", { generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });
    for (const path of ["/room1/access", "/room1/versions", "/room1/comments/x/reply"]) {
      expect((await room.fetch(await authedRequest("alice", path, { method: "GET" }))).status).toBe(410);
    }
    expect((await room.fetch(new Request("https://example.com/room1", { headers: { Upgrade: "websocket" } }))).status).toBe(410);
  });
```

Check `sessionRequest` / `authedRequest` helpers at the top of the file are still used by kept tests (they are — `authorize` + `migrate` tests use them); leave them. Remove any helper that's now unreferenced (run `npm run typecheck` — TS `noUnusedLocals` is off, so also eyeball for obviously-dead helpers like a `syncUpdateMessage` that lived only in the deleted read-only-enforcement block).

- [ ] **Step 6: Run the CollabRoom unit tests**

Run: `npx vitest run tests/src/collab-room.test.ts`
Expected: PASS. Test count drops sharply (from ~72 to ~20). If a kept `authorize`/`getAccess` test fails, the `putAccess` rewrite has a field wrong — compare against the object shape in `getAccess`.

- [ ] **Step 7: Update the worker dispatch test**

`tests/src/worker.test.ts` — replace the CollabRoom test (around line 56):

```ts
  it("dispatches /api/collab/:id/migrate to the CollabRoom DO", async () => {
    const { env, doFetch } = fakeEnv();
    await worker.fetch(new Request("https://app.example.com/api/collab/room1/migrate", { method: "POST" }), env);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("no longer routes the removed legacy /api/collab endpoints to a DO (404 from the router)", async () => {
    const { env, doFetch } = fakeEnv();
    for (const path of ["/api/collab/room1", "/api/collab/room1/access", "/api/collab/room1/versions", "/api/collab/room1/comments/t1/reply"]) {
      doFetch.mockClear();
      const res = await worker.fetch(new Request(`https://app.example.com${path}`, { method: "GET" }), env);
      expect(doFetch).not.toHaveBeenCalled();
      expect(res.status).toBe(404);
    }
  });
```

If `fakeEnv()` shares one namespace mock for `WORKSPACE_ROOM` and `COLLAB_ROOM` (check — it does at line ~17), `doFetch` fires for either; that's fine for these assertions. If the router's fall-through isn't a literal 404 (e.g. it serves the SPA index for unknown paths), adjust the second test's `expect(res.status)` to whatever the router actually returns for an unknown `/api/...` path — the assertion that matters is `doFetch` was not called.

- [ ] **Step 8: Delete the legacy-room e2e**

```bash
git rm tests/e2e/collab/legacy-migration.spec.ts tests/e2e/collab/support/legacy-room.ts
```

Then check nothing else imports the helper:
```bash
grep -rn "legacy-room\|seedLegacyCollabRoom\|mintDevSession" tests/
```
Expected: no hits (if `mintDevSession` is used by another spec, extract just that function into a small `tests/e2e/collab/support/dev-session.ts` and re-point that spec — do NOT keep `legacy-room.ts` for it).

- [ ] **Step 9: `npm run typecheck` + full unit suite**

Run: `npm run typecheck` then `npx vitest run --project=unit`
Expected: 0 type errors; unit suite green (total drops by ~50 from the deleted CollabRoom describes).

- [ ] **Step 10: `npm run test:e2e:collab`**

Run: `npm run test:e2e:collab`
Precondition: `git diff -- src/worker.ts` shows only the route deletions (not the top-of-file region). If it touched the top, `git checkout` and redo Step 1 more surgically.
Expected: all remaining collab e2e pass (`legacy-migration.spec.ts` is gone; nothing else used `legacy-room.ts`).

- [ ] **Step 11: Trim the CollabRoom rows in `docs/TEST-COVERAGE.md`**

In the §10 table: `SEC-04`, `SEC-21`, `SEC-22`, `SEC-23` all concern CollabRoom endpoints that no longer exist. Replace those four rows with a single row:

```markdown
| SEC-04 | Legacy `CollabRoom` is a migration-only shim — `fetch` serves `POST /migrate` (auth-gated, MDE-04; idempotent via the `migratedTo` tombstone) and 410s everything else. No session map, no WebSocket, no HTTP mutation endpoints — the run-3/4/5 parity gaps (MDE-21/22/23) are gone with the code | integration | covered | `tests/src/collab-room.test.ts` | v1.62.x · CollabRoom shim (spec `2026-09-10-collabroom-migration-shim`) |
```

Also find and remove any non-SEC CollabRoom rows for the deleted endpoints (search the file for `CollabRoom`, `/api/collab`, `collab-room.test.ts` — e.g. legacy version-history / comment rows). Leave the running totals wrong for now; Task 2 Step 4 reconciles every count in one pass.

- [ ] **Step 12: `npm run format` + commit**

```bash
npm run format
git add src/worker.ts src/collab-room.ts tests/src/collab-room.test.ts tests/src/worker.test.ts docs/TEST-COVERAGE.md
git rm tests/e2e/collab/legacy-migration.spec.ts tests/e2e/collab/support/legacy-room.ts
git commit -m "refactor(collab): reduce CollabRoom to a migration-only shim

The current client only ever calls POST /api/collab/<id>/migrate, then
talks exclusively to WorkspaceRoom. Delete the four other /api/collab
routes and gut collab-room.ts (722 -> ~135 lines) down to the storage
reads + handleMigrateRequest. No session map, no WebSocket, no HTTP
mutation endpoints — nothing left for an audit to find a parity gap in.
Deletes legacy-migration.spec.ts (option A — server migration stays
integration-covered).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Docs + release

**Files:**
- Modify: `client/src/history.ts` (~line 5 comment), `client/src/app.ts` (~line 518 comment)
- Modify: `docs/ARCHITECTURE.md`, `CLAUDE.md`, `ROADMAP.md`, `CHANGELOG.md`, `docs/TEST-COVERAGE.md` (count reconciliation)
- Modify: `package.json`, `package-lock.json`

### Steps

- [ ] **Step 1: Comment wording in `client/src/`**

`client/src/history.ts` line ~5 — the comment says version history lives in "CollabRoom's own Durable Object storage". For a shared doc that's `WorkspaceRoom` now. Reword to:

```ts
// WorkspaceRoom's own Durable Object storage (see src/workspace-room.ts) and is
```

`client/src/app.ts` line ~518 — reword:

```ts
    // Once a document has ever been shared, its WorkspaceRoom (server-side) is
    // the sole owner of its history — see history.ts's own comment.
```

(No behaviour change — both paths already call `/api/workspace/*`.)

- [ ] **Step 2: `docs/ARCHITECTURE.md` + `CLAUDE.md`**

`docs/ARCHITECTURE.md` — the `CollabRoom` paragraph (search `CollabRoom`). Replace "a **legacy**, one-Durable-Object-per-document predecessor, kept alive only so an old single-document share link still works — opening one transparently migrates it" with:

```markdown
`CollabRoom` (`src/collab-room.ts`) is a **migration-only shim** — the
pre-workspace one-Durable-Object-per-document design, now reduced to just
`POST /api/collab/<id>/migrate`, which seeds a fresh `WorkspaceRoom` from
whatever was last checkpointed in the legacy room and writes a
`migratedTo` tombstone. Every other legacy endpoint (live WebSocket,
`/access`, `/versions`, `/comments`) is gone; `client/src/collab.ts`'s
`migrateLegacyDoc` calls `/migrate` on open, then talks only to the
`WorkspaceRoom`. The class stays only until every legacy link has been
opened once.
```

`CLAUDE.md` — in "Workspaces, documents, and two generations of Durable Object", the `CollabRoom` sentence — make the same "migration-only shim" adjustment (keep it to one or two sentences to match the file's density).

- [ ] **Step 3: `CHANGELOG.md`**

Add above the current top section:

```markdown
## [1.62.x] - 2026-09-10

### Changed

- The legacy single-document collaboration rooms (superseded by workspaces since v1.20) are now migration-only: opening an old share link still moves the document into a workspace exactly as before, but the retired room no longer accepts live edits, version-history requests, or comment requests — closing the surface that three separate audit rounds kept finding gaps in.
```

Replace `1.62.x` with the actual next patch number.

- [ ] **Step 4: `docs/TEST-COVERAGE.md` count reconciliation**

`npx vitest run --project=unit` and note the new `collab-room.test.ts` count. Update the §10 row count and the `**Total**` row in the summary table at the top so they match reality (§10 drops by the number of CollabRoom describe blocks removed minus the rows kept/added; total drops the same). Do the arithmetic against the actual `vitest` output, not an estimate.

- [ ] **Step 5: `ROADMAP.md`**

Group D "Security follow-ups" — the follow-up line added in v1.62.7 ("reduce `CollabRoom` to a migration-only shim … its own small plan") — mark it done:

```markdown
  Done in **v1.62.x** (spec/plan `2026-09-10-collabroom-migration-shim`):
  `CollabRoom` is now ~135 lines — `POST /migrate` and storage reads only.
```

- [ ] **Step 6: Version bump (last step before the PR)**

Hand-edit (no `npm install`): `package.json` line 4 and `package-lock.json` lines 3 & 9 → the next patch version. Verify the `CHANGELOG.md` heading matches.

```bash
grep -n '"version"' package.json | head -1
npm run format:check
```

- [ ] **Step 7: Full verification**

```bash
npm test
npm run typecheck
npm run build
npm run format:check
npm run check:no-dev-login
```
Expected: all green.

- [ ] **Step 8: Commit + finish the branch**

```bash
git add -A
git commit -m "chore: release 1.62.x — CollabRoom migration shim + docs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

**REQUIRED SUB-SKILL:** Use `superpowers:finishing-a-development-branch`. Base branch `master`. Push, open a PR titled `refactor(collab): reduce CollabRoom to a migration-only shim — v1.62.x`; body summarises the cut, links the spec, notes the accepted e2e coverage delta, ends with the `🤖 Generated with [Claude Code](https://claude.com/claude-code)` line (no `Claude-Session:` link). Wait for CI green; merge only on the user's go-ahead. auto-tag → release → deploy run on their own.

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
| --- | --- |
| worker.ts: keep only `ROOM_MIGRATE_PATH`, delete the other 4 routes | Task 1 Step 1 |
| collab-room.ts: keep constructor+load, `authorize`/`getAccess`/`getSession`/`getSnapshots`, `fetch`→`/migrate`\|410, `handleMigrateRequest` | Task 1 Step 3 (full target file) |
| delete: session/WS machinery, `/versions` + `/comments` endpoints, `handleAccessRequest`, snapshot creation, persistence, `normalizeInvited`, protocol imports | Task 1 Step 3 (whole-file replace) + Step 2 (import check) |
| keep the class / binding / SQLite migration / `worker.ts:1` export | Global Constraints + Task 1 Step 1 (leaves line 1) |
| `CommentThread`/`CommentReply`/`Snapshot` interfaces stay (seed body shape) | Task 1 Step 3 |
| `handleMigrateRequest` keeps MDE-04 auth + tombstone short-circuit, loses the v1.62.7 session-close loop | Task 1 Step 3 |
| e2e seed = option A (delete both files) | Task 1 Step 8 |
| `check-no-dev-login.mjs` keeps passing | Task 2 Step 7 (`npm run check:no-dev-login`) — the shim adds no dev string |
| `history.ts` / `app.ts` comment wording | Task 2 Step 1 |
| CHANGELOG `### Changed`, patch, no whats-new | Task 2 Step 3 + Step 6 |
| TEST-COVERAGE: fold SEC-04/21/22/23 → one row, fix counts | Task 1 Step 11 + Task 2 Step 4 |
| ARCHITECTURE + CLAUDE.md wording | Task 2 Step 2 |
| ROADMAP mark done | Task 2 Step 5 |
| Non-goal: don't delete the class / binding | honoured — Global Constraints, no task does it |
| Non-goal: don't touch WorkspaceRoom | honoured — no task modifies it |
| Non-goal: keep `migrateLegacyDoc` client-side | honoured — no client logic change, only a comment |

No gaps.

**2. Placeholder scan** — no "TBD" / "handle edge cases" / "similar to Task N". `1.62.x` is a deliberate "fill from `package.json`" instruction repeated with the how, not a placeholder. The full target file is inline. Step 7's "adjust to whatever the router returns" spells out the fallback and names the real assertion.

**3. Type consistency**

- `putAccess(room, owner: string, body: Record<string, unknown>): Promise<void>` — same signature in Task 1 Step 5 and every kept caller (`authorize`/`getAccess`/`migrate` describes) passes `(room, "alice", {...})`. ✓
- `CollabRoom` public surface in Task 1 "Produces" matches the target file in Step 3 exactly (`doc`, `commentThreads`, `migratedTo`, `fetch`, `handleMigrateRequest`, `authorize`, `getAccess`, `getSnapshots`, `getSession`). ✓
- `AuthResult` shape unchanged from the original. ✓
- `Snapshot` / `CommentReply` / `CommentThread` exported with identical fields to the original. ✓
- Task 1 Step 7's worker test uses `fakeEnv()` / `doFetch` — the existing helpers in `worker.test.ts`, not new names. ✓
- `migratedTo` / `handleMigrateRequest` / the tombstone tests referenced in Task 1 Step 5 match the v1.62.7 code merged in PR #216. ✓
