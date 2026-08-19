# Editor Core Migration Phase D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move formatting commands (`runCmd` and its helpers) into a new
plain module, and give `stores/view.ts` full ownership of view-mode state
(eliminating `window.MDE.setView` entirely), continuing the editor-core
migration's pattern of moving `app.ts`'s remaining logic to wherever it
genuinely belongs — a plain module when there's no template/UI of its
own, a store when the state already has one.

**Architecture:** `formatting-commands.ts` is a new plain module (not a
Svelte component) following the exact precedent `gist.ts`/`repo-sync-ui.ts`
already established: imported directly in `main.ts`, assigns its own
`window.MDE.*` bridge methods at module top-level, no `onMount` needed
since none of its functions touch anything but `window.MDE.getEditor()`
and two modal stores. `stores/view.ts` absorbs `setView`/`STORAGE_VIEW`/
init-on-load, the same full-ownership treatment Phase A gave
`stores/keybindings.ts` — `window.MDE.setView` is removed outright, not
left optional, since every caller can reach the store directly. These two
areas share no state, so they're separate, independently-compilable
tasks; a third task rewrites the one existing test file this migration
has needed to touch (`stores/view.test.ts`) and does the comprehensive
live-verification.

**Tech Stack:** TypeScript, Svelte 5, CodeMirror 6 (read-only access via
`window.MDE.getEditor()`), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-19-editor-core-migration-phase-d-design.md`
(and Phases A-C's specs for the bridge/module conventions this plan
continues).

## Global Constraints

- No behavior change — every moved piece is a verbatim relocation
  (`cm` → `window.MDE.getEditor()`), per the spec's Goals section.
- New/changed `MDEBridge` optional methods follow the `publishGist?`
  doc-comment convention (module-assigned, not component-assigned) —
  see `client/src/types.ts:234-237`.
- No new unit tests for the moved formatting-command logic — no
  precedent for testing this kind of CodeMirror-dispatch code (verified
  via `find client/src/components -name "*.test.ts"` returning nothing,
  same as every prior phase). `stores/view.test.ts` is the one
  exception: it already exists and gets rewritten, not dropped.
- `git commit` after each task, in the worktree already created for this
  phase (`.worktrees/editor-core-migration-phase-d`, branch
  `editor-core-migration-phase-d`) — no need to create a new one.

---

### Task 1: `formatting-commands.ts` — new module, wired into Toolbar and app.ts's keymap

**Files:**
- Create: `client/src/formatting-commands.ts`
- Modify: `client/src/main.ts`, `client/src/components/Toolbar.svelte`,
  `client/src/app.ts` (imports, `buildEditorExtensions()`'s keymap,
  deletions, bridge literal), `client/src/types.ts`

**Interfaces:**
- Consumes: `window.MDE.getEditor(): EditorView` (existing, Phase A),
  `linkModalOpen`/`linkModalPrefillText` stores
  (`client/src/stores/linkModal.ts`, existing).
- Produces: `runCmd(cmd: string): void`, `wrapSelection(before: string, after: string, placeholder?: string): void`,
  `prefixLine(prefix: string): void`, `insertLink(): void`,
  `insertLinkIntoEditor(text: string, url: string): void`,
  `insertImage(): void`, `insertTable(): void`,
  `insertBlock(block: string): void`, `insertMathSnippet(): void`,
  `insertFootnoteSnippet(): void` — all exported from
  `client/src/formatting-commands.ts`.
  `window.MDE.runCmd?(cmd: string): void`,
  `window.MDE.insertLinkIntoEditor?(text: string, url: string): void`,
  `window.MDE.insertAtCursor?(text: string): void` — assigned by this
  module at load time. `CommandPalette.svelte`, `SlashMenu.svelte`,
  `MenuBar.svelte`, and `DiagramEditor.svelte` (existing components,
  unchanged in this task) are these bridge methods' callers.

- [ ] **Step 1: Create `client/src/formatting-commands.ts`**

```typescript
import { linkModalOpen, linkModalPrefillText } from "./stores/linkModal";

