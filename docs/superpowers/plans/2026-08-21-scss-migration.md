# SCSS Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `client/src/style.css` (3946 lines, one flat file) into 15 SCSS partials organized by UI/component area, under `client/src/styles/`, with zero change to compiled CSS output.

**Architecture:** One partial extracted per task, in a fixed order, each verified against a compiled-output baseline captured before any extraction begins — so every task's diff check compares against the *original* file's behavior, not the previous task's.

**Tech Stack:** Sass (`sass` npm package, Vite's built-in Sass support), Prettier (already installed, used to normalize compiled CSS for diffing).

**Spec:** `docs/superpowers/specs/2026-08-21-scss-migration-design.md`

## Global Constraints

- No CSS custom property (`var(--x)`) becomes an SCSS `$variable` — `:root`/`[data-theme="dark"]` blocks are copied verbatim. (Spec Goals.)
- No Sass features beyond `@use` and `&`-nesting — no mixins, functions, loops. (Spec Non-goals.)
- No selector/class/ID renamed. Compiled output must be identical to the pre-migration baseline after every task, not just at the end. (Spec Goals, Non-goals.)
- A multi-selector CSS rule (e.g. `.icon-btn:active, .share-pill:active, .primary-btn:active { ... }`) whose selectors span more than one partial's assignment stays intact in whichever partial owns the majority of its selectors — never split across files. (Discovered while mapping selectors to partials; not in the original spec, follows directly from the spec's "no compiled-output change" rule.)
- `client/src/main.ts:12`'s `import "./style.css";` becomes `import "./style.scss";` — done once, in Task 1. (Spec Goals.)

## Selector-to-partial assignment

(Derived by reading every top-level selector in `client/src/style.css` — this is the concrete mapping every extraction task below uses. "Base" rules — `:root`, `[data-theme="dark"]`'s custom-property block, `*`, `html, body`, and the later standalone `body { transition: ... }` — go to `_variables.scss`, not listed per-selector since they're not class/ID selectors.)

