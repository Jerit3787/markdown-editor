# Google Drive Folder-Backed Local History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Store each synced document's local version snapshots and notes in `.mde/history/<path>.json` inside the Drive folder, pushing and pulling them alongside markdown.

**Architecture:** Reuse the existing repo-sync history conventions (`historyPathFor`, `mergeSnapshotsFromRepo`, `mergeDocNotes`). The Drive push planner adds `historyChanges` and `historyDeletes`; the existing Drive push endpoint already accepts arbitrary JSON files. Pull reads every `.mde/history/*.json` from the Drive tree and merges by id. Deleted docs queue their history path so the file is removed on the next push.

**Tech Stack:** TypeScript, Svelte stores, IndexedDB-backed history, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-google-drive-sync-design.md`, section “Local history stored in the folder”.

## Global Constraints

- History is local-only data: snapshots + personal notes. Never render it as document content.
- Merge by snapshot id; never overwrite a newer local snapshot with an older remote one.
- Best-effort per file; one bad history JSON must not fail the whole pull/push.
- Renames move the history file; local deletes remove it; remote deletes do not echo into the other provider.
- User-facing feature → minor bump, CHANGELOG, What's New entry with a real screenshot.

## Review Focus

- A doc with no history must not create an empty `.mde/history` file.
- A pull with a corrupt history JSON must continue and report a failure.
- A local delete must remove the history file; a remote delete must not queue a history delete back.
- A rename must not leave the old history file behind or lose snapshots.
- History pushes must not block markdown pushes (or vice versa) when one fails.

---

### Task 1: History paths + pending-deletion state

**Files:** `client/src/history-paths.ts` (new), `client/src/repo-sync.ts`, `client/src/stores/docs.ts`, `client/src/stores/workspaces.ts`, `client/src/types.ts`
**Test:** `tests/client/src/stores/drive-sync-store.test.ts`

- [ ] Move `historyPathFor` / `historyOwnerDocPath` into `history-paths.ts`; re-export from `repo-sync.ts`.
- [ ] Add `Workspace.pendingDriveHistoryDeletions` + queue/clear functions.
- [ ] Queue the history path in `removeDocById` for a local Drive-linked delete.
- [ ] Test queue/clear and delete propagation.

### Task 2: Planner history changes

**Files:** `client/src/drive-sync.ts`
**Test:** `tests/client/src/drive-sync.test.ts`

- [ ] Add `historyChanges` / `historyDeletes` to `PushPlan`; accept `localHistory`.
- [ ] Emit a `.mde/history/<path>.json` create/update whenever local snapshots/notes exist (even if markdown is unchanged).
- [ ] Rename: delete the old history file id; pending history deletes resolve by path.
- [ ] Test create/update, rename, pending deletion, and no-op without history.

### Task 3: Push/pull orchestration

**Files:** `client/src/drive-sync.ts`
**Test:** `tests/client/src/drive-sync-orchestration.test.ts`

- [ ] Fetch each doc's snapshots (`getHistory`) and notes before planning.
- [ ] Send history changes in their own capped push batch; failure marks the push partial.
- [ ] Pull every `.mde/history/*.json` for a live doc, merge snapshots via `mergeSnapshotsFromRepo` and notes via `mergeDocNotes`; corrupt/404 files become pull failures.
- [ ] Clear pending history deletions only after a fully successful push; queue skipped/failed deletes.
- [ ] Test push body JSON, pull merge, corrupt file continuation, and pending-delete retry.

### Task 4: Release

**Files:** `package.json`, `package-lock.json`, `CHANGELOG.md`, `client/src/whats-new-entries.ts`, `docs/TEST-COVERAGE.md`, screenshot script/asset

- [ ] Bump to `1.69.0`, add CHANGELOG + What's New entry.
- [ ] Capture a Version History screenshot showing merged local/Drive history.
- [ ] Add DRIVE-17/18 coverage rows.
- [ ] Full tests/typecheck/format/build; PR → checks → merge → verify release.