export function runCmd(cmd: string) {
  switch (cmd) {
    case "bold": return wrapSelection("**", "**", "bold text");
    case "italic": return wrapSelection("_", "_", "italic text");
    case "strike": return wrapSelection("~~", "~~", "strikethrough");
    case "h1": return prefixLine("# ");
    case "h2": return prefixLine("## ");
    case "h3": return prefixLine("### ");
    case "quote": return prefixLine("> ");
    case "code": return wrapSelection("`", "`", "code");
    case "codeblock": return wrapSelection("```\n", "\n```", "code");
    case "ul": return prefixLine("- ");
    case "ol": return prefixLine("1. ");
    case "task": return prefixLine("- [ ] ");
    case "link": return insertLink();
    case "image": return insertImage();
    case "table": return insertTable();
    case "hr": return insertBlock("\n---\n");
    case "math": return insertMathSnippet();
    case "footnote": return insertFootnoteSnippet();
  }
}

export function wrapSelection(before: string, after: string, placeholder?: string) {
  const view = window.MDE.getEditor();
  const { from, to } = view.state.selection.main;
  const sel = view.state.sliceDoc(from, to);
  const text = sel || placeholder || "";
  const insert = before + text + after;
  if (!sel && placeholder) {
    // Select just the inserted placeholder so typing immediately
    // replaces it, instead of leaving the cursor after it.
    const selFrom = from + before.length;
    const selTo = selFrom + placeholder.length;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: selFrom, head: selTo } });
  } else {
    view.dispatch(view.state.replaceSelection(insert));
  }
}

export function prefixLine(prefix: string) {
  const view = window.MDE.getEditor();
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (line.text.startsWith(prefix)) {
    view.dispatch({ changes: { from: line.from, to: line.from + prefix.length, insert: "" } });
  } else {
    // Without an explicit selection, an insertion landing exactly at
    // the cursor's position (the common case — an empty line) maps
    // the cursor to stay *before* the inserted text by default,
    // leaving it sitting in front of "# " instead of ready to type
    // after it.
    const head = view.state.selection.main.head;
    view.dispatch({ changes: { from: line.from, insert: prefix }, selection: { anchor: head + prefix.length } });
  }
}

// A popup instead of dropping raw `[text](https://)` markdown into the
// editor — friendlier for anyone not already fluent in markdown syntax.
export function insertLink() {
  const view = window.MDE.getEditor();
  const { from, to } = view.state.selection.main;
  linkModalPrefillText.set(view.state.sliceDoc(from, to));
  linkModalOpen.set(true);
}

export function insertLinkIntoEditor(text: string, url: string) {
  const view = window.MDE.getEditor();
  view.dispatch(view.state.replaceSelection(`[${text || "link text"}](${url || "https://"})`));
  view.focus();
}

export function insertImage() {
  document.getElementById("imageFileInput").click();
}

export function insertTable() {
  insertBlock(
    "\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |\n| Cell | Cell | Cell |\n"
  );
}

export function insertBlock(block: string) {
  const view = window.MDE.getEditor();
  const pos = view.state.selection.main.head;
  view.dispatch({ changes: { from: pos, insert: block }, selection: { anchor: pos + block.length } });
}

// Inserts a block math snippet with the cursor on the blank line
// between the delimiters, so typing immediately starts the LaTeX
// source — same "insert and place the cursor usefully" shape as
// insertTable()/insertBlock(), just with an interior cursor position
// rather than one trailing the whole insert.
export function insertMathSnippet() {
  const view = window.MDE.getEditor();
  const pos = view.state.selection.main.head;
  const block = "$$\n\n$$";
  const cursorPos = pos + 3; // after "$$\n"
  view.dispatch({ changes: { from: pos, insert: block }, selection: { anchor: cursorPos } });
}

// Inserts a [^N] reference at the cursor and a [^N]: definition at the
// document's end, auto-numbered past any existing numeric footnote
// references — a hand-written named footnote like [^note] is ignored
// by the scan (matches [^(\d+)] only) and never collides with this
// button's own numbering. One atomic transaction (both changes
// dispatched together) — a single undo step, not two.
export function insertFootnoteSnippet() {
  const view = window.MDE.getEditor();
  const text = view.state.doc.toString();
  const existingLabels = [...text.matchAll(/\[\^(\d+)\]/g)]
    .map((m) => parseInt(m[1], 10))
    .filter((n) => !Number.isNaN(n));
  const nextLabel = existingLabels.length > 0 ? Math.max(...existingLabels) + 1 : 1;
  const pos = view.state.selection.main.head;
  const ref = `[^${nextLabel}]`;
  const def = `\n\n[^${nextLabel}]: `;
  const docEnd = view.state.doc.length;
  view.dispatch({
    changes: [
      { from: pos, insert: ref },
      { from: docEnd, insert: def },
    ],
    selection: { anchor: docEnd + ref.length + def.length },
  });
}