- **`_topbar.scss`**: `#brand`, `#topbar`, `#topbar-row`, `#topbarActionsCol`, `#topbarRow1`, `.topbar-actions`, `.topbar-row`, `#toolbar`, `#toolbar-mount`, `.toolbar-buttons`, `.toolbar-overflow`, `.toolbar-overflow-menu`
- **`_sidebar.scss`**: `#sidebar`, `#sidebarHeader`, `#sidebarHeaderLeft`, `#sidebarToggleOut`, `#docList`, `#doclist-mount`, `.doc-row`, `.doc-row-link`, `.doc-menu-btn`, `.doc-menu-popover`, `.doc-menu-submenu-label`, `.doc-outline`, `.doc-outline-toggle`, `.doc-outline-toggle-spacer`, `.doclist-headings-tab-label`, `.doclist-presence`, `.doclist-tabs`, `#docTitle`, `#docTitleMirror`
- **`_editor-preview.scss`**: `#editor-mount`, `#editorPane`, `#editorWrap`, `#preview`, `#preview-mount`, `#previewPane`, `.outline-item`, `.outline-list`, `.focus-mode-exit-btn`, `.view-selector`, `.katex` (if present as an actual rule, not just the top-of-file `@import`)
- **`_statusbar.scss`**: `#statusbar`, `.statusbar-link`, `.status-dot`, `#saveStatusBtn`, `.save-status-popup`
- **`_menu.scss`**: `#menuBar`, `#menubar-mount`, `.menu-check`, `.menu-chevron`, `.menu-divider`, `.menu-glyph-btn`, `.menu-item`, `.menu-link`, `.menu-recent-empty`, `.menu-recent-item`, `.menu-recent-name`, `.menu-recent-time`, `.menu-section-label`, `.menu-section-sublabel`, `.menu-submenu`, `.menu-submenu-panel`, `.menu-submenu-trigger`, `.menu-view-btn`, `.menubar-btn`, `.menubar-menu`, `.keybinding-mode-indicator`
- **`_command-palette.scss`**: `.command-palette`, `.command-palette-backdrop`, `.command-palette-input`, `.command-palette-input-row`, `.command-palette-results`, `.command-palette-row`
- **`_modals.scss`**: `.modal-actions`, `.modal-actions-share`, `.modal-backdrop`, `.modal-body`, `.modal-box`, `.modal-box-v2`, `.modal-box-wide`, `.modal-close-btn`, `.modal-content`, `.modal-field`, `.modal-footer`, `.modal-header`, `.modal-hint`, `.modal-tabs`, `.about-brand`, `.about-links`, `.about-title`, `.about-version`, `.setting-desc`, `.setting-label`, `.setting-row`, `.setting-title`, `.settings-row`, `.custom-css-input`, `.shortcuts-list`, `.shortcuts-row`, `.whats-new-counter`, `.whats-new-nav`, `.whats-new-screenshot`, `.whats-new-slide`, `.whats-new-text`
- **`_comments.scss`**: `.comment-add-btn`, `.comment-body`, `.comment-delete-btn`, `.comment-draft-actions`, `.comment-draft-anchor`, `.comment-draft-box`, `.comment-entry`, `.comment-entry-quote`, `.comment-orphaned-label`, `.comment-reply-row`, `.comments-panel`, `.comments-panel-header`, `.comments-panel-list`
- **`_share-workspace.scss`**: `.share-access-icon`, `.share-access-mirror`, `.share-access-row`, `.share-access-select`, `.share-access-text`, `.share-add-people-input`, `.share-btn-group`, `.share-name-row`, `.share-people-list`, `.share-person`, `.share-person-name`, `.share-person-remove`, `.share-person-role`, `.share-pill`, `.share-role-select`, `.share-row`, `.presence-avatar`, `.presence-avatar-sm`, `.presence-bar`, `.workspace-list`, `.workspace-new-btn`, `.workspace-rename-input`, `.workspace-row`, `.workspace-row-name`, `.workspace-switcher`, `.workspace-switcher-popover`, `.workspace-switcher-trigger`
- **`_diagram-editor.scss`**: `.diagram-editor-body`, `.diagram-editor-code-host`, `.diagram-editor-header`, `.diagram-editor-overlay`, `.diagram-editor-preview`, `.diagram-editor-preview-wrap`, `.diagram-editor-reference`, `.diagram-preview-reset`, `.diagram-template-card`, `.diagram-template-grid`, `.diagram-template-or`, `.diagram-template-picker`
- **`_diff-view.scss`**: `.diff-image-loading`, `.diff-image-thumb`, `.diff-view`, `.diff-view-cell`, `.diff-view-gutter`, `.diff-view-mode-toggle`, `.diff-view-row`, `.diff-view-unified`, `.version-history-actions`, `.version-history-body`, `.version-history-current`, `.version-history-header`, `.version-history-list`, `.version-history-overlay`, `.version-history-preview`, `.version-history-preview-wrap`, `.version-history-row`, `.version-history-row-label`, `.version-history-view-toggle`, `.doc-info-backlink-row`, `.doc-info-backlinks`, `.doc-info-link`, `.doc-info-primary`, `.doc-info-row`, `.doc-info-secondary`
- **`_slash-wikilink.scss`**: `.slash-menu`, `.slash-menu-row`
- **`_utilities.scss`**: `.dropdown`, `.dropdown-divider`, `.dropdown-menu`, `.dropdown-text`, `.dropdown-text-desc`, `.dropdown-text-title`, `.empty-state`, `.empty-state-actions`, `.empty-state-desc`, `.empty-state-icon`, `.empty-state-inner`, `.empty-state-title`, `.gist-item`, `.hint-text`, `.hint-toggle-btn`, `.icon`, `.icon-btn`, `.image-item`, `.image-unused-label`, `.images-list`, `.primary-btn`, `.secondary-btn`, `.danger-btn`, `.sep`, `.skeleton`, `.spacer`, `.sr-only`, `.desktop-only`, `.tab-switch`, `.tab-switch-btn`, `.toast`, `.toast-close`, `.toast-error`, `.toast-message`, `.toast-stack`, `.toast-success`, `.toggletip`, `.toggletip-bubble`, plus the "Animation/Transitions" section near the file's end (the `.icon-btn:active, .share-pill:active, .primary-btn:active, .secondary-btn:active, .danger-btn:active` rule, `input, textarea, select` focus-transition rule, `@keyframes shimmer`) — kept together per the multi-selector rule in Global Constraints.
- **`_layout.scss`**: `#app`, `#body`, `#main`, `#content-row`, `#divider`, `.pane`

For any selector encountered during extraction that isn't in this list (the mapping was built from a `grep` of top-level selectors and may have missed something nested or a selector variant), assign it to whichever partial its neighboring rules in the original file belong to, and note the addition in that task's commit message.

---

### Task 1: SCSS tooling setup, unsplit rename, and baseline capture

**Files:**
- Create: `client/src/style.scss` (renamed from `client/src/style.css`, content unchanged)
- Delete: `client/src/style.css`
- Modify: `client/src/main.ts:12`, `package.json`, `package-lock.json`
- Create: `scripts/verify-scss-migration.sh` (temporary — deleted in the final task)

**Interfaces:**
- Produces: `scripts/verify-scss-migration.sh`, invoked identically by every later task as `bash scripts/verify-scss-migration.sh` (no arguments — compares the current compiled `client/src/style.scss` against the fixed baseline this task captures).

- [ ] **Step 1: Install `sass`**

```bash
npm install --save-dev sass
```

- [ ] **Step 2: Rename `style.css` to `style.scss`, unsplit (content identical)**

```bash
git mv client/src/style.css client/src/style.scss
```

- [ ] **Step 3: Update the import in `main.ts`**

In `client/src/main.ts`, change line 12 from:

```typescript
import "./style.css";
```

to:

```typescript
import "./style.scss";
```

