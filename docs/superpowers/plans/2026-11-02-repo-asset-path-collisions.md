# Repo asset/history path collisions — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every repo-linked doc its own asset folder and history file, even when two docs share a basename.

**Architecture:** Derive both paths from the doc's full repo path (minus `.md`) instead of its basename; keep root-level paths byte-identical to today; resolve/fetch the legacy paths as fallbacks so existing repos keep working until their next push; make all sweep logic map asset/history paths back to their owning markdown path.

**Tech Stack:** TypeScript client modules, the existing fake repo backend (isomorphic-git-free HTTP fake) for integration tests, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-repo-asset-path-collisions-design.md`

## Global Constraints

- Root-level paths stay unchanged: `notes.md` → `assets/notes/…`, `.mde/history/notes.json`.
- Never delete repo content unless `sameWorkspace` is true or the path was vacated by this same push.
- Keep unknown markdown image refs untouched.
- All production changes are test-first.

## Review Focus

- Two same-basename docs pushing the same ref key (`pic.png`) must produce two blobs with different bytes.
- A nested doc that migrates must not lose the legacy folder's files before the new ones are pushed.
- A live root doc with the same basename must keep its legacy folder even after a nested doc migrates.
- A pull of an old repo (refs still under the legacy prefix) must still resolve images.
- A history file present only at the legacy path must still be merged.

---

### Task 1: Path-derived asset folders + legacy pull resolution

**Files:**
- Modify: `client/src/repo-sync.ts`
- Test: `tests/client/src/repo-sync.test.ts`

**Interfaces:**
- Produces: `assetFolderFor(repoPath: string): string` — repo path minus a trailing `.md` (case-insensitive); exported.
- Produces: `resolveImagesFromPull(content: string, assetFolder: string, blobs: Record<string, string>, legacyFolder?: string)` — resolves refs under both prefixes.
- `rewriteImagesForPush` keeps its signature; callers pass `assetFolderFor(repoPath)`.

- [ ] **Step 1: Write failing tests**
  - `assetFolderFor("notes.md") === "notes"`, `assetFolderFor("docs/notes.md") === "docs/notes"`.
  - `rewriteImagesForPush` with folder `docs/notes` turns `![x](pic.png)` into `![x](assets/docs/notes/pic.png)`.
  - `resolveImagesFromPull("![x](assets/docs/notes/pic.png)", "docs/notes", {...})` resolves to `pic.png`.
  - The same function with a legacy ref `assets/notes/pic.png` and `legacyFolder="notes"` resolves too.
- [ ] **Step 2: Run tests, verify they fail** (`npx vitest run tests/client/src/repo-sync.test.ts`)
- [ ] **Step 3: Implement `assetFolderFor` and the legacy prefix list in `resolveImagesFromPull`; switch pull's caller in `pullFromRepo` to `assetFolderFor(repoPath)` and pass `slugFromRepoPath(repoPath)` as the legacy folder.**
- [ ] **Step 4: Run tests, verify green.**
- [ ] **Step 5: Commit** (`fix: give nested repo docs their own asset folder`).

### Task 2: Path-derived history files + legacy fallback fetch

**Files:**
- Modify: `client/src/repo-sync.ts` (`historyPathFor`), `client/src/repo-history-sync.ts`
- Test: `tests/client/src/repo-sync.test.ts`, `tests/client/src/repo-history-sync.test.ts`

**Interfaces:**
- `historyPathFor(repoPath)` returns `.mde/history/<repoPath minus .md>.json`.
- `fetchAndMergeRepoHistory(doc)` tries the new path, then `.mde/history/<basename>.json` when different, merging whichever responses are 200.

- [ ] **Step 1: Write failing tests** — nested `historyPathFor`; a mocked fetch where the new path 404s and the legacy path returns snapshots, asserting they merge.
- [ ] **Step 2: Run, verify red.**
- [ ] **Step 3: Implement.** Keep `fetchedDocIds` once-per-doc; do not mutate it early on failure (retry semantics unchanged).
- [ ] **Step 4: Run, verify green.**

### Task 3: Path-aware asset/history sweeps in `planPush`

**Files:**
- Modify: `client/src/repo-sync.ts`
- Test: `tests/client/src/repo-sync.test.ts`

**Interfaces:**
- Internal only: helper `assetOwnerDocPath(assetPath): string | null` mapping `assets/<p>/<file>` → `<p>.md`; helper `historyOwnerDocPath(historyPath): string | null` mapping `.mde/history/<p>.json` → `<p>.md`.

- [ ] **Step 1: Write failing unit tests:**
  - Two docs `notes.md` (root) and `docs/notes.md` with different images of the same ref → `plan.changes` asset paths differ (`assets/notes/…` vs `assets/docs/notes/…`).
  - On a `sameWorkspace` repo, after migrating `docs/notes.md` to the nested folder, a legacy `assets/notes/old.png` with no root `notes.md` in the tree is in `plan.deletions`.
  - With a root `notes.md` present, the same legacy path is NOT deleted.
  - A legacy history file `.mde/history/notes.json` with no `notes.md` in the tree is deleted on a workspace-owned repo; the nested `.mde/history/docs/notes.json` is kept while `docs/notes.md` exists.
- [ ] **Step 2: Run, verify red.**
- [ ] **Step 3: Replace slug-keyed sweeps with path-keyed ones; keep the `sameWorkspace` gates and the still-linked orphan sweep.**
- [ ] **Step 4: Run the whole repo-sync suite, verify green.**

### Task 4: Fake-backend integration

**Files:**
- Test: `tests/client/src/repo-sync.test.ts`

- [ ] **Step 1: Write a failing test:** seed an empty repo; two local docs `notes.md` and `docs/notes.md`, both embedding `pic.png` with different data URIs; `pushToRepo`; fetch the tree and both blobs; assert the two asset paths differ and their bytes differ.
- [ ] **Step 2: Run, verify red (or already green if Tasks 1–3 are correct — then keep it as the regression pin).**
- [ ] **Step 3: Fix anything it exposes.**
- [ ] **Step 4: Run the full suite, typecheck, format.**