// MenuBar.svelte/CommandPalette.svelte/SlashMenu.svelte/DiagramEditor.svelte
// call these directly — they have no access to this module's functions
// otherwise, same reasoning as every other window.MDE bridge method.
// Toolbar.svelte imports runCmd directly instead (see its own change in
// this task) since it's a plain function in a plain module, not a
// component-owned one.
window.MDE.runCmd = runCmd;
window.MDE.insertLinkIntoEditor = insertLinkIntoEditor;
window.MDE.insertAtCursor = insertBlock;
```

- [ ] **Step 2: Import the new module in `client/src/main.ts`**

Change (currently at the top of `client/src/main.ts`):

```typescript
import "./app";
import "./collab";
import "./gist";
import "./repo-sync-ui";
import "./style.css";
```

to:

```typescript
import "./app";
import "./collab";
import "./gist";
import "./repo-sync-ui";
import "./formatting-commands";
import "./style.css";
```

- [ ] **Step 3: Update `client/src/components/Toolbar.svelte`**

Change:

```svelte
  import { onMount } from "svelte";
  import { diagramEditorOpen, diagramEditorRef } from "../stores/diagramEditor";
  import { viewMode, isEditorOn, isPreviewOn, toggleEditorPane, togglePreviewPane } from "../stores/view";

  function run(cmd: string) {
    window.MDE.runCmd(cmd);
    window.MDE.getEditor().focus();
  }
```

to:

```svelte
  import { onMount } from "svelte";
  import { diagramEditorOpen, diagramEditorRef } from "../stores/diagramEditor";
  import { viewMode, isEditorOn, isPreviewOn, toggleEditorPane, togglePreviewPane } from "../stores/view";
  import { runCmd } from "../formatting-commands";

  function run(cmd: string) {
    runCmd(cmd);
    window.MDE.getEditor().focus();
  }
```

- [ ] **Step 4: Update `app.ts`'s Mod-b/Mod-i/Mod-k keymap**

Add the import near app.ts's other local-module imports (alongside
`import { escapeHtml } from "./escape-html";`):

```typescript
import { wrapSelection, insertLink } from "./formatting-commands";
```

The keymap itself (in `buildEditorExtensions()`) already reads
`wrapSelection(...)`/`insertLink()` by name — no change needed to the
keymap's own code, only to where those names resolve from (the new
import, instead of local closure functions being deleted in Step 5).

- [ ] **Step 5: Delete the moved functions from `client/src/app.ts`**

Delete `runCmd`, `wrapSelection`, `prefixLine`, `insertLink`,
`insertLinkIntoEditor`, `insertImage`, `insertTable`, `insertBlock`,
`insertMathSnippet`, `insertFootnoteSnippet` in full (currently
`app.ts:631-748` — the whole block from `function runCmd(cmd: string) {`
through `insertFootnoteSnippet`'s closing `}`, right before the
`// ---------- View toggle ----------` comment, which stays).

In the bridge object literal (`const bridge: MDEBridge = {...}`), delete:

```typescript
    insertLinkIntoEditor,
```

(was on its own line, directly after `closeAllDropdowns,` and before
`requireGithubSignIn(hint) {`) and:

```typescript
    runCmd,
    insertAtCursor: (text: string) => insertBlock(text),
```

(were on their own lines, directly after `pasteClipboard: menuClipboardPaste,`
and before `newDoc: createNewDoc,`).

- [ ] **Step 6: Update `client/src/types.ts`**

Remove the three required declarations (currently `runCmd(cmd: string): void;`
at line 221 and `insertAtCursor(text: string): void;` at line 222 in the
main body of the interface, and `insertLinkIntoEditor(text: string, url: string): void;`
at line 163):

