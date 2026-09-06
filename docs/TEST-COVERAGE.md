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

| ID     | Scenario                                                                                        | Level | Status  | Test                                                                                | Notes                                                                                    |
| ------ | --------------------------------------------------------------------------------------------- | ----- | ------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| MDX-01 | `[[Name]]` transforms to a `wikilink:`-scheme link; parens round-trip; ordinary links untouched | unit  | covered | `tests/client/src/wikilinks.test.ts`                                               |                                                                                        |
| MDX-02 | `resolveWikilinkTarget` exact-match / no-match; `findBacklinks` incl. self-reference handling    | unit  | covered | `tests/client/src/wikilinks.test.ts`                                              |                                                                                        |
| MDX-03 | Backlinks panel lists documents that link here and navigates on click                            | component | gap  | —                                                                                | logic covered by MDX-02; the panel UI is not                                            |
| MDX-04 | `[[` opens the wikilink menu, filtered by existing doc names; Escape closes without inserting `]]` | e2e | covered | `tests/e2e/local/slash-and-wikilinks.spec.ts`                                     |                                                                                        |
| MDX-05 | Wikilink menu keyboard nav (arrows + Enter select the highlighted doc)                           | e2e   | gap     | —                                                                                | only Escape + click paths tested                                                        |
| MDX-06 | Clicking a wikilink in the preview navigates to the target; clicking an unresolved one creates the doc | e2e | covered | `tests/e2e/local/slash-and-wikilinks.spec.ts`                                    |                                                                                        |
| MDX-07 | `rewriteWikilinkReferences` / `findWikilinkOccurrences` — exact match only, ranges in order (client + Worker copies) | unit | covered | `tests/client/src/wikilink-rewrite.test.ts`, `tests/src/wikilink-rewrite.test.ts` |                                                                        |
| MDX-08 | `planWikilinkRenameCascade` buckets self / local / shared targets (with defensive fallbacks); `runWikilinkRenameCascade` counts each and isolates failures | unit | covered | `tests/client/src/wikilink-rename-cascade.test.ts` |                                                     |
| MDX-09 | Renaming a doc rewrites `[[old]]` → `[[new]]` across other docs, with a toast; the doc's own open buffer updates | e2e | covered | `tests/e2e/local/wikilink-rename-cascade.spec.ts`                                 |                                                                                        |
| MDX-10 | A rename that collides opens `RenameCollisionModal`; Replace still cascades                       | e2e   | covered | `tests/e2e/local/wikilink-rename-cascade.spec.ts`                                 |                                                                                        |
| MDX-11 | Renaming a doc while a second collaborator is connected updates a background doc's `[[link]]` for both | e2e-collab | covered | `tests/e2e/collab/wikilink-rename-cascade.spec.ts`                          |                                                                                        |
| MDX-12 | `parseMetadataBlock` / `serializeMetadataBlock` — bare + HTML-comment-wrapped formats, indented continuations, legacy upgrade, exact round-trip | unit | covered | `tests/client/src/mmd-metadata.test.ts` |                                                            |
| MDX-13 | Metadata values / keys containing `-->` or `--!>` are escaped so they can't close the wrapping HTML comment | unit | covered | `tests/client/src/mmd-metadata.test.ts`                                      | regression for `029af44`                                                                |
| MDX-14 | Adding a metadata field in Document Info round-trips through `.md` export                          | e2e   | covered | `tests/e2e/local/mmd-syntax.spec.ts`                                              |                                                                                        |
| MDX-15 | The metadata block is not rendered as visible content in the preview                              | e2e   | gap     | —                                                                                |                                                                                        |
| MDX-16 | `transformCitations` — text + structured sources, numbered + author-year styles, repeated keys reuse a number, unknown key untouched, author-year bib sorted | unit | covered | `tests/client/src/mmd-citations.test.ts` |                                                       |
| MDX-17 | A `[@key]` citation with a typed definition renders as a numbered link + bibliography; a structured entry round-trips through `.md` export | e2e | covered | `tests/e2e/local/mmd-citations.spec.ts`                          |                                                                                        |
| MDX-18 | Author-year display style renders end-to-end in the preview (requires structured storage)         | e2e   | gap     | —                                                                                | only numbered style is e2e-tested                                                       |
| MDX-19 | Per-document citation marker style toggle (`[@key]` pandoc vs `[#key]` multimarkdown) takes effect | e2e   | gap     | —                                                                                | both regexes unit-covered; the setting toggle is not                                    |
| MDX-20 | `transformDefinitionLists` / `transformSuperscriptSubscript` — conversions, and no misread of footnote-as-superscript or GFM-strikethrough-as-subscript | unit | covered | `tests/client/src/mmd-inline-blocks.test.ts` |                                                    |
| MDX-21 | Definition lists, superscript, subscript render in the preview                                    | e2e   | covered | `tests/e2e/local/mmd-syntax.spec.ts`                                             |                                                                                        |
| MDX-22 | Definition list / superscript / subscript survive a `.md` export → re-import round-trip           | e2e   | gap     | —                                                                                | cross-ref §6; only metadata + citations round-trips are tested                          |
| MDX-23 | `scanMarkdownCompatibility` flags every app-only + flavor-specific construct, sorted by position, with code spans exempt and no double-flagging | unit | covered | `tests/client/src/markdown-compat.test.ts` |                                                        |
| MDX-24 | Slash menu: `/` opens + filters + runs a command; Escape closes without inserting                 | e2e   | covered | `tests/e2e/local/slash-and-wikilinks.spec.ts`                                     |                                                                                        |
| MDX-25 | Slash menu keyboard nav (arrows + Enter); every registered slash command is reachable             | e2e   | gap     | —                                                                                |                                                                                        |

