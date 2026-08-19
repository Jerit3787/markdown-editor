# Editor Core Migration (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the four CodeMirror extension compartments (readOnly, editing-mode, focus-mode, keybindings), keybinding-mode switching, and focus mode out of `app.ts`'s closure and into `Editor.svelte`, with no behavior change.

**Architecture:** A new `client/src/stores/keybindings.ts` store becomes the single owner of keybinding-mode persistence (fixing a pre-existing two-owners bug where `Settings.svelte` duplicated the value). A new `client/src/editor-theme.ts` module holds the zero-coupling `editorTheme`/`markdownHighlightStyle` values. `Editor.svelte` grows to own the four compartments and reacts to the keybindings and focus-mode stores via `$effect`, assigning `undo`/`redo`/`setReadOnly`/`enterCollabMode`/`exitCollabMode` onto `window.MDE` at mount time — the same pattern `gist.ts`/`repo-sync-ui.ts` already use for their own bridge contributions. `app.ts`'s `buildEditorExtensions()` shrinks to only what later phases (B–G) still own.

**Tech Stack:** TypeScript, Svelte 5, CodeMirror 6, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-19-editor-core-migration-design.md`

## Global Constraints

- No behavior change: normal/vim/emacs keybindings (runtime switch + status-bar indicator), focus mode (mobile exit button, desktop Escape, typewriter-scroll), collab read-only/editing-mode switching, and undo/redo routing must all work identically after this phase.
- No new unit tests for the compartment/effect wiring itself — this codebase has zero precedent for testing Svelte component internals or CodeMirror extension construction (confirmed: no `.test.ts` files under `client/src/components/`). Verified live in-browser instead.
- Everything genuinely becomes Svelte (`$effect`-driven), not relocated into a plain `.ts` module that keeps the same imperative style.

---

### Task 1: `client/src/stores/keybindings.ts` — new store

**Files:**
- Create: `client/src/stores/keybindings.ts`
- Test: `client/src/stores/keybindings.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `export type KeybindingMode = "normal" | "vim" | "emacs"`. `export const keybindingMode: Writable<KeybindingMode>`. `export function setKeybindingMode(mode: KeybindingMode): void`. Task 3 imports all three (both in `Editor.svelte` and `Settings.svelte`).

This task is purely additive — nothing calls the new store yet, so there's no intermediate broken state. `Settings.svelte` and `Editor.svelte` both cut over to it together in Task 3 (splitting the cutover would leave a window where clicking a keybinding button in Settings updates `localStorage` but nothing reconfigures the live editor).

- [ ] **Step 1: Write the failing test**

Create `client/src/stores/keybindings.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";

if (typeof localStorage === "undefined") {
  class MockLocalStorage {
    private data: Record<string, string> = {};
    setItem(key: string, value: string): void {
      this.data[key] = String(value);
    }
    getItem(key: string): string | null {
      return this.data[key] ?? null;
    }
    removeItem(key: string): void {
      delete this.data[key];
    }
    clear(): void {
      this.data = {};
    }
    key(index: number): string | null {
      return Object.keys(this.data)[index] ?? null;
    }
    get length(): number {
      return Object.keys(this.data).length;
    }
  }
  (globalThis as any).localStorage = new MockLocalStorage();
}

describe("keybindings store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to normal when localStorage has no saved mode", async () => {
    const { keybindingMode } = await import("./keybindings");
    expect(get(keybindingMode)).toBe("normal");
  });

  it("loads a previously-saved mode on module init", async () => {
    localStorage.setItem("mde:keybindings", "vim");
    const { keybindingMode } = await import("./keybindings");
    expect(get(keybindingMode)).toBe("vim");
  });

  it("falls back to normal for a corrupted/unrecognized saved value", async () => {
    localStorage.setItem("mde:keybindings", "colemak");
    const { keybindingMode } = await import("./keybindings");
    expect(get(keybindingMode)).toBe("normal");
  });

  it("setKeybindingMode updates the store and persists to localStorage", async () => {
    const { keybindingMode, setKeybindingMode } = await import("./keybindings");
    setKeybindingMode("emacs");
    expect(get(keybindingMode)).toBe("emacs");
    expect(localStorage.getItem("mde:keybindings")).toBe("emacs");
  });
});
```

Note: each test does a fresh `await import("./keybindings")` (not a top-level static import) because the module reads `localStorage` once at load time to compute its initial value — a static import would only ever see whatever `localStorage` held the first time any test file imported it. Vitest's per-test-file module cache means dynamic re-import within the same file still returns the same cached instance unless `vi.resetModules()` is called — add that to make each test's fresh read meaningful:

Add `import { vi } from "vitest";` to the top of the test file (alongside the existing `describe, it, expect, beforeEach` import), and add `vi.resetModules();` as the first line inside `beforeEach`, before `localStorage.clear()`... actually order matters: clear localStorage AND reset modules, in either order, both before each test:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
```

```ts
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- keybindings.test.ts`
Expected: FAIL — the module `./keybindings` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `client/src/stores/keybindings.ts`:

```ts
// Single owner of keybinding-mode persistence — Editor.svelte reacts to
// this store via $effect to reconfigure the live CodeMirror compartment;
// Settings.svelte writes to it directly via setKeybindingMode(). Before
// this store existed, app.ts owned the localStorage key AND
// Settings.svelte separately duplicated it as its own local component
// state — a two-owners-for-one-value situation this store fixes by
// giving it exactly one owner, same shape as stores/workspaces.ts's own
// relationship to its localStorage keys.
import { writable } from "svelte/store";

export type KeybindingMode = "normal" | "vim" | "emacs";

const STORAGE_KEYBINDINGS = "mde:keybindings";

function loadKeybindingMode(): KeybindingMode {
  const raw = localStorage.getItem(STORAGE_KEYBINDINGS);
  return raw === "vim" || raw === "emacs" ? raw : "normal";
}

export const keybindingMode = writable<KeybindingMode>(loadKeybindingMode());