```typescript
  insertLinkIntoEditor(text: string, url: string): void;
```
```typescript
  runCmd(cmd: string): void;
  insertAtCursor(text: string): void;
```

Add all three at the very end of the interface, after `unlinkRepo?()`
(currently the last member before the interface's closing `}`, at
`client/src/types.ts:244`) — the module-assigned convention, not the
component-assigned one used by `undo?`/`insertImageWithUpload?`/etc.:

```typescript
  // Set by repo-sync-ui.ts at module load, same pattern as the two above.
  openRepoLinkModal?(): void;
  openRepoModal?(): void;
  pushToRepoAction?(): void;
  pullFromRepoAction?(): void;
  unlinkRepo?(): void;
}
```

becomes:

```typescript
  // Set by repo-sync-ui.ts at module load, same pattern as the two above.
  openRepoLinkModal?(): void;
  openRepoModal?(): void;
  pushToRepoAction?(): void;
  pullFromRepoAction?(): void;
  unlinkRepo?(): void;
  // Set by formatting-commands.ts at module load, same pattern as
  // publishGist? above. MenuBar.svelte/CommandPalette.svelte/
  // SlashMenu.svelte call runCmd; DiagramEditor.svelte calls
  // insertAtCursor after creating a new diagram; LinkModal.svelte calls
  // insertLinkIntoEditor.
  runCmd?(cmd: string): void;
  insertAtCursor?(text: string): void;
  insertLinkIntoEditor?(text: string, url: string): void;
}
```

- [ ] **Step 7: Type-check and verify**

```bash
cd client && npx tsc --noEmit
```

Expected: clean. If you see `Cannot find name 'wrapSelection'` or
similar inside app.ts, the Step 4 import is missing or misspelled.

```bash
npx svelte-check --tsconfig ./tsconfig.json
```

Expected: `0 ERRORS 0 WARNINGS`.

```bash
cd .. && npm test 2>&1 | tail -10
```

