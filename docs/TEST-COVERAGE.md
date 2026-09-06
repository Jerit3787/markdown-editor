# Test Coverage Catalog

A living map of every user-facing scenario the app supports and where it
is tested. Maintained by hand: **every new user-facing behavior, and
every fixed bug, adds a row here** in the same PR.

## How to read this

Each subsystem section is a table of scenarios. One row = one observable
behavior, stated as an outcome ("Deleting a repo-linked doc removes it
from the repo on next push"), not an implementation detail.

**Level** — the level a scenario _should_ be tested at (cheapest that
exercises the real risk):

| Level        | Meaning                                            | Location                                            |
| ------------ | ------------------------------------------------- | -------------------------------------------------- |
| `unit`       | pure function / store, no DOM                     | `tests/client/src/*.test.ts`, `tests/src/*.test.ts` |
| `component`  | one `.svelte` file in real headless Chromium      | `tests/client/src/components/*.test.ts`             |
| `integration`| Worker / Durable Object in-process, network faked | `tests/src/*.test.ts`                               |
| `e2e`        | full built client, no Worker                      | `tests/e2e/local/*.spec.ts`                         |
| `e2e-collab` | full client + real `wrangler dev` Worker + DOs    | `tests/e2e/collab/*.spec.ts`                        |

**Status** — `covered` (a test asserts the outcome) · `partial` (a test
touches the path but not the outcome, or tests it at the wrong level) ·
`gap` (nothing).

**ID** — `<SUBSYS>-NN`, stable, referenced from test names and commit
messages.

---

## 1. Editor core & formatting

_Source: `client/src/app.ts`, `client/src/formatting-commands.ts`, `client/src/components/Editor.svelte`, `client/src/components/Toolbar.svelte`_

| ID  | Scenario | Level | Status | Test | Notes |
| --- | -------- | ----- | ------ | ---- | ----- |

## 2. Preview, scroll-sync & rendering

_Source: `client/src/components/Preview.svelte`, `client/src/scroll-sync.ts`, `client/src/math-preview.ts`, `client/src/mermaid-preview.ts`, `client/src/diagram-export.ts`, `client/src/diagram-refs.ts`, `client/src/components/DiagramEditor.svelte`_

| ID  | Scenario | Level | Status | Test | Notes |
| --- | -------- | ----- | ------ | ---- | ----- |

## 3. Markdown dialects

_Source: `client/src/wikilinks.ts`, `client/src/wikilink-rewrite.ts`, `client/src/wikilink-rename-cascade.ts`, `client/src/mmd-citations.ts`, `client/src/mmd-metadata.ts`, `client/src/mmd-inline-blocks.ts`, `client/src/markdown-compat.ts`_

| ID  | Scenario | Level | Status | Test | Notes |
| --- | -------- | ----- | ------ | ---- | ----- |

## 4. Documents, workspaces & multi-tab

_Source: `client/src/stores/docs.ts`, `client/src/stores/workspaces.ts`, `client/src/merge-records.ts`, `client/src/router.ts`, `client/src/doc-naming.ts`, `client/src/components/DocList.svelte`, `client/src/components/WorkspaceSwitcher.svelte`_

| ID  | Scenario | Level | Status | Test | Notes |
| --- | -------- | ----- | ------ | ---- | ----- |

## 5. Images

_Source: image paste/drop/pick paths in `client/src/app.ts`, `client/src/image-key.ts`, `client/src/components/ImagesModal.svelte`_

| ID  | Scenario | Level | Status | Test | Notes |
| --- | -------- | ----- | ------ | ---- | ----- |

## 6. Export & print

_Source: export / print logic in `client/src/app.ts`_

| ID  | Scenario | Level | Status | Test | Notes |
| --- | -------- | ----- | ------ | ---- | ----- |

## 7. Find & replace / search

_Source: `client/src/search.ts`, `client/src/fuzzy-match.ts`, `client/src/stores/findReplace.ts`, `client/src/components/FindReplaceBar.svelte`_

| ID  | Scenario | Level | Status | Test | Notes |
| --- | -------- | ----- | ------ | ---- | ----- |

## 8. Version history & diff view

_Source: `client/src/version-grouping.ts`, `client/src/history.ts`, `client/src/version-preview.ts`, `client/src/diff-lines.ts`, `client/src/diff-image-row.ts`, `client/src/components/VersionHistory.svelte`, `client/src/components/DiffView.svelte`, `src/version-grouping.ts`_

| ID  | Scenario | Level | Status | Test | Notes |
| --- | -------- | ----- | ------ | ---- | ----- |

## 9. Comments

_Source: `client/src/comments.ts`, `client/src/components/CommentsPanel.svelte`, `client/src/stores/commentsPanel.ts`, `client/src/stores/commentDraft.ts`, comment routes in `src/workspace-room.ts`_

| ID  | Scenario | Level | Status | Test | Notes |
| --- | -------- | ----- | ------ | ---- | ----- |

## 10. Workspace collab

_Source: `client/src/collab.ts`, `src/workspace-room.ts`, `src/collab-room.ts`, `client/src/suggestions.ts`, `src/suggestions.ts`, `client/src/suggestion-editor.ts`, `client/src/suggestion-preview.ts`, `src/access-role.ts`, `src/access-visibility.ts`, `client/src/stores/workspacePresence.ts`_

| ID  | Scenario | Level | Status | Test | Notes |
| --- | -------- | ----- | ------ | ---- | ----- |

## 11. GitHub auth & Gist

_Source: `src/github-auth.ts`, `src/auth.ts`, `src/env.ts`, `client/src/gist.ts`, `src/gist-images.ts`, `src/memory-fs.ts`_

| ID  | Scenario | Level | Status | Test | Notes |
| --- | -------- | ----- | ------ | ---- | ----- |

## 12. GitHub repo sync

_Source: `client/src/repo-sync.ts`, `client/src/repo-sync-ui.ts`, `src/github-repo.ts`, `client/src/repo-history-sync.ts`, `client/src/repo-doc-dates.ts`_

| ID  | Scenario | Level | Status | Test | Notes |
| --- | -------- | ----- | ------ | ---- | ----- |

## 13. Mobile

_Source: mobile layout branches in `client/src/app.ts` and components — bottom sheets, tab switcher, toolbar overflow, input-zoom, scroll sync_

| ID  | Scenario | Level | Status | Test | Notes |
| --- | -------- | ----- | ------ | ---- | ----- |

## 14. App shell

_Source: `client/src/components/MenuBar.svelte`, `client/src/components/CommandPalette.svelte`, `client/src/components/Modal.svelte`, `client/src/stores/toast.ts`, `client/src/whats-new.ts`, `client/src/whats-new-entries.ts`, `client/src/components/WhatsNew.svelte`, `client/src/focus-mode.ts`, `client/src/debounce.ts`, `client/src/relative-time.ts`, `client/src/anchor.ts`, `client/src/escape-html.ts`, `src/worker.ts` (routing / static-serving fallthrough)_

| ID  | Scenario | Level | Status | Test | Notes |
| --- | -------- | ----- | ------ | ---- | ----- |

---

## Deferred

Scenarios deliberately not tested, and `it.skip` / `test.fixme` rows
pointing at real bugs awaiting a fix branch.

| ID  | Scenario | Why deferred |
| --- | -------- | ------------ |