export function setKeybindingMode(mode: KeybindingMode): void {
  localStorage.setItem(STORAGE_KEYBINDINGS, mode);
  keybindingMode.set(mode);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- keybindings.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add client/src/stores/keybindings.ts client/src/stores/keybindings.test.ts
git commit -m "feat: add keybindings store, single owner of keybinding-mode persistence"
```

---

### Task 2: `client/src/editor-theme.ts` — new module

**Files:**
- Create: `client/src/editor-theme.ts`
- Modify: `client/src/app.ts:337-370` (replace local definitions with an import)

**Interfaces:**
- Consumes: nothing new.
- Produces: `export const editorTheme: Extension`. `export const markdownHighlightStyle: HighlightStyle`. Task 3's `Editor.svelte` imports both; this task's own `app.ts` change imports both too (temporarily — app.ts still includes them in its own extension array until Task 3 removes that).

This task moves the values but changes nothing about which array they end up in — app.ts still returns `editorTheme` and `syntaxHighlighting(markdownHighlightStyle)` from its own `buildEditorExtensions()`, just sourced from the new file. Net-zero behavior change, independently verifiable.

- [ ] **Step 1: Create the new module**

Create `client/src/editor-theme.ts`:

```ts
// Pure, zero-coupling editor styling — no reference to anything else in
// app.ts's closure, so there's no reason to route these through the
// window.MDE bridge. Verbatim move from app.ts (previously lines 337-370).
import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const editorTheme = EditorView.theme({
  "&": { color: "var(--text)", backgroundColor: "var(--bg)", height: "100%" },
  // Equal top/side padding matching #preview's own 40px, for visual
  // balance between the two panes; bottom kept small (not also 40px) —
  // a full 40px bottom padding left a gap at the editor's true scroll
  // end large enough to visibly desync from the preview's own end.
  // Scoped to only this editor instance via this theme extension
  // (not a global `.cm-content` CSS rule) — DiagramEditor.svelte builds
  // a separate CodeMirror instance with its own extensions and never
  // includes this theme, so a global rule would have (and previously
  // did) leak 40px of padding into that unrelated, much smaller editor.
  ".cm-content": { fontFamily: "var(--mono)", fontSize: "14.5px", lineHeight: "1.6", padding: "40px 40px 4px 40px", caretColor: "var(--text)" },
  ".cm-scroller": { overflow: "auto", fontFamily: "var(--mono)" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--accent-dim) !important" },
  ".cm-image-uploading": { opacity: "0.6", fontStyle: "italic" },
  ".cm-dimmed-line": { opacity: "0.35", transition: "opacity 0.2s ease" },
  ".cm-comment-marker": { backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)", borderBottom: "2px solid var(--accent)" },
});

export const markdownHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700", fontSize: "1.3em", color: "var(--text)" },
  { tag: t.heading2, fontWeight: "700", fontSize: "1.15em", color: "var(--text)" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "700", color: "var(--text)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.monospace, fontFamily: "var(--mono)" },
  { tag: [t.link, t.url], color: "var(--accent)" },
  { tag: t.quote, color: "var(--text-dim)", fontStyle: "italic" },
  { tag: t.list, color: "var(--accent)" },
  { tag: [t.meta, t.processingInstruction, t.contentSeparator], color: "var(--text-dim)" },
]);
```

- [ ] **Step 2: Update app.ts to import instead of define**

In `client/src/app.ts`, find (lines 336-370):

```ts
  // ---------- Editor (CodeMirror 6) ----------
  const editorTheme = EditorView.theme({
    "&": { color: "var(--text)", backgroundColor: "var(--bg)", height: "100%" },
    // Equal top/side padding matching #preview's own 40px, for visual
    // balance between the two panes; bottom kept small (not also 40px) —
    // a full 40px bottom padding left a gap at the editor's true scroll
    // end large enough to visibly desync from the preview's own end.
    // Scoped to only this editor instance via this theme extension
    // (not a global `.cm-content` CSS rule) — DiagramEditor.svelte builds
    // a separate CodeMirror instance with its own extensions and never
    // includes this theme, so a global rule would have (and previously
    // did) leak 40px of padding into that unrelated, much smaller editor.
    ".cm-content": { fontFamily: "var(--mono)", fontSize: "14.5px", lineHeight: "1.6", padding: "40px 40px 4px 40px", caretColor: "var(--text)" },
    ".cm-scroller": { overflow: "auto", fontFamily: "var(--mono)" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor": { borderLeftColor: "var(--text)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--accent-dim) !important" },
    ".cm-image-uploading": { opacity: "0.6", fontStyle: "italic" },
    ".cm-dimmed-line": { opacity: "0.35", transition: "opacity 0.2s ease" },
    ".cm-comment-marker": { backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)", borderBottom: "2px solid var(--accent)" },
  });

  const markdownHighlightStyle = HighlightStyle.define([
    { tag: t.heading1, fontWeight: "700", fontSize: "1.3em", color: "var(--text)" },
    { tag: t.heading2, fontWeight: "700", fontSize: "1.15em", color: "var(--text)" },
    { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "700", color: "var(--text)" },
    { tag: t.strong, fontWeight: "700" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.monospace, fontFamily: "var(--mono)" },
    { tag: [t.link, t.url], color: "var(--accent)" },
    { tag: t.quote, color: "var(--text-dim)", fontStyle: "italic" },
    { tag: t.list, color: "var(--accent)" },
    { tag: [t.meta, t.processingInstruction, t.contentSeparator], color: "var(--text-dim)" },
  ]);
```

Replace with:

```ts
  // ---------- Editor (CodeMirror 6) ----------