Expected: all 473 existing tests still pass (this task doesn't touch
`view.test.ts` — that's Task 3).

- [ ] **Step 8: Commit**

```bash
git add client/src/formatting-commands.ts client/src/main.ts client/src/components/Toolbar.svelte client/src/app.ts client/src/types.ts
git commit -m "$(cat <<'EOF'
feat: move formatting commands into a new formatting-commands.ts module

Phase D (part 1) of the editor-core migration: runCmd and its helpers
(wrapSelection, prefixLine, insertLink, insertBlock, etc.) move from
app.ts into a new plain module, following the same precedent
gist.ts/repo-sync-ui.ts already established — imported directly in
main.ts, assigns its own window.MDE.runCmd/insertLinkIntoEditor/
insertAtCursor bridge methods (all now optional) at module load.
Toolbar.svelte imports runCmd directly instead of going through the
bridge for its own buttons. app.ts's Mod-b/Mod-i/Mod-k keymap imports
wrapSelection/insertLink directly too (a plain-module-to-plain-module
import, no bridge needed for that direction).
EOF
)"
```

---

### Task 2: `stores/view.ts` — full ownership of view-mode state

**Files:**
- Modify: `client/src/stores/view.ts`, `client/src/components/CommandPalette.svelte`,
  `client/src/app.ts` (deletions, bridge literal, `init()`),
  `client/src/types.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `setView(view: ViewMode): void` — new export from
  `client/src/stores/view.ts`. `CommandPalette.svelte` (this task)
  imports it directly. `toggleEditorPane`/`togglePreviewPane` (existing
  exports, unchanged signatures) call it internally instead of
  `window.MDE.setView`.

- [ ] **Step 1: Update `client/src/stores/view.ts`**

Change the full file from:

```typescript
import { writable, get } from "svelte/store";

// Mirrors app.ts's initViewToggle() closure state — written there (the
// source of truth, since it also owns main.className/localStorage/cm.refresh
// side effects), read here by MenuBar.svelte for the View menu's
// checkmarks and by Toolbar.svelte for the view-selector buttons'
// active state.
export type ViewMode = "editor" | "split" | "preview";
export const viewMode = writable<ViewMode>("split");

export function isEditorOn(mode: ViewMode): boolean {
  return mode !== "preview";
}
export function isPreviewOn(mode: ViewMode): boolean {
  return mode !== "editor";
}

// Toggling the only pane that's currently on is a no-op — there's
// always at least one pane visible, never both hidden at once. Past
// that guard, exactly one case remains each way: this pane was on (so
// the other must be too, i.e. split) and is turning off, leaving the
// other pane alone; or this pane was off (so the other was on alone)
// and is turning on, which is always "split".
export function toggleEditorPane(): void {
  const mode = get(viewMode);
  if (isEditorOn(mode) && !isPreviewOn(mode)) return;
  window.MDE.setView(isEditorOn(mode) ? "preview" : "split");
}
export function togglePreviewPane(): void {
  const mode = get(viewMode);
  if (isPreviewOn(mode) && !isEditorOn(mode)) return;
  window.MDE.setView(isPreviewOn(mode) ? "editor" : "split");
}
```

to:

```typescript
import { writable, get } from "svelte/store";

// Sole owner of view-mode state, including the #body className and
// localStorage side effects — same full-ownership treatment
// stores/keybindings.ts already got in Phase A of the editor-core
// migration. Read by MenuBar.svelte for the View menu's checkmarks and
// by Toolbar.svelte for the view-selector buttons' active state.
export type ViewMode = "editor" | "split" | "preview";

const STORAGE_VIEW = "mde:view";

function loadViewMode(): ViewMode {
  const raw = localStorage.getItem(STORAGE_VIEW);
  return raw === "editor" || raw === "preview" ? raw : "split";
}

export const viewMode = writable<ViewMode>(loadViewMode());

export function isEditorOn(mode: ViewMode): boolean {
  return mode !== "preview";
}
export function isPreviewOn(mode: ViewMode): boolean {
  return mode !== "editor";
}

export function setView(view: ViewMode): void {
  document.getElementById("body")!.className = `mode-${view}`;
  localStorage.setItem(STORAGE_VIEW, view);
  viewMode.set(view);
}

// Applies the loaded mode's #body class on module load — mirrors
// app.ts's old initViewToggle(), now self-contained here instead of
// being kicked off from its DOMContentLoaded-gated init(). #body
// already exists by module-load time (a plain div early in index.html,
// well before any <script type="module"> tag) — same guarantee
// docsStore's/keybindingMode's own self-init already relies on.
document.getElementById("body")!.className = `mode-${get(viewMode)}`;

// Toggling the only pane that's currently on is a no-op — there's
// always at least one pane visible, never both hidden at once. Past
// that guard, exactly one case remains each way: this pane was on (so
// the other must be too, i.e. split) and is turning off, leaving the
// other pane alone; or this pane was off (so the other was on alone)
// and is turning on, which is always "split".
export function toggleEditorPane(): void {
  const mode = get(viewMode);
  if (isEditorOn(mode) && !isPreviewOn(mode)) return;
  setView(isEditorOn(mode) ? "preview" : "split");
}
export function togglePreviewPane(): void {
  const mode = get(viewMode);
  if (isPreviewOn(mode) && !isEditorOn(mode)) return;
  setView(isPreviewOn(mode) ? "editor" : "split");
}
```

- [ ] **Step 2: Update `client/src/components/CommandPalette.svelte`**

Add the import alongside the other `../stores/view` import:

```svelte
  import { viewMode } from "../stores/view";
```

becomes:

```svelte
  import { viewMode, setView } from "../stores/view";
```

Change the three View commands from:

```svelte
    { id: "view-editor", label: "Switch to Editor view", category: "View", run: () => window.MDE.setView("editor") },
    { id: "view-split", label: "Switch to Split view", category: "View", run: () => window.MDE.setView("split") },
    { id: "view-preview", label: "Switch to Preview view", category: "View", run: () => window.MDE.setView("preview") },
```

to:

```svelte
    { id: "view-editor", label: "Switch to Editor view", category: "View", run: () => setView("editor") },
    { id: "view-split", label: "Switch to Split view", category: "View", run: () => setView("split") },
    { id: "view-preview", label: "Switch to Preview view", category: "View", run: () => setView("preview") },
```

- [ ] **Step 3: Delete the moved code from `client/src/app.ts`**

Delete `initViewToggle` and `setView` in full (currently `app.ts:750-760` —
the `// ---------- View toggle ----------` comment through `setView`'s
closing `}`).