- [ ] **Step 4: Create the verification script**

```bash
#!/usr/bin/env bash
# TEMPORARY — used only during the SCSS migration
# (docs/superpowers/plans/2026-08-21-scss-migration.md). Deleted in that
# plan's final task. Compiles client/src/style.scss, normalizes it
# through Prettier so formatting differences don't create false-positive
# diffs, and compares against the fixed baseline captured once at the
# start of the migration (BASELINE_FILE) — every task's compiled output
# must match this same baseline, not the previous task's output, so a
# mistake anywhere is caught immediately rather than silently
# compounding.
set -euo pipefail
cd "$(dirname "$0")/.."

BASELINE_FILE="/tmp/scss-migration-baseline.css"
CURRENT_FILE="/tmp/scss-migration-current.css"

npx sass --no-source-map --style=expanded client/src/style.scss | npx prettier --parser css > "$CURRENT_FILE"

if [ "${1:-}" = "--save-baseline" ]; then
  cp "$CURRENT_FILE" "$BASELINE_FILE"
  echo "Baseline saved to $BASELINE_FILE"
  exit 0
fi

if [ ! -f "$BASELINE_FILE" ]; then
  echo "No baseline found at $BASELINE_FILE — run with --save-baseline first." >&2
  exit 1
fi

if diff -q "$BASELINE_FILE" "$CURRENT_FILE" > /dev/null; then
  echo "MATCH: compiled output is identical to the baseline."
else
  echo "MISMATCH: compiled output differs from the baseline." >&2
  diff "$BASELINE_FILE" "$CURRENT_FILE" || true
  exit 1
fi
```

Save this to `scripts/verify-scss-migration.sh` and make it executable:

```bash
chmod +x scripts/verify-scss-migration.sh
```

- [ ] **Step 5: Capture the baseline from the still-unsplit file**

```bash
bash scripts/verify-scss-migration.sh --save-baseline
```

Expected: `Baseline saved to /tmp/scss-migration-baseline.css`. This is the reference every later task's extraction is checked against — captured now, while `style.scss` is still just a renamed, unsplit copy of the original `style.css`, so it represents exactly today's real behavior.

- [ ] **Step 6: Verify the (trivial, no-op) migration state matches its own baseline**

```bash
bash scripts/verify-scss-migration.sh
```

Expected: `MATCH: compiled output is identical to the baseline.` — proves the rename + tooling setup alone changed nothing.

- [ ] **Step 7: Verify the app still builds and tests still pass**

```bash
npm run build
npx vitest run
```

Expected: build succeeds, all 473 tests pass — confirms Vite's Sass integration works end-to-end for a real build, not just the standalone `sass` CLI compile Step 6 used.

- [ ] **Step 8: Commit**

```bash
git add client/src/style.scss client/src/main.ts package.json package-lock.json scripts/verify-scss-migration.sh
git commit -m "$(cat <<'EOF'
build: add Sass tooling, rename style.css to style.scss (unsplit)

First step of the SCSS partial migration
(docs/superpowers/specs/2026-08-21-scss-migration-design.md) — pure
rename plus tooling, zero content change, verified via a
compiled-output diff against a baseline captured from this exact
commit. Every later task in the migration plan re-runs the same check
against this same baseline.
EOF
)"
```

---

### Task 2: Extract `_topbar.scss`

**Files:**
- Create: `client/src/styles/_topbar.scss`
- Modify: `client/src/style.scss`

**Interfaces:**
- Consumes: `scripts/verify-scss-migration.sh` (Task 1).

- [ ] **Step 1: Extract the topbar selectors**

In `client/src/style.scss`, find every rule (including any `[data-theme="dark"]`-scoped override and any media query specifically targeting one of these selectors) for: `#brand`, `#topbar`, `#topbar-row`, `#topbarActionsCol`, `#topbarRow1`, `.topbar-actions`, `.topbar-row`, `#toolbar`, `#toolbar-mount`, `.toolbar-buttons`, `.toolbar-overflow`, `.toolbar-overflow-menu`.

Cut them, preserving their original relative order, into a new file `client/src/styles/_topbar.scss`. Where two or more of these selectors share a common prefix (e.g. `#topbar`, `#topbar-row`, `.topbar-actions`, `.topbar-row`), nest them under a shared parent with `&` where it clarifies structure — e.g.:

```scss
#topbar {
  // ...existing #topbar rule body...

  &-row {
    // ...existing #topbar-row rule body...
  }
}

.topbar {
  &-actions {
    // ...existing .topbar-actions rule body...
  }

  &-row {
    // ...existing .topbar-row rule body...
  }
}
```

Leave selectors with no shared prefix among this group (e.g. `#brand`, `#toolbar-mount`) as flat top-level rules in the same file.

- [ ] **Step 2: Wire it into the entry point**

In `client/src/style.scss`, near the top (after the existing `@import "katex/dist/katex.min.css";` and the `_variables`/base rules, in the same position these rules used to occupy relative to the rest of the file), add:

