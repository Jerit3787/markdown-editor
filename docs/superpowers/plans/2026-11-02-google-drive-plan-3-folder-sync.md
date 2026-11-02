# Google Drive Folder Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link a workspace to an app-created Google Drive folder, then bidirectionally pull/push its markdown and images with per-file conflict resolution.

**Architecture:** A server-side Drive proxy (`src/google-drive.ts` + routes in `src/worker.ts`) exposes folder creation, folder listing, a recursive tree, file download, and a best-effort push. A new client module (`client/src/drive-sync.ts`) holds pure planners and fetch-based orchestration, mirroring `repo-sync.ts`; a small UI layer (`drive-sync-ui.ts`, two modals, menu entries, DocInfo rows) wires it to `window.MDE`. Drive is addressed by opaque file ids; `drivePath` is synthetic and only for display/dedupe.

**Tech Stack:** TypeScript, Cloudflare Workers, Svelte 5, Vitest, Playwright (screenshot only).

**Spec:** `docs/superpowers/specs/2026-09-08-google-drive-sync-design.md` — this plan implements only the folder-sync portion. Drive version history and `.mde/history` push/pull remain separate plans.

## Global Constraints

- `drive.file` scope only. Never request broader Drive scopes.
- All Drive traffic goes through the Worker; only the Google Picker may receive a client token.
- Never store the access token on the client. `getGoogleAccessToken` refreshes transparently and every handler threads its `setCookie` onto the response.
- Missing `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` → `503`; a dead grant → `401 "Reconnect Google Drive."`.
- Best-effort push: HTTP 200 with per-item results even when some items fail. Never roll back partial work.
- A file's `headRevisionId` is the conflict token; fall back to `modifiedTime` when absent.
- Cap every request: 5 MB per file, 20 files per import, 40 push items, depth 8, 40 folders per tree walk.
- User-facing → minor version bump. `package.json` + `package-lock.json`, `CHANGELOG.md`, and a `whats-new-entries.ts` entry with a real committed screenshot.
- Regenerate `tests/scripts/manual-testing/dev-login.patch` whenever `src/worker.ts` imports or route constants change.

## Review Focus

- A file renamed on either side must not create a duplicate or lose its content; path dedupe must never make two docs claim one Drive file.
- An image changed remotely while its markdown did not must surface as a conflict (dirty local) or a pull (clean local), not be silently ignored.
- A partial push (one item fails) must commit only the successful items and leave the failed doc's stored ids/revisions untouched for the next push.
- A folder that is not this workspace's (`mdeWorkspace` differs) must never trigger orphan-asset cleanup or adopt-by-path.
- UTF-8 and binary image content must round-trip exactly; no `atob`-only text decoding, no base64 string concatenation that mangles multi-byte characters.

---

### Task 1: Server folder, tree, file, and push endpoints

**Files:**
- Modify: `src/google-drive.ts`
- Modify: `src/worker.ts`
- Test: `tests/src/google-drive.test.ts`

**Interfaces:**
- Produces: `handleDriveCreateFolder`, `handleDriveListFolders`, `handleDriveTree`, `handleDriveFile`, `handleDrivePush`
- Produces: `GET /api/drive/folders` → `{ folders: { folderId; folderName; workspaceId; modifiedTime }[] }`
- Produces: `GET /api/drive/folder/:folderId/tree` → `{ folderId; folderName; workspaceId: string | null; entries: { fileId; path; mimeType; rev }[] }`
- Produces: `GET /api/drive/file/:fileId` → `{ contentBase64 }`
- Produces: `POST /api/drive/folder/:folderId/push` body `{ ensureSubfolders, creates, updates, deletes }` → `{ results: { path; op; ok; fileId?; rev?; error? }[], synced, failed }`