## 4. Documents, workspaces & multi-tab

_Source: `client/src/stores/docs.ts`, `client/src/stores/workspaces.ts`, `client/src/merge-records.ts`, `client/src/router.ts`, `client/src/doc-naming.ts`, `client/src/components/DocList.svelte`, `client/src/components/WorkspaceSwitcher.svelte`_

| ID     | Scenario                                                                                          | Level     | Status  | Test                                                | Notes                                                                          |
| ------ | --------------------------------------------------------------------------------------------- | --------- | ------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| DOC-01 | `createDoc` stamps the active workspace, honors an override, self-heals a missing workspace, and splits a leading metadata block once | unit | covered | `tests/client/src/stores/docs.test.ts`         |                                                                            |
| DOC-02 | `nextAvailableName` / `ensureUniqueName` — unchanged when free, `-2` on collision, keeps incrementing, excludeId frees its own name | unit | covered | `tests/client/src/doc-naming.test.ts`          | the app's silent-suffix uniqueness rule                                     |
| DOC-03 | Creating a document via the UI adds it to the sidebar and switches to it                          | e2e       | covered | `tests/e2e/local/documents.spec.ts`              |                                                                            |
| DOC-04 | Deleting a document via the UI (with confirm) removes it and falls back to another doc in the same workspace | e2e | gap  | —                                               | `removeDocById` fallback + repoPath-deletion queue covered at unit          |
| DOC-05 | `removeDocById` queues a repo-synced doc's `repoPath` for deletion on a later push; queues nothing for a never-synced doc; its own save doesn't resurrect the doc from a stale `localStorage` snapshot | unit | covered | `tests/client/src/stores/docs.test.ts` | cross-ref §12                                              |
| DOC-06 | Renaming a document from the Edit modal; a colliding rename opens the collision dialog above it   | e2e + component | covered | `tests/e2e/local/doc-info-edit-modal.spec.ts`, `tests/client/src/components/DocEditModal.test.ts` |                                              |
| DOC-07 | `moveDocToWorkspace` reassigns `workspaceId` only; via the MoveToWorkspaceModal UI                | unit + e2e | partial | `tests/client/src/stores/docs.test.ts`          | store covered; the modal UI is not                                          |
| DOC-08 | `createWorkspace` / `renameWorkspace` / `switchWorkspace` / `deleteWorkspaceRecord` mutate correctly, with oldest-remaining and null fallbacks on delete | unit | covered | `tests/client/src/stores/workspaces.test.ts` |                                                          |
| DOC-09 | Create / rename / delete / switch a workspace via the WorkspaceSwitcher UI                        | component | gap     | —                                               | store logic fully covered by DOC-08                                          |
| DOC-10 | First run with no `mde:workspaces` seeds zero workspaces and persists that immediately; a stored active id is restored | unit | covered | `tests/client/src/stores/workspaces.test.ts`   |                                                                            |
| DOC-11 | Legacy docs with no `workspaceId` are backfilled to the oldest workspace by `createdAt` and the rewrite is persisted immediately (once) | unit | covered | `tests/client/src/stores/docs.test.ts`        | pre-workspace user migration                                                |
| DOC-12 | End-to-end first-run migration: a pre-workspace `localStorage` shape loads into a default workspace with the editor working | e2e | gap   | —                                               | only the store-level backfill (DOC-11) is tested                            |
| DOC-13 | `persistDocs` / `persistWorkspaces` merge with what another tab already saved instead of overwriting, keeping the other tab's newer edits | unit | covered | `tests/client/src/stores/docs.test.ts`, `workspaces.test.ts` | `TODO.md` multi-tab data-loss fix                    |
| DOC-14 | `mergeById` — newer side wins, ties keep current, one-sided records preserved, empty inputs handled                | unit      | covered | `tests/client/src/merge-records.test.ts`         |                                                                            |
| DOC-15 | Two real tabs open: a save in one tab never destroys the other tab's untouched docs / workspaces; a delete still sticks | e2e     | gap     | —                                               | `TODO.md` — the actual multi-tab scenario, not just the merge helper        |
| DOC-16 | `syncRemoteDocContent` writes changed content / images / name and bumps `updatedAt`; is a no-op when nothing changed (incl. reordered image keys); suffixes a colliding remote rename | unit | covered | `tests/client/src/stores/docs.test.ts` | cross-ref §10                                          |
| DOC-17 | `parseDocIdFromPath` extracts `/d/<id>`, rejects root / share-link / malformed paths; `pushDocUrl` / `replaceDocUrl` / `replaceToRoot` avoid redundant history entries | unit | covered | `tests/client/src/router.test.ts` |                                                                    |
| DOC-18 | Deep-linking to `/d/<id>` loads that document                                                    | e2e       | partial | `tests/e2e/local/support/fixtures.ts`            | every local spec loads via `/d/<id>` but none asserts it resolved the right doc |
| DOC-19 | Switching documents updates the URL; browser back / forward navigates between documents; deleting the active doc replaces the URL with `/` | e2e | gap  | —                                               | `initRouter` `popstate` handling is untested at any level                   |
| DOC-20 | Sidebar rows are real `<a href="/d/…">` links — Ctrl/Cmd-click and middle-click open a document in a new tab | e2e     | gap     | —                                               | `TODO.md` tab-per-document routing                                          |
| DOC-21 | DocList sorts documents alphabetically and shows a live per-document heading outline for the active doc | component | gap  | —                                               |                                                                            |
| DOC-22 | `importRemoteDocs` adds remote docs into the target workspace, renaming on name collision        | unit      | covered | `tests/client/src/stores/docs.test.ts`           | cross-ref §10                                                               |
| DOC-23 | Ephemeral (preview) workspaces: never persisted, activating one doesn't overwrite the default landing workspace, promote persists it for real | unit | covered | `tests/client/src/stores/workspaces.test.ts`   | cross-ref §10 for the reload-loses-it e2e                                   |
| DOC-24 | `setActiveDocMetadata` / `setActiveDocCitations` / `replaceDocImages` update and persist the active doc | unit | covered | `tests/client/src/stores/docs.test.ts`           |                                                                            |

