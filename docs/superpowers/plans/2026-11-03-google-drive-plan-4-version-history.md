# Google Drive Version History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a folder-synced document's Google Drive revisions in the Version History panel, with preview, diff, and restore.

**Architecture:** Two Worker endpoints proxy Drive's revisions list and revision media. `client/src/drive-sync.ts` exposes `pullDriveRevisions` / `getDriveRevisionContent` / `fetchDriveRevisionImages`. `VersionHistory.svelte` generalizes its `CommitEntry` into a `RemoteEntry` with `source: "github" | "drive"` and merges both sources (when both links exist) into the existing timeline. Restore reuses the existing local/shared restore path.

**Tech Stack:** TypeScript, Cloudflare Workers, Svelte 5, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-google-drive-sync-design.md`, section “Version History integration”.

## Global Constraints

- Drive API v3, `drive.file` scope only; every request goes through `getGoogleAccessToken` and threads its `setCookie`.
- A dead grant → `401 "Reconnect Google Drive."`; missing file → `404`.
- Cap revision media at 5 MB.
- `LocalEntry` and `SessionEntry` stay untouched; GitHub and Drive rows render through the same `RemoteEntry` shape.
- Drive revisions are shown only when the doc has `driveFileId` and its workspace has `driveLink`.
- User-facing feature → minor version bump, CHANGELOG, What's New entry with a real screenshot.
- Regenerate `tests/scripts/manual-testing/dev-login.patch` after the worker route/import change.

## Review Focus

- A Drive-linked doc with no revisions must still show local history (no empty panel, no thrown error).
- A doc linked to both GitHub and Drive must show both timelines, not one replacing the other.
- Selecting a Drive revision must not race a slower earlier selection (existing stale-response guard).
- Restoring a Drive revision must go through the existing local/shared restore path, including images.
- A Drive 401/404 must degrade to local history, not break the whole panel.

---

### Task 1: Server revision endpoints

**Files:**
- Modify: `src/google-drive.ts`, `src/worker.ts`
- Test: `tests/src/google-drive.test.ts`

**Interfaces:**
- `GET /api/drive/file/:fileId/revisions` → `{ revisions: { revId; modifiedTime; author }[] }` (empty for ≤1 revision)
- `GET /api/drive/file/:fileId/revisions/:revId` → `{ contentBase64 }`

- [ ] Write failing tests for pagination/mapping, empty-for-one-revision, media download + cap, 401/404.
- [ ] Implement `handleDriveRevisions` and `handleDriveRevisionContent`, paginating `files.get` revisions.
- [ ] Add worker routes before the plain file route.
- [ ] Run the server tests + typecheck.
- [ ] Commit.

### Task 2: Client API helpers

**Files:**
- Modify: `client/src/drive-sync.ts`
- Test: `tests/client/src/drive-sync-orchestration.test.ts`

**Interfaces:**
- `pullDriveRevisions(fileId): Promise<{ revId; modifiedTime; author }[]>`
- `getDriveRevisionContent(fileId, revId): Promise<string>`
- `fetchDriveRevisionImages(doc, content): Promise<Record<string, string>>`

- [ ] Write failing tests for mapping, base64 decoding, 401 reconnect, and current-asset image resolution.
- [ ] Implement the helpers using `jsonFetch`, `decodeBase64Text`, `downloadBase64`, and `mimeFromAssetPath`.
- [ ] Run the tests.
- [ ] Commit.

### Task 3: Version History UI

**Files:**
- Modify: `client/src/components/VersionHistory.svelte`
- Test: `tests/client/src/components/VersionHistoryDriveRevisions.test.ts`

**Interfaces:**
- `RemoteEntry { kind:"remote"; source:"github"|"drive"; id; timestamp; message; author }`
- `HistoryEntry = LocalEntry | RemoteEntry | SessionEntry`

- [ ] Write failing component tests: Drive revisions render, content/diff loads, restore dispatches content, a dual-linked doc shows both sources, a 401 still shows local history.
- [ ] Rename `CommitEntry` → `RemoteEntry` and `loadCommitEntries` → `loadRemoteEntries(doc, source)`; keep the GitHub behavior.
- [ ] Add the Drive branch in `loadVersions`, `loadEntryContent`, and the row icon/label.
- [ ] Run the component tests.
- [ ] Commit.

### Task 4: Release metadata and screenshot

**Files:**
- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `docs/TEST-COVERAGE.md`
- Create: `tests/scripts/manual-testing/capture-drive-history-screenshot.mjs`
- Create: `client/public/whats-new/drive-history.png`
- Modify: `tests/scripts/manual-testing/dev-login.patch`

- [ ] Bump to `1.68.0`, add CHANGELOG + What's New entry.
- [ ] Capture the Version History panel with real Drive revision rows.
- [ ] Add DRIVE-15/16 coverage rows and update totals.
- [ ] Regenerate the dev-login patch; verify `git apply --check`.
- [ ] Run full tests/typecheck/format/build.
- [ ] Commit, PR, watch checks, merge, verify tag/release.