```scss
@use "./styles/topbar";
```

- [ ] **Step 3: Verify**

```bash
bash scripts/verify-scss-migration.sh
```

Expected: `MATCH: compiled output is identical to the baseline.` If it reports `MISMATCH`, the diff output shows exactly which rule changed — fix the extraction (usually a missed selector, a reordering, or a nesting mistake that altered the compiled selector string) and re-run before continuing.

- [ ] **Step 4: Commit**

```bash
git add client/src/styles/_topbar.scss client/src/style.scss
git commit -m "style: extract topbar rules into _topbar.scss"
```

---

### Task 3: Extract `_sidebar.scss`

**Files:**
- Create: `client/src/styles/_sidebar.scss`
- Modify: `client/src/style.scss`

**Interfaces:**
- Consumes: `scripts/verify-scss-migration.sh` (Task 1).

- [ ] **Step 1: Extract the sidebar selectors**

Same process as Task 2, Step 1, for: `#sidebar`, `#sidebarHeader`, `#sidebarHeaderLeft`, `#sidebarToggleOut`, `#docList`, `#doclist-mount`, `.doc-row`, `.doc-row-link`, `.doc-menu-btn`, `.doc-menu-popover`, `.doc-menu-submenu-label`, `.doc-outline`, `.doc-outline-toggle`, `.doc-outline-toggle-spacer`, `.doclist-headings-tab-label`, `.doclist-presence`, `.doclist-tabs`, `#docTitle`, `#docTitleMirror` — into `client/src/styles/_sidebar.scss`, nesting where a shared prefix exists (`.doc-row`/`.doc-row-link`; `.doc-menu-*`; `.doc-outline*`; `.doclist-*`; `#sidebar*`).

- [ ] **Step 2: Wire it in**

```scss
@use "./styles/sidebar";
```

- [ ] **Step 3: Verify**

```bash
bash scripts/verify-scss-migration.sh
```

Expected: `MATCH: compiled output is identical to the baseline.`

- [ ] **Step 4: Commit**

```bash
git add client/src/styles/_sidebar.scss client/src/style.scss
git commit -m "style: extract sidebar/doc-list rules into _sidebar.scss"
```

---

### Task 4: Extract `_editor-preview.scss`

**Files:**
- Create: `client/src/styles/_editor-preview.scss`
- Modify: `client/src/style.scss`

**Interfaces:**
- Consumes: `scripts/verify-scss-migration.sh` (Task 1).

- [ ] **Step 1: Extract the editor/preview selectors**

Same process, for: `#editor-mount`, `#editorPane`, `#editorWrap`, `#preview`, `#preview-mount`, `#previewPane`, `.outline-item`, `.outline-list`, `.focus-mode-exit-btn`, `.view-selector`, and `.katex` if it exists as an actual rule (not just the file-header `@import`) — into `client/src/styles/_editor-preview.scss`, nesting `#editor*`/`#preview*` groups and `.outline-*` where they share a prefix.

- [ ] **Step 2: Wire it in**

```scss
@use "./styles/editor-preview";
```

- [ ] **Step 3: Verify**

```bash
bash scripts/verify-scss-migration.sh
```

Expected: `MATCH: compiled output is identical to the baseline.`

- [ ] **Step 4: Commit**

```bash
git add client/src/styles/_editor-preview.scss client/src/style.scss
git commit -m "style: extract editor/preview rules into _editor-preview.scss"
```

---

### Task 5: Extract `_statusbar.scss`

**Files:**
- Create: `client/src/styles/_statusbar.scss`
- Modify: `client/src/style.scss`

**Interfaces:**
- Consumes: `scripts/verify-scss-migration.sh` (Task 1).

- [ ] **Step 1: Extract the status-bar selectors**

For: `#statusbar`, `.statusbar-link`, `.status-dot`, `#saveStatusBtn`, `.save-status-popup` — into `client/src/styles/_statusbar.scss`.

- [ ] **Step 2: Wire it in**

```scss
@use "./styles/statusbar";
```

- [ ] **Step 3: Verify**

```bash
bash scripts/verify-scss-migration.sh
```

Expected: `MATCH: compiled output is identical to the baseline.`

- [ ] **Step 4: Commit**

```bash
git add client/src/styles/_statusbar.scss client/src/style.scss
git commit -m "style: extract status bar rules into _statusbar.scss"
```

---

### Task 6: Extract `_menu.scss`

**Files:**
- Create: `client/src/styles/_menu.scss`
- Modify: `client/src/style.scss`

**Interfaces:**
- Consumes: `scripts/verify-scss-migration.sh` (Task 1).

- [ ] **Step 1: Extract the menu selectors**