Delete the `STORAGE_VIEW` constant (currently `app.ts:53`):

```typescript
  const STORAGE_VIEW = "mde:view";
```

Delete `init()`'s call to the deleted function (currently `app.ts:85`):

```typescript
    initViewToggle();
```

In the bridge object literal, delete:

```typescript
    setView,
```

(was on its own line, directly after `openAbout() { aboutModalOpen.set(true); },`
and before `openDiagramEditor() {`).

- [ ] **Step 4: Update `client/src/types.ts`**

Remove the required declaration (currently `setView(mode: "editor" | "split" | "preview"): void;`
in the main body of the interface):

```typescript
  setView(mode: "editor" | "split" | "preview"): void;
```

Do **not** add an optional replacement — `setView` is fully removed from
`MDEBridge`, matching how Phase A fully removed `setKeybindings` once
nothing needed the bridge indirection (confirmed via this phase's own
grep: `stores/view.ts`'s own two callers become local calls, and
`CommandPalette.svelte` — the only external caller — now imports
`setView` directly).

- [ ] **Step 5: Type-check and verify**

```bash
cd client && npx tsc --noEmit
```

Expected: clean.

```bash
npx svelte-check --tsconfig ./tsconfig.json
```

Expected: `0 ERRORS 0 WARNINGS`.

```bash
cd .. && npm test 2>&1 | tail -20
```

Expected: `client/src/stores/view.test.ts` now **fails** — it still
mocks `window.MDE.setView`, which nothing calls anymore, so its
`expect(window.MDE.setView).toHaveBeenCalledWith(...)` assertions never
see a call. This is expected and handled in Task 3; every *other* test
file should still pass. Confirm the failure is isolated to
`view.test.ts` before proceeding — if anything else fails, stop and
investigate before starting Task 3.

- [ ] **Step 6: Commit**

```bash
git add client/src/stores/view.ts client/src/components/CommandPalette.svelte client/src/app.ts client/src/types.ts
git commit -m "$(cat <<'EOF'
feat: give stores/view.ts full ownership of view-mode state

Phase D (part 2) of the editor-core migration: setView/STORAGE_VIEW/
the init-on-load behavior move from app.ts into stores/view.ts, the
same full-ownership treatment stores/keybindings.ts got in Phase A.
window.MDE.setView is removed outright (not left optional) —
stores/view.ts's own toggleEditorPane/togglePreviewPane call the
local setView directly, and CommandPalette.svelte (the only external
caller) now imports setView from stores/view.ts instead of going
through the bridge.

Note: this leaves stores/view.test.ts failing (it still mocks the
now-removed window.MDE.setView) — fixed in the next commit.
EOF
)"
```

---

### Task 3: Rewrite `view.test.ts`, comprehensive live-verification

**Files:**
- Modify: `client/src/stores/view.test.ts`

**Interfaces:**
- Consumes: `viewMode`, `isEditorOn`, `isPreviewOn`, `toggleEditorPane`,
  `togglePreviewPane` from `./view` (all from Task 2, signatures
  unchanged from before this phase).

- [ ] **Step 1: Rewrite `client/src/stores/view.test.ts`**

`stores/view.ts` now runs a DOM-touching side effect
(`document.getElementById("body")!.className = ...`) at module load
time, not just when `setView`/`toggleEditorPane`/etc. are called — the
same category of load-time side effect `stores/keybindings.ts` already
has for `localStorage`, which `keybindings.test.ts` already handles via
`vi.resetModules()` + a dynamic `await import(...)` per test. This file
needs the same treatment, plus a `<div id="body">` created before each
dynamic import (a static top-level `import ... from "./view"` would
throw immediately — `#body` wouldn't exist yet the first time the module
evaluates).

Replace the full file with:

