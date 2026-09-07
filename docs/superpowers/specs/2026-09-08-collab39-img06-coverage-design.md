# COLLAB-39 + IMG-06 e2e coverage — Design Spec

## Goal

Close the two `e2e-collab` catalogue rows the Bucket B plan
(`docs/superpowers/plans/2026-09-08-test-coverage-bucket-b-finish.md`)
explicitly deferred:

- **COLLAB-39** — a document still carrying the legacy per-document
  `shared: true` flag, on open, transparently migrates its `CollabRoom`
  into a fresh `WorkspaceRoom` **before** live sync attaches, end-to-end.
  Today only the server-side pieces are integration-covered
  (`collab-room.test.ts`'s `handleMigrateRequest` tombstone,
  `workspace-room.test.ts`'s `/internal/seed`).
- **IMG-06** — while `![Encoding photo.png…]()` sits in the editor during
  the `FileReader` read, `imageMarkerField` (a CM6 `DecorationSet` that
  `.map(tr.changes)`s through every transaction) remaps the placeholder
  when a **collaborator's** insertion lands above it, so the real
  `![alt](key)` swaps in at the shifted position, not the stale one.
  IMG-07 covers only the single-editor "switch away mid-read → drop it"
  half (`if (!range) return`).

After this change the catalogue has **zero `gap` rows** — IMG-06 and
COLLAB-39 are the only two — leaving GIST-05 (a `partial`) as the lone
permanent deferral. (The subsystem-totals table in `TEST-COVERAGE.md` has
minor pre-existing drift — it claims 3 gaps / 3 partials but only 2 of
each are in the row tables; the implementation recounts the whole table
from the actual rows rather than blind-decrementing.)

## Non-goals / deferred scope

- **GIST-05 stays permanently deferred.** A real isomorphic-git push over
  `gist.github.com/<id>.git`'s smart-HTTP creates a gist every run and
  needs a full git-server test double; everything up to the push is
  covered by `gist-images.test.ts`. Unchanged by this spec.
- **No production-code change.** Both tests are pure test additions. The
  only `src/` touch remains the existing uncommitted dev-login patch,
  which the `collab` project already depends on.
- **COLLAB-39 does not test the modern `/w/…` join path** (covered by
  `live-sync.spec.ts`, `shared-workspace-preview.spec.ts`) nor the
  name-healing branch of `migrateLegacyDoc` for a room that predates
  name-syncing (integration-covered; the seeded room here carries a
  `meta.name`, so it takes the normal path). It tests the migration
  trigger, the content carry-over, the local adopt, and that live sync
  works on the migrated room.
- **COLLAB-39 does not re-test the idempotency tombstone** (a second
  collaborator opening the same old link) — `collab-room.test.ts`
  covers `handleMigrateRequest`'s `migratedTo` short-circuit directly.
- **IMG-06 does not test the error branch** (`readImageAsDataURL`
  rejecting) or the oversize/non-image branches — those are IMG-04/05 and
  single-editor. It tests one thing: a remote insertion above a live
  placeholder shifts it, and the swap-in lands correctly.
- **No new npm dependencies.** `ws`, `yjs`, `y-protocols`, `lib0` are
  already dependencies (used by `tests/scripts/manual-testing/simulate-collaborator-ws.mjs`).

## Current mechanics this builds on

### Legacy migration (COLLAB-39)

- `client/src/collab.ts` `handleDocChanged(doc)`: when the doc's workspace
  is **not** `shared`/`remoteId` but `doc.shared === true` (the legacy
  per-document flag), it calls `migrateLegacyDoc(doc.id)`.
- `migrateLegacyDoc(docId)`:
  1. `POST /api/collab/<docId>/migrate` (no auth — `handleMigrateRequest`
     only checks the `migratedTo` tombstone).
  2. `CollabRoom.handleMigrateRequest` mints a `workspaceId`, reads
     `getAccess()` / `getSnapshots()` / `commentThreads` / the Y.Doc's
     `meta.name`, and `POST`s `{docId, docName, update, access, snapshots,
     comments}` to the new `WorkspaceRoom`'s `/internal/seed`. Writes the
     `migratedTo` tombstone.
  3. Client adopts the workspace locally via `adoptSharedWorkspace(workspaceId,
     name)` → a new `Workspace { id: uid(), shared: true, remoteId: workspaceId }`
     prepended to `workspacesStore`, made active, persisted.
  4. The doc record is rewritten `{ ...d, workspaceId: <new local id>,
     shared: undefined }` and persisted.
  5. `await rejoinKnownWorkspace(workspaceId, docId)` opens the real
     `WorkspaceRoom` WebSocket and binds the editor.
- `CollabRoom` WebSocket wire format (`src/collab-room.ts` `handleMessage`):
  `[varUint MESSAGE_SYNC=0][ y-protocols/sync sub-message ]` — **no**
  `docId` string frame-prefix (that is `WorkspaceRoom`-only). `SYNC_STEP1
  = 0`, `SYNC_STEP2 = 1`, update `= 2`. Writes are dropped unless the
  session role is `editor`.
- `CollabRoom.authorize()`: 403 "hasn't been shared" until an access
  record with an `owner` exists; ownership is claimed by the first
  `PUT /api/collab/<docId>/access` from a signed-in session.
- Route regexes in `src/worker.ts`: `ROOM_PATH =
  /^\/api\/collab\/([A-Za-z0-9_-]{1,128})$/` (WebSocket),
  `ROOM_ACCESS_PATH = …/access$/`, `ROOM_MIGRATE_PATH = …/migrate$/`.

### Image marker tracking (IMG-06)

- `client/src/components/Editor.svelte`:
  - `imageMarkerField` — `StateField<DecorationSet>`, listed in
    `buildExtensions()` as a **base** extension (line ~515), so it is
    always active, including in collab mode (`enterCollabMode` only
    reconfigures `editingModeCompartment`). Its `update()` does
    `value.map(tr.changes)` first, so every transaction — local typing
    **and** a remote Yjs delta arriving as a CM transaction via
    y-codemirror.next — remaps live marker ranges.
  - `insertImageWithUpload(file, pos?, onError?)`: inserts
    `![Encoding ${file.name}…]()` at `pos ?? selection.main.head`, adds a
    marker over it via `addImageMarker(from, to)`, then
    `readImageAsDataURL(file).then(...)`. On resolve: `findImageMarker(id)`
    → if gone, drop; else `setDocImage` + `onImageAdded` + dispatch
    `{ changes: { from: range.from, to: range.to, insert:
    ` + "`![${altTextFromFilename(file.name)}](${key})`" + ` } }`.
  - `readImageAsDataURL` sets `reader.onload` **before** calling
    `reader.readAsDataURL(file)`.
  - `altTextFromFilename("raced.png") === "raced"`; `imageKey("raced.png",
    {})` returns `"raced.png"` for a first insert → swap-in text is
    `![raced](raced.png)`.
- `window.MDE.insertImageWithUpload` is on the bridge
  (`client/src/types.ts:254`).

### Test harness

- `playwright.config.ts` `collab` project: `testDir: ./tests/e2e/collab`,
  `baseURL: http://localhost:8787`, `fullyParallel: false`,
  `expect.timeout: 15000`. `wrangler dev` + the dev-login patch are set up
  by `tests/scripts/e2e-collab.sh`.
- `tests/e2e/collab/support/`:
  - `dev-login.ts` → `signInAsDevUser(page, username)` mints a session via
    `GET /api/dev/login?username=<u>` (route stub + a `window.MDE.githubUsername`
    stub, per `feedback_local_testing_github_auth`).
  - `collab.ts` → `ownerWithDoc`, `shareAnyoneLink`, `joinSharedWorkspace`,
    `editorText`, `expectEditorContains`, `setActiveDocContent`, `BASE`.
  - `share.ts` → `readSharedState(page)` polls localStorage until
    `shared`/`remoteId` are consistent.
- `tests/scripts/manual-testing/simulate-collaborator-ws.mjs` — reference
  for a Node-side raw-WS Yjs client (targets `WorkspaceRoom`; its frames
  carry a `docId` prefix this spec's `CollabRoom` helper omits).

## Design

### New file: `tests/e2e/collab/support/legacy-room.ts`

A Node-side helper that stands up a legacy `CollabRoom` with known content,
so a browser can then be pointed at a doc that migrates it.

```
seedLegacyCollabRoom(opts: {
  docId: string;
  ownerCookie: string;   // raw SESSION_COOKIE value, from mintDevSession()
  content: string;
  name?: string;         // written into the Y.Doc meta map; default "Legacy Doc"
}): Promise<void>
```

Steps inside:

1. `PUT http://localhost:8787/api/collab/<docId>/access` with header
   `Cookie: mde_gh_session=<ownerCookie>` and body
   `{ generalAccess: "anyone", requireAccount: false, role: "editor",
   invited: [] }`. Asserts `res.ok` (claims ownership → `authorize()` will
   now admit the WS).
2. Open `new WebSocket("ws://localhost:8787/api/collab/<docId>", { headers:
   { Cookie: "mde_gh_session=<ownerCookie>" } })`, `binaryType =
   "arraybuffer"`.
3. On `open`: build a local `Y.Doc`, `doc.getText("content").insert(0,
   content)` and `doc.getMap("meta").set("name", name)` in one
   `doc.transact`. Send `[MESSAGE_SYNC][writeUpdate(Y.encodeStateAsUpdate(doc))]`
   (a single frame, no docId prefix).
4. On `message`: run `syncProtocol.readSyncMessage` against the local doc
   for any reply (SYNC_STEP1 from the server → we answer STEP2; that plus
   our update is what persists server-side).
5. Resolve once the server has acked — implemented as: after sending the
   update, send `[MESSAGE_SYNC][writeSyncStep1(doc)]` and resolve when the
   matching STEP2 arrives **and** its applied state's `content` text
   equals `content` (guarantees the server persisted our write before we
   close). Hard-timeout 10 s → reject.
6. `ws.close()`.

Also exported from this file (small, shared with the spec file):

```
mintDevSession(username: string): Promise<string>
```

`fetch("http://localhost:8787/api/dev/login?username=" + username)`,
read the `Set-Cookie` header, return the `mde_gh_session` value. (The
browser-side `signInAsDevUser` already does the cookie-in-browser half;
this is the Node-side equivalent for the raw-WS/PUT calls.)

Constants (`MESSAGE_SYNC = 0`, `MESSAGE_AWARENESS = 1`) are declared
locally, matching `simulate-collaborator-ws.mjs`.

### New file: `tests/e2e/collab/legacy-migration.spec.ts`

One test: **`COLLAB-39: a legacy per-document shared doc migrates to a
WorkspaceRoom transparently on open`**.

1. `const docId = "legacy-" + Date.now().toString(36)` (fresh room per
   run — `CollabRoom` storage is addressed by name and never torn down).
2. `const ownerCookie = await mintDevSession("legacy-owner-e2e")`.
3. `await seedLegacyCollabRoom({ docId, ownerCookie, content: "LEGACY
   SHARED CONTENT", name: "Legacy Doc" })`.
4. `const page = await browser.newPage()` (fresh context).
   `await signInAsDevUser(page, "legacy-owner-e2e")`.
5. Prime localStorage **before** first load, via
   `page.addInitScript(...)` keyed on origin — set:
   - `mde:workspaces` → `[{ id: "legacy-ws-local", name: "Old Workspace",
     createdAt: <n>, updatedAt: <n> }]` (**no** `shared`, **no**
     `remoteId`).
   - `mde:docs` → `[{ id: docId, name: "Legacy Doc", workspaceId:
     "legacy-ws-local", content: "", shared: true, createdAt: <n>,
     updatedAt: <n> }]`.
   - `mde:active` → `docId`.
   - `mde:activeWorkspace` → `"legacy-ws-local"`.
   (Key names per `client/src/stores/docs.ts` — `mde:docs` / `mde:active`
   — and `workspaces.ts` — `mde:workspaces` / `mde:activeWorkspace`. The
   record *shapes* are the Task 1 Step 1 spike: confirm the store loaders
   accept a pre-seeded doc with `shared: true` without normalising it
   away.)
6. `await page.goto(BASE)`; wait for `window.MDE.getEditor`.
   `await dismissWhatsNew(page)`.
7. **Assert migration landed:**
   - `await expect.poll(() => editorText(page)).toBe("LEGACY SHARED
     CONTENT")` — content came from the migrated `WorkspaceRoom`, not the
     empty local record.
   - `await expect.poll(() => page.evaluate(() => { const d =
     JSON.parse(localStorage.getItem("mde:docs"))[0]; return d.shared ??
     null; })).toBeNull()` — legacy flag cleared.
   - `const remoteId = await page.evaluate(...)` reads the doc's new
     `workspaceId`, looks it up in `mde:workspaces`, returns its
     `remoteId`; assert it is a non-empty string.
8. **Assert live sync works on the migrated room:** a second collaborator.
   - `const url = ` + "`${BASE}/w/${remoteId}/${docId}/edit`" + `.`
   - `const viewer = await (await browser.newContext()).newPage()`;
     `signInAsDevUser(viewer, "legacy-viewer-e2e")`;
     `joinSharedWorkspace(viewer, url)`.
   - `await expectEditorContains(viewer, "LEGACY SHARED CONTENT")`.
   - Owner appends `" + edit"` at the end of its doc; `await
     expectEditorContains(viewer, "LEGACY SHARED CONTENT + edit")`.
9. Close contexts.

If the pre-seeded `mde:*` shape proves not to round-trip (store
constructors normalise on load), fall back to driving the same state
through the app: create the workspace + doc via the store modules in a
`page.evaluate` dynamic import, then patch the one doc record to `shared:
true` and reload. Decided in Task 1 Step 1 before writing the assertions.

### New file: `tests/e2e/collab/image-marker-concurrent.spec.ts`

One test: **`IMG-06: a placeholder tracks its position when a
collaborator inserts above it during the FileReader read`**.

1. `const a = ...`, `const b = ...` (two contexts).
2. **Before A loads any page**, `await a.addInitScript(() => { const R =
   window.FileReader; class Slow extends R { readAsDataURL(blob) { const
   orig = this.onload; this.onload = (e) => setTimeout(() => orig &&
   orig.call(this, e), 1500); super.readAsDataURL(blob); } }
   window.FileReader = Slow; })`. Test-only; A's page only.
3. `await ownerWithDoc(a, "imgmark-a-e2e", "LINE1\nLINE2\nLINE3")`.
   `const url = await shareAnyoneLink(a, "Editor")`.
   `await joinSharedWorkspace(b, url)`.
   `await expectEditorContains(b, "LINE3")`.
4. A starts the upload at end-of-doc:
   ```
   await a.evaluate(async (b64) => {
     const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
     const cm = window.MDE.getEditor();
     window.MDE.insertImageWithUpload(
       new File([bytes], "raced.png", { type: "image/png" }),
       cm.state.doc.length,
     );
   }, PIXEL_PNG_BASE64);
   ```
   `PIXEL_PNG_BASE64` imported from the existing
   `tests/e2e/local/images.spec.ts` fixture module, or a tiny local copy
   (decide in implementation — prefer a shared `tests/e2e/support/fixtures.ts`
   only if it already exists; otherwise inline the 1×1 PNG constant with a
   comment, same as `images.spec.ts` does).
5. `await expect.poll(() => editorText(a)).toContain("![Encoding
   raced.png…]()")` — placeholder is in.
6. **During the 1.5 s stubbed read**, B inserts a prefix at offset 0:
   ```
   await b.evaluate(() => {
     const cm = window.MDE.getEditor();
     cm.dispatch({ changes: { from: 0, insert: "PREFIX " } });
   });
   await expectEditorContains(a, "PREFIX LINE1");   // remote insert reached A
   ```
7. `await expect.poll(() => editorText(a), { timeout: 15000 })
   .toBe("PREFIX LINE1\nLINE2\nLINE3![raced](raced.png)")` — the swap-in
   landed at the **shifted** tail (contiguous with `LINE3`), i.e. the
   marker remapped past B's 7-char insert. A stale offset would have put
   it 7 chars early, mid-`LINE3`.
8. `expect(await editorText(a)).not.toContain("Encoding")`.
9. `await expect.poll(() => editorText(b))
   .toBe("PREFIX LINE1\nLINE2\nLINE3![raced](raced.png)")` — B converges.
10. Close contexts.

Edge the assertion is written around: end-of-doc insert means the
placeholder has nothing after it, so a failed remap is unambiguous —
the image link ends up before `\nLINE2` instead of after `LINE3`.

### `docs/TEST-COVERAGE.md`

- COLLAB-39 row (line ~381): `gap` → `covered`, evidence
  `tests/e2e/collab/legacy-migration.spec.ts`, note trimmed to "seeded
  legacy `CollabRoom` (raw-WS) + a fresh visitor opening a
  `shared:true` doc; asserts content carry-over, local adopt, and live
  sync on the migrated room".
- IMG-06 row (line ~223): `gap` → `covered`, evidence
  `tests/e2e/collab/image-marker-concurrent.spec.ts`, note "deterministic
  1.5 s `FileReader` stub on editor A; a collaborator's prefix insert
  shifts the live placeholder and the swap-in follows it".
- `## Deferred` section: remove the IMG-06 row (line ~223 of that
  section); leave VER-08 and GIST-05.
- **Recount the whole subsystem-totals table from the row tables** (it
  currently shows `308 / 3 / 3` but the rows hold 2 `gap` + 2 `partial`,
  so there is drift to fix, not just a decrement). After: `§5 Images`
  gap → 0; `§10 Workspace collab` gap → 0; `Gap` column total → **0**;
  `Covered` total = 314 − (partials). Fix the `~93% … ~5% are gaps` prose
  and the intro sentence to match the recounted numbers ("no gaps
  remain; GIST-05 is the one partial").

### `CHANGELOG.md`

Fold into the **already-drafted** `## [1.48.4]` section (added by the
flakiness fix, same branch) — its `### Changed` bullet gains:

> - **Test coverage — the two long-deferred `e2e-collab` gaps are closed.**
>   COLLAB-39 drives the legacy single-document → workspace migration
>   end-to-end (a raw-WebSocket-seeded `CollabRoom`, then a fresh visitor
>   opening a doc still carrying the old per-document `shared` flag —
>   asserting the content carries over, the workspace is adopted locally,
>   and live sync works on the migrated room). IMG-06 covers an image
>   placeholder keeping its place when a collaborator types above it
>   mid-encode. No catalogued gaps remain; GIST-05 (a real gist push,
>   which would create a gist per run) stays a documented partial.

No `whats-new-entries.ts` entry (test-only). No version-number change
beyond the flakiness fix's existing `1.48.4` bump (applied at PR time).

## Risks

- **`CollabRoom` storage never resets.** Every run leaves a room behind.
  Mitigated by a per-run `docId` (`legacy-<timestamp>`), same as the
  `e2e-github` fixtures approach — Durable Object storage in `wrangler
  dev` is local `.wrangler/state` and disposable.
- **Pre-seeded `localStorage` may be normalised on load.** Handled by the
  Task 1 Step 1 spike + the documented fallback (drive the stores, then
  patch the one flag).
- **The `FileReader` subclass stub** assumes `onload` is assigned before
  `readAsDataURL` — true for `readImageAsDataURL` (verified). If that ever
  changes the test fails loudly (placeholder never resolves → assertion
  timeout), not silently.
- **1.5 s stub delay vs. the 15 s `expect` timeout** leaves wide margin
  even on a slow CI runner; the remote-insert step (6) asserts B's edit
  reached A *before* waiting on the swap-in, so a too-slow read can't make
  the test pass vacuously.