## 5. Images

_Source: image paste/drop/pick paths in `client/src/app.ts`, `client/src/components/Editor.svelte` (`insertImageWithUpload`, `MAX_IMAGE_BYTES`, paste/drop handlers), `client/src/image-key.ts`, `client/src/components/ImagesModal.svelte`_

| ID     | Scenario                                                                                          | Level | Status  | Test                                    | Notes                                                                            |
| ------ | --------------------------------------------------------------------------------------------- | ----- | ------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| IMG-01 | `imageKey` sanitizes the filename (spaces → hyphens, unsafe chars stripped, periods kept), suffixes `-2` on collision, falls back to a default base/extension | unit | covered | `tests/client/src/image-key.test.ts` | a filename-sanitization bug (not a rendering bug) was why images "couldn't be imported" |
| IMG-02 | Pasting an image embeds it as a `![](key)` ref resolving to a data URI                            | e2e   | covered | `tests/e2e/local/images.spec.ts`        |                                                                            |
| IMG-03 | Dropping an image file onto the editor embeds it at the drop position                             | e2e   | gap     | —                                       | `drop` handler in `Editor.svelte`; only paste is tested                     |
| IMG-04 | An oversized (>2 MB) image inserts the `image too large, 2MB max` marker instead of uploading — on both paste and drop | e2e | partial | `tests/e2e/local/images.spec.ts` | paste path covered; drop path not                                           |
| IMG-05 | A non-image paste / drop payload is ignored (the `image/` type filter)                            | e2e   | gap     | —                                       |                                                                            |
| IMG-06 | The `![Encoding name…]()` placeholder is replaced in place once the `FileReader` resolves, its position tracked across concurrent edits | e2e-collab | gap | —                                | live-tracked range in `Editor.svelte`                                       |
| IMG-07 | Switching documents mid-encode drops the pending image instead of writing it to the wrong doc    | e2e   | gap     | —                                       | `if (!range) return` in `Editor.svelte`                                     |
| IMG-08 | Toolbar / Insert-menu image button opens the Images modal                                         | e2e   | covered | `tests/e2e/local/images.spec.ts`        |                                                                            |
| IMG-09 | Clicking a thumbnail in the Images modal inserts `![alt](key)` and closes the modal              | e2e   | covered | `tests/e2e/local/images.spec.ts`        |                                                                            |
| IMG-10 | "Upload new image" inside the modal inserts a new image and closes the modal                      | e2e   | covered | `tests/e2e/local/images.spec.ts`        |                                                                            |
| IMG-11 | "Replace" on a row overwrites the same key without changing the document text; an oversized replacement errors and leaves the original untouched | e2e | covered | `tests/e2e/local/images.spec.ts` | in-place image replacement (v1.32.0)                                        |
| IMG-12 | Deleting an image from the Images modal removes it from the doc's image map and refreshes the list | component | gap  | —                                       | `deleteDocImage`                                                            |
| IMG-13 | The Images modal shows each image's size (`formatBytes`)                                          | component | gap     | —                                       |                                                                            |
| IMG-14 | Pasting the same file twice creates two distinct keys (`name` then `name-2`) — there is no content-hash dedup | unit | gap  | —                                       | pins actual behavior; `imageKey` is filename-based                          |
| IMG-15 | `![](key)` references resolve to their data URI in the rendered preview                           | e2e   | partial | `tests/e2e/local/images.spec.ts`        | implied by IMG-02's data-URI assertion; not a dedicated check              |