- [ ] **Step 1: Write failing tests** for folder creation (`appProperties`), folder listing, recursive tree flattening + `headRevisionId ?? modifiedTime`, file download/base64 + size cap, push multipart create/PATCH update/delete, and best-effort results (2 ok, 1 failure → HTTP 200). Also assert `401` with no cookie for every handler.
- [ ] **Step 2: Run** `npx vitest run tests/src/google-drive.test.ts` and confirm the new cases fail because the exports don't exist.
- [ ] **Step 3: Implement the handlers** in `src/google-drive.ts` with shared helpers: `driveFetch` (one retry on `403 rateLimitExceeded`/`userRateLimitExceeded`), `escapeDriveQuery`, `ensureFolderPath` (name+parent lookup then create, cached per request), `uploadMultipart`, and `revOf(meta)`.
- [ ] **Step 4: Add worker routes** in `src/worker.ts`, using path regexes that only match the exact shapes above.
- [ ] **Step 5: Run** `npx vitest run tests/src/google-drive.test.ts`, then `npm run typecheck`.
- [ ] **Step 6: Commit.**

### Task 2: Data model and store primitives

**Files:**
- Modify: `client/src/types.ts`
- Modify: `client/src/stores/workspaces.ts`
- Modify: `client/src/stores/docs.ts`
- Test: `tests/client/src/stores/drive-sync-store.test.ts` (new)

**Interfaces:**
- Produces on `Workspace`: `driveLink?: { folderId; folderName }`, `driveLastSyncedAt?: number`, `pendingDriveDeletions?: string[]`
- Produces on `Doc`: `drivePath?`, `driveFileId?`, `driveRev?`, `driveImageRevs?: Record<string, { fileId; rev }>`, `drivePushedHash?`
- Produces: `setWorkspaceDriveLink`, `clearWorkspaceDriveLink`, `setWorkspaceDriveLastSynced`, `queueDriveDeletion`, `clearPendingDriveDeletions`
- Produces: `upsertDocFromDrive`, `removeDocsByDriveFileIds`, `setDocDriveLinkById`, `clearDriveSyncMetadata`

- [ ] **Step 1: Write failing tests** for: setting/clearing a drive link; queueing and clearing a drive deletion; upsert creates by `drivePath` then updates by `driveFileId`; removing by file id; clearing stale folder metadata.
- [ ] **Step 2: Run** the new test and confirm it fails.
- [ ] **Step 3: Add the fields** and functions. `removeDocById` must queue `removedDoc.driveFileId` when the doc's workspace has a drive link. `duplicateDoc` must drop every `drive*` folder-sync field. `clearDriveSyncMetadata` clears `drivePath`/`driveFileId`/`driveRev`/`driveImageRevs`/`drivePushedHash` only — never `driveExportId`/`driveExportName`.
- [ ] **Step 4: Run** the test + `npm run typecheck`.
- [ ] **Step 5: Commit.**

### Task 3: Pure drive planners

**Files:**
- Create: `client/src/drive-sync.ts`
- Test: `tests/client/src/drive-sync.test.ts`

**Interfaces:**
- Produces: `DriveEntry`, `DriveTree`, `PullPlan`, `PushPlan`, `ImageOp`
- Produces: `planDrivePull(tree, docs, dirtyDocIds)`, `planDrivePush(docs, tree, sameWorkspace, pendingDriveDeletions)`, `hashPushPayload(content, assets)`, `assetFolderForDrivePath`, `drivePathForDoc`
- Reuses from `repo-sync.ts`: `slugifyDocName`, `dedupeRepoPath`, `assetFolderFor`, `rewriteImagesForPush`, `resolveImagesFromPull`, `historyPathFor`, `slugFromRepoPath`, `mimeFromAssetPath` (export this one).

- [ ] **Step 1: Write failing planner tests** covering: create/update/unchanged/conflict/deletion on pull; image-only remote change → update when clean, conflict when dirty; first-link match by path; push create path + dedupe; rename → create new + delete old; remote rev moved → conflict; `drivePushedHash` match → unchanged; image creates/updates/deletes; pending deletion not deleted when reclaimed.
- [ ] **Step 2: Run** the tests and confirm they fail.
- [ ] **Step 3: Implement the planners.** Content comparison uses `hashPushPayload` (SHA-256 of the rewritten markdown + sorted asset paths/data URLs) against `doc.drivePushedHash`. Push path selection reuses `slugifyDocName` and `dedupeRepoPath`; linked docs keep `drivePath` unless the doc was renamed. Only `sameWorkspace` enables adopt-by-path and `assets/*` orphan cleanup.
- [ ] **Step 4: Run** the tests + `npm run typecheck`.
- [ ] **Step 5: Commit.**

