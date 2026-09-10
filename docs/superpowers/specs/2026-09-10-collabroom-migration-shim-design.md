# Reduce `CollabRoom` to a migration-only shim — design

**Status:** draft, under review
**Trigger:** five external audit rounds; runs 3–4 hardened `WorkspaceRoom`, run 5 (MDE-21/22/23) found the *same* gaps unpatched in the legacy `CollabRoom`, which was only ever getting parity fixes after the fact. The maintainer's call: stop patching it — remove the surface.
**Predecessors:** the whole `project_workspace_pivot` (WorkspaceRoom replaced CollabRoom), `2026-09-10` security batches (MDE-04 in v1.62.1, MDE-21/22/23 in v1.62.7).
**Ships as:** a **minor** release only if anything user-visible changes (it doesn't for a current client) — realistically a **patch** (`1.62.x`): `CHANGELOG.md` `### Changed`, no What's New. It's a behind-the-scenes teardown of dead code.

## Global constraints

- `src/worker.ts`'s top-of-file region (the import block, the start of `fetch`) stays untouched — `dev-login.patch` (e2e-collab / e2e-github) patches there. The CollabRoom **route** constants and dispatch are ~line 9–13 and ~line 92–123, well clear of that.
- The `CollabRoom` DO **class, binding, and SQLite migration stay** (`wrangler.jsonc` `COLLAB_ROOM` / `migrations` `v1`). Legacy documents' content lives in per-instance DO storage; the class must remain alive to serve `POST /migrate` — possibly forever, unless a separate decision abandons never-reopened legacy docs.
- No new npm dependency.
- `check-no-dev-login.mjs` must keep passing — no `/api/dev/login` / `DEV_LOGIN_PATH` string may enter `src/**`.

## Background — what `CollabRoom` still does, and who calls it

`CollabRoom` is the pre-workspace one-Durable-Object-per-document design. A document shared before the workspace pivot has `shared: true` in `localStorage`; on open, `client/src/collab.ts`'s `migrateLegacyDoc` (line ~567) does exactly one thing against `/api/collab/*`:

```
POST /api/collab/<docId>/migrate   →  { workspaceId }
```

then adopts that workspace and talks **only** to `WorkspaceRoom` from there (`rejoinKnownWorkspace`, `fetchWorkspaceAccess`, live sync over `/api/workspace/<id>` — never a WebSocket to `/api/collab/*`). Verified by grep: the current client has **no** other `/api/collab/*` call and **no** `new WebSocket(".../api/collab/...")`.

`src/worker.ts` nonetheless routes **five** shapes of request to `CollabRoom`:

| Route const | Path | Reached by a current client? |
| --- | --- | --- |
| `ROOM_MIGRATE_PATH` | `/api/collab/:id/migrate` | **yes** — the only one |
| `ROOM_ACCESS_PATH` | `/api/collab/:id/access` | no |
| `ROOM_VERSIONS_PATH` | `/api/collab/:id/versions*` | no |
| `ROOM_COMMENTS_PATH` | `/api/collab/:id/comments*` | no |
| `ROOM_PATH` | `/api/collab/:id` (WS upgrade) | no |

So four of the five routes, plus all the live-collaboration machinery behind the WS route, are **dead code for every current client** — reachable only by a stale cached bundle or a hand-crafted request, which is precisely the recurring audit surface.

## Goal

Make `CollabRoom` a **migration shim**: it can be *read* and *migrated*, nothing else. After this, `src/collab-room.ts` is ~150 lines (from 722) and has no session map, no WebSocket handling, no HTTP mutation endpoints — so there is nothing left for an audit to find a "parity gap" in.

## Design

### Server: `src/worker.ts`

Remove the four non-migrate routes. Keep only:

```ts
const roomMigrateMatch = url.pathname.match(ROOM_MIGRATE_PATH);
if (roomMigrateMatch) {
  const id = env.COLLAB_ROOM.idFromName(roomMigrateMatch[1]!);
  return env.COLLAB_ROOM.get(id).fetch(request);
}
```

Delete `ROOM_PATH`, `ROOM_ACCESS_PATH`, `ROOM_VERSIONS_PATH`, `ROOM_COMMENTS_PATH` and their four dispatch blocks. `/api/collab/:id`, `/api/collab/:id/access`, etc. then fall through to the worker's existing 404. (A migrated-away client hitting one of these already handled a `410` from `CollabRoom.fetch` since v1.62.7; a `404` from the router is an acceptable, slightly blunter "gone".)

### Server: `src/collab-room.ts`

**Keep** (everything `handleMigrateRequest` transitively needs):

- the class, constructor, `blockConcurrencyWhile` doc + comments + `migratedTo` load
- `this.doc`, `this.commentThreads` (read-only now), `this.migratedTo`
- `fetch()` — reduced to: `/migrate` → `handleMigrateRequest`; anything else → `410`
- `handleMigrateRequest` (minus the session-close loop — no sessions to close)
- `authorize`, `getSession`, `getAccess`
- `getSnapshots` (read-only; forwarded into the seed body)
- `CommentThread` / `CommentReply` / `Snapshot` interfaces (the seed body's shape; `WorkspaceRoom`'s `/internal/seed` handler consumes them)
- `uid`

**Delete:**

| Removed | Why |
| --- | --- |
| `handleSession`, `handleMessage`, `handleClose`, `broadcast`, `handleDocUpdate`, `handleAwarenessUpdate`, `reconcileSessionRoles` | the WS live-collab path — the MDE-21/23 surface |
| `this.sessions`, `SessionInfo`, `this.awareness`, `this.doc.on("update")` / `awareness.on("update")` wiring | session/awareness state |
| `schedulePersist`, `alarm`, `persistNow`, `this.persistScheduled` | persistence only mattered for live edits; the doc is now frozen at its last-persisted state |
| `handleVersionsListRequest`, `handleVersionContentRequest`, `handleVersionRestoreRequest`, `maybeSnapshot`, `forceSnapshot`, `imagesFromDoc`, `this.lastSnapshotAt` | `/versions` HTTP endpoints + snapshot creation (`getSnapshots` read stays) |
| `handleCommentsRequest`, `handleCommentReplyRequest`, `handleCommentResolveRequest`, `handleCommentDeleteRequest`, `createThread`, `addReply`, `resolveThread`, `deleteThread`, `refreshCommentAnchors`, `persistComments` | `/comments` HTTP endpoints + thread CRUD |
| `handleAccessRequest` (both GET and PUT), `normalizeInvited` (+ its export), `redactAccessForOutsider` import, `relocateAnchor` import, `MESSAGE_*` / `SYNC_*` / `PERSIST_DELAY_MS` / `SNAPSHOT_*` / `MAX_SNAPSHOTS` constants | `/access` endpoint (a legacy room's access is frozen at whatever it was) + now-unused helpers/constants |

`MESSAGE_SYNC` etc. and the `y-protocols/sync` / `y-protocols/awareness` / `lib0/encoding` / `lib0/decoding` imports go with the WS path. `yjs` stays (the doc). `Y.encodeStateAsUpdate(this.doc)` in `handleMigrateRequest` stays.

`handleMigrateRequest` keeps its `authorize()` gate (MDE-04) and its `existingTombstone` short-circuit (idempotent discovery). The `this.sessions` close loop added in v1.62.7 is deleted along with `this.sessions`.

### The one real snag: the e2e seed

`tests/e2e/collab/legacy-migration.spec.ts` (COLLAB-39) proves the **client** orchestration end to end: a `shared: true` localStorage doc, opened, migrates and then live-syncs on the resulting workspace. Its `tests/e2e/collab/support/legacy-room.ts` helper stands up a populated legacy `CollabRoom` by `PUT /access` (claim ownership) + a WebSocket (write content) — **both of which this design removes.**

Three ways to keep that coverage; the plan picks one after review:

- **(A) Delete `legacy-migration.spec.ts` + `legacy-room.ts`.** Migration is already covered at integration level: `collab-room.test.ts` (5 `handleMigrateRequest` cases — auth, tombstone, seed body, name forwarding, idempotency) and `workspace-room.test.ts` (`/internal/seed`). What's *lost* is the client-side `migrateLegacyDoc` orchestration (adopt workspace, clear `shared`, rejoin, name-heal) as an e2e — currently only e2e-covered. **Simplest; small coverage regression.**
- **(B) A narrow test-only seed hook on `handleMigrateRequest`.** When the POST body carries `{ __seed: { content, name } }` *and* the env has the same dev marker the dev-login patch uses, `CollabRoom` writes that into `this.doc` (+ claims `access.owner` from the caller) before migrating. One clearly-labelled, dev-gated branch instead of the whole WS + `/access` surface. `legacy-room.ts` shrinks to one `fetch`. **Preserves the e2e; adds a small dev-only code path** (must be covered by `check-no-dev-login.mjs`'s cousin — a `check-no-test-seed` scan, or fold into the existing script).
- **(C) Rebuild the scenario from the workspace side.** Seed a real `WorkspaceRoom` with the content via existing helpers, then in the browser point the `shared: true` doc's migration at it. Needs the `CollabRoom` to already carry a `migratedTo` tombstone → still needs a way to write `CollabRoom` storage. **No clean path; rejected.**

**Recommendation: (A).** The client orchestration is mostly mechanical store bookkeeping; the risky parts (the server migrate + seed) stay integration-covered, and `collab.ts`'s migrate flow can get a focused unit test in `tests/client/src/collab.test.ts` if the coverage gap feels real. (B) is the fallback if we want the full e2e kept.

### `history.ts` / `app.ts` comments

`client/src/history.ts:5` and `client/src/app.ts:518` have comments saying "CollabRoom (server-side) is the sole owner of a shared doc's history". Post-workspace that's already `WorkspaceRoom`; update the wording (no behaviour change — those paths already use `/api/workspace/*`).

## Files

| File | Change |
| --- | --- |
| `src/worker.ts` | delete 4 route consts + 4 dispatch blocks; keep `ROOM_MIGRATE_PATH` |
| `src/collab-room.ts` | 722 → ~150 lines per the delete table above |
| `tests/src/collab-room.test.ts` | delete the tests for every removed method (WS read-only enforcement, `reconcileSessionRoles`, version snapshots, comment threads, `handleAccessRequest`, `normalizeInvited`); keep `handleMigrateRequest` + the `getAccess` reads it needs + the v1.62.7 `migratedTo`/`410` tests |
| `tests/e2e/collab/legacy-migration.spec.ts`, `tests/e2e/collab/support/legacy-room.ts` | per the chosen seed option (A: delete both) |
| `tests/client/src/collab.test.ts` | (option A only) optional focused test for `migrateLegacyDoc` bookkeeping |
| `client/src/history.ts`, `client/src/app.ts` | comment wording |
| `CHANGELOG.md` | `## [1.62.x]` `### Changed` |
| `docs/TEST-COVERAGE.md` | fold/trim the CollabRoom rows (§10) — SEC-04/21/22/23 collapse to "migration + tombstone only"; drop rows for deleted endpoints; update counts |
| `docs/ARCHITECTURE.md` | the `CollabRoom` paragraph — "migration shim" not "legacy predecessor kept alive for old links" |
| `CLAUDE.md` | the `CollabRoom` mention in "Workspaces, documents, and two generations of Durable Object" |
| `ROADMAP.md` | Group D — mark the follow-up done |

## Non-goals / deferred

- **Deleting the `CollabRoom` class / DO binding / SQLite migration.** Legacy content is only reachable through it; removing the class strands every never-reopened legacy doc. A separate decision with a real sunset communication.
- **A server-side "migrate every legacy doc now" sweep.** There is no registry of legacy room names to iterate.
- **Removing `migrateLegacyDoc` from the client.** It's the only thing that still needs `/api/collab/*`; it stays until the class is retired.
- **Touching `WorkspaceRoom`.** Out of scope entirely.

## Test / rollout

`npm test`, `npm run typecheck`, `npm run build`, `npm run format:check`, then `npm run test:e2e:collab` (must stay green — `legacy-migration.spec.ts` either passes under the chosen seed option or is removed with it). PR → CI green → merge → auto-tag → release → Cloudflare auto-deploy.
