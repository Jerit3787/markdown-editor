# Workspace Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a `Workspace` container (VS Code-style, one active at a time) that every document belongs to, with a switcher UI to create/switch/rename/delete workspaces and move documents between them, transparently migrating existing users onto a default workspace.

**Architecture:** A new leaf store module (`client/src/stores/workspaces.ts`) owns workspace CRUD + persistence with zero knowledge of documents. `client/src/stores/docs.ts` depends on it one-way (imports its stores) to stamp/backfill/filter `workspaceId` on documents — the reverse dependency is forbidden (would create an import cycle). Two Svelte components (a new `WorkspaceSwitcher.svelte`, and small edits to the existing `DocList.svelte`) are the only places that coordinate both stores together (e.g. "switch workspace, then fix up which document is active"), keeping the two store modules decoupled.

**Tech Stack:** TypeScript, Svelte 5 (runes), `svelte/store`, `localStorage`, Vitest + jsdom.

## Global Constraints

- One workspace active/visible at a time — no multi-root view (per the design spec).
- Deleting a workspace deletes all its documents too, after a confirm showing the document count (reuses the existing `confirmAction()` from `client/src/stores/confirmDialog.ts`).
- Deleting the last workspace is allowed (mirrors the existing zero-document empty state) — a "no workspace" empty state covers this.
- Workspace names do not need to be unique.
- `workspaces.ts` must never import from `docs.ts` — only the reverse. Any place that needs both (switch/create/delete workspace + fix up the active document) does so from the calling component, not from either store.
- Full design reference: `docs/superpowers/specs/2026-08-15-workspace-core-design.md`.

---

> **Status note (added after shipping, 2026-08-16):** This plan shipped as
> v1.20.0. Tasks 1-5 below are exactly what was built and reviewed via
> subagent-driven-development. A **final whole-branch review** (run after
> Task 5, on the most capable available model) found 5 additional
> cross-cutting integration bugs no single task's isolated diff could
> reveal — fixed in one consolidated fix commit and re-reviewed clean.
> They are **not reflected in the task text below** (which is the
> original, pre-review plan) — see `CHANGELOG.md`'s `[1.20.0]` entry and
> the design spec's own post-implementation note for the corrected
> behavior:
> 1. `initialActiveId` (module-load fallback in `docs.ts`) needed to
>    become workspace-scoped, matching `getActiveDoc()`'s pattern —
>    otherwise a reload after switching to an empty workspace could
>    silently reopen a document from a different workspace.
> 2. The migration's `fallbackWorkspaceId` needed to pick the *oldest*
>    workspace by `createdAt`, not `workspacesStore[0]` (which is the
>    newest, since `createWorkspace` prepends) — and needed to persist
>    immediately when a backfill actually occurred, not rely on some
>    later unrelated save.
> 3. `switchDoc()` needed to bring the active workspace along when
>    navigating to a document in a different one — 8 call sites
>    (wikilinks, Command Palette, Recent docs, backlinks, shared-link
>    join, ImagesModal's fallback) were leaving `activeWorkspaceId` and
>    `activeId` desynchronized. **User decision:** cross-workspace
>    navigation should follow you to the target workspace, fixed at this
>    single choke point rather than in all 8 consumers.
> 4. `createDoc()`'s workspace-id fallback needed to self-heal (create a
>    workspace on demand) rather than ever stamp `workspaceId: ""` —
>    reachable because several document-creation entry points stay live
>    even in the "no workspace" empty state.
> 5. A `workspacesStore` subscription added in a Task 5 fix round was
>    calling the *full* `updateMainView`, which collapses the mobile
>    sidebar — split into a narrow empty-state-only function so ordinary
>    workspace mutations (e.g. renaming) don't collapse the sidebar out
>    from under a mobile user mid-interaction.
>
> If you are resuming or referencing this plan for future work (e.g. a
> follow-up sub-project), read `docs.ts`'s actual shipped code for these
> five functions rather than trusting the task text below verbatim.

---

### Task 1: `workspaces.ts` store

**Files:**
- Modify: `client/src/types.ts` — add `Workspace` interface.
- Create: `client/src/stores/workspaces.ts`
- Create: `client/src/stores/workspaces.test.ts`

