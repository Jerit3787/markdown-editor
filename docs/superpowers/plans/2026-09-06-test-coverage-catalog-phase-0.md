# Test Coverage Catalog — Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add coverage instrumentation and author the full `docs/TEST-COVERAGE.md` catalog, so phases 1–13 have a scenario-level map and a line/branch baseline to work from.

**Architecture:** Phase 0 is the only phase planned in full up front. It ships two things in one PR: (1) `@vitest/coverage-v8` wired into a non-blocking `npm run test:coverage` + CI summary, and (2) `docs/TEST-COVERAGE.md` — a committed, hand-maintained catalog with one section per subsystem, every scenario row, and its current test status determined by reading source and existing tests directly. Phases 1–13 each get their own short plan written later, directly from the finished catalog.

**Tech Stack:** Vitest 5 (`unit` + `components` projects), `@vitest/coverage-v8`, Playwright 5 (`local` + `collab` projects), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-06-test-coverage-catalog-design.md`

## Global Constraints

- **Versioning:** Phase 0 is behind-the-scenes. Patch bump only: `package.json` `1.45.0` → `1.45.2`, and both `version` fields in `package-lock.json` (lines ~3 and ~9) hand-edited to match. No full `npm install --package-lock-only`.
- **CHANGELOG:** one new `## [1.45.2] - <today>` section, `### Added` ("Test coverage catalog (`docs/TEST-COVERAGE.md`) and `npm run test:coverage` instrumentation"). Keep a Changelog format.
- **No `client/src/whats-new-entries.ts` entry** — behind-the-scenes changes never get one.
- **No hard coverage threshold.** No `thresholds` block in the coverage config, no failing CI on coverage regression this round.
- **Do not modify application code** in Phase 0. Only: `package.json`, `package-lock.json`, `vitest.config.ts`, `.gitignore`, `.github/workflows/test.yml`, `CHANGELOG.md`, and new files under `docs/`.
- **Existing tests are not touched.** `npm test` must still pass unchanged.
- **Format before every commit:** `npm run format` (Prettier owns `.md`, `.ts`, `.yml`).
- **Catalog accuracy rule:** every scenario row's `Status` is set by actually opening the cited source file and the candidate test file — never inferred from a filename. A row is `covered` only if a test asserts the scenario's *outcome*, `partial` if a test touches the code path but not the outcome (or tests it at the wrong level), `gap` otherwise.

---

## Task 1: Add coverage instrumentation

**Files:**
- Modify: `package.json` (devDependencies + scripts)
- Modify: `package-lock.json` (via targeted `npm install`)
- Modify: `vitest.config.ts` (add `test.coverage`)
- Modify: `.gitignore` (add `coverage/`)

**Interfaces:**
- Produces: an `npm run test:coverage` command that runs both Vitest projects with V8 coverage and prints a `text-summary`; a `coverage/` directory (gitignored) containing `index.html` and `coverage-final.json`.

- [ ] **Step 1: Install the coverage provider**

Run:
```bash
npm install --save-dev @vitest/coverage-v8@^5.0.0
```
Expected: `package.json` devDependencies gains `@vitest/coverage-v8`, `package-lock.json` updates. The installed version must match the `vitest` major already present (5.x).

- [ ] **Step 2: Add the `test:coverage` script**

In `package.json` `"scripts"`, add after `"test"`:
```json
"test:coverage": "vitest run --coverage",
```

- [ ] **Step 3: Add the coverage config block**

In `vitest.config.ts`, inside the top-level `test: { ... }` object (a sibling of `projects`), add:
```ts
    coverage: {
      // V8 — the engine both projects already run on (jsdom-on-Node for
      // "unit", real Chromium for "components"); no Istanbul source
      // instrumentation pass needed.
      provider: "v8",
      reporter: ["text-summary", "html", "json"],
      reportsDirectory: "coverage",
      include: ["client/src/**", "src/**"],
      exclude: [
        "**/*.d.ts",
        "client/src/vite-env.d.ts",
        "client/src/main.ts",
        "**/test-support/**",
      ],
      // No `thresholds` — Phase 0 measures only. A floor is a
      // deliberate follow-up once the real baseline number exists.
    },
```

- [ ] **Step 4: Gitignore the report directory**

In `.gitignore`, add a line after `playwright-report/`:
```
coverage/
```

- [ ] **Step 5: Run coverage and verify it produces a report**

Run:
```bash
npm run test:coverage
```
Expected: both projects run (`unit` and `components`), all existing tests still pass, and the run ends with a `% Coverage report from v8` `text-summary` table printed to stdout. `coverage/index.html` and `coverage/coverage-final.json` exist afterward.

- [ ] **Step 6: If the `components` (browser) project errors under coverage**