```

Then add a new import line near the top of `app.ts`, right after the existing `import { activeParagraphRange } from "./focus-mode";` line:

```ts
import { editorTheme, markdownHighlightStyle } from "./editor-theme";
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: 0 errors. (`HighlightStyle` and `tags as t` are still imported at the top of app.ts at this point — they become unused only in Task 3, once `syntaxHighlighting(markdownHighlightStyle)` itself moves out of app.ts's array. Leaving those two imports in place for now is correct; do not remove them in this task.)

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS, no regressions (this is a pure relocation, no logic changed).

- [ ] **Step 5: Commit**

```bash
git add client/src/editor-theme.ts client/src/app.ts
git commit -m "refactor: move editorTheme/markdownHighlightStyle into their own module"
```

---

### Task 3: Grow `Editor.svelte`, shrink `app.ts`, cut over every call site

**Files:**
- Modify: `client/src/components/Editor.svelte` (full rewrite — currently 33 lines)
- Modify: `client/src/types.ts` (`MDEBridge` interface)
- Modify: `client/src/app.ts` (remove ~230 lines across ~15 locations — compartments, keybindings functions, focus-mode functions, bridge entries, imports, two call sites)
- Modify: `client/src/components/Settings.svelte` (keybinding buttons)
- Modify: `client/src/components/CommandPalette.svelte:104`
- Modify: `client/src/components/MenuBar.svelte:227`
- Modify: `client/src/stores/focusMode.ts` (stale ownership comment)

**Interfaces:**
- Consumes: `keybindingMode`, `setKeybindingMode`, `type KeybindingMode` from `./stores/keybindings` (Task 1). `editorTheme`, `markdownHighlightStyle` from `./editor-theme` (Task 2). `focusMode` from `./stores/focusMode` (already existed). `activeParagraphRange` from `./focus-mode` (already existed).
- Produces: `Editor.svelte` assigns `window.MDE.undo`, `.redo`, `.setReadOnly`, `.enterCollabMode`, `.exitCollabMode` at mount — Phase B/C/D/G rely on these existing exactly as before (same signatures, just a different assigner). `MDEBridge.getEditorExtensions()`'s contract changes (returns only what app.ts still owns, not the full list) — Phase B/C/D's own plans build directly on this new, smaller contract.

This is one atomic task: the four compartments cannot exist in two places at once (app.ts's old array AND Editor.svelte's new one) without either duplicating them (breaking collab.ts's reconfigure calls, which would only ever reach one of the two instances) or leaving a broken intermediate commit. Every step below lands together.

- [ ] **Step 1: Rewrite `Editor.svelte`**

Replace the entire contents of `client/src/components/Editor.svelte` with:

```svelte
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { EditorView, Decoration, drawSelection, keymap, type DecorationSet } from "@codemirror/view";
  import { EditorState, Compartment, StateField, type Extension } from "@codemirror/state";
  import { history, historyKeymap, undo as cmUndo, redo as cmRedo } from "@codemirror/commands";
  import { syntaxHighlighting } from "@codemirror/language";
  import { editorTheme, markdownHighlightStyle } from "../editor-theme";
  import { keybindingMode, type KeybindingMode } from "../stores/keybindings";
  import { focusMode } from "../stores/focusMode";
  import { activeParagraphRange } from "../focus-mode";

  let hostEl: HTMLDivElement | undefined = $state();
  let view: EditorView | undefined;

  // ---------- Compartments ----------
  // readOnlyCompartment: viewer/reviewer roles in a shared room (collab.ts
  // drives this via window.MDE.setReadOnly).
  // editingModeCompartment: swaps the whole editing/undo stack between
  // local (CM6's own history()) and collaborative (y-codemirror.next's
  // yCollab extensions + its Yjs-aware undo keymap) as one atomic unit —
  // never both at once, since they'd fight over Mod-Z. collab.ts drives
  // this via window.MDE.enterCollabMode/exitCollabMode.
  const readOnlyCompartment = new Compartment();
  const editingModeCompartment = new Compartment();
  const focusModeCompartment = new Compartment();
  const keybindingsCompartment = new Compartment();

  function localEditingModeExtensions(): Extension {
    return [history(), keymap.of(historyKeymap)];
  }

  // Set by collab.ts when a room is joined (a fresh Y.UndoManager per
  // join) so window.MDE.undo()/redo() — the Edit-menu's programmatic
  // triggers, as opposed to a real Mod-Z keypress the editingMode keymap
  // already handles — can route to whichever undo system is actually
  // active. y-codemirror.next's own undo/redo StateCommands aren't part
  // of its public API surface (only their keymap bindings are exported),
  // so this talks to the Y.UndoManager instance directly instead — same
  // effect, since the collab extension's own listeners are registered
  // against that instance regardless of what calls .undo()/.redo() on it.
  interface UndoManagerLike {
    undo(): void;
    redo(): void;
  }
  let collabUndoManager: UndoManagerLike | null = null;

  // ---------- Keybindings ----------
  // drawSelection() is in the base extension list below — vim mode needs
  // it (the vim package's own docs call it out as required for correct
  // visual-mode selection rendering when not using CM6's basicSetup,
  // which this app doesn't use) and it's already unconditional, so it
  // isn't added again here.
  //
  // Dynamically imported (not top-level imports) — @replit/codemirror-vim
  // and @replit/codemirror-emacs only matter for the small minority of
  // users who turn on non-default keybindings, so they shouldn't cost
  // every page load. "normal" (the default) resolves with no import at
  // all.
  async function keybindingsExtensionsFor(mode: KeybindingMode): Promise<Extension[]> {
    if (mode === "vim") {
      const { vim } = await import("@replit/codemirror-vim");
      return [vim()];
    }
    if (mode === "emacs") {
      const { emacs } = await import("@replit/codemirror-emacs");
      return [emacs()];
    }
    return [];
  }

  async function updateKeybindingIndicator(mode: KeybindingMode): Promise<void> {
    const el = document.getElementById("keybindingMode");
    if (mode === "normal") {
      el.hidden = true;
      return;
    }
    if (mode === "emacs") {
      el.hidden = false;
      el.textContent = "EMACS";
      return;
    }
    // vim — getCM(view) only resolves once vim() has actually
    // initialized on this view. Each switch into vim mode gets a fresh
    // CM5-compat instance (the package creates a new one every time
    // vim() initializes), so repeatedly toggling Vim mode on/off/on
    // never accumulates stale listeners on an old, discarded instance.
    // The dynamic import here always hits module cache — the caller
    // (applyKeybindingMode) already imported the same module to build
    // the vim() extension, so this never triggers a second network fetch.
    el.hidden = false;
    const { getCM } = await import("@replit/codemirror-vim");
    const cm5 = getCM(view!);
    const updateFromVimState = () => {
      const vimState = cm5?.state?.vim;
      el.textContent = vimState?.mode ? vimState.mode.toUpperCase() : "NORMAL";
    };
    updateFromVimState();
    cm5?.on("vim-mode-change", updateFromVimState);
  }

  async function applyKeybindingMode(mode: KeybindingMode): Promise<void> {
    if (!view) return;
    const extensions = await keybindingsExtensionsFor(mode);
    view.dispatch({ effects: keybindingsCompartment.reconfigure(extensions) });
    await updateKeybindingIndicator(mode);
  }

  // ---------- Focus Mode ----------
  const dimLineMark = Decoration.line({ class: "cm-dimmed-line" });

  function computeDimDecorations(state: EditorState): DecorationSet {
    const { from, to } = activeParagraphRange(state.doc, state.selection.main.head);
    const marks = [];
    for (let ln = 1; ln <= state.doc.lines; ln++) {
      const line = state.doc.line(ln);
      if (line.to < from || line.from > to) marks.push(dimLineMark.range(line.from));
    }
    return Decoration.set(marks);
  }

  const focusDimField = StateField.define<DecorationSet>({
    create: (state) => computeDimDecorations(state),
    update(deco, tr) {
      if (!tr.docChanged && !tr.selection) return deco;
      return computeDimDecorations(tr.state);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // Mutates scrollDOM.scrollTop directly — a plain DOM property write,
  // not view.dispatch() — so there's no concern about dispatching a new
  // transaction from inside an updateListener callback. Reuses
  // lineBlockAt(), the same API app.ts's own scroll-sync code relies on
  // for real pixel positions.
  function centerCursorLine(v: EditorView) {
    const pos = v.state.selection.main.head;
    const block = v.lineBlockAt(pos);
    const target = block.top - v.scrollDOM.clientHeight / 2 + block.height / 2;
    v.scrollDOM.scrollTop = Math.max(0, target);
  }

  const typewriterListener = EditorView.updateListener.of((update) => {
    if (update.docChanged || update.selectionSet) centerCursorLine(update.view);
  });

  function focusModeExtensions(): Extension[] {
    return [focusDimField, typewriterListener];
  }

  // Reactive replacements for the old imperative setKeybindings()/
  // toggleFocusMode() dispatch calls — re-runs whenever the store value
  // changes, whether that's Settings.svelte's runtime switch or the
  // initial value read at mount.
  $effect(() => {
    if (view) void applyKeybindingMode($keybindingMode);
  });

  $effect(() => {
    if (!view) return;
    document.body.classList.toggle("focus-mode", $focusMode);
    view.dispatch({ effects: focusModeCompartment.reconfigure($focusMode ? focusModeExtensions() : []) });
    if ($focusMode) centerCursorLine(view);
  });

  function buildExtensions(): Extension[] {
    return [
      keybindingsCompartment.of([]),
      readOnlyCompartment.of(EditorState.readOnly.of(false)),
      editingModeCompartment.of(localEditingModeExtensions()),
      focusModeCompartment.of([]),
      syntaxHighlighting(markdownHighlightStyle),
      editorTheme,
      drawSelection(),
      // Everything Phase B/C/D still own (formatting keymaps, markdown
      // language, comment/image/slash/wikilink fields, the save/preview
      // updateListener, paste/drop handlers) — see app.ts's own
      // buildEditorExtensions() and its doc comment.
      ...window.MDE.getEditorExtensions(),
    ];
  }

  onMount(() => {
    view = new EditorView({ doc: "", parent: hostEl, extensions: buildExtensions() });
    window.MDE.registerEditor(view);

    // Bridge contributions this phase now owns — same established
    // pattern gist.ts/repo-sync-ui.ts already use for their own optional
    // bridge methods (window.MDE.publishGist = publish; etc.), not a new
    // mechanism. Safe timing-wise: this onMount already runs before
    // app.ts's DOMContentLoaded-triggered init() (an existing guarantee
    // app.ts's own comments document), and collab.ts can only call these
    // after a room is joined, which needs user interaction that can't
    // happen before mount completes.
    window.MDE.undo = () => {
      if (collabUndoManager) collabUndoManager.undo();
      else cmUndo(view!);
      view!.focus();
    };
    window.MDE.redo = () => {
      if (collabUndoManager) collabUndoManager.redo();
      else cmRedo(view!);
      view!.focus();
    };
    window.MDE.setReadOnly = (readOnly) => {
      view!.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)) });
    };
    window.MDE.enterCollabMode = (extensions, undoManager) => {
      collabUndoManager = undoManager;
      view!.dispatch({ effects: editingModeCompartment.reconfigure(extensions) });
    };
    window.MDE.exitCollabMode = () => {
      collabUndoManager = null;
      view!.dispatch({ effects: editingModeCompartment.reconfigure(localEditingModeExtensions()) });
    };
  });

  onDestroy(() => {
    view?.destroy();
  });
</script>

<div id="editorWrap">
  <div bind:this={hostEl} class="cm-host"></div>
</div>
```

- [ ] **Step 2: Update `client/src/types.ts`**

Find the `MDEBridge` interface. Change:

```ts
  getEditorExtensions(): Extension[];
```

(keep this line exactly as-is, but update the doc comment two lines above it — find:)

```ts
  // Editor.svelte's construction handoff: it builds the actual EditorView
  // (DOM host + mount/destroy lifecycle are its job), but the extension
  // list is almost entirely app.ts's own callbacks/state, so it asks for
  // that here and hands the resulting view back via registerEditor.
  getEditorExtensions(): Extension[];
```

Replace with:

```ts
  // Editor.svelte owns the EditorView's construction/mount/destroy
  // lifecycle AND, as of Phase A of the app.ts migration, the readOnly/
  // editing-mode/focus-mode/keybindings compartments and their base
  // theme/highlighting extensions. This asks app.ts for whatever it
  // still owns (Phase B/C/D territory — formatting keymaps, markdown
  // language, comment/image/slash/wikilink fields, the save/preview
  // updateListener, paste/drop handlers) to splice into the final list.
  getEditorExtensions(): Extension[];
```

Find:

```ts
  undo(): void;
  redo(): void;
  // Reconfigures the editor's readOnly facet and its editing-mode/undo
  // stack — collab.ts drives both when a room is joined/left/its role
  // changes (see app.ts's editingModeCompartment/readOnlyCompartment).
  setReadOnly(readOnly: boolean): void;
  enterCollabMode(extensions: Extension, undoManager: { undo(): void; redo(): void }): void;
  exitCollabMode(): void;
```

Replace with:

```ts
  // Optional (assigned by Editor.svelte's onMount, not app.ts's own
  // bridge literal) — same pattern as publishGist?/openGistPicker?
  // below: app.ts's bridge object is typed/assigned before Editor.svelte
  // mounts, so these can't be required there. Reconfigures the editor's
  // readOnly facet and its editing-mode/undo stack — collab.ts drives
  // setReadOnly/enterCollabMode/exitCollabMode when a room is
  // joined/left/its role changes.
  undo?(): void;
  redo?(): void;
  setReadOnly?(readOnly: boolean): void;
  enterCollabMode?(extensions: Extension, undoManager: { undo(): void; redo(): void }): void;
  exitCollabMode?(): void;
```

Find and delete this line entirely:

```ts
  toggleFocusMode(): void;
```

Find and delete this line entirely:

```ts
  setKeybindings(mode: "normal" | "vim" | "emacs"): void;
```

- [ ] **Step 3: Update `client/src/app.ts` — remove moved declarations**

Find (lines 146-177, the compartments through `collabUndoManager`):

```ts
  // ---------- Editor extension compartments ----------
  // readOnlyCompartment: viewer/reviewer roles in a shared room (collab.ts
  // drives this via window.MDE.setReadOnly).
  // editingModeCompartment: swaps the whole editing/undo stack between
  // local (CM6's own history()) and collaborative (y-codemirror.next's
  // yCollab extensions + its Yjs-aware undo keymap) as one atomic unit —
  // never both at once, since they'd fight over Mod-Z. collab.ts drives
  // this via window.MDE.enterCollabMode/exitCollabMode.
  const readOnlyCompartment = new Compartment();
  const editingModeCompartment = new Compartment();
  const focusModeCompartment = new Compartment();
  const keybindingsCompartment = new Compartment();

  function localEditingModeExtensions(): Extension {
    return [history(), keymap.of(historyKeymap)];
  }

  // Set by collab.ts when a room is joined (a fresh Y.UndoManager per
  // join) so window.MDE.undo()/redo() — the Edit-menu's programmatic
  // triggers, as opposed to a real Mod-Z keypress the editingMode keymap
  // already handles — can route to whichever undo system is actually
  // active. y-codemirror.next's own undo/redo StateCommands aren't part
  // of its public API surface (only their keymap bindings are exported),
  // so this talks to the Y.UndoManager instance directly instead — same
  // effect, since the collab extension's own listeners are registered
  // against that instance regardless of what calls .undo()/.redo() on it.
  interface UndoManagerLike {
    undo(): void;
    redo(): void;
  }
  let collabUndoManager: UndoManagerLike | null = null;

  // ---------- Storage helpers ----------
```

Replace with:

```ts
  // ---------- Storage helpers ----------
```

(The four compartments, `localEditingModeExtensions`, `UndoManagerLike`, and `collabUndoManager` now live in `Editor.svelte` — see `docs/superpowers/specs/2026-08-19-editor-core-migration-design.md`.)

- [ ] **Step 4: Remove `STORAGE_KEYBINDINGS` constant**

Find (near the top of `app.ts`, around line 88):

```ts
  const STORAGE_KEYBINDINGS = "mde:keybindings";
```

Delete this line entirely (now owned by `client/src/stores/keybindings.ts`).

- [ ] **Step 5: Remove `KeybindingMode` type and the keybindings functions**

Find (the whole block from `type KeybindingMode` through `initKeybindingIndicator`'s closing brace):

```ts
  type KeybindingMode = "normal" | "vim" | "emacs";

  // drawSelection() is now in the base extension list (see
  // buildEditorExtensions) — vim mode needs it (the vim package's own
  // docs call it out as required for correct visual-mode selection
  // rendering when not using CM6's basicSetup, which this app doesn't
  // use) and it's already unconditional, so it isn't added again here.
  //
  // Dynamically imported (not top-level imports) — @replit/codemirror-vim
  // and @replit/codemirror-emacs only matter for the small minority of
  // users who turn on non-default keybindings, so they shouldn't cost
  // every page load. "normal" (the default) resolves with no import at
  // all.
  async function keybindingsExtensionsFor(mode: KeybindingMode): Promise<Extension[]> {
    if (mode === "vim") {
      const { vim } = await import("@replit/codemirror-vim");
      return [vim()];
    }
    if (mode === "emacs") {
      const { emacs } = await import("@replit/codemirror-emacs");
      return [emacs()];
    }
    return [];
  }
```

Delete this entire block (the `keybindingsExtensionsFor` function and its comments — now in `Editor.svelte`), but **keep** the doc comment immediately above `buildEditorExtensions()` (the "Editor.svelte (mounted at #editor-mount) owns..." comment right before `function buildEditorExtensions()`) — that stays, just gets rewritten in Step 7 below.

Later in the same file, find (`applyKeybindings` through `initKeybindingIndicator`, currently right after the Focus Mode section's `toggleFocusMode`):

```ts
  // Shared by setKeybindings() (a user-triggered runtime switch) and
  // registerEditor() (applying whatever mode was saved from a previous
  // session, right after the view first exists) — both just need "make
  // the compartment and indicator reflect this mode," async either way
  // now that vim()/emacs() are dynamically imported.
  async function applyKeybindings(mode: KeybindingMode): Promise<void> {
    const extensions = await keybindingsExtensionsFor(mode);
    cm.dispatch({ effects: keybindingsCompartment.reconfigure(extensions) });
    await updateKeybindingIndicator(mode);
  }

  function setKeybindings(mode: KeybindingMode) {
    localStorage.setItem(STORAGE_KEYBINDINGS, mode);
    void applyKeybindings(mode);
  }

  async function updateKeybindingIndicator(mode: KeybindingMode): Promise<void> {
    const el = document.getElementById("keybindingMode");
    if (mode === "normal") {
      el.hidden = true;
      return;
    }
    if (mode === "emacs") {
      el.hidden = false;
      el.textContent = "EMACS";
      return;
    }
    // vim — getCM(view) only resolves once vim() has actually
    // initialized on this view. Each call to setKeybindings("vim") gets
    // a fresh CM5-compat instance (the package creates a new one every
    // time vim() initializes), so repeatedly toggling Vim mode on/off/on
    // never accumulates stale listeners on an old, discarded instance.
    // The dynamic import here always hits module cache — applyKeybindings
    // already imported the same module to build the vim() extension
    // above, so this never triggers a second network fetch.
    el.hidden = false;
    const { getCM } = await import("@replit/codemirror-vim");
    const cm5 = getCM(cm);
    const updateFromVimState = () => {
      const vimState = cm5?.state?.vim;
      el.textContent = vimState?.mode ? vimState.mode.toUpperCase() : "NORMAL";
    };
    updateFromVimState();
    cm5?.on("vim-mode-change", updateFromVimState);
  }

  function initKeybindingIndicator() {
    const mode = (localStorage.getItem(STORAGE_KEYBINDINGS) as KeybindingMode) || "normal";
    void updateKeybindingIndicator(mode);
  }
```

Delete this entire block.

- [ ] **Step 6: Remove the Focus Mode section**

Find (from the `// ---------- Focus Mode ----------` header through `toggleFocusMode`'s closing brace):

```ts
  // ---------- Focus Mode ----------
  const dimLineMark = Decoration.line({ class: "cm-dimmed-line" });

  function computeDimDecorations(state: EditorState): DecorationSet {
    const { from, to } = activeParagraphRange(state.doc, state.selection.main.head);
    const marks = [];
    for (let ln = 1; ln <= state.doc.lines; ln++) {
      const line = state.doc.line(ln);
      if (line.to < from || line.from > to) marks.push(dimLineMark.range(line.from));
    }
    return Decoration.set(marks);
  }

  const focusDimField = StateField.define<DecorationSet>({
    create: (state) => computeDimDecorations(state),
    update(deco, tr) {
      if (!tr.docChanged && !tr.selection) return deco;
      return computeDimDecorations(tr.state);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // Mutates scrollDOM.scrollTop directly — a plain DOM property write,
  // not cm.dispatch() — so there's no concern about dispatching a new
  // transaction from inside this same updateListener callback. Mirrors
  // how initSyncScroll() already manipulates cm.scrollDOM directly
  // elsewhere in this file, and reuses lineBlockAt(), the same API
  // editorPixelRangeForLines() (scroll-sync) relies on for real pixel
  // positions.
  function centerCursorLine(view: EditorView) {
    const pos = view.state.selection.main.head;
    const block = view.lineBlockAt(pos);
    const target = block.top - view.scrollDOM.clientHeight / 2 + block.height / 2;
    view.scrollDOM.scrollTop = Math.max(0, target);
  }

  const typewriterListener = EditorView.updateListener.of((update) => {
    if (update.docChanged || update.selectionSet) centerCursorLine(update.view);
  });

  function focusModeExtensions(): Extension[] {
    return [focusDimField, typewriterListener];
  }

  let focusModeOn = false;

  function toggleFocusMode() {
    focusModeOn = !focusModeOn;
    focusMode.set(focusModeOn);
    document.body.classList.toggle("focus-mode", focusModeOn);
    cm.dispatch({
      effects: focusModeCompartment.reconfigure(focusModeOn ? focusModeExtensions() : []),
    });
    if (focusModeOn) centerCursorLine(cm);
  }

```

Delete this entire block (all of it now lives in `Editor.svelte`).

- [ ] **Step 7: Shrink `buildEditorExtensions()`**

Find:

```ts
  // Editor.svelte (mounted at #editor-mount) owns the actual EditorView
  // construction/mount/destroy lifecycle — this just builds the extension
  // list, since that's almost entirely app.ts's own callbacks/state
  // (scheduleSave, wrapSelection, the collab compartments, ...) and has
  // nothing to do with where the DOM host element lives. The component
  // calls this from onMount and hands the resulting view back via
  // window.MDE.registerEditor.
  function buildEditorExtensions(): Extension[] {
    // Keybindings compartment starts empty regardless of the saved mode
    // — vim()/emacs() need an async dynamic import (see
    // keybindingsExtensionsFor), and this function's own return type is
    // relied on to stay synchronous (Editor.svelte builds the initial
    // EditorState directly from it). registerEditor() applies the saved
    // mode right after the view exists, via the same applyKeybindings()
    // helper setKeybindings() uses for a runtime switch — same
    // reconfigure-the-compartment mechanism either way, just async here.
    return [
      keybindingsCompartment.of([]),
      readOnlyCompartment.of(EditorState.readOnly.of(false)),
      editingModeCompartment.of(localEditingModeExtensions()),
      focusModeCompartment.of([]),
      keymap.of([
```

Replace with:

```ts
  // Editor.svelte (mounted at #editor-mount) owns the actual EditorView
  // construction/mount/destroy lifecycle, the readOnly/editing-mode/
  // focus-mode/keybindings compartments, and the base theme/highlighting
  // extensions (see docs/superpowers/specs/2026-08-19-editor-core-migration-design.md,
  // "Phase A"). This builds only what app.ts still owns — formatting
  // keymaps, the markdown language, comment/image/slash/wikilink fields,
  // the save/preview updateListener, paste/drop handlers — which
  // Editor.svelte splices in via window.MDE.getEditorExtensions().
  function buildEditorExtensions(): Extension[] {
    return [
      keymap.of([
```

Then find, a few lines further down in the same function:

```ts
      keymap.of(defaultKeymap),
      markdown({ extensions: [GFM] }),
      syntaxHighlighting(markdownHighlightStyle),
      editorTheme,
      EditorView.lineWrapping,
      // CM6's own decoration-based selection overlay — renders
      // regardless of DOM focus, unlike the browser's native text
      // selection (what CM6 falls back to without this), which visibly
      // disappears the moment focus moves elsewhere — e.g. to the
      // Comments panel's draft textarea while writing a comment on the
      // very text you just selected. editorTheme's own
      // .cm-selectionBackground rule was already written to keep the
      // same color in both focus states; this is what actually makes
      // that apply.
      drawSelection(),
      imageMarkerField,
```

Replace with:

```ts
      keymap.of(defaultKeymap),
      markdown({ extensions: [GFM] }),
      EditorView.lineWrapping,
      imageMarkerField,
```

(`syntaxHighlighting(markdownHighlightStyle)`, `editorTheme`, and `drawSelection()` now come from `Editor.svelte`'s own `buildExtensions()`, which runs before this function's return value is spread in — including them here too would register each twice.)

- [ ] **Step 8: Update `init()`**

Find (around line 210-212):

```ts
    document.getElementById("focusModeExitBtn")?.addEventListener("click", toggleFocusMode);
    initEmptyState();
    initKeybindingIndicator();
```

Replace with:

```ts
    // Focus mode is a store now (Editor.svelte reacts to it via $effect)
    // — this button only ever turns focus mode off, never on, so a plain
    // set(false) is correct (unlike MenuBar.svelte's toggle button).
    document.getElementById("focusModeExitBtn")?.addEventListener("click", () => focusMode.set(false));
    initEmptyState();
```

(`initKeybindingIndicator()` is gone — `Editor.svelte`'s own `$effect` on `$keybindingMode` already runs once at mount with the store's initial value, which does the same job.)

- [ ] **Step 9: Update `initModalEscapeKey()`**

Find (around line 289):

```ts
  function initModalEscapeKey() {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (focusModeOn) toggleFocusMode();
```

Replace with:

```ts
  function initModalEscapeKey() {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (get(focusMode)) focusMode.set(false);
```

- [ ] **Step 10: Update the bridge object literal**

Find:

```ts
    registerEditor(view) {
      cm = view;
      // buildEditorExtensions() always leaves the keybindings compartment
      // empty (see its own comment) — apply whatever mode was saved from
      // a previous session now that the view actually exists. "normal"
      // needs no import at all, so this is a no-op dispatch for the
      // (default, common) case.
      const savedKeybindingMode = (localStorage.getItem(STORAGE_KEYBINDINGS) as KeybindingMode) || "normal";
      void applyKeybindings(savedKeybindingMode);
    },
```

Replace with:

```ts
    registerEditor(view) {
      cm = view;
    },
```

Find:

```ts
    undo() {
      if (collabUndoManager) collabUndoManager.undo();
      else cmUndo(cm);
      cm.focus();
    },
    redo() {
      if (collabUndoManager) collabUndoManager.redo();
      else cmRedo(cm);
      cm.focus();
    },
    setReadOnly(readOnly) {
      cm.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)) });
    },
    enterCollabMode(extensions, undoManager) {
      collabUndoManager = undoManager;
      cm.dispatch({ effects: editingModeCompartment.reconfigure(extensions) });
    },
    exitCollabMode() {
      collabUndoManager = null;
      cm.dispatch({ effects: editingModeCompartment.reconfigure(localEditingModeExtensions()) });
    },
```

Delete this entire block (`Editor.svelte`'s `onMount` assigns all five directly onto `window.MDE` now).

Find:

```ts
    setView,
    toggleFocusMode,
    openDiagramEditor() {
```

Replace with:

```ts
    setView,
    openDiagramEditor() {
```

Find:

```ts
    setKeybindings,
    formatRelativeTime,
```

Replace with:

```ts
    formatRelativeTime,
```

- [ ] **Step 11: Clean up now-unused imports in `app.ts`**

Find:

```ts
import { EditorState, StateField, StateEffect, Compartment, Transaction, type Extension } from "@codemirror/state";
import { EditorView, Decoration, drawSelection, keymap, type DecorationSet } from "@codemirror/view";
import { history, historyKeymap, undo as cmUndo, redo as cmRedo, defaultKeymap, indentWithTab } from "@codemirror/commands";
```

Replace with:

```ts
import { StateField, StateEffect, Transaction, type Extension } from "@codemirror/state";
import { EditorView, Decoration, keymap, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
```

Find:

```ts
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
```

Delete both lines entirely (nothing in app.ts's remainder uses `HighlightStyle`, `syntaxHighlighting`, or `tags`/`t` — `markdownHighlightStyle`'s only use, `syntaxHighlighting(markdownHighlightStyle)`, moved to `Editor.svelte` in Step 7).

Find:

```ts
import { activeParagraphRange } from "./focus-mode";
```

Delete this line entirely (only `computeDimDecorations`, now in `Editor.svelte`, used it).

**Do not** remove the `import { editorTheme, markdownHighlightStyle } from "./editor-theme";` line Task 2 added — even though app.ts's own `buildEditorExtensions()` no longer uses them after Step 7, leaving an unused import would be a lint/dead-code issue. Remove that import line too:

Find:

```ts
import { editorTheme, markdownHighlightStyle } from "./editor-theme";
```

Delete this line entirely.

**Do not** remove `import { focusMode } from "./stores/focusMode";` — Steps 8 and 9 above both still call `focusMode.set(...)` / `get(focusMode)` from app.ts.

- [ ] **Step 12: Update `client/src/stores/focusMode.ts`'s stale comment**

Find:

```ts
// Mirrors viewMode's pattern — written in app.ts (the source of truth,
// since it also owns the CodeMirror compartment / body class side
// effects), read here by MenuBar.svelte for the View menu's checkmark.
// Not persisted to localStorage — always starts false on load, a
// session toggle rather than a sticky preference.
export const focusMode = writable<boolean>(false);
```

Replace with:

```ts
// Mirrors viewMode's pattern — written by whichever UI toggles focus
// mode (MenuBar.svelte, CommandPalette.svelte, app.ts's mobile exit
// button and desktop Escape handler); Editor.svelte reacts to it via
// $effect to own the CodeMirror compartment / body class side effects
// as of Phase A of the editor-core migration. Not persisted to
// localStorage — always starts false on load, a session toggle rather
// than a sticky preference.
export const focusMode = writable<boolean>(false);
```

- [ ] **Step 13: Update `Settings.svelte`**

Find:

```ts
  const STORAGE_KEYBINDINGS = "mde:keybindings";

  let hidden = $state(true);
  let theme = $state(localStorage.getItem(STORAGE_THEME) || "light");
  let customCss = $state(localStorage.getItem(STORAGE_CUSTOM_CSS) || "");
  let keybindings = $state(localStorage.getItem(STORAGE_KEYBINDINGS) || "normal");
```

Replace with:

```ts
  let hidden = $state(true);
  let theme = $state(localStorage.getItem(STORAGE_THEME) || "light");
  let customCss = $state(localStorage.getItem(STORAGE_CUSTOM_CSS) || "");
```

Add a new import near the top of the `<script>` block, alongside the existing `import { githubUsername } from "../stores/github";` line:

```ts
  import { keybindingMode, setKeybindingMode } from "../stores/keybindings";
```

Find:

```ts
  function applyKeybindings(next: "normal" | "vim" | "emacs") {
    keybindings = next;
    window.MDE.setKeybindings(next);
  }
```

Delete this function entirely (the template calls `setKeybindingMode` directly now).

Find (the three keybinding buttons):

```svelte
        <button type="button" class="tab-switch-btn" class:active={keybindings === "normal"} role="tab" aria-selected={keybindings === "normal"} onclick={() => applyKeybindings("normal")}>Normal</button>
        <button type="button" class="tab-switch-btn" class:active={keybindings === "vim"} role="tab" aria-selected={keybindings === "vim"} onclick={() => applyKeybindings("vim")}>Vim</button>
        <button type="button" class="tab-switch-btn" class:active={keybindings === "emacs"} role="tab" aria-selected={keybindings === "emacs"} onclick={() => applyKeybindings("emacs")}>Emacs</button>
```

Replace with:

```svelte
        <button type="button" class="tab-switch-btn" class:active={$keybindingMode === "normal"} role="tab" aria-selected={$keybindingMode === "normal"} onclick={() => setKeybindingMode("normal")}>Normal</button>
        <button type="button" class="tab-switch-btn" class:active={$keybindingMode === "vim"} role="tab" aria-selected={$keybindingMode === "vim"} onclick={() => setKeybindingMode("vim")}>Vim</button>
        <button type="button" class="tab-switch-btn" class:active={$keybindingMode === "emacs"} role="tab" aria-selected={$keybindingMode === "emacs"} onclick={() => setKeybindingMode("emacs")}>Emacs</button>
```

- [ ] **Step 14: Update `CommandPalette.svelte`**

Find (line 104):

```ts
    { id: "toggle-focus", label: $focusMode ? "Turn off Focus Mode" : "Turn on Focus Mode", category: "View", run: () => window.MDE.toggleFocusMode() },
```

Replace with:

```ts
    { id: "toggle-focus", label: $focusMode ? "Turn off Focus Mode" : "Turn on Focus Mode", category: "View", run: () => focusMode.update((v) => !v) },
```

- [ ] **Step 15: Update `MenuBar.svelte`**

Find (line 227):

```svelte
      <button class="menu-view-btn" class:active={$focusMode} type="button" onclick={() => act(() => window.MDE.toggleFocusMode())}>
```

Replace with:

```svelte
      <button class="menu-view-btn" class:active={$focusMode} type="button" onclick={() => act(() => focusMode.update((v) => !v))}>
```

- [ ] **Step 16: Type-check**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: 0 errors. If any remain, they're almost certainly a leftover reference to something removed in Steps 3-11 — search the reported file for the exact removed name (`toggleFocusMode`, `setKeybindings`, `focusModeOn`, `collabUndoManager`, `readOnlyCompartment`, etc.) rather than guessing.

- [ ] **Step 17: svelte-check**

Run: `npx svelte-check --tsconfig client/tsconfig.json`
Expected: 0 errors, 0 warnings.

- [ ] **Step 18: Run the full test suite**

Run: `npm test`
Expected: PASS, no regressions (this task moves code, doesn't change any tested behavior — no test file references any of the moved/removed symbols directly, since none of them were ever unit-tested, per this plan's Global Constraints).

- [ ] **Step 19: Live-verify — normal mode, vim mode, emacs mode**

Start a dev server (`npm run dev:client -- --port <unused port>`), seed a local doc via `localStorage` (same technique used throughout this session: `mde:docs`/`mde:workspaces`/`mde:active`/`mde:activeWorkspace`/`mde:whatsNewSeen`), and in a browser:

1. Default (normal) mode: type in the editor, confirm no vim/emacs status indicator shows.
2. Open Settings, switch to Vim. Confirm the status bar shows the vim mode indicator (starts as "NORMAL", vim's own normal mode). Click into the editor, press `0`, `d`, `w` in sequence on a line with at least two words — confirm the first word is deleted (a real vim motion working, not just the indicator changing — this exact test already worked in this session's earlier bundle-size-fix verification; confirm it still does after this relocation).
3. Switch to Emacs in Settings. Confirm the status bar indicator shows "EMACS".
4. Switch back to Normal. Confirm the indicator hides again.
5. Reload the page (with Vim still saved from step 2/3 if not switched back) — confirm the saved mode is restored on load without needing to reopen Settings.

- [ ] **Step 20: Live-verify — focus mode**

1. Open the View menu in `MenuBar.svelte`, click "Focus Mode". Confirm the current paragraph stays fully visible while the rest of the document visibly dims.
2. Toggle it off via the same menu item.
3. Open the Command Palette (Ctrl/Cmd+Shift+P), search "focus", run "Turn on Focus Mode" — confirm it activates the same way.
4. On a narrow/mobile-width viewport (or by checking the DOM directly), confirm `#focusModeExitBtn` is visible while focus mode is on and clicking it turns focus mode off.
5. With focus mode on, press Escape — confirm it turns focus mode off (the desktop escape-key path, `initModalEscapeKey()`).

- [ ] **Step 21: Live-verify — undo/redo (local path)**

Type some text, then trigger Edit > Undo from `MenuBar.svelte` (or Ctrl/Cmd+Z), confirm the text reverts. Trigger Redo, confirm it reapplies. This exercises `window.MDE.undo`/`redo`'s non-collab branch (`cmUndo`/`cmRedo`) — the collab branch (`collabUndoManager`) needs a real shared room via `wrangler dev`, which the spec already flagged as out of scope for this plan's live-verification (needs a running Durable Object backend, not just `vite dev`) — do not attempt to fake this path with stubbed data; skip it and note in the task-completion report that collab-mode read-only/editing-mode switching is unverified by this plan and should be checked manually against a real shared room before this lands in a release, not before merging to master.

- [ ] **Step 22: Clean up**

Close the browser tab, kill the dev server.

- [ ] **Step 23: Commit**

```bash
git add client/src/components/Editor.svelte client/src/types.ts client/src/app.ts \
  client/src/components/Settings.svelte client/src/components/CommandPalette.svelte \
  client/src/components/MenuBar.svelte client/src/stores/focusMode.ts
git commit -m "refactor: move editor compartments, keybindings, and focus mode into Editor.svelte"
```

---

## Post-plan note (for whoever runs `finishing-a-development-branch` after this)

Task 3, Step 21 identified a real gap: this plan cannot verify collab-mode read-only/editing-mode switching without a running Durable Object backend (`wrangler dev`). Flag this explicitly when presenting the merge/PR decision — it's a known, deliberate gap (per the spec's own Testing section), not an oversight, but it should be manually checked against a real shared room at some point before this branch's changes reach a tagged release, since `setReadOnly`/`enterCollabMode`/`exitCollabMode` are exactly the three bridge methods this plan made optional and reassigned ownership of.