For: `#menuBar`, `#menubar-mount`, `.menu-check`, `.menu-chevron`, `.menu-divider`, `.menu-glyph-btn`, `.menu-item`, `.menu-link`, `.menu-recent-empty`, `.menu-recent-item`, `.menu-recent-name`, `.menu-recent-time`, `.menu-section-label`, `.menu-section-sublabel`, `.menu-submenu`, `.menu-submenu-panel`, `.menu-submenu-trigger`, `.menu-view-btn`, `.menubar-btn`, `.menubar-menu`, `.keybinding-mode-indicator` — into `client/src/styles/_menu.scss`, nesting `.menu-*` and `.menubar-*` groups separately (they share only the "menu" root token, not a real hierarchy).

- [ ] **Step 2: Wire it in**

```scss
@use "./styles/menu";
```

- [ ] **Step 3: Verify**

```bash
bash scripts/verify-scss-migration.sh
```

Expected: `MATCH: compiled output is identical to the baseline.`

- [ ] **Step 4: Commit**

```bash
git add client/src/styles/_menu.scss client/src/style.scss
git commit -m "style: extract menu/menubar rules into _menu.scss"
```

---

### Task 7: Extract `_command-palette.scss`

**Files:**
- Create: `client/src/styles/_command-palette.scss`
- Modify: `client/src/style.scss`

**Interfaces:**
- Consumes: `scripts/verify-scss-migration.sh` (Task 1).

- [ ] **Step 1: Extract the command-palette selectors**

For: `.command-palette`, `.command-palette-backdrop`, `.command-palette-input`, `.command-palette-input-row`, `.command-palette-results`, `.command-palette-row` — into `client/src/styles/_command-palette.scss`, nested under one `.command-palette { &-backdrop { ... } &-input { ... } ... }` group.

- [ ] **Step 2: Wire it in**

```scss
@use "./styles/command-palette";
```

- [ ] **Step 3: Verify**

```bash
bash scripts/verify-scss-migration.sh
```

Expected: `MATCH: compiled output is identical to the baseline.`

- [ ] **Step 4: Commit**

```bash
git add client/src/styles/_command-palette.scss client/src/style.scss
git commit -m "style: extract command palette rules into _command-palette.scss"
```

---

### Task 8: Extract `_modals.scss`

**Files:**
- Create: `client/src/styles/_modals.scss`
- Modify: `client/src/style.scss`

**Interfaces:**
- Consumes: `scripts/verify-scss-migration.sh` (Task 1).

- [ ] **Step 1: Extract the modal/settings/about/shortcuts/whats-new selectors**