### Task 4: Orchestration

**Files:**
- Modify: `client/src/drive-sync.ts`
- Test: `tests/client/src/drive-sync.test.ts`

**Interfaces:**
- Produces: `linkWorkspaceToDrive(workspaceId, folderName)`, `openDriveFolderAsWorkspace(folder)`, `pullFromDrive(workspaceId)`, `pushToDrive(workspaceId)`, `planCreateWorkspaceFromDrive(folder, workspaces)`
- Produces result `{ plan, applyResolved, result?: PushResult }`; push failures are per-item, never thrown for a single bad file.

- [ ] **Step 1: Write failing orchestration tests** with a stubbed `fetch`: link posts the folder then the push body; pull decodes UTF-8, resolves `assets/...` images, stores ids/revisions/hash; push commits only successful results; a failed item leaves its doc's old link intact; a 401 surfaces a reconnect error; conflicts do not send a push.
- [ ] **Step 2: Run** the tests and confirm they fail.
- [ ] **Step 3: Implement orchestration.** `pullFromDrive` also removes docs whose `driveFileId` vanished from the tree and reports them in `plan.deletions`. `pushToDrive` fetches a fresh tree, plans, returns conflicts for the modal, otherwise posts and commits each result. Clear only sent ids from `pendingDriveDeletions`.
- [ ] **Step 4: Run** the full client test file + `npm run typecheck`.
- [ ] **Step 5: Commit.**

### Task 5: UI wiring

**Files:**
- Modify: `client/src/stores/driveSync.ts`
- Create: `client/src/drive-sync-ui.ts`
- Create: `client/src/components/OpenDriveModal.svelte`
- Create: `client/src/components/LinkDriveModal.svelte`
- Modify: `client/src/components/MenuBar.svelte`
- Modify: `client/src/components/DocInfoPanel.svelte`
- Modify: `client/src/components/RepoConflictModal.svelte` and `client/src/stores/repoSync.ts` (add optional `source: "repo" | "drive"`)
- Modify: `client/src/types.ts`, `client/src/main.ts`, `client/index.html`
- Test: `tests/client/src/components/OpenDriveModal.test.ts`, `LinkDriveModal.test.ts`, `DocInfoPanel.test.ts`, `MenuBar.test.ts`

**Interfaces:**
- Produces: `openDriveModalOpen`, `linkDriveModalOpen`, `driveSyncBusyLabel`
- Produces bridge: `openDriveFolderPicker()`, `openDriveLinkModal()`, `pullFromDriveAction()`, `pushToDriveAction()`, `unlinkDrive()`
- Reuses `driveConnected` / `driveConfigured` and `window.MDE.connectGoogleDrive`.

- [ ] **Step 1: Write failing component tests** for the open-folder list, the link-folder form, the Drive rows in Document Info, and the File ▸ Google Drive menu states (connect / open / link / linked).
- [ ] **Step 2: Run** them and confirm they fail.
- [ ] **Step 3: Implement** the stores, UI module, modals, menu submenu, DocInfo rows, mounts, and bridge typings. Disconnect must confirm first (`confirmAction`) and call the existing `disconnectGoogleDrive`.
- [ ] **Step 4: Run** the component tests + full `npm test` + `npm run typecheck`.
- [ ] **Step 5: Commit.**

### Task 6: Release metadata and screenshot

**Files:**
- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `client/src/analytics.ts`
- Create: `tests/scripts/manual-testing/capture-drive-folder-sync-screenshot.mjs`
- Create: `client/public/whats-new/drive-folder-sync.png`
- Modify: `tests/scripts/manual-testing/dev-login.patch` (regenerate after the worker import change)

- [ ] **Step 1: Bump to `1.67.0`** in both package files; add the CHANGELOG `### Added` section and one What's New entry.
- [ ] **Step 2: Capture a real screenshot** of the File ▸ Google Drive submenu with a linked folder, using the dev server and mocked status/GitHub endpoints.
- [ ] **Step 3: Regenerate the dev-login patch** and verify `git apply --check` passes against a clean `src/worker.ts`.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, `npm run format:check`.
- [ ] **Step 5: Commit, push, open PR, watch checks, merge, confirm tag/release.**
