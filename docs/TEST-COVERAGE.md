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

| ID      | Scenario                                                                                    | Level | Status  | Test                                              | Notes                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------- | ----- | ------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| EDIT-01 | Bold / italic / strikethrough wrap a non-empty selection                                    | e2e   | covered | `tests/e2e/local/formatting.spec.ts`             |                                                                                                                    |
| EDIT-02 | Heading 1/2/3 prefix the current line                                                       | e2e   | covered | `tests/e2e/local/formatting.spec.ts`             |                                                                                                                    |
| EDIT-03 | Blockquote / inline code / code block                                                       | e2e   | covered | `tests/e2e/local/formatting.spec.ts`             |                                                                                                                    |
| EDIT-04 | Bullet / numbered / task list prefix                                                        | e2e   | covered | `tests/e2e/local/formatting.spec.ts`             |                                                                                                                    |
| EDIT-05 | Insert table and horizontal rule                                                            | e2e   | covered | `tests/e2e/local/formatting.spec.ts`             |                                                                                                                    |
| EDIT-06 | Math snippet inserts `$$\n\n$$` with the cursor on the interior blank line                   | e2e   | partial | `tests/e2e/local/formatting.spec.ts`             | content asserted; interior cursor position not                                                                    |
| EDIT-07 | Footnote snippet inserts `[^1]` at cursor + `[^1]:` at doc end, as one undo step             | e2e   | partial | `tests/e2e/local/formatting.spec.ts`             | basic `[^1]` case only; single-undo-step and auto-numbering past existing `[^N]` (named `[^note]` ignored) untested |
| EDIT-08 | Link toolbar button / Insert menu / Mod-k open the link modal with the selection prefilled  | e2e   | covered | `tests/e2e/local/formatting.spec.ts`, `menu-format-insert.spec.ts` |                                                                                                |
| EDIT-09 | Link modal confirm inserts `[text](url)` into the editor, with `link text` / `https://` fallbacks for empty fields | e2e | gap | —                                       | `insertLinkIntoEditor` in `formatting-commands.ts`                                                                 |
| EDIT-10 | Mod-b / Mod-i wrap the selection                                                            | e2e   | covered | `tests/e2e/local/formatting.spec.ts`             |                                                                                                                    |
| EDIT-11 | Wrap command on an **empty** selection inserts the placeholder and selects it (type-to-replace) | e2e | gap | —                                                | `wrapSelection` branch; every formatting e2e selects-all first                                                     |
| EDIT-12 | Line-prefix command on a line that **already** has the prefix removes it (toggle off)       | e2e   | gap     | —                                                | `prefixLine` toggle-off branch                                                                                     |
| EDIT-13 | Undo / Redo toolbar buttons                                                                 | e2e   | covered | `tests/e2e/local/formatting.spec.ts`             |                                                                                                                    |
| EDIT-14 | Command Palette toolbar button opens the palette with its input focused                     | e2e   | covered | `tests/e2e/local/formatting.spec.ts`             | palette itself catalogued in §14                                                                                   |
| EDIT-15 | Toolbar groups insert buttons with separators; Command Palette set apart at the end         | e2e   | covered | `tests/e2e/local/toolbar-grouping.spec.ts`       | `IMPROVEMENTS.md` v1.40.4                                                                                           |
| EDIT-16 | Toolbar overflow menu appears and works when the bar is narrower than its buttons (desktop) | e2e   | partial | `tests/e2e/local/mobile-menu-overflow.spec.ts`   | mobile width only; desktop-narrow path untested — cross-ref §13                                                    |
| EDIT-17 | Toolbar update does not throw when `.view-selector` / `#toolbar` is absent from the DOM (locked viewer) | e2e-collab | gap | —                                        | regression for `0c658b6`; needs a viewer role — cross-ref §10                                                      |
| EDIT-18 | Edit-menu Cut / Copy / Paste act on the editor selection                                    | e2e   | gap     | —                                                | `menuClipboard*` in `app.ts`; native shortcuts work without these                                                  |
| EDIT-19 | Tab / Shift-Tab indent / dedent the selected lines (Tab captured, does not move focus out)  | e2e   | gap     | —                                                | `indentWithTab`                                                                                                    |
| EDIT-20 | Typing schedules a debounced save (~400ms) and an undebounced preview / count / outline update | unit | gap     | —                                                | `scheduleSave` / `updateListener` wiring; `debounce.ts` itself covered in §14                                      |
| EDIT-21 | Status bar word count, character count, and cursor position update on edit / selection      | e2e   | gap     | —                                                | `updateCounts` / `updateCursorPos`                                                                                 |
| EDIT-22 | Switching keybinding mode (Normal / Vim / Emacs) via Settings shows / hides the status indicator and enables the motions | e2e | covered | `tests/e2e/local/keybindings.spec.ts`   |                                                                                                                    |
| EDIT-23 | Keybinding mode persists to `localStorage`; corrupted saved value falls back to Normal      | unit  | covered | `tests/client/src/stores/keybindings.test.ts`    |                                                                                                                    |
| EDIT-24 | Vim status indicator reflects the current vim sub-mode (NORMAL / INSERT / VISUAL)           | e2e   | gap     | —                                                | `vim-mode-change` listener in `Editor.svelte`; repeated toggle re-binds the listener                              |
| EDIT-25 | Editor is read-only when `window.MDE.setReadOnly(true)` (viewer role)                        | e2e-collab | partial | `tests/e2e/collab/readonly-and-editing-mode.spec.ts` | verify depth — cross-ref §10                                                                                 |