V8 coverage in Vitest browser mode is collected over CDP and can fail to initialize in some sandboxed CI/dev containers. If Step 5 fails *only* in the `components` project (the `unit` project's coverage works), scope coverage to per-project instead: remove the top-level `coverage` block's effect on the browser project by adding `coverage: { enabled: false }` inside the `components` project's own `test: { ... }` object, and leave a comment:
```ts
          // Browser-mode V8 coverage is collected over CDP and doesn't
          // initialize reliably in this repo's headless container. The
          // component project's coverage signal lives in the catalog's
          // `component` rows instead; `npm run test:coverage` reports the
          // "unit" project (Node/jsdom) only.
          coverage: { enabled: false },
```
Then re-run Step 5 and confirm the `unit` project alone produces the summary. Record which path was taken in the commit message.

- [ ] **Step 7: Commit**

Run:
```bash
npm run format
git add package.json package-lock.json vitest.config.ts .gitignore
git commit -m "test: add @vitest/coverage-v8 and npm run test:coverage"
```

---

## Task 2: Wire a non-blocking coverage summary into CI

**Files:**
- Modify: `.github/workflows/test.yml` (the `test` job, after the existing "Run tests" step)

**Interfaces:**
- Consumes: the `npm run test:coverage` script from Task 1.
- Produces: a CI step that prints the coverage `text-summary` to the job log and uploads `coverage/` as an artifact. Never fails the job on coverage grounds.

- [ ] **Step 1: Add the coverage step**

In `.github/workflows/test.yml`, in the `test:` job's `steps:`, immediately after the `- name: Run tests` step (line ~37) and before `- name: Upload component test screenshots`, insert:
```yaml
      - name: Coverage report
        run: npm run test:coverage
        continue-on-error: true

      - name: Upload coverage report
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: coverage-report
          path: coverage/
          retention-days: 7
          if-no-files-found: ignore
```

Rationale to keep in the diff as a comment above the first step:
```yaml
      # Non-blocking: `npm test` above is the gate. This re-runs the
      # suite with V8 coverage only to publish the summary + html
      # report as a build artifact. `continue-on-error` so a coverage
      # tooling hiccup never blocks a PR — there is no threshold yet.
```

- [ ] **Step 2: Validate the workflow YAML**

Run:
```bash
npx --yes yaml-lint .github/workflows/test.yml 2>/dev/null || node -e "require('js-yaml') && console.log('has js-yaml')" 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/test.yml')); print('valid YAML')"
```
Expected: the file parses as valid YAML (use whichever checker is available; `python3 -c` is the reliable fallback).

- [ ] **Step 3: Commit**

Run:
```bash
npm run format
git add .github/workflows/test.yml
git commit -m "ci: publish a non-blocking coverage summary and html artifact"
```

---

## Task 3: Scaffold `docs/TEST-COVERAGE.md`

**Files:**
- Create: `docs/TEST-COVERAGE.md`

**Interfaces:**
- Produces: the catalog skeleton — preamble, level/status definitions, 14 empty subsystem sections with their source-file lists, and a `## Deferred` section. Tasks 4–17 fill one section each.

- [ ] **Step 1: Write the skeleton**

Create `docs/TEST-COVERAGE.md` with exactly this structure (fill the source-file lists from the spec's subsystem table):

```markdown
# Test Coverage Catalog

A living map of every user-facing scenario the app supports and where it
is tested. Maintained by hand: **every new user-facing behavior, and
every fixed bug, adds a row here** in the same PR.

## How to read this

Each subsystem section is a table of scenarios. One row = one observable
behavior, stated as an outcome ("Deleting a repo-linked doc removes it
from the repo on next push"), not an implementation detail.

**Level** — the level a scenario *should* be tested at (cheapest that
exercises the real risk):

| Level | Meaning | Location |
|-------|---------|----------|
| `unit` | pure function / store, no DOM | `tests/client/src/*.test.ts`, `tests/src/*.test.ts` |
| `component` | one `.svelte` file in real headless Chromium | `tests/client/src/components/*.test.ts` |
| `integration` | Worker / Durable Object in-process, network faked | `tests/src/*.test.ts` |
| `e2e` | full built client, no Worker | `tests/e2e/local/*.spec.ts` |
| `e2e-collab` | full client + real `wrangler dev` Worker + DOs | `tests/e2e/collab/*.spec.ts` |

**Status** — `covered` (a test asserts the outcome) · `partial` (a test
touches the path but not the outcome, or tests it at the wrong level) ·
`gap` (nothing).

**ID** — `<SUBSYS>-NN`, stable, referenced from test names and commit
messages.

---

## 1. Editor core & formatting

_Source: `client/src/app.ts`, `client/src/formatting-commands.ts`, `client/src/components/Editor.svelte`, `client/src/components/Toolbar.svelte`_

| ID | Scenario | Level | Status | Test | Notes |
|----|----------|-------|--------|------|-------|

## 2. Preview, scroll-sync & rendering

_Source: `client/src/components/Preview.svelte`, `client/src/scroll-sync.ts`, `client/src/math-preview.ts`, `client/src/mermaid-preview.ts`, `client/src/diagram-export.ts`, `client/src/diagram-refs.ts`, `client/src/components/DiagramEditor.svelte`_

| ID | Scenario | Level | Status | Test | Notes |
|----|----------|-------|--------|------|-------|

## 3. Markdown dialects

_Source: `client/src/wikilinks.ts`, `client/src/wikilink-rewrite.ts`, `client/src/wikilink-rename-cascade.ts`, `client/src/mmd-citations.ts`, `client/src/mmd-metadata.ts`, `client/src/mmd-inline-blocks.ts`, `client/src/markdown-compat.ts`_

| ID | Scenario | Level | Status | Test | Notes |
|----|----------|-------|--------|------|-------|

## 4. Documents, workspaces & multi-tab

_Source: `client/src/stores/docs.ts`, `client/src/stores/workspaces.ts`, `client/src/merge-records.ts`, `client/src/router.ts`, `client/src/doc-naming.ts`, `client/src/components/DocList.svelte`, `client/src/components/WorkspaceSwitcher.svelte`_

| ID | Scenario | Level | Status | Test | Notes |
|----|----------|-------|--------|------|-------|

## 5. Images

_Source: image paste/drop/pick paths in `client/src/app.ts`, `client/src/image-key.ts`, `client/src/components/ImagesModal.svelte`_

| ID | Scenario | Level | Status | Test | Notes |
|----|----------|-------|--------|------|-------|

## 6. Export & print

_Source: export / print logic in `client/src/app.ts`_

| ID | Scenario | Level | Status | Test | Notes |
|----|----------|-------|--------|------|-------|

## 7. Find & replace / search

_Source: `client/src/search.ts`, `client/src/fuzzy-match.ts`, `client/src/stores/findReplace.ts`, `client/src/components/FindReplaceBar.svelte`_

| ID | Scenario | Level | Status | Test | Notes |
|----|----------|-------|--------|------|-------|

## 8. Version history & diff view

_Source: `client/src/version-grouping.ts`, `client/src/history.ts`, `client/src/version-preview.ts`, `client/src/diff-lines.ts`, `client/src/diff-image-row.ts`, `client/src/components/VersionHistory.svelte`, `client/src/components/DiffView.svelte`, `src/version-grouping.ts`_

| ID | Scenario | Level | Status | Test | Notes |
|----|----------|-------|--------|------|-------|

## 9. Comments

_Source: `client/src/comments.ts`, `client/src/components/CommentsPanel.svelte`, `client/src/stores/commentsPanel.ts`, `client/src/stores/commentDraft.ts`, comment routes in `src/workspace-room.ts`_

| ID | Scenario | Level | Status | Test | Notes |
|----|----------|-------|--------|------|-------|

## 10. Workspace collab

_Source: `client/src/collab.ts`, `src/workspace-room.ts`, `src/collab-room.ts`, `client/src/suggestions.ts`, `src/suggestions.ts`, `client/src/suggestion-editor.ts`, `client/src/suggestion-preview.ts`, `src/access-role.ts`, `src/access-visibility.ts`, `client/src/stores/workspacePresence.ts`_

| ID | Scenario | Level | Status | Test | Notes |
|----|----------|-------|--------|------|-------|

## 11. GitHub auth & Gist

_Source: `src/github-auth.ts`, `src/auth.ts`, `src/env.ts`, `client/src/gist.ts`, `src/gist-images.ts`, `src/memory-fs.ts`_

| ID | Scenario | Level | Status | Test | Notes |
|----|----------|-------|--------|------|-------|

## 12. GitHub repo sync

_Source: `client/src/repo-sync.ts`, `client/src/repo-sync-ui.ts`, `src/github-repo.ts`, `client/src/repo-history-sync.ts`, `client/src/repo-doc-dates.ts`_

| ID | Scenario | Level | Status | Test | Notes |
|----|----------|-------|--------|------|-------|

## 13. Mobile

_Source: mobile layout branches in `client/src/app.ts` and components — bottom sheets, tab switcher, toolbar overflow, input-zoom, scroll sync_

| ID | Scenario | Level | Status | Test | Notes |
|----|----------|-------|--------|------|-------|

## 14. App shell

_Source: `client/src/components/MenuBar.svelte`, `client/src/components/CommandPalette.svelte`, `client/src/components/Modal.svelte`, `client/src/stores/toast.ts`, `client/src/whats-new.ts`, `client/src/whats-new-entries.ts`, `client/src/components/WhatsNew.svelte`, `client/src/focus-mode.ts`, `client/src/debounce.ts`, `client/src/relative-time.ts`, `client/src/anchor.ts`, `client/src/escape-html.ts`, `src/worker.ts` (routing / static-serving fallthrough)_

| ID | Scenario | Level | Status | Test | Notes |
|----|----------|-------|--------|------|-------|

---

## Deferred

Scenarios deliberately not tested, and `it.skip` / `test.fixme` rows
pointing at real bugs awaiting a fix branch.

| ID | Scenario | Why deferred |
|----|----------|--------------|
```

- [ ] **Step 2: Commit**

Run:
```bash
npm run format
git add docs/TEST-COVERAGE.md
git commit -m "docs: scaffold the test coverage catalog"
```

---

## Tasks 4–17: Author one subsystem section each

**Every one of these tasks follows the identical procedure below.** The
only thing that differs per task is the subsystem number/name, the
source files to read, the existing test files to check, and the seed
scenarios (bugs already known from `CHANGELOG.md` / `TODO.md` that must
appear as rows).

### Per-subsystem procedure (applies to Tasks 4–17)

- [ ] **Step A: Read the source.** Open every file in that section's
  `_Source:_` list. For each exported function, component prop/event,
  store, menu action, and server route, note the distinct user-facing
  behaviors and their edge cases (empty input, collision, permission
  denied, offline, malformed data, first-run, mobile).

- [ ] **Step B: Read the candidate tests.** Open every test file whose
  name matches the subsystem (see each task's list). For each, note
  which scenario outcomes it actually asserts.

- [ ] **Step C: Enumerate scenario rows.** Write one row per behavior
  from Step A. Assign `ID` (`<SUBSYS>-NN`, sequential), `Scenario`
  (outcome phrasing), `Level` (cheapest level that exercises the real
  risk — see the spec's guidance), `Status` (`covered` / `partial` /
  `gap`, per the Global Constraints accuracy rule), `Test` (path, or
  `—`), `Notes`.

- [ ] **Step D: Fold in the seed scenarios.** Each task lists specific
  past bugs. Ensure each has a row. If no regression test exists, its
  `Status` is `gap` (or `partial`) with a `Notes` link to the fixing
  commit.

- [ ] **Step E: Prune.** Where Step C produced a combinatorial fan-out
  (every setting × every state), collapse to representative rows and
  note the pruning in `Notes` or the `## Deferred` table.

- [ ] **Step F: Fill the table** in `docs/TEST-COVERAGE.md` for that
  section only.

- [ ] **Step G: Commit.**
  ```bash
  npm run format
  git add docs/TEST-COVERAGE.md
  git commit -m "docs: catalog section <N> — <subsystem name>"
  ```

---

### Task 4: Section 1 — Editor core & formatting

- **Read (source):** `client/src/app.ts` (CodeMirror setup, formatting command wiring, menu/toolbar handlers, export — for this task focus on editor + formatting), `client/src/formatting-commands.ts`, `client/src/components/Editor.svelte`, `client/src/components/Toolbar.svelte`.
- **Read (tests):** `tests/e2e/local/formatting.spec.ts`, `tests/e2e/local/menu-format-insert.spec.ts`, `tests/e2e/local/keybindings.spec.ts`, `tests/e2e/local/toolbar-grouping.spec.ts`, `tests/client/src/stores/keybindings.test.ts`.
- **Seed scenarios (must have rows):**
  - Bold/italic/strike toggle on a selection, and on an empty selection (caret between markers).
  - Heading cycle, list toggle, blockquote, code block, inline code, link insert, horizontal rule.
  - Undo/redo via toolbar and via keyboard.
  - Toolbar overflow menu appears/works when the bar is narrower than its buttons.
  - `CHANGELOG` `0c658b6` — "don't crash the whole toolbar update when `.view-selector` is absent" → a scenario row for "toolbar update is safe when the view-selector / toolbar is not in the DOM (locked viewer)".
  - Toolbar grouping order (media/reference / structural / notation / command-palette-apart) — `IMPROVEMENTS.md` shipped item.

### Task 5: Section 2 — Preview, scroll-sync & rendering

- **Read (source):** `client/src/components/Preview.svelte`, `client/src/scroll-sync.ts`, `client/src/math-preview.ts`, `client/src/mermaid-preview.ts`, `client/src/mermaid-language.ts`, `client/src/diagram-export.ts`, `client/src/diagram-refs.ts`, `client/src/components/DiagramEditor.svelte`.
- **Read (tests):** `tests/e2e/local/preview-rendering.spec.ts`, `tests/client/src/scroll-sync.test.ts`, `tests/client/src/math-preview.test.ts`, `tests/client/src/mermaid-preview.test.ts`, `tests/client/src/mermaid-language.test.ts`, `tests/client/src/diagram-export.test.ts`, `tests/client/src/diagram-refs.test.ts`.
- **Seed scenarios (must have rows):**
  - Markdown → HTML rendering for each block type; sanitization of raw HTML / script (`client/src/escape-html.ts` is used here — cross-link to Section 14).
  - Editor↔preview scroll sync in both directions; sync with images/large blocks; sync when preview is hidden then shown.
  - KaTeX math: inline `$…$`, block `$$…$$`, malformed expression fallback.
  - Mermaid: valid diagram renders; invalid diagram shows an error, not a crash; diagram source round-trips (`TODO.md` item 12 — committing a mermaid diagram must include its source, not just the ref name).
  - Diagram editor: open, edit, save back into the document.

### Task 6: Section 3 — Markdown dialects

- **Read (source):** `client/src/wikilinks.ts`, `client/src/wikilink-rewrite.ts`, `client/src/wikilink-rename-cascade.ts`, `client/src/mmd-citations.ts`, `client/src/mmd-metadata.ts`, `client/src/mmd-inline-blocks.ts`, `client/src/markdown-compat.ts`, `src/wikilink-rewrite.ts`.
- **Read (tests):** `tests/client/src/wikilinks.test.ts`, `tests/client/src/wikilink-rewrite.test.ts`, `tests/client/src/wikilink-rename-cascade.test.ts`, `tests/client/src/mmd-citations.test.ts`, `tests/client/src/mmd-metadata.test.ts`, `tests/client/src/mmd-inline-blocks.test.ts`, `tests/client/src/markdown-compat.test.ts`, `tests/client/src/mmd-*.test.ts`, `tests/src/wikilink-rewrite.test.ts`, `tests/e2e/local/mmd-syntax.spec.ts`, `tests/e2e/local/mmd-citations.spec.ts`, `tests/e2e/local/slash-and-wikilinks.spec.ts`.
- **Seed scenarios (must have rows):**
  - `[[Wikilink]]` autocomplete, resolution, backlinks panel, click-to-navigate, link to nonexistent doc.
  - Rename cascade: renaming a doc rewrites `[[old]]` → `[[new]]` across all docs; collision handling (`RenameCollisionModal`).
  - MMD metadata block round-trips as `Key: Value` on import/export.
  - `CHANGELOG` `029af44` — "also escape the `--!>` HTML comment-closing sequence in metadata" → a row for "metadata containing `-->` / `--!>` is escaped so it can't break out of its HTML comment wrapper".
  - Citations `[@key]` / `[#key]`: numbered style, author-year style, unresolved key, bibliography from typed text vs structured Document Info.
  - Definition lists, superscript, subscript.
  - Markdown-compat checker flags app-only and flavor-specific syntax.

### Task 7: Section 4 — Documents, workspaces & multi-tab

- **Read (source):** `client/src/stores/docs.ts`, `client/src/stores/workspaces.ts`, `client/src/merge-records.ts`, `client/src/router.ts`, `client/src/doc-naming.ts`, `client/src/stores/docList.ts`, `client/src/components/DocList.svelte`, `client/src/components/WorkspaceSwitcher.svelte`, `client/src/components/MoveToWorkspaceModal.svelte`, `client/src/components/DocEditModal.svelte`.
- **Read (tests):** `tests/client/src/stores/docs.test.ts`, `tests/client/src/stores/workspaces.test.ts`, `tests/client/src/merge-records.test.ts`, `tests/client/src/router.test.ts`, `tests/client/src/doc-naming.test.ts`, `tests/client/src/wikilink-rename-cascade.test.ts`, `tests/client/src/components/DocEditModal.test.ts`, `tests/e2e/local/documents.spec.ts`, `tests/e2e/local/doc-info-edit-modal.spec.ts`, `tests/e2e/local/view-mode.spec.ts`.
- **Seed scenarios (must have rows):**
  - Create / rename / delete / duplicate a document; unique-name enforcement (silent `-2` suffix).
  - Switch active document; active-document-deleted fallback.
  - Create / rename / delete / switch workspace; migration of pre-workspace users to a default workspace.
  - Move a document between workspaces.
  - `TODO.md` multi-tab item — two tabs open, a save in one tab must merge-by-record (not blind-overwrite) so the other tab's unrelated docs/workspaces survive (`merge-records.ts`); deletion still works through the merge.
  - `TODO.md` tab-per-document routing — `/d/<docId>` URL reflects/drives active doc; deep link; browser back/forward; sidebar rows are real links (Ctrl/Cmd-click opens a new tab).

### Task 8: Section 5 — Images

- **Read (source):** image paste/drop/file-pick handlers in `client/src/app.ts`, `client/src/image-key.ts`, `client/src/components/ImagesModal.svelte`, `client/src/stores/imagesModal.ts`.
- **Read (tests):** `tests/client/src/image-key.test.ts`, `tests/e2e/local/images.spec.ts`.
- **Seed scenarios (must have rows):**
  - Paste / drop / pick an image → `![](ref)` inserted, resolved against the doc image map.
  - 2 MB cap enforced with a message.
  - Filename sanitization (`CHANGELOG` — a sanitization bug was why images "couldn't be imported"): odd filenames, uppercase, spaces, unicode.
  - Images Modal: browse uploaded images, insert an existing one, replace an image's file in place (ref/position kept).
  - Duplicate-image dedup by content (`image-key.ts`).

### Task 9: Section 6 — Export & print

- **Read (source):** export handlers (Markdown / HTML / PDF-via-print) and print CSS wiring in `client/src/app.ts`.
- **Read (tests):** `tests/e2e/local/export.spec.ts`, `tests/e2e/local/print.spec.ts`.
- **Seed scenarios (must have rows):**
  - Export to `.md` (content fidelity — images inlined or referenced per the export mode).
  - Export to HTML (styles inlined, renders standalone).
  - Print / PDF path opens the print view with preview-styled content.
  - Export a document with images, mermaid, math, citations — each survives the round-trip.
  - Export filename derives from the document name (sanitized).

### Task 10: Section 7 — Find & replace / search

- **Read (source):** `client/src/search.ts`, `client/src/fuzzy-match.ts`, `client/src/stores/findReplace.ts`, `client/src/components/FindReplaceBar.svelte`.
- **Read (tests):** `tests/client/src/search.test.ts`, `tests/client/src/fuzzy-match.test.ts`, `tests/client/src/stores/findReplace.test.ts`, `tests/client/src/components/FindReplaceBar.test.ts`, `tests/e2e/local/search-and-replace.spec.ts`.
- **Seed scenarios (must have rows):**
  - Find: next/prev, wrap-around, match count, case-sensitive toggle, regex toggle, whole-word toggle, no-match state.
  - Replace one / replace all; replace with regex capture groups.
  - Bar open/close via shortcut and button; query persists across close/reopen per the store's design.
  - Fuzzy match ranking (used by Command Palette / wikilink menu — cross-link to Section 14).

### Task 11: Section 8 — Version history & diff view

- **Read (source):** `client/src/version-grouping.ts`, `client/src/history.ts`, `client/src/version-preview.ts`, `client/src/diff-lines.ts`, `client/src/diff-image-row.ts`, `client/src/components/VersionHistory.svelte`, `client/src/components/DiffView.svelte`, `src/version-grouping.ts`.
- **Read (tests):** `tests/client/src/version-grouping.test.ts`, `tests/client/src/version-preview.test.ts`, `tests/client/src/history.test.ts`, `tests/client/src/diff-lines.test.ts`, `tests/client/src/diff-image-row.test.ts`, `tests/client/src/version-grouping.test.ts`, `tests/client/src/components/VersionHistory.test.ts`, `tests/src/version-grouping.test.ts`, `tests/e2e/local/version-history-grouping.spec.ts`.
- **Seed scenarios (must have rows):**
  - Snapshot capture cadence (30s) and session grouping (30-min gap = new session); collapsed session shows final state.
  - Diff any two selected entries; diff an entry against live content.
  - `TODO.md` — GitHub-style diff: line numbers, word-level intraline highlight, Split/Unified toggle.
  - `TODO.md` — image diffs render before/after thumbnails in Split and Unified, for local docs, shared docs, legacy collab-room docs, and repo-commit diffs; restore brings images back.
  - `TODO.md` — an image-reference-format normalization must not show as a diff.
  - `TODO.md` item 19 — "restore" button disabled when the selected entry is already the current revision.
  - Restore a version → content + images replaced, a new snapshot recorded.

### Task 12: Section 9 — Comments

- **Read (source):** `client/src/comments.ts`, `client/src/components/CommentsPanel.svelte`, `client/src/stores/commentsPanel.ts`, `client/src/stores/commentDraft.ts`, comment HTTP routes in `src/workspace-room.ts`.
- **Read (tests):** `tests/client/src/comments.test.ts`, `tests/e2e/local/comments.spec.ts`, and any comment assertions in `tests/src/workspace-room.test.ts`.
- **Seed scenarios (must have rows):**
  - Add a comment on a selection; anchor survives edits above/below/inside the anchored range; anchor orphaned when its text is deleted.
  - Reply to a thread; resolve / reopen a thread.
  - `IMPROVEMENTS.md` Phase 1 open item — "replying to a comment or marking one resolved is broken in practice (confirmed 2026-08-13)": add a row per the two roles (`reviewer`, `editor`) doing reply + resolve on a real shared doc; `Status` `gap`, `Notes` "unreproduced — needs an `e2e-collab` repro with two authenticated roles", and add it to `## Deferred` pointing at a future fix branch.
  - Unresolved-count badge on the topbar icon and File menu entry.
  - Per-role comment permissions (viewer/reviewer/editor) match each role's documented access.
  - Comments panel open/close animation parity with the workspace panel (`TODO.md` item 9) — a `component` or `e2e` row for "panel collapses fully with no leftover sliver".

### Task 13: Section 10 — Workspace collab

- **Read (source):** `client/src/collab.ts`, `src/workspace-room.ts`, `src/collab-room.ts`, `client/src/suggestions.ts`, `src/suggestions.ts`, `client/src/suggestion-editor.ts`, `client/src/suggestion-preview.ts`, `src/access-role.ts`, `src/access-visibility.ts`, `client/src/stores/workspacePresence.ts`, `client/src/components/Share.svelte`, `client/src/components/JoinWorkspaceModal.svelte`, `client/src/components/ShareChoiceModal.svelte`, `client/src/components/WorkspaceAccessBanner.svelte`.
- **Read (tests):** `tests/client/src/collab.test.ts`, `tests/client/src/suggestion-editor.test.ts`, `tests/client/src/suggestion-preview.test.ts`, `tests/client/src/components/JoinWorkspaceModal.test.ts`, `tests/client/src/components/WorkspaceAccessBanner.test.ts`, `tests/client/src/components/SignedOutIndicator.test.ts`, `tests/src/workspace-room.test.ts`, `tests/src/collab-room.test.ts`, `tests/src/suggestions.test.ts`, `tests/src/access-role.test.ts`, all six `tests/e2e/collab/*.spec.ts`.
- **Seed scenarios (must have rows):**
  - Two editors typing concurrently converge (CRDT).
  - Presence: who's-looking-at-what across documents (`MESSAGE_PRESENCE`).
  - Legacy `CollabRoom` single-doc link migrates to a fresh `WorkspaceRoom` on open, before live sync attaches.
  - Roles resolved server-side by `authorize()`: owner→editor; `generalAccess:"anyone"`→link role; invited-username→that entry. Client role is display-only.
  - Viewer: no edit surface at all (Preview-only). **`gap` per the spec.**
  - Reviewer: edit becomes a tracked suggestion; editor accepts / rejects; reviewer withdraws.
  - `CHANGELOG` `f723634` / `61da45e` — "shared documents duplicating content on refresh" → an `e2e-collab` row; likely `gap`.
  - `CHANGELOG` `b0a1b9b` / `d6df5ad` — "document created after a workspace connection is already live is discovered by connected peers" → covered by `workspace-structure-sync.spec.ts`, verify.
  - `CHANGELOG` `bb938d9` — "`identityUnverified` doesn't get stuck false after a redundant rejoin".
  - `CHANGELOG` 1.45.0 — a not-yet-bound document's role is the session's resolved role, never a stale lookup falling back to "editor".
  - Workspace meta sync (name + doc-order + deletion) — `MESSAGE_WORKSPACE_META`; covered by `workspace-structure-sync.spec.ts`, verify depth.
  - Share modal: generate link, set general access, invite a username with a role, revoke.
  - Preview-a-shared-workspace (never persisted) vs "Keep this workspace"; zero-workspace receiver lands permanently.
  - Single-doc share → lands as its own new workspace named after the doc, no modal.
  - `WorkspaceAccessBanner` — access denied / session expired / role changed.
- **Split note:** if this section's rows exceed ~1 day of later test work, the *phase* (not this cataloguing task) splits into 10a (WorkspaceRoom/CollabRoom integration) and 10b (`collab.ts` client + `e2e-collab`). Note the recommended split in the section's intro text.

### Task 14: Section 11 — GitHub auth & Gist

- **Read (source):** `src/github-auth.ts`, `src/auth.ts`, `src/env.ts`, `client/src/gist.ts`, `client/src/stores/gist.ts`, `client/src/stores/github.ts`, `src/gist-images.ts`, `src/memory-fs.ts`, `client/src/components/GithubSignInModal.svelte`, `client/src/components/OpenGistModal.svelte`, `client/src/components/GistVisibilityDialog.svelte`.
- **Read (tests):** `tests/src/auth.test.ts`, `tests/src/github-auth.test.ts`, `tests/src/gist-images.test.ts`, `tests/client/src/gist.test.ts`, `tests/client/src/components/GistVisibilityDialog.test.ts`, `tests/src/test-support/fake-github-server.test.ts`.
- **Seed scenarios (must have rows):**
  - OAuth round-trip: redirect, callback, token encrypted into an HttpOnly session cookie, client only ever sees the username.
  - `feedback_local_testing_github_auth` memory — `handleMe` re-verifies the token against the real GitHub API; expired/revoked token → signed-out state.
  - Session cookie crypto: sign/verify, tamper rejection, expiry (`src/auth.ts`).
  - Publish current doc as a new Gist (public vs secret chosen at creation only); update the linked Gist.
  - Images in a published Gist pushed as real git blobs (`gist-images.ts` + `memory-fs.ts`); markdown rewritten to reference them.
  - `CHANGELOG` — Gist API filename-matching bug: renaming then updating must not create a duplicate file.
  - Open a Gist by URL / ID / from the user's list → new local doc; inline base64 images converted back to local refs.
  - Signed-out: Gist / repo actions are gated; `3c75e6d` — "skip repo-commits requests entirely when signed out".

### Task 15: Section 12 — GitHub repo sync

- **Read (source):** `client/src/repo-sync.ts`, `client/src/repo-sync-ui.ts`, `src/github-repo.ts`, `client/src/repo-history-sync.ts`, `client/src/repo-doc-dates.ts`, `client/src/stores/repoSync.ts`, `client/src/components/OpenRepoModal.svelte`, `client/src/components/RepoLinkModal.svelte`, `client/src/components/RepoConflictModal.svelte`, `client/src/components/RepoPicker.svelte`.
- **Read (tests):** `tests/client/src/repo-sync.test.ts`, `tests/client/src/repo-history-sync.test.ts`, `tests/client/src/repo-doc-dates.test.ts`, `tests/src/github-repo.test.ts`, `tests/client/src/test-support/fake-repo-backend.test.ts`, `tests/src/test-support/fake-github-server.test.ts`.
- **Seed scenarios (must have rows):**
  - Link a workspace to a repo → pull every `.md` recursively as documents.
  - Push local changes as one commit via the Git Data API; per-file SHA conflict detection → conflict modal, never a silent overwrite.
  - `TODO.md` item 11 — unlink then relink to the same repo must not duplicate files.
  - `TODO.md` item 13 — linking to an existing repo does name-collision management.
  - `TODO.md` "New Bugs" — deleting a repo-linked doc locally deletes it in the repo on next push (via `pendingRepoDeletions`); renaming a doc renames the repo path (detected against last-pushed path); a pre-existing untouched repo path is never deleted.
  - `TODO.md` item 12 — a doc with a mermaid diagram pushes the diagram *source*, not just its ref name; filenames not force-lowercased.
  - `TODO.md` item 6 — linking renames the workspace to the repo name only if still the generic default name.
  - `TODO.md` items 16 / 8 — Document Info created/modified dates derived from commit history; diffs between commits.
  - `TODO.md` item 17 — no separate initial commit; repo initialized as-is.
  - `TODO.md` items 15 / 22 — opening a repo dismisses the modal (progress toast instead); `repo-doc-dates` deterministic image refs on pull (no spurious diff).
  - Repo store workspace metadata (`.md` structure file) round-trips (`TODO.md` item 10).

### Task 16: Section 13 — Mobile

- **Read (source):** mobile branches in `client/src/app.ts` (viewport detection, bottom-sheet wiring), the mobile paths in `MenuBar.svelte`, `Toolbar.svelte`, `DocList.svelte`, `CommentsPanel.svelte`, plus `client/src/focus-mode.ts` mobile behavior.
- **Read (tests):** `tests/e2e/local/mobile-input-zoom.spec.ts`, `tests/e2e/local/mobile-menu-overflow.spec.ts`, `tests/e2e/local/mobile-scroll-sync.spec.ts`, `tests/e2e/local/mobile-toolbar-and-sheets.spec.ts`.
- **Seed scenarios (must have rows):**
  - Stacked layout (editor above preview) below the mobile breakpoint.
  - Document sidenav and comments open as bottom-sheet modals; tap-outside / close-button dismiss; sheet resets to "Documents" tab on open.
  - Tabbed document/headings switcher; headings tab is read-only navigation.
  - `IMPROVEMENTS.md` — View menu dropdown must not overflow the right edge (runtime overflow flip); every menu-bar dropdown, not just one hardcoded item.
  - `IMPROVEMENTS.md` — Share dialog "Anyone with the link" label not truncated on mobile Safari width.
  - `IMPROVEMENTS.md` — workspace switcher "Preview" badge stays within the sidebar edge (`display: contents` on the mount).
  - Input font-size ≥ 16px so iOS doesn't zoom on focus (`mobile-input-zoom`).
  - Toolbar overflow on narrow widths.

### Task 17: Section 14 — App shell

- **Read (source):** `client/src/components/MenuBar.svelte`, `client/src/components/CommandPalette.svelte`, `client/src/stores/commandPalette.ts`, `client/src/components/Modal.svelte`, `client/src/stores/toast.ts`, `client/src/components/Toast.svelte`, `client/src/whats-new.ts`, `client/src/whats-new-entries.ts`, `client/src/components/WhatsNew.svelte`, `client/src/focus-mode.ts`, `client/src/stores/focusMode.ts`, `client/src/debounce.ts`, `client/src/relative-time.ts`, `client/src/anchor.ts`, `client/src/escape-html.ts`, `client/src/components/Toggletip.svelte`, `client/src/components/ConfirmDialog.svelte`, `src/worker.ts` (route dispatch + static asset fallthrough).
- **Read (tests):** `tests/client/src/whats-new.test.ts`, `tests/client/src/whats-new-entries.test.ts`, `tests/client/src/focus-mode.test.ts`, `tests/client/src/debounce.test.ts`, `tests/client/src/relative-time.test.ts`, `tests/client/src/anchor.test.ts`, `tests/client/src/stores/toast.test.ts`, `tests/client/src/components/WhatsNew.test.ts`, `tests/client/src/components/Toggletip.test.ts`, `tests/e2e/local/focus-mode.spec.ts`, `tests/e2e/local/whats-new.spec.ts`, `tests/e2e/local/menu-format-insert.spec.ts`.
- **Seed scenarios (must have rows):**
  - Command Palette: open, fuzzy filter, run a command, keyboard nav, close; every registered command reachable.
  - Menu bar: every menu opens, every item dispatches; dropdown overflow handling (cross-link Section 13).
  - Modal: focus trap, Esc closes, backdrop click, scroll lock, header/content/footer structure.
  - Toast: enqueue, auto-dismiss, manual dismiss, stacking, progress toast.
  - What's New: shows once per version; `WhatsNew.svelte` dev warning when the last entry's version ≠ `__APP_VERSION__`; entries oldest-first.
  - Focus mode: toggle, hides chrome, stateless-by-default on reopen.
  - `escape-html.ts` — every HTML metacharacter escaped (used by preview + metadata).
  - `relative-time.ts` — "today / yesterday / Nd ago / date" thresholds (`TODO.md` item 4).
  - `worker.ts` — unknown `/api/*` route → 404; non-API path → serves the built client `index.html` (SPA fallback); `/api` routes dispatch to the right handler.

---

## Task 18: Final consistency pass, version bump, changelog

**Files:**
- Modify: `docs/TEST-COVERAGE.md` (fixes found in review)
- Modify: `package.json`, `package-lock.json` (version)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the completed catalog from Tasks 4–17.

- [ ] **Step 1: Cross-check every documented bug has a row**

Run:
```bash
git log v1.20.0..HEAD --oneline | grep -iE '^\w+ fix' 
```
For each fix commit, confirm `docs/TEST-COVERAGE.md` has a scenario row referencing it (in `Test` if a regression test exists, in `Notes` + `Status: gap` otherwise). Also walk `TODO.md`'s "Bugs" / "New Bugs" lists and `IMPROVEMENTS.md` Phase 1. Add any missing rows to the right section.

- [ ] **Step 2: Verify ID uniqueness and level/status vocabulary**

Run:
```bash
grep -oE '\| [A-Z]+-[0-9]+ ' docs/TEST-COVERAGE.md | sort | uniq -d
```
Expected: no output (no duplicate IDs). Then eyeball that every `Level` cell is one of `unit|component|integration|e2e|e2e-collab` and every `Status` cell is one of `covered|partial|gap`.

- [ ] **Step 3: Tally and record the baseline**

Add a short `## Baseline (v1.45.2)` section just under "How to read this": total scenarios, and the `covered` / `partial` / `gap` counts per subsystem as a table. Paste the `npm run test:coverage` `text-summary` numbers (overall % lines / % branches) into that section as the coverage baseline.

Run:
```bash
npm run test:coverage
```

- [ ] **Step 4: Version bump**

In `package.json`: `"version": "1.45.0"` → `"version": "1.45.2"`.
In `package-lock.json`: both `"version": "1.45.0"` occurrences (lines ~3 and ~9) → `"1.45.2"`.

- [ ] **Step 5: Changelog**

In `CHANGELOG.md`, add directly under the title block, above `## [1.45.0]`:
```markdown
## [1.45.2] - <today's date>

### Added

- **A test coverage catalog (`docs/TEST-COVERAGE.md`)** enumerating every user-facing scenario per subsystem and its current automated-test status, plus `npm run test:coverage` (V8 coverage instrumentation) and a non-blocking CI coverage summary. Groundwork for a maintenance-phase pass that closes the catalogued gaps subsystem by subsystem.
```

- [ ] **Step 6: Full verification**

Run:
```bash
npm test && npm run typecheck && npm run format:check && npm run build
```
Expected: all pass. (`format:check` will fail if Step-earlier `npm run format` wasn't run — run `npm run format` and re-stage if so.)

- [ ] **Step 7: Commit**

```bash
npm run format
git add docs/TEST-COVERAGE.md package.json package-lock.json CHANGELOG.md
git commit -m "docs: complete test coverage catalog + v1.45.2 baseline"
```

- [ ] **Step 8: Push and open the PR**

```bash
git push -u origin <branch>
gh pr create --base master --title "Test coverage catalog + coverage instrumentation (Phase 0)" --body "$(cat <<'EOF'
Phase 0 of the maintenance-phase test effort — see `docs/superpowers/specs/2026-09-06-test-coverage-catalog-design.md`.

- Adds `@vitest/coverage-v8`, `npm run test:coverage`, and a non-blocking CI coverage summary + html artifact.
- Adds `docs/TEST-COVERAGE.md`: every user-facing scenario per subsystem, its intended test level, and its current status (covered / partial / gap), with a v1.45.2 baseline tally.
- No application code changes. Patch bump to v1.45.2.

Phases 1–13 (one per subsystem) each get their own short plan written from the finished catalog.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Coverage instrumentation (spec §Architecture "Coverage instrumentation") → Tasks 1, 2. ✅
- Non-blocking, no threshold (spec §Non-goals) → Task 1 Step 3 comment, Task 2 `continue-on-error`. ✅
- Catalog document, 14 sections, level/status vocab, per-row schema (spec §Architecture "The catalog document") → Task 3 skeleton + Tasks 4–17. ✅
- Status accuracy rule (spec §Components) → Global Constraints "Catalog accuracy rule" + per-subsystem Step B/C. ✅
- Recently-fixed bugs each become a row (spec §Architecture) → seed scenarios in every subsystem task + Task 18 Step 1 cross-check. ✅
- `## Deferred` section (spec §Architecture) → Task 3 skeleton; Task 12 (comments reply/resolve) and Task 13 (viewer no-edit-surface `gap`) explicitly feed it. ✅
- Level definitions (spec §Architecture) → Task 3 skeleton table. ✅
- Versioning: patch, CHANGELOG, no whats-new (spec §Versioning) → Global Constraints + Task 18. ✅
- Phases 1–13 planned later from the catalog (spec §Components) → stated in header + PR body. ✅
- Review prompt defaults (14 phases; `docs/TEST-COVERAGE.md`; split-at-execution) → all three followed. ✅

**Placeholder scan:** Tasks 4–17 share one procedure by design (research tasks, not code) but each carries its own concrete source list, test list, and seed scenarios — not "similar to Task N". No "TBD"/"add error handling"/"write tests for the above". Config and YAML snippets are literal. ✅

**Type consistency:** No code interfaces produced beyond the `npm run test:coverage` script name and the `coverage/` path, both used consistently in Tasks 1, 2, 18. Catalog ID format `<SUBSYS>-NN` used consistently. ✅

---

## After Phase 0

Each subsequent phase gets a plan named `docs/superpowers/plans/2026-XX-XX-test-coverage-phase-<N>-<subsystem>.md`, written directly from that subsystem's finished catalog section: one task per cluster of related gap rows, real find/change-to test code, TDD, the bug-bundling rule from the spec, a patch bump, and a `CHANGELOG` `### Changed` entry.
