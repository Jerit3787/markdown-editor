# Google Drive — Plan 2: Save / update markdown to Drive

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Save to Google Drive" / "Update in Google Drive" — per-file export of the active document to a standalone Drive `.md` file, with an optional destination folder.

**Architecture:** A server endpoint (`POST /api/drive/export`) creates a multipart upload or PATCHes media for an existing `fileId`. The client stores `driveExportId`/`driveExportName` on the doc; a small modal collects the filename/folder on first save only. Mirrors the Gist publish flow.

**Spec:** `docs/superpowers/specs/2026-09-08-google-drive-sync-design.md` — "Save markdown to Drive (per-file export)" + error-handling table. Plan 1 (connect + import) shipped in v1.65.0.

## Global Constraints

- `drive.file` scope only; no new Google scopes.
- The exported file is markdown text from the editor buffer (image refs stay local/unresolved; noted in the success toast only if the doc has unresolved refs).
- Overwrite without conflict detection, matching "Update Gist".
- 404 on update → clear `driveExportId`, retry as a create.
- Not connected → open the OAuth popup and resume the save afterwards.
- Tests first; no version bump until the release task.

## Review Focus

- UTF-8 round trip (emoji/accents) through base64 content.
- Drive file deleted outside the app → update falls back to a create.
- Filename/folder selection only on the first save.
- Cross-origin/auth state: 401 from the export endpoint triggers reconnect + resume.
- No change to the import flow.

---

### Task 1: Server export endpoint

**Files:** `src/google-drive.ts`, `src/worker.ts`, `tests/src/google-drive.test.ts`.

**Interfaces:** `handleDriveExport(request, env): Promise<Response>`; body `{ fileId?, name?, parentFolderId?, contentBase64 }`; returns `{ fileId, name, webViewLink }` or `404 { error: "not-found" }`.

- [ ] Test: no `fileId` → multipart create with metadata name/mimeType/parents and the decoded bytes; returns mapped ids.
- [ ] Test: `fileId` present → `PATCH …/files/{id}?uploadType=media`; 404 → 404 `{error:"not-found"}`.
- [ ] Test: 401 when disconnected / 503 when unconfigured / 413 over 5 MB.
- [ ] Implement + route `POST /api/drive/export`.

### Task 2: Doc model + client save flow

**Files:** `client/src/types.ts`, `client/src/stores/docs.ts`, `client/src/stores/driveSync.ts`, `client/src/stores/driveExport.ts` (new), `client/src/drive-files.ts`, `tests/client/src/drive-files.test.ts`.

- [ ] Test: first save opens the chooser, POSTs a create, stores `driveExportId`/`driveExportName`, toasts.
- [ ] Test: second save PATCHes with no dialog; a 404 clears the id and retries as a create.
- [ ] Test: not connected → connect popup, then resumes the save after `mde-google-auth`.
- [ ] Implement `chooseDriveExport`, `saveToDrive`, `pickDriveFolder`, pending-action resume, `setDocDriveExport`/`clearDocDriveExport`.

### Task 3: UI

**Files:** `client/src/components/SaveToDriveDialog.svelte` (new), `client/src/main.ts`, `client/index.html`, `client/src/components/MenuBar.svelte`, `client/src/components/DocInfoPanel.svelte`, `client/src/types.ts`.

- [ ] Add the modal mount + Escape/focus behaviour.
- [ ] Publish submenu: Save/Update Google Drive + View in Drive, visible when Drive is configured/connected (independent of GitHub sign-in); same owner-only `publishHidden` gate as Gist.
- [ ] Document Info row for `driveExportId`.
- [ ] Component tests for the dialog (filename, folder choice, cancel) and the menu labels.

### Task 4: Release

- [ ] Bump to **1.66.0**, CHANGELOG `### Added`, What's New entry + real screenshot of the Publish menu.
- [ ] Full suite, typecheck, format; PR → merge → tag.