```typescript
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

describe("isEditorOn / isPreviewOn", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="body"></div>';
    vi.resetModules();
  });

  it("editor mode: editor on, preview off", async () => {
    const { isEditorOn, isPreviewOn } = await import("./view");
    expect(isEditorOn("editor")).toBe(true);
    expect(isPreviewOn("editor")).toBe(false);
  });

  it("preview mode: editor off, preview on", async () => {
    const { isEditorOn, isPreviewOn } = await import("./view");
    expect(isEditorOn("preview")).toBe(false);
    expect(isPreviewOn("preview")).toBe(true);
  });

  it("split mode: both on", async () => {
    const { isEditorOn, isPreviewOn } = await import("./view");
    expect(isEditorOn("split")).toBe(true);
    expect(isPreviewOn("split")).toBe(true);
  });
});

describe("toggleEditorPane / togglePreviewPane", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="body"></div>';
    vi.resetModules();
  });

  it("toggleEditorPane from split turns editor off (-> preview)", async () => {
    const { viewMode, toggleEditorPane } = await import("./view");
    viewMode.set("split");
    toggleEditorPane();
    expect(get(viewMode)).toBe("preview");
  });

  it("toggleEditorPane from preview turns editor on (-> split)", async () => {
    const { viewMode, toggleEditorPane } = await import("./view");
    viewMode.set("preview");
    toggleEditorPane();
    expect(get(viewMode)).toBe("split");
  });

  it("toggleEditorPane from editor is a no-op (editor is the only pane on)", async () => {
    const { viewMode, toggleEditorPane } = await import("./view");
    viewMode.set("editor");
    toggleEditorPane();
    expect(get(viewMode)).toBe("editor");
  });

  it("togglePreviewPane from split turns preview off (-> editor)", async () => {
    const { viewMode, togglePreviewPane } = await import("./view");
    viewMode.set("split");
    togglePreviewPane();
    expect(get(viewMode)).toBe("editor");
  });

  it("togglePreviewPane from editor turns preview on (-> split)", async () => {
    const { viewMode, togglePreviewPane } = await import("./view");
    viewMode.set("editor");
    togglePreviewPane();
    expect(get(viewMode)).toBe("split");
  });

  it("togglePreviewPane from preview is a no-op (preview is the only pane on)", async () => {
    const { viewMode, togglePreviewPane } = await import("./view");
    viewMode.set("preview");
    togglePreviewPane();
    expect(get(viewMode)).toBe("preview");
  });
});
```

(The six `toggleEditorPane`/`togglePreviewPane` cases are the same six
the file already had — same inputs, same expected outcomes — just
asserting `viewMode`'s resulting value directly instead of a
`window.MDE.setView` mock's call arguments, since there's no bridge call
to mock anymore.)

- [ ] **Step 2: Run the full test suite**

```bash
cd /Users/danishhakim/Documents/GitHub/markdown-editor/.worktrees/editor-core-migration-phase-d
npm test 2>&1 | tail -15
```

Expected: all 473 tests pass again (view.test.ts's 9 cases — 3
`isEditorOn`/`isPreviewOn` + 6 toggle cases — included, none dropped).

```bash
cd client && npx tsc --noEmit && npx svelte-check --tsconfig ./tsconfig.json
```

Expected: both clean.

- [ ] **Step 3: Live-verify**

Start the dev server and seed `localStorage` with a test document (same
technique used for Phases A-C — one doc, one workspace, `mde:docs`/
`mde:workspaces`/`mde:active`/`mde:activeWorkspace`/`mde:whatsNewSeen`,
then navigate to `/d/<docId>`):

```bash
cd client && npm run dev -- --port 5274
```

1. **Every `runCmd` case via Toolbar buttons**: click each formatting
   button (Bold, Italic, Strikethrough, H1-H3, Blockquote, Inline code,
   Code block, Bullet list, Numbered list, Task list, Link, Image,
   Table, Horizontal rule, Math, Footnote) on a document with some
   selected text where relevant, and confirm each inserts/wraps the
   expected markdown (spot-check via
   `window.MDE.getEditor().state.doc.toString()` after each).
2. **Mod-b/Mod-i/Mod-k**: place the cursor in the editor, select some
   text, press Cmd/Ctrl+B, confirm it wraps in `**`; same for Cmd/Ctrl+I
   (`_`); press Cmd/Ctrl+K, confirm the link modal opens.
3. **Command Palette formatting + view commands**: open the palette
   (Cmd/Ctrl+Shift+P), search "bold", run it, confirm it applies; search
   "view", confirm "Switch to Editor/Split/Preview view" all appear and
   work.
4. **Slash menu**: type "/" at a line start, run a command (e.g.
   Heading 1), confirm it applies and the menu closes — exercises
   `window.MDE.runCmd` from a different caller than Toolbar/Palette.