## 2. Preview, scroll-sync & rendering

_Source: `client/src/components/Preview.svelte`, `client/src/scroll-sync.ts`, `client/src/math-preview.ts`, `client/src/mermaid-preview.ts`, `client/src/diagram-export.ts`, `client/src/diagram-refs.ts`, `client/src/components/DiagramEditor.svelte`_

| ID       | Scenario                                                                                   | Level     | Status  | Test                                          | Notes                                                                                             |
| -------- | ----------------------------------------------------------------------------------------- | --------- | ------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| PREV-01  | Markdown renders to HTML for every block type (headings, lists, nested lists, tables, blockquotes, hr, links, inline styles) | e2e | partial | `tests/e2e/local/preview-rendering.spec.ts` | only heading + mermaid + math + footnote asserted today                                          |
| PREV-02  | Raw HTML / `<script>` / event-handler attributes in the source are stripped by DOMPurify before reaching the preview DOM | component | gap | — | `renderMarkdown` in `Preview.svelte`; only the KaTeX `trust:false` path is tested (`math-preview.test.ts`) |
| PREV-03  | External links render with a safe `rel` / `target` (custom link renderer)                  | component | gap     | —                                            | `Preview.svelte` line ~74                                                                        |
| PREV-04  | GFM task-list items render as checkboxes                                                    | e2e       | gap     | —                                            |                                                                                                 |
| PREV-05  | Fenced code blocks render with syntax highlighting for non-mermaid languages               | e2e       | gap     | —                                            | `defaultCodeRenderer` path                                                                       |
| PREV-06  | Footnote references render as superscripts with back-links and an `sr-only` "Footnotes" heading | e2e   | partial | `tests/e2e/local/preview-rendering.spec.ts` | presence only                                                                                    |
| PREV-07  | Inline `$…$` and block `$$…$$` math render via KaTeX                                        | e2e       | partial | `tests/e2e/local/preview-rendering.spec.ts` | "live rendering" asserts math present; inline-vs-block distinction not                            |
| PREV-08  | A malformed math expression renders an error inline without crashing the preview           | component | gap     | —                                            |                                                                                                 |
| PREV-09  | `extractMathSpans` — inline/block extraction, currency not treated as math, code spans left alone, block-before-inline ordering | unit | covered | `tests/client/src/math-preview.test.ts` |                                                                                          |
| PREV-10  | A `mermaid` fence becomes a `<pre class="mermaid">` placeholder with HTML-escaped source; a stored ref resolves to its source; unknown ref falls back to literal | unit | covered | `tests/client/src/mermaid-preview.test.ts` |                                                            |
| PREV-11  | `renderMermaidDiagrams` — renders with theme, one failure shows an inline error without throwing, diagrams are independent, re-render reuses source, unchanged is skipped | unit | covered | `tests/client/src/mermaid-preview.test.ts` |                                                    |
| PREV-12  | `mermaidThemeFor` maps `data-theme` (dark / light / null / unknown) to a mermaid theme     | unit      | covered | `tests/client/src/mermaid-preview.test.ts`   |                                                                                                 |
| PREV-13  | `detectDiagramType` recognizes every supported mermaid diagram type, skips leading comments, returns null for junk | unit | covered | `tests/client/src/mermaid-language.test.ts` |                                                                          |
| PREV-14  | Theme toggle re-renders existing mermaid diagrams from their original source               | e2e       | covered | `tests/e2e/local/preview-rendering.spec.ts`  |                                                                                                 |
| PREV-15  | `computeBlockLineStarts` / `computeListItemLineStarts` map rendered blocks back to source line numbers | unit | covered | `tests/client/src/scroll-sync.test.ts`      |                                                                                                 |
| PREV-16  | Preview scroll follows the editor in split view and is gated off outside split view        | e2e       | covered | `tests/e2e/local/preview-rendering.spec.ts`  |                                                                                                 |
| PREV-17  | Cursor-follow scrolls the preview to an off-screen cursor position                         | e2e       | covered | `tests/e2e/local/preview-rendering.spec.ts`  |                                                                                                 |
| PREV-18  | Scroll sync recovers correctly after the preview is hidden and re-shown                     | e2e       | gap     | —                                            |                                                                                                 |
| PREV-19  | DiagramEditor opens, edits re-render the diagram (debounced), and Save writes the source back into the document | e2e | gap | —                                            | no DiagramEditor test at any level                                                               |
| PREV-20  | DiagramEditor: insert a starter template, fit-to-container / reset view (panzoom)          | e2e       | gap     | —                                            |                                                                                                 |
| PREV-21  | DiagramEditor: export PNG / copy-as-SVG produces a valid standalone asset; filename derives from the diagram | unit + e2e | partial | `tests/client/src/diagram-export.test.ts` | `svgOuterHtmlForExport` covered; the editor wiring (`copyAsSvg` / `downloadPng` / `exportFilename`) is not |
| PREV-22  | `diagramKey` allocates `diagram` / `diagram-2` / … ; `resolveDiagramRefs` substitutes stored sources, leaves unknown refs and no-map text alone | unit | covered | `tests/client/src/diagram-refs.test.ts` |                                                                    |
| PREV-23  | Suggestion insert/delete marks render in the preview when a shared doc has tracked suggestions | e2e-collab | partial | `tests/e2e/collab/suggestion-mode.spec.ts` | cross-ref §10; `withSuggestions` path in `Preview.svelte`                                         |

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