**Interfaces:**
- Consumes: `showToast` from `client/src/stores/toast.ts` (already exists — `showToast(message: string, kind: "success" | "error"): void`).
- Produces (used by Task 2 onward):
  - `export const workspacesStore: Writable<Workspace[]>`
  - `export const activeWorkspaceIdStore: Writable<string | null>`
  - `export function persistWorkspaces(): void`
  - `export function createWorkspace(name: string): Workspace`
  - `export function renameWorkspace(id: string, name: string): void`
  - `export function switchWorkspace(id: string): boolean`
  - `export function deleteWorkspaceRecord(id: string): void`
  - `export interface Workspace { id: string; name: string; createdAt: number }` (from `types.ts`)

- [x] **Step 1: Add the `Workspace` interface to `client/src/types.ts`**
- [x] **Step 2: Write the failing tests**
- [x] **Step 3: Run the tests to verify they fail**
- [x] **Step 4: Implement `client/src/stores/workspaces.ts`**
- [x] **Step 5: Run the tests to verify they pass**
- [x] **Step 6: Typecheck and full build**
- [x] **Step 7: Commit**

(Full step-by-step code for this task matched the design spec's `workspaces.ts` section verbatim — see that file. Shipped as commit `0cd4c49`.)

---

### Task 2: `docs.ts` workspace integration

**Files:**
- Modify: `client/src/types.ts` — add `workspaceId: string` to `Doc`.
- Modify: `client/src/stores/docs.ts`
- Modify: `client/src/doc-naming.test.ts` — existing `Doc` fixtures need `workspaceId`.
- Modify: `client/src/wikilinks.test.ts` — existing `Doc` fixtures need `workspaceId`.
- Create: `client/src/stores/docs.test.ts`

**Interfaces:**
- Consumes: `workspacesStore`, `activeWorkspaceIdStore`, `createWorkspace` from `client/src/stores/workspaces.ts` (Task 1).
- Produces (used by Task 3+):
  - `export function ensureActiveDocInWorkspace(workspaceId: string): void`
  - `export function moveDocToWorkspace(id: string, workspaceId: string): void`
  - `createDoc()`, `getActiveDoc()`, `removeDocById()` behavior changes (same signatures as before).

- [x] **Step 1: Add `workspaceId` to the `Doc` interface**
- [x] **Step 2: Fix existing test fixtures so the build still typechecks**
- [x] **Step 3: Run the full test suite to verify the fixture fixes compile and still pass**
- [x] **Step 4: Write the failing tests for the new workspace-aware `docs.ts` behavior**
- [x] **Step 5: Run the tests to verify they fail**
- [x] **Step 6: Implement the changes in `client/src/stores/docs.ts`** — `normalizeLoadedDocs`, `createDoc`, `getActiveDoc`, `removeDocById`, plus new exports `ensureActiveDocInWorkspace` and `moveDocToWorkspace`. (See the design spec's `docs.ts` section for the original code — **superseded by the final-review fix wave**, see the Status note above.)
- [x] **Step 7: Run the tests to verify they pass**
- [x] **Step 8: Run the full test suite, typecheck, and build**
- [x] **Step 9: Commit**

Shipped as commit `7fb586a` (original), further corrected by the final-review fix commit `da0d865`.

---

### Task 3: `WorkspaceSwitcher.svelte`

**Files:**
- Create: `client/src/components/WorkspaceSwitcher.svelte`
- Modify: `client/index.html` — replace the static "Documents" label with a new mount point.
- Modify: `client/src/main.ts` — mount the new component.
- Modify: `client/src/style.css` — new `.workspace-switcher*` rules.

**Interfaces:**
- Consumes: everything from Task 1 (`workspacesStore`, `activeWorkspaceIdStore`, `createWorkspace`, `renameWorkspace`, `switchWorkspace`, `deleteWorkspaceRecord`) and Task 2 (`docsStore`, `removeDocById`, `ensureActiveDocInWorkspace`), plus the existing `confirmAction` from `client/src/stores/confirmDialog.ts`.
- Produces: nothing new consumed by later tasks — this is a leaf UI component.

- [x] **Step 1: Replace the static "Documents" label with a mount point in `client/index.html`**
- [x] **Step 2: Implement `client/src/components/WorkspaceSwitcher.svelte`** (see design spec for the component code — icons used: `icon-chevron-down`, `icon-pencil`, `icon-trash-2`, `icon-plus`, not `icon-folder-plus` which doesn't exist in this app's sprite)
- [x] **Step 3: Mount it from `client/src/main.ts`**
- [x] **Step 4: Add CSS to `client/src/style.css`**
- [x] **Step 5: Build and typecheck**
- [x] **Step 6: Manual verification (desktop, via Claude-in-Chrome)** — create/switch/rename/delete workspaces all verified live, including delete-cascade with correct document counts.
- [x] **Step 7: Commit**

Shipped as commit `d8170c6`.

---

### Task 4: `DocList.svelte` — filter by workspace + move-to-workspace

**Files:**
- Modify: `client/src/components/DocList.svelte`
- Modify: `client/src/style.css` — small addition for the submenu label.

**Interfaces:**
- Consumes: `activeWorkspaceIdStore`, `workspacesStore` from `client/src/stores/workspaces.ts` (Task 1); `moveDocToWorkspace`, `ensureActiveDocInWorkspace` from `client/src/stores/docs.ts` (Task 2).

- [x] **Step 1: Filter the document list to the active workspace**
- [x] **Step 2: Add the "Move to workspace" submenu to the "⋮" popover**
- [x] **Step 3: Add CSS for the submenu label**
- [x] **Step 4: Build and typecheck**
- [x] **Step 5: Manual verification** — confirmed the cross-workspace leak (a document from another workspace showing in the active one's list) found during Task 3's verification is fixed; move-to-workspace tested including moving the sole document out of the active workspace.
- [x] **Step 6: Commit**

Shipped as commit `f9c9bde`.

---

### Task 5: Workspace-scoped empty states

**Files:**
- Modify: `client/index.html` — add the "no workspace" empty-state variant.
- Modify: `client/src/app.ts` — toggle between the two variants, wire the new button.
- Modify: `client/src/style.css` — show/hide the right variant.

**Interfaces:**
- Consumes: `workspacesStore` from `client/src/stores/workspaces.ts` (Task 1); `createWorkspace` from the same.

- [x] **Step 1: Add the second empty-state variant to `client/index.html`**
- [x] **Step 2: Toggle the right variant and wire the new button in `client/src/app.ts`**
- [x] **Step 3: CSS to show exactly one variant at a time**
- [x] **Step 4: Build and typecheck**
- [x] **Step 5: Manual verification**
- [x] **Step 6: Commit**

Shipped as commit `2139893`. **Fix round 1/1** (controller-discovered via live verification, not a task reviewer): the empty state didn't update when the last workspace was deleted, since `updateMainView` was only triggered by `activeIdStore`'s subscription, and that store often doesn't change value when the last (already-doc-empty) workspace is deleted. Fixed by adding a direct `workspacesStore` subscription in `app.ts` — commit `35ead49`. (This fix's own side effect — the mobile sidebar-collapse issue — is finding #5 in the Status note above, fixed in the final-review fix wave.)

---

### Task 6: Full regression pass + release

- [x] **Step 1: Full automated check** — typecheck, build, `npm test` all green.
- [x] **Step 2: Manual end-to-end pass (desktop + mobile)** — plus a **final whole-branch code review** (opus, over the full `751d503..35ead49` range) that found the 5 cross-cutting bugs described in the Status note above. Fixed in one consolidated commit (`da0d865`, dispatched on sonnet after an opus dispatch hit a session limit with zero work done), re-reviewed clean, then live-verified by the controller (findings 1/3/4, the UI-observable ones).
- [x] **Step 3: Update `IMPROVEMENTS.md`/`ROADMAP.md`** — Workspace core marked shipped; the three follow-on sub-projects (workspace-level sharing, GitHub repo sync, Google Drive sync) added to `ROADMAP.md`'s bigger-bets backlog.
- [x] **Step 4: Version bump, changelog, tag, push, deploy** — v1.20.0, tagged, pushed, deployed to editor.danplace.tech. Included a What's New carousel entry (genuine feature, not bug-fix-tier).

---

## Self-review

(Original self-review from plan authoring — see the design spec for the equivalent architectural self-review. The plan's task decomposition covered every spec requirement; the final whole-branch review after execution is what caught the cross-cutting integration bugs that no single task's isolated diff could reveal, which is exactly the gap a broad final review exists to close.)