## 6. Export & print

_Source: export / print logic in `client/src/app.ts` (`exportAs`, `exportPdf`, `printDocument`, `buildStandaloneHtml`, `currentFileBase`)_

| ID     | Scenario                                                                                          | Level | Status  | Test                                | Notes                                                                                    |
| ------ | --------------------------------------------------------------------------------------------- | ----- | ------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| EXP-01 | `.md` export resolves diagram refs to their source and image refs to data URIs, then re-serializes the metadata and citations blocks | e2e | gap | —                                 | the entire `md` branch of `exportAs` is untested; fidelity-critical                     |
| EXP-02 | `.md` export → import round-trip preserves metadata, citations, images, and diagrams             | e2e   | gap     | —                                  | cross-ref MDX-22                                                                        |
| EXP-03 | `.txt` export downloads `<base>.txt` containing the preview's rendered text (no markdown syntax)  | e2e   | partial | `tests/e2e/local/export.spec.ts`    | filename asserted; text-content shape not                                               |
| EXP-04 | `.html` export downloads a standalone document with the rendered diagram SVG, not the raw fence   | e2e   | covered | `tests/e2e/local/export.spec.ts`    |                                                                                        |
| EXP-05 | `.html` export inlines the stylesheet (incl. KaTeX CSS) so the file renders correctly opened alone | e2e  | partial | `tests/e2e/local/export.spec.ts`    | `<svg>` presence only; not that styles are inlined                                      |
| EXP-06 | `.html` export escapes the document body so it can't inject markup into the exported file        | unit  | gap     | —                                  | `buildStandaloneHtml` escaping                                                          |
| EXP-07 | `.pdf` export downloads `<base>.pdf`                                                              | e2e   | covered | `tests/e2e/local/export.spec.ts`    |                                                                                        |
| EXP-08 | Export filename derives from the document name, sanitized (`currentFileBase`)                     | e2e   | gap     | —                                  | tests only assert the extension, never the base name                                    |
| EXP-09 | txt / html / pdf export awaits `flushPreviewRenders` so a just-pasted diagram / formula isn't exported as raw source | e2e | covered | `tests/e2e/local/export.spec.ts` | the "not `\`\`\`mermaid`" assertion in EXP-04                                            |
| EXP-10 | Print media hides all app chrome and shows the preview regardless of the current view mode        | e2e   | covered | `tests/e2e/local/print.spec.ts`     |                                                                                        |
| EXP-11 | The printed page shows the document title as a heading that is hidden on screen                   | e2e   | covered | `tests/e2e/local/print.spec.ts`     |                                                                                        |
| EXP-12 | File-menu Print and Command Palette Print both call `window.print()`                              | e2e   | covered | `tests/e2e/local/print.spec.ts`     |                                                                                        |