5. **View-mode toggling — all three UI paths**: Toolbar's two
   view-selector buttons, MenuBar's View menu, and Command Palette's
   view commands — for each, confirm `#body`'s class updates
   (`mode-editor`/`mode-split`/`mode-preview`) and the pane visibility
   changes correctly.
6. **View-mode persistence**: switch to "editor" mode, reload the page,
   confirm it comes back in "editor" mode (reads `localStorage`'s
   `mde:view` key via `stores/view.ts`'s module-load-time init).
7. **`DiagramEditor.svelte`'s insert flow**: insert a new diagram,
   confirm it inserts a ` ```mermaid ` fence at the cursor — exercises
   `window.MDE.insertAtCursor`.
8. **`LinkModal.svelte`'s insert flow**: trigger the link modal (Mod-K or
   toolbar), fill in text/URL, submit, confirm it inserts
   `[text](url)` — exercises `window.MDE.insertLinkIntoEditor`.
9. **Regression spot-check**: vim mode's status indicator, focus mode's
   body class, comment marker highlighting, slash/wikilink Escape,
   sync-scroll — cheap given the shared dev-server setup, and this
   phase's app.ts edits touch the same `buildEditorExtensions()`
   function every prior phase's keymap lives in.

Stop the dev server when done.

- [ ] **Step 4: Commit**

```bash
git add client/src/stores/view.test.ts
git commit -m "$(cat <<'EOF'
test: rewrite view.test.ts for stores/view.ts's new full ownership

window.MDE.setView no longer exists (Phase D of the editor-core
migration removed it), so the existing mock-and-assert-on-call-args
tests no longer apply. Rewritten to assert on viewMode's resulting
value directly, using the same vi.resetModules() + dynamic-import
pattern keybindings.test.ts already established for a module with
load-time side effects. Same six toggle cases, same coverage — just a
more direct assertion of the same behavior.

Live-verified: every runCmd case via Toolbar, Mod-b/Mod-i/Mod-k,
Command Palette (formatting + view commands), slash menu, view-mode
toggling via all three UI paths plus reload persistence,
DiagramEditor's insertAtCursor, LinkModal's insertLinkIntoEditor, plus
a Phase A-C regression spot-check.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Post-plan note

Same category of gap every prior phase has flagged: this plan's live
verification covers the local (non-collab) path only. Nothing here is
collab-specific — formatting commands and view-mode are both UI/editor
concerns with no interaction with `collab.ts`'s Yjs sync — so no new risk
is expected, but as always, this hasn't been runtime-verified against a
real `wrangler dev` shared room.

## Self-review

- **Spec coverage**: every Goals-section item in the Phase D design spec
  has a task — `formatting-commands.ts` and its bridge/Toolbar/keymap
  wiring (Task 1), `stores/view.ts`'s full ownership and `setView`'s
  removal (Task 2), the `view.test.ts` rewrite (Task 3). The spec's
  Non-goals (doc-title, save/sidebar) are untouched by every task.
- **Placeholder scan**: none — every step's code block is the actual
  verbatim content (read directly from the current worktree
  immediately before writing this plan) or an exact diff, including the
  full rewritten `view.test.ts`.
- **Type consistency**: `runCmd(cmd: string): void`,
  `insertLinkIntoEditor(text: string, url: string): void`,
  `insertAtCursor(text: string): void` (aliased to `insertBlock`) match
  between Task 1's module exports, its bridge assignments, and its
  `types.ts` optional declarations. `setView(view: ViewMode): void`
  matches between Task 2's `stores/view.ts` export,
  `CommandPalette.svelte`'s new import, and `toggleEditorPane`/
  `togglePreviewPane`'s internal calls.
- **Task boundaries**: Tasks 1 and 2 are fully independent (no shared
  state between formatting commands and view-mode) and each leaves the
  suite green on its own — except Task 2 deliberately leaves
  `view.test.ts` red, called out explicitly in Task 2's own verification
  step so it's never mistaken for an unexpected regression, with Task 3
  fixing it immediately after. This is the one deliberate exception to
  every prior phase's "green after every task" rule, and it's stated as
  such rather than silently left for the plan's reader to notice.