For: `.modal-actions`, `.modal-actions-share`, `.modal-backdrop`, `.modal-body`, `.modal-box`, `.modal-box-v2`, `.modal-box-wide`, `.modal-close-btn`, `.modal-content`, `.modal-field`, `.modal-footer`, `.modal-header`, `.modal-hint`, `.modal-tabs`, `.about-brand`, `.about-links`, `.about-title`, `.about-version`, `.setting-desc`, `.setting-label`, `.setting-row`, `.setting-title`, `.settings-row`, `.custom-css-input`, `.shortcuts-list`, `.shortcuts-row`, `.whats-new-counter`, `.whats-new-nav`, `.whats-new-screenshot`, `.whats-new-slide`, `.whats-new-text` — into `client/src/styles/_modals.scss`. Nest `.modal-*` as one group; `.about-*`, `.setting-*`/`.settings-row`, `.shortcuts-*`, `.whats-new-*` as their own separate nested groups within the same file (they're all modal-hosted content, but not nested under `.modal-*` itself in the original flat selectors, so don't force a nesting relationship that didn't exist).

- [ ] **Step 2: Wire it in**

```scss
@use "./styles/modals";
```

- [ ] **Step 3: Verify**

```bash
bash scripts/verify-scss-migration.sh
```

Expected: `MATCH: compiled output is identical to the baseline.`

- [ ] **Step 4: Commit**

```bash
git add client/src/styles/_modals.scss client/src/style.scss
git commit -m "style: extract modal/settings/about/shortcuts/whats-new rules into _modals.scss"
```

---

### Task 9: Extract `_comments.scss`

**Files:**
- Create: `client/src/styles/_comments.scss`
- Modify: `client/src/style.scss`

**Interfaces:**
- Consumes: `scripts/verify-scss-migration.sh` (Task 1).

- [ ] **Step 1: Extract the comments selectors**

For: `.comment-add-btn`, `.comment-body`, `.comment-delete-btn`, `.comment-draft-actions`, `.comment-draft-anchor`, `.comment-draft-box`, `.comment-entry`, `.comment-entry-quote`, `.comment-orphaned-label`, `.comment-reply-row`, `.comments-panel`, `.comments-panel-header`, `.comments-panel-list` — into `client/src/styles/_comments.scss`. Nest `.comment-*` (singular) as one group and `.comments-panel*` (plural) as a separate group — they're two distinct prefixes, not a hierarchy of each other.

- [ ] **Step 2: Wire it in**

```scss
@use "./styles/comments";
```

- [ ] **Step 3: Verify**

```bash
bash scripts/verify-scss-migration.sh
```

Expected: `MATCH: compiled output is identical to the baseline.`

- [ ] **Step 4: Commit**

```bash
git add client/src/styles/_comments.scss client/src/style.scss
git commit -m "style: extract comment/comments-panel rules into _comments.scss"
```

---

### Task 10: Extract `_share-workspace.scss`

**Files:**
- Create: `client/src/styles/_share-workspace.scss`
- Modify: `client/src/style.scss`

**Interfaces:**
- Consumes: `scripts/verify-scss-migration.sh` (Task 1).

- [ ] **Step 1: Extract the share/workspace/presence selectors**

For: `.share-access-icon`, `.share-access-mirror`, `.share-access-row`, `.share-access-select`, `.share-access-text`, `.share-add-people-input`, `.share-btn-group`, `.share-name-row`, `.share-people-list`, `.share-person`, `.share-person-name`, `.share-person-remove`, `.share-person-role`, `.share-pill`, `.share-role-select`, `.share-row`, `.presence-avatar`, `.presence-avatar-sm`, `.presence-bar`, `.workspace-list`, `.workspace-new-btn`, `.workspace-rename-input`, `.workspace-row`, `.workspace-row-name`, `.workspace-switcher`, `.workspace-switcher-popover`, `.workspace-switcher-trigger` — into `client/src/styles/_share-workspace.scss`. Nest `.share-*`, `.presence-*`, and `.workspace-*` as three separate groups.

**Note:** `.share-pill` also appears in the multi-selector `:active` rule that belongs to `_utilities.scss` (Task 15) per the Global Constraints rule — leave `.share-pill`'s own standalone rule(s) here in `_share-workspace.scss`; only the shared `:active` rule moves to `_utilities.scss`.

- [ ] **Step 2: Wire it in**

```scss
@use "./styles/share-workspace";
```

- [ ] **Step 3: Verify**

```bash
bash scripts/verify-scss-migration.sh
```

Expected: `MATCH: compiled output is identical to the baseline.`

- [ ] **Step 4: Commit**

```bash
git add client/src/styles/_share-workspace.scss client/src/style.scss
git commit -m "style: extract share/workspace/presence rules into _share-workspace.scss"
```

---

### Task 11: Extract `_diagram-editor.scss`

**Files:**
- Create: `client/src/styles/_diagram-editor.scss`
- Modify: `client/src/style.scss`

**Interfaces:**
- Consumes: `scripts/verify-scss-migration.sh` (Task 1).

- [ ] **Step 1: Extract the diagram-editor selectors**

For: `.diagram-editor-body`, `.diagram-editor-code-host`, `.diagram-editor-header`, `.diagram-editor-overlay`, `.diagram-editor-preview`, `.diagram-editor-preview-wrap`, `.diagram-editor-reference`, `.diagram-preview-reset`, `.diagram-template-card`, `.diagram-template-grid`, `.diagram-template-or`, `.diagram-template-picker` — into `client/src/styles/_diagram-editor.scss`. Nest `.diagram-editor-*` as one group, `.diagram-template-*` as another; `.diagram-preview-reset` stands alone (no siblings sharing that exact prefix).

- [ ] **Step 2: Wire it in**

```scss
@use "./styles/diagram-editor";
```

- [ ] **Step 3: Verify**

```bash
bash scripts/verify-scss-migration.sh
```

Expected: `MATCH: compiled output is identical to the baseline.`

- [ ] **Step 4: Commit**

```bash
git add client/src/styles/_diagram-editor.scss client/src/style.scss
git commit -m "style: extract diagram editor rules into _diagram-editor.scss"
```

---

### Task 12: Extract `_diff-view.scss`

**Files:**
- Create: `client/src/styles/_diff-view.scss`
- Modify: `client/src/style.scss`

**Interfaces:**
- Consumes: `scripts/verify-scss-migration.sh` (Task 1).

- [ ] **Step 1: Extract the diff-view/version-history/doc-info selectors**

For: `.diff-image-loading`, `.diff-image-thumb`, `.diff-view`, `.diff-view-cell`, `.diff-view-gutter`, `.diff-view-mode-toggle`, `.diff-view-row`, `.diff-view-unified`, `.version-history-actions`, `.version-history-body`, `.version-history-current`, `.version-history-header`, `.version-history-list`, `.version-history-overlay`, `.version-history-preview`, `.version-history-preview-wrap`, `.version-history-row`, `.version-history-row-label`, `.version-history-view-toggle`, `.doc-info-backlink-row`, `.doc-info-backlinks`, `.doc-info-link`, `.doc-info-primary`, `.doc-info-row`, `.doc-info-secondary` — into `client/src/styles/_diff-view.scss`. Nest `.diff-*`, `.version-history-*`, and `.doc-info-*` as three separate groups.

- [ ] **Step 2: Wire it in**

```scss
@use "./styles/diff-view";
```

- [ ] **Step 3: Verify**

```bash
bash scripts/verify-scss-migration.sh
```

Expected: `MATCH: compiled output is identical to the baseline.`

- [ ] **Step 4: Commit**

```bash
git add client/src/styles/_diff-view.scss client/src/style.scss
git commit -m "style: extract diff-view/version-history/doc-info rules into _diff-view.scss"
```

---

### Task 13: Extract `_slash-wikilink.scss`

**Files:**
- Create: `client/src/styles/_slash-wikilink.scss`
- Modify: `client/src/style.scss`

**Interfaces:**
- Consumes: `scripts/verify-scss-migration.sh` (Task 1).

- [ ] **Step 1: Extract the slash-menu selectors**

For: `.slash-menu`, `.slash-menu-row` — into `client/src/styles/_slash-wikilink.scss`, nested as `.slash-menu { &-row { ... } }`.

(This file is named `_slash-wikilink.scss` per the spec's partition list even though only slash-menu selectors were found at the top-level selector scan — wikilink-specific styling may be nested inside `.slash-menu`'s own rules, e.g. a wikilink variant class, rather than appearing as its own top-level selector. Check for any wikilink-related selector nested within what gets extracted here; if none exists, the file legitimately only contains the two slash-menu selectors, which is fine.)

- [ ] **Step 2: Wire it in**

```scss
@use "./styles/slash-wikilink";
```

- [ ] **Step 3: Verify**

```bash
bash scripts/verify-scss-migration.sh
```

Expected: `MATCH: compiled output is identical to the baseline.`

- [ ] **Step 4: Commit**

```bash
git add client/src/styles/_slash-wikilink.scss client/src/style.scss
git commit -m "style: extract slash-menu/wikilink rules into _slash-wikilink.scss"
```

---

### Task 14: Extract `_utilities.scss`

**Files:**
- Create: `client/src/styles/_utilities.scss`
- Modify: `client/src/style.scss`

**Interfaces:**
- Consumes: `scripts/verify-scss-migration.sh` (Task 1).

- [ ] **Step 1: Extract the utility/shared selectors**

For: `.dropdown`, `.dropdown-divider`, `.dropdown-menu`, `.dropdown-text`, `.dropdown-text-desc`, `.dropdown-text-title`, `.empty-state`, `.empty-state-actions`, `.empty-state-desc`, `.empty-state-icon`, `.empty-state-inner`, `.empty-state-title`, `.gist-item`, `.hint-text`, `.hint-toggle-btn`, `.icon`, `.icon-btn`, `.image-item`, `.image-unused-label`, `.images-list`, `.primary-btn`, `.secondary-btn`, `.danger-btn`, `.sep`, `.skeleton`, `.spacer`, `.sr-only`, `.desktop-only`, `.tab-switch`, `.tab-switch-btn`, `.toast`, `.toast-close`, `.toast-error`, `.toast-message`, `.toast-stack`, `.toast-success`, `.toggletip`, `.toggletip-bubble` — into `client/src/styles/_utilities.scss`. Nest each same-prefix group (`.dropdown-*`, `.empty-state-*`, `.image*`, `.tab-switch*`, `.toast-*`, `.toggletip-*`) separately; leave singletons (`.icon`, `.icon-btn`, `.primary-btn`, `.secondary-btn`, `.danger-btn`, `.sep`, `.skeleton`, `.spacer`, `.sr-only`, `.desktop-only`, `.gist-item`, `.hint-text`, `.hint-toggle-btn`) flat.

Also move the "Animation/Transitions" section near the end of `style.scss` (the `.icon-btn:active, .share-pill:active, .primary-btn:active, .secondary-btn:active, .danger-btn:active { transform: scale(0.96); }` rule, the `input, textarea, select` focus-transition rule, and the `@keyframes shimmer` block) into this same file — per the Global Constraints rule, this multi-selector rule stays intact rather than being split across `_utilities.scss` and `_share-workspace.scss` even though `.share-pill` technically belongs to the latter.

- [ ] **Step 2: Wire it in**

```scss
@use "./styles/utilities";
```

- [ ] **Step 3: Verify**

```bash
bash scripts/verify-scss-migration.sh
```

Expected: `MATCH: compiled output is identical to the baseline.`

- [ ] **Step 4: Commit**

```bash
git add client/src/styles/_utilities.scss client/src/style.scss
git commit -m "style: extract shared utility/button/toast/animation rules into _utilities.scss"
```

---

### Task 15: Extract `_layout.scss` and `_variables.scss`, delete the empty `style.scss` tail

**Files:**
- Create: `client/src/styles/_layout.scss`, `client/src/styles/_variables.scss`
- Modify: `client/src/style.scss`

**Interfaces:**
- Consumes: `scripts/verify-scss-migration.sh` (Task 1).

By this task, every component-area selector has been extracted in Tasks 2-14. What remains in `client/src/style.scss` should only be: the top `@import "katex/dist/katex.min.css";`, the `:root`/`[data-theme="dark"]` custom-property blocks, `*`/`html, body` resets, the standalone `body { transition: ... }` rule, and the layout selectors (`#app`, `#body`, `#main`, `#content-row`, `#divider`, `.pane`) — plus the `@use` lines added by Tasks 2-14.

- [ ] **Step 1: Extract the base/variables rules**

Cut `:root { ... }`, `[data-theme="dark"] { ... }`, `* { ... }`, `html, body { ... }`, and the standalone `body { transition: ...; }` rule into `client/src/styles/_variables.scss`, in their original order, unnested (these are root-level rules with no shared prefix to nest under).

- [ ] **Step 2: Extract the layout rules**

Cut `#app`, `#body`, `#main`, `#content-row`, `#divider`, `.pane` into `client/src/styles/_layout.scss`, nesting where a real prefix relationship exists (there likely isn't one among these — leave flat if so).

- [ ] **Step 3: Rebuild `style.scss` as a pure entry point**

`client/src/style.scss` should now contain only:

```scss
@import "katex/dist/katex.min.css";

@use "./styles/variables";
@use "./styles/layout";
@use "./styles/topbar";
@use "./styles/sidebar";
@use "./styles/editor-preview";
@use "./styles/statusbar";
@use "./styles/menu";
@use "./styles/command-palette";
@use "./styles/modals";
@use "./styles/comments";
@use "./styles/share-workspace";
@use "./styles/diagram-editor";
@use "./styles/diff-view";
@use "./styles/slash-wikilink";
@use "./styles/utilities";
```

Confirm the `@use` order matches the original file's top-to-bottom rule order for each section (variables/resets first, then layout, then each component area in whatever order they appeared in the original — reorder these `@use` lines if a later verification step shows a mismatch traceable to source order).

- [ ] **Step 4: Verify**

```bash
bash scripts/verify-scss-migration.sh
```

Expected: `MATCH: compiled output is identical to the baseline.` This is the final, complete-migration check — every selector from the original file must now be accounted for across the 15 partials.

- [ ] **Step 5: Commit**

```bash
git add client/src/styles/_variables.scss client/src/styles/_layout.scss client/src/style.scss
git commit -m "style: extract variables/layout rules, style.scss is now a pure @use entry point"
```

---

### Task 16: Full verification, manual visual pass, cleanup

**Files:**
- Delete: `scripts/verify-scss-migration.sh`

**Interfaces:**
- Consumes: `scripts/verify-scss-migration.sh` (Task 1) — deleted by this task, its job now done.

- [ ] **Step 1: Full automated verification**

```bash
npx vitest run
npm run typecheck
npm run build
npm run test:e2e:local
```

Expected: 473 unit tests pass, 0 typecheck errors, build succeeds, all 44 local e2e tests pass.

- [ ] **Step 2: Manual visual pass**

Run `npm run dev:client`, open the app in a real browser, and check both light and dark theme (`Settings` > theme toggle), at both a desktop and a mobile viewport width, covering: the topbar, the sidebar document list, the editor/preview split view, the comments panel (open it, add a draft comment), the command palette (`Ctrl/Cmd+Shift+P`), the Settings modal, the diagram editor (insert a diagram, open its editor), and a Version History diff view on any document with edit history. Confirm nothing looks different from before this migration — this is the spec's own Testing section requirement, covering the areas with the most historically fragile CSS in this project (topbar sizing, mobile bottom-sheet animations, comments panel collapse width).

- [ ] **Step 3: Remove the temporary verification script**

```bash
rm scripts/verify-scss-migration.sh
git add scripts/verify-scss-migration.sh
```

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore: remove the temporary SCSS-migration verification script

Its job is done — every partial's compiled output was verified
against the pre-migration baseline in its own task. Final full-suite
verification (473 unit tests, typecheck, build, 44 e2e tests) plus a
manual visual pass across both themes and desktop/mobile widths all
confirm zero behavior change.
EOF
)"
```

---

## Self-review

- **Spec coverage**: every Goals-section item has a task — the
  15-partial split by UI area (Tasks 2-15), `&`-nesting within each
  (every extraction step), CSS custom properties left untouched (Task
  15 copies `:root`/`[data-theme="dark"]` verbatim, no task anywhere
  introduces an SCSS `$variable`), `main.ts`'s import updated (Task 1),
  `sass` installed (Task 1), and the compiled-output diff verification
  (every task's Step 3/4, using the script Task 1 builds). The Testing
  section's four checks (build, e2e, and — new here — a manual visual
  pass across themes/viewports) are Task 16.
- **Placeholder scan**: no bare "extract the relevant CSS" — every
  extraction task names its exact selector list, sourced from a full
  read of the file's top-level selectors (documented in the plan's
  own "Selector-to-partial assignment" section). The one acknowledged
  gap (a selector the initial `grep` might have missed) has an explicit
  fallback rule, not silence.
- **Type consistency**: n/a — no functions/types span tasks; the only
  cross-task "interface" is the verification script's fixed invocation
  (`bash scripts/verify-scss-migration.sh`, no arguments after Task 1's
  `--save-baseline` run), used identically and correctly in every task.