## 7. Find & replace / search

_Source: `client/src/search.ts`, `client/src/fuzzy-match.ts`, `client/src/stores/findReplace.ts`, `client/src/components/FindReplaceBar.svelte`_

| ID      | Scenario                                                                                         | Level     | Status  | Test                                            | Notes                                                                     |
| ------- | ------------------------------------------------------------------------------------------- | --------- | ------- | --------------------------------------------- | --------------------------------------------------------------------- |
| SRCH-01 | `countMatches` — zero for no-match / empty / invalid regex (no throw), counts + picks the match at/after the cursor, wraps past the last | unit | covered | `tests/client/src/search.test.ts`             |                                                                     |
| SRCH-02 | `countMatches` honors the case-sensitive and regexp options                                       | unit      | covered | `tests/client/src/search.test.ts`              |                                                                     |
| SRCH-03 | `Ctrl/Cmd+F` opens the find bar and highlights all matches with a live count                       | e2e       | covered | `tests/e2e/local/search-and-replace.spec.ts`   |                                                                     |
| SRCH-04 | `Ctrl/Cmd+H` opens with the replace row; Replace All replaces every match                          | e2e       | covered | `tests/e2e/local/search-and-replace.spec.ts`   |                                                                     |
| SRCH-05 | Find next / previous navigate through matches and wrap around at each end                          | component | gap     | —                                             | `findNext` / `findPrevious` wiring; only the count is tested          |
| SRCH-06 | Replace-one (`replaceNext`) replaces just the current match and advances                           | component | gap     | —                                             | only Replace All is tested                                           |
| SRCH-07 | Regex replace applies capture-group substitutions (`$1`)                                           | component | gap     | —                                             |                                                                     |
| SRCH-08 | Whole-word toggle restricts matches to word boundaries                                             | component | gap     | —                                             | `wholeWord` option exists in `FindReplaceBar` but is untested        |
| SRCH-09 | Match-case toggle narrows the live count                                                           | component | covered | `tests/client/src/components/FindReplaceBar.test.ts` |                                                               |
| SRCH-10 | An invalid regex disables navigation and shows the invalid state                                   | component | covered | `tests/client/src/components/FindReplaceBar.test.ts` |                                                               |
| SRCH-11 | Replace / Replace All are disabled on a read-only view                                             | component | covered | `tests/client/src/components/FindReplaceBar.test.ts` | cross-ref §10                                                        |
| SRCH-12 | The replace row only appears in replace mode                                                       | component | covered | `tests/client/src/components/FindReplaceBar.test.ts` |                                                               |
| SRCH-13 | Escape closes the bar                                                                              | component + e2e | covered | `tests/client/src/components/FindReplaceBar.test.ts`, `tests/e2e/local/search-and-replace.spec.ts` |                                     |
| SRCH-14 | `openFindBar` switches out of preview-only view mode so the bar is visible; leaves an already-visible mode alone; `closeFindBar` hides it | unit | covered | `tests/client/src/stores/findReplace.test.ts` |                                          |
| SRCH-15 | The current query / options persist (or reset) predictably across close → reopen                   | component | gap     | —                                             | pins actual behavior — the store holds only open + mode, not the query |
| SRCH-16 | `fuzzyScore` — exact = best, non-contiguous subsequence matches, non-subsequence = null, case-insensitive, tighter/earlier scores better | unit | covered | `tests/client/src/fuzzy-match.test.ts`      | consumed by Command Palette (§14) and wikilink menu (§3)             |

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
