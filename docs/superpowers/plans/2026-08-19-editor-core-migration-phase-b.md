# Editor Core Migration Phase B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the four remaining self-contained editor-feature `StateField`s
(image markers/upload, comment markers, slash commands, wikilink
autocomplete) out of `client/src/app.ts` and into `client/src/components/Editor.svelte`,
continuing the Phase A pattern of `$effect`/component-scoped CodeMirror
ownership instead of app.ts's old imperative closure style.

**Architecture:** Each `StateField` (plus its supporting effects, sync
listener, and any pure helper functions) is a verbatim move from app.ts's
closure into Editor.svelte's `<script>` scope, with `cm` (app.ts's module-level
`EditorView`) replaced by `view!` (Editor.svelte's own). Two `window.MDE`
bridge methods change: `setCommentMarkers` becomes optional and is assigned
by `Editor.svelte`'s `onMount` (mirroring Phase A's `undo`/`redo`); a new
optional `insertImageWithUpload` is added the same way, so app.ts's
`initImageUploads()` (which wires the raw `#imageFileInput` DOM element,
staying in app.ts/index.html) can still reach it. The `Escape` key handler
splits out of its old shared keymap array (which also holds Phase D's
Mod-b/Mod-i/Mod-k) into its own keymap that moves with the slash/wikilink
fields it reads.

**Tech Stack:** Svelte 5 (runes: `$effect`, `$state`), CodeMirror 6
(`StateField`, `StateEffect`, `Decoration`/`DecorationSet`), TypeScript,
Vitest.

**Spec:** `docs/superpowers/specs/2026-08-19-editor-core-migration-phase-b-design.md`
(and Phase A's spec, `docs/superpowers/specs/2026-08-19-editor-core-migration-design.md`,
for the compartment/bridge conventions this plan continues).

## Global Constraints

- No behavior change — every moved piece is a verbatim relocation (module
  references adjusted, no logic rewritten), per the spec's Goals section.
- New/changed `MDEBridge` optional methods follow the exact doc-comment
  convention Phase A established for `undo?`/`redo?`/etc. (see
  `client/src/types.ts:181-192`).
- No new unit tests — this codebase has no precedent for testing Svelte
  component internals or CodeMirror extension construction (verified via
  `find client/src/components -name "*.test.ts"` returning nothing).
  Verification is `tsc`/`svelte-check`/`npm test` (regression only) plus
  live-browser verification, same posture as Phase A.
- `git commit` after each task, in the worktree already created for this
  phase (`.worktrees/editor-core-migration-phase-b`, branch
  `editor-core-migration-phase-b`) — no need to create a new one.

---

### Task 1: Image markers and image-upload logic → Editor.svelte

**Files:**
- Modify: `client/src/components/Editor.svelte`
- Modify: `client/src/app.ts:2` (import), `client/src/app.ts:3` (import),
  `client/src/app.ts:46` (import), `client/src/app.ts:304-350` (remove),
  `client/src/app.ts:562` (remove from array), `client/src/app.ts:915-969`
  (remove/modify), `client/src/app.ts:971-982` (remove),
  `client/src/app.ts:582-598` (remove from array)
- Modify: `client/src/types.ts:180-192` (add optional bridge member)

**Interfaces:**
- Consumes: `window.MDE.setDocImage(key, dataUrl)` (existing bridge
  method, `client/src/types.ts:159`, unchanged), `window.MDE.onImageAdded`
  (existing nullable bridge callback, `client/src/types.ts:160`,
  unchanged), `getActiveDoc()` from `client/src/stores/docs.ts` (existing
  export), `imageKey(filename, images)` from `client/src/image-key.ts`
  (existing export).
- Produces: `window.MDE.insertImageWithUpload?(file: File, pos?: number): void`
  — new optional bridge method, assigned by `Editor.svelte`'s `onMount`.
  Task 3's final cleanup step and app.ts's `initImageUploads()` (this
  task) both call it.

- [ ] **Step 1: Add the new imports Editor.svelte needs**

In `client/src/components/Editor.svelte`, the `<script>` block currently
starts:

```svelte
  import { onMount, onDestroy } from "svelte";
  import { EditorView, Decoration, drawSelection, keymap, type DecorationSet } from "@codemirror/view";
  import { EditorState, Compartment, StateField, type Extension } from "@codemirror/state";
  import { history, historyKeymap, undo as cmUndo, redo as cmRedo } from "@codemirror/commands";
  import { syntaxHighlighting } from "@codemirror/language";
  import { editorTheme, markdownHighlightStyle } from "../editor-theme";
  import { keybindingMode, type KeybindingMode } from "../stores/keybindings";
  import { focusMode } from "../stores/focusMode";
  import { activeParagraphRange } from "../focus-mode";
```

Change the `@codemirror/state` import to add `StateEffect`, and add two
new imports after the `activeParagraphRange` line:

```svelte
  import { EditorState, Compartment, StateField, StateEffect, type Extension } from "@codemirror/state";
```

```svelte
  import { activeParagraphRange } from "../focus-mode";
  import { getActiveDoc } from "../stores/docs";
  import { imageKey } from "../image-key";
```

- [ ] **Step 2: Add the image-marker field and upload logic to Editor.svelte**

Insert this new section after the Focus Mode section (after the
`focusModeExtensions()` function, i.e. right before the two `$effect(...)`
blocks — placement doesn't matter functionally, but keep it grouped with
its own comment header):

```svelte
  // ---------- Image markers ----------
  // A live-tracked highlight over "![Encoding photo.png…]()" while it's
  // being read, so the eventual real markdown link can be swapped in at
  // wherever that placeholder ends up — including if concurrent typing
  // (local or a collaborator's) shifted it since the upload started. CM6
  // decorations auto-map their position through every subsequent edit,
  // the same live tracking CM5's TextMarker gave this for free.
  let imageMarkerIdSeq = 0;
  const addImageMarkerEffect = StateEffect.define<{ id: number; from: number; to: number }>();
  const removeImageMarkerEffect = StateEffect.define<number>();
  const imageMarkerField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, tr) {
      let deco = value.map(tr.changes);
      for (const effect of tr.effects) {
        if (effect.is(addImageMarkerEffect)) {
          const mark = Decoration.mark({ class: "cm-image-uploading", id: effect.value.id });
          deco = deco.update({ add: [mark.range(effect.value.from, effect.value.to)] });
        } else if (effect.is(removeImageMarkerEffect)) {
          deco = deco.update({ filter: (_f, _t, d) => (d.spec as { id: number }).id !== effect.value });
        }
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  function addImageMarker(from: number, to: number): number {
    const id = ++imageMarkerIdSeq;
    view!.dispatch({ effects: addImageMarkerEffect.of({ id, from, to }) });
    return id;
  }

  function findImageMarker(id: number): { from: number; to: number } | undefined {
    let found: { from: number; to: number } | undefined;
    view!.state.field(imageMarkerField).between(0, view!.state.doc.length, (from, to, deco) => {
      if ((deco.spec as { id: number }).id === id) {
        found = { from, to };
        return false;
      }
    });
    return found;
  }

  function removeImageMarker(id: number) {
    view!.dispatch({ effects: removeImageMarkerEffect.of(id) });
  }

  // ---------- Image embedding (paste / drop / toolbar) ----------
  // Images are embedded directly as base64 data URIs in the markdown — no
  // upload, no server involved. Kept fairly small since it counts against
  // both localStorage's ~5-10MB quota and, for shared documents, the size
  // of every Yjs sync payload sent to collaborators. Paste/drop are wired
  // in buildExtensions() below; app.ts's initImageUploads() reaches this
  // through window.MDE.insertImageWithUpload for the toolbar/menu
  // file-picker path (the #imageFileInput element itself stays in
  // index.html — out of scope for this phase, see the design spec's
  // Non-goals).
  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

  function imageFilesFrom(dataTransfer: DataTransfer | null) {
    if (!dataTransfer || !dataTransfer.files) return [];
    return Array.from(dataTransfer.files).filter((f) => f.type.startsWith("image/"));
  }

  function altTextFromFilename(name: string) {
    return name.replace(/\.[^.]+$/, "") || "image";
  }

  function readImageAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  function insertImageWithUpload(file: File, pos?: number) {
    const from = pos ?? view!.state.selection.main.head;
    if (file.size > MAX_IMAGE_BYTES) {
      view!.dispatch({ changes: { from, insert: `![${file.name}: image too large, 2MB max]()` } });
      return;
    }

    const placeholder = `![Encoding ${file.name}…]()`;
    const to = from + placeholder.length;
    view!.dispatch({ changes: { from, insert: placeholder } });
    // Live-tracks the placeholder's position as other edits (local typing,
    // or a collaborator's) land while the file is being read.
    const markerId = addImageMarker(from, to);

    readImageAsDataURL(file)
      .then((dataUrl) => {
        const range = findImageMarker(markerId);
        removeImageMarker(markerId);
        if (!range) return; // doc was switched away mid-read; drop it
        const doc = getActiveDoc();
        if (!doc) return;
        const key = imageKey(file.name, doc.images || {});
        // Bridge method already does both the store write and the
        // preview refresh (app.ts's bridge.setDocImage) — one call
        // replaces app.ts's old separate setDocImage()+updatePreview().
        window.MDE.setDocImage(key, dataUrl);
        window.MDE.onImageAdded?.(key, dataUrl);
        view!.dispatch({ changes: { from: range.from, to: range.to, insert: `![${altTextFromFilename(file.name)}](${key})` } });
      })
      .catch((err) => {
        const range = findImageMarker(markerId);
        removeImageMarker(markerId);
        if (range) view!.dispatch({ changes: { from: range.from, to: range.to, insert: `![image failed to load: ${err.message}]()` } });
      });
  }
```

- [ ] **Step 3: Wire the field, paste/drop handlers, and bridge assignment into `buildExtensions()`/`onMount`**

Change `buildExtensions()` from:

```svelte
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
```

to:

```svelte
  function buildExtensions(): Extension[] {
    return [
      keybindingsCompartment.of([]),
      readOnlyCompartment.of(EditorState.readOnly.of(false)),
      editingModeCompartment.of(localEditingModeExtensions()),
      focusModeCompartment.of([]),
      syntaxHighlighting(markdownHighlightStyle),
      editorTheme,
      drawSelection(),
      imageMarkerField,
      EditorView.domEventHandlers({
        paste: (event) => {
          const files = imageFilesFrom(event.clipboardData);
          if (files.length === 0) return false;
          event.preventDefault();
          files.forEach((file) => insertImageWithUpload(file));
          return true;
        },
        drop: (event, v) => {
          const files = imageFilesFrom(event.dataTransfer);
          if (files.length === 0) return false;
          event.preventDefault();
          const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
          files.forEach((file) => insertImageWithUpload(file, pos ?? undefined));
          return true;
        },
      }),
      // Everything Phase C/D still own (formatting keymaps, markdown
      // language, comment/slash/wikilink fields, the save/preview
      // updateListener) — see app.ts's own buildEditorExtensions() and
      // its doc comment.
      ...window.MDE.getEditorExtensions(),
    ];
  }
```

In `onMount(...)`, after the existing `window.MDE.exitCollabMode = ...`
assignment, add:

```svelte
    window.MDE.insertImageWithUpload = insertImageWithUpload;
```

- [ ] **Step 4: Add the optional bridge member to `client/src/types.ts`**

Find the optional-bridge-methods block (around line 181-192):

```typescript
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

Add `insertImageWithUpload?` right after `exitCollabMode?`:

```typescript
  undo?(): void;
  redo?(): void;
  setReadOnly?(readOnly: boolean): void;
  enterCollabMode?(extensions: Extension, undoManager: { undo(): void; redo(): void }): void;
  exitCollabMode?(): void;
  // Assigned by Editor.svelte's onMount, same reasoning as the five
  // methods above — Phase B of the editor-core migration moved the
  // image-marker field and upload logic there. app.ts's
  // initImageUploads() (the #imageFileInput file-picker path) is the
  // only caller.
  insertImageWithUpload?(file: File, pos?: number): void;
```

- [ ] **Step 5: Remove the moved code from `client/src/app.ts`**

Delete lines 304-350 (the full "---- image-upload placeholder marker
----" comment block through the closing `}` of `removeImageMarker`).

In the remaining `buildEditorExtensions()` function, remove the
`imageMarkerField,` line (was line 562) and the entire
`EditorView.domEventHandlers({ paste: ..., drop: ... })` block (was lines
582-598) — including its trailing comma placement (whatever extension now
precedes it in the array becomes the last entry before
`window.MDE.getEditorExtensions()`'s spread, if this were app.ts's array
— but note this whole array lives in Editor.svelte now via Step 3; in
app.ts, the entry that directly preceded `domEventHandlers` is the
save/preview `EditorView.updateListener.of(...)` block, which simply
becomes the new last array entry).

Delete lines 971-982 (`altTextFromFilename` and `readImageAsDataURL`
functions — both fully moved, no longer referenced in app.ts).

Change `insertImageWithUpload`'s definition (was lines 937-969) and its
caller — `initImageUploads()` (was lines 924-930) — from:

```typescript
  function initImageUploads() {
    document.getElementById("imageFileInput").addEventListener("change", (e) => {
      const file = (e.target as HTMLInputElement).files[0];
      if (file) insertImageWithUpload(file);
      (e.target as HTMLInputElement).value = "";
    });
  }

  function imageFilesFrom(dataTransfer: DataTransfer | null) {
    if (!dataTransfer || !dataTransfer.files) return [];
    return Array.from(dataTransfer.files).filter((f) => f.type.startsWith("image/"));
  }

  function insertImageWithUpload(file: File, pos?: number) {
    // ...full body...
  }
```

to just:

```typescript
  function initImageUploads() {
    document.getElementById("imageFileInput").addEventListener("change", (e) => {
      const file = (e.target as HTMLInputElement).files[0];
      if (file) window.MDE.insertImageWithUpload?.(file);
      (e.target as HTMLInputElement).value = "";
    });
  }
```

(`imageFilesFrom` and `insertImageWithUpload` are deleted entirely —
fully moved to Editor.svelte. `MAX_IMAGE_BYTES`, which was defined right
above `initImageUploads()`, is also deleted from app.ts — it moved into
Editor.svelte in Step 2 and has no other app.ts reader.)

Remove the now-unused `imageKey` import — app.ts:46
(`import { imageKey } from "./image-key";`) — it was only referenced
inside the now-deleted `insertImageWithUpload`. Confirm before deleting:
`grep -n "imageKey(" client/src/app.ts` should return nothing.

- [ ] **Step 6: Type-check and verify**

```bash
cd client && npx tsc --noEmit
```

Expected: no output (clean). If you see `Cannot find name 'addImageMarker'`
or similar inside app.ts, you missed a reference — check
`grep -n "addImageMarker\|findImageMarker\|removeImageMarker\|insertImageWithUpload\|imageFilesFrom" client/src/app.ts`
returns nothing except the `initImageUploads` call site changed in Step 5.

```bash
npx svelte-check --tsconfig ./tsconfig.json
```

Expected: `0 ERRORS 0 WARNINGS`.

```bash
cd .. && npm test 2>&1 | tail -10
```

Expected: all existing tests still pass (this task adds no new tests —
image upload has no unit-test precedent in this codebase).

- [ ] **Step 7: Commit**

```bash
git add client/src/components/Editor.svelte client/src/app.ts client/src/types.ts
git commit -m "$(cat <<'EOF'
feat: move image markers and upload logic into Editor.svelte

Phase B (part 1) of the editor-core migration: imageMarkerField and
insertImageWithUpload/imageFilesFrom/paste-drop handling move from
app.ts into Editor.svelte. window.MDE gains an optional
insertImageWithUpload, assigned at mount, so app.ts's
initImageUploads() (still owning the raw #imageFileInput element) can
reach it.
EOF
)"
```

---

### Task 2: Comment markers → Editor.svelte

**Files:**
- Modify: `client/src/components/Editor.svelte`
- Modify: `client/src/app.ts:2-3` (imports), `client/src/app.ts:44`
  (import), `client/src/app.ts:352-404` (remove),
  `client/src/app.ts:567-568` (remove from array),
  `client/src/app.ts:2094-2096` (remove from bridge literal)
- Modify: `client/src/types.ts:181-192` (flip required → optional)

**Interfaces:**
- Consumes: `commentDraft` store from `client/src/stores/commentDraft.ts`
  (existing export, unchanged).
- Produces: `window.MDE.setCommentMarkers?(entries: { id: string; from: number; to: number }[]): void`
  — flips from a required bridge method (previously implemented in
  app.ts's bridge literal, wrapping an app.ts closure function) to
  optional, assigned by `Editor.svelte`'s `onMount`.
  `CommentsPanel.svelte:33,58` (existing call sites) are unchanged — they
  already call `window.MDE.setCommentMarkers(...)`, which now resolves to
  Editor.svelte's version instead of app.ts's.

- [ ] **Step 1: Add the `commentDraft` import to Editor.svelte**

Add alongside the imports Task 1 added:

```svelte
  import { commentDraft } from "../stores/commentDraft";
```

- [ ] **Step 2: Add the comment-marker field to Editor.svelte**

Insert after the image-embedding section Task 1 added:

```svelte
  // ---------- Comment markers ----------
  // Mirrors imageMarkerField exactly — a DecorationSet StateField whose
  // ranges auto-remap through every transaction via .map(tr.changes), so
  // highlights track live typing regardless of whether the document is
  // local or shared (this is a CodeMirror-level concern, independent of
  // how content itself syncs).
  const addCommentMarkerEffect = StateEffect.define<{ id: string; from: number; to: number }>();
  const removeCommentMarkerEffect = StateEffect.define<string>();
  const clearCommentMarkersEffect = StateEffect.define<null>();

  const commentMarkerField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, tr) {
      let deco = value.map(tr.changes);
      for (const effect of tr.effects) {
        if (effect.is(addCommentMarkerEffect)) {
          const mark = Decoration.mark({ class: "cm-comment-marker", id: effect.value.id });
          deco = deco.update({ add: [mark.range(effect.value.from, effect.value.to)] });
        } else if (effect.is(removeCommentMarkerEffect)) {
          deco = deco.update({ filter: (_f, _t, d) => (d.spec as { id: string }).id !== effect.value });
        } else if (effect.is(clearCommentMarkersEffect)) {
          deco = Decoration.none;
        }
      }
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  // Fully replaces the marker set — called whenever a document loads or
  // its entry list changes (create/delete). Simple full-resync rather
  // than incremental add/remove, since entry counts per document are
  // small.
  function setCommentMarkers(entries: { id: string; from: number; to: number }[]) {
    view!.dispatch({
      effects: [clearCommentMarkersEffect.of(null), ...entries.map((e) => addCommentMarkerEffect.of(e))],
    });
  }

  const commentDraftSyncListener = EditorView.updateListener.of((update) => {
    const sel = update.state.selection.main;
    if (sel.empty) {
      commentDraft.set({ visible: false, from: 0, to: 0, coords: null });
      return;
    }
    const rect = update.view.coordsAtPos(sel.to);
    commentDraft.set({
      visible: true,
      from: sel.from,
      to: sel.to,
      coords: rect ? { left: rect.left, bottom: rect.bottom } : null,
    });
  });
```

- [ ] **Step 3: Wire the field into `buildExtensions()` and assign the bridge method in `onMount`**

In `buildExtensions()`, add `commentMarkerField,` and
`commentDraftSyncListener,` right after the `imageMarkerField,` /
`EditorView.domEventHandlers({...})` block Task 1 added (before the
`...window.MDE.getEditorExtensions()` spread). Update the comment above
that spread from "comment/slash/wikilink fields" to "slash/wikilink
fields":

```svelte
      imageMarkerField,
      EditorView.domEventHandlers({ /* ...from Task 1... */ }),
      commentMarkerField,
      commentDraftSyncListener,
      // Everything Phase C/D still own (formatting keymaps, markdown
      // language, slash/wikilink fields, the save/preview updateListener)
      // — see app.ts's own buildEditorExtensions() and its doc comment.
      ...window.MDE.getEditorExtensions(),
```

In `onMount(...)`, after the `window.MDE.insertImageWithUpload = ...`
line Task 1 added:

```svelte
    window.MDE.setCommentMarkers = setCommentMarkers;
```

- [ ] **Step 4: Flip `setCommentMarkers` to optional in `client/src/types.ts`**

Remove the old required declaration (currently around line 208, in the
main body of the interface):

```typescript
  setCommentMarkers(entries: { id: string; from: number; to: number }[]): void;
```

Add it to the optional-bridge-methods block instead (the same block Task
1's Step 4 added `insertImageWithUpload?` to), right after it:

```typescript
  insertImageWithUpload?(file: File, pos?: number): void;
  // Assigned by Editor.svelte's onMount, same reasoning — Phase B moved
  // commentMarkerField there. CommentsPanel.svelte is the only caller.
  setCommentMarkers?(entries: { id: string; from: number; to: number }[]): void;
```

- [ ] **Step 5: Remove the moved code from `client/src/app.ts`**

Delete lines 352-404 (the full "---------- Comment markers ----------"
comment block through the end of `commentDraftSyncListener`).

In `buildEditorExtensions()`, remove the `commentMarkerField,` and
`commentDraftSyncListener,` lines (were lines 567-568).

In the bridge object literal (`const bridge: MDEBridge = {...}`, near the
end of the file), remove:

```typescript
    setCommentMarkers(entries) {
      setCommentMarkers(entries);
    },
```

(was lines 2094-2096 — the wrapped closure function it called no longer
exists in app.ts; the bridge no longer assigns this property at all,
matching how Phase A fully removed `undo`/`redo`/etc. from this same
literal rather than leaving stubs).

Remove the now-fully-unused `Decoration` and `DecorationSet` imports from
app.ts's `@codemirror/view` import (line 3). Before:

```typescript
import { EditorView, Decoration, keymap, type DecorationSet } from "@codemirror/view";
```

After:

```typescript
import { EditorView, keymap } from "@codemirror/view";
```

Confirm first: `grep -n "Decoration\.\|DecorationSet" client/src/app.ts`
should return nothing (both marker fields — image and comment — are now
gone; `StateField`/`StateEffect` are still used by the not-yet-moved
slash/wikilink fields, so leave those two imports alone this task).

Remove the now-unused `commentDraft` import — app.ts:44
(`import { commentDraft } from "./stores/commentDraft";`). Confirm first:
`grep -n "commentDraft\." client/src/app.ts` should return nothing.

- [ ] **Step 6: Type-check and verify**

```bash
cd client && npx tsc --noEmit
```

Expected: clean.

```bash
npx svelte-check --tsconfig ./tsconfig.json
```

Expected: `0 ERRORS 0 WARNINGS`.

```bash
cd .. && npm test 2>&1 | tail -10
```

Expected: all existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/Editor.svelte client/src/app.ts client/src/types.ts
git commit -m "$(cat <<'EOF'
feat: move comment markers into Editor.svelte

Phase B (part 2) of the editor-core migration: commentMarkerField and
its sync listener move from app.ts into Editor.svelte.
window.MDE.setCommentMarkers flips from required to optional,
assigned at mount — same pattern as Phase A's undo/redo.
CommentsPanel.svelte's call sites are unchanged.
EOF
)"
```

---

### Task 3: Slash commands, wikilink autocomplete, and the Escape keymap → Editor.svelte

**Files:**
- Modify: `client/src/components/Editor.svelte`
- Modify: `client/src/app.ts:2` (import), `client/src/app.ts:39,48-49`
  (imports), `client/src/app.ts:406-522` (remove),
  `client/src/app.ts:524-600` (rewrite `buildEditorExtensions()` and its
  doc comment)
- Modify: `client/src/types.ts:137-144` (update doc comment only)

**Interfaces:**
- Consumes: `slashMenu` store (`client/src/stores/slashMenu.ts`),
  `wikilinkMenu` store (`client/src/stores/wikilinkMenu.ts`) — both
  existing exports, unchanged.
- Produces: nothing new on the bridge — `slashTriggerField`/
  `wikilinkTriggerField` and their close effects are entirely
  Editor.svelte-internal, same as `focusDimField` from Phase A. No other
  module reads them directly.

- [ ] **Step 1: Add the `slashMenu`/`wikilinkMenu` imports to Editor.svelte**

Add alongside the other Task 1/2 imports:

```svelte
  import { slashMenu } from "../stores/slashMenu";
  import { wikilinkMenu } from "../stores/wikilinkMenu";
```

- [ ] **Step 2: Add the slash-command and wikilink-autocomplete fields, plus the Escape keymap**

Insert after the comment-markers section Task 2 added:

```svelte
  // ---------- Slash commands ----------
  interface SlashTriggerState {
    open: boolean;
    triggerPos: number;
  }

  const closeSlashMenuEffect = StateEffect.define<null>();

  // A plain StateField (no decorations to provide) tracking whether the
  // slash-command popup should be open and, if so, where the triggering
  // "/" is.
  const slashTriggerField = StateField.define<SlashTriggerState | null>({
    create: () => null,
    update(value, tr) {
      if (tr.effects.some((e) => e.is(closeSlashMenuEffect))) return null;
      if (!tr.docChanged && !tr.selection) return value;

      if (tr.docChanged) {
        let triggered: SlashTriggerState | null = null;
        tr.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
          if (toB - fromB === 1 && inserted.toString() === "/") {
            const line = tr.state.doc.lineAt(fromB);
            const before = tr.state.doc.sliceString(line.from, fromB);
            if (before.trim() === "") triggered = { open: true, triggerPos: fromB };
          }
        });
        if (triggered) return triggered;
      }

      if (!value?.open) return null;

      // Validate the existing open state is still valid: the "/" is
      // still there, the cursor hasn't moved before it, and no
      // space/newline has been typed into the query.
      const pos = tr.state.selection.main.head;
      if (pos <= value.triggerPos) return null;
      if (tr.state.doc.length <= value.triggerPos || tr.state.doc.sliceString(value.triggerPos, value.triggerPos + 1) !== "/") return null;
      const query = tr.state.sliceDoc(value.triggerPos + 1, pos);
      if (query.includes(" ") || query.includes("\n")) return null;
      return value;
    },
  });

  const slashMenuSyncListener = EditorView.updateListener.of((update) => {
    const value = update.state.field(slashTriggerField);
    if (!value?.open) {
      slashMenu.set({ open: false, query: "", triggerPos: 0, coords: null });
      return;
    }
    const pos = update.state.selection.main.head;
    const query = update.state.sliceDoc(value.triggerPos + 1, pos);
    const rect = update.view.coordsAtPos(value.triggerPos);
    slashMenu.set({
      open: true,
      query,
      triggerPos: value.triggerPos,
      coords: rect ? { left: rect.left, bottom: rect.bottom } : null,
    });
  });

  // ---------- Wikilink autocomplete ----------
  interface WikilinkTriggerState {
    open: boolean;
    triggerPos: number; // position right after the triggering "[["
  }

  const closeWikilinkMenuEffect = StateEffect.define<null>();

  // Structurally the same as slashTriggerField, but with different
  // close conditions — document names commonly contain spaces (unlike
  // slash-command names), so this doesn't close on a space; it closes
  // on "]" typed (the user closing the brackets by hand), a newline,
  // the cursor moving before the trigger, or the "[[" prefix itself
  // being deleted.
  const wikilinkTriggerField = StateField.define<WikilinkTriggerState | null>({
    create: () => null,
    update(value, tr) {
      if (tr.effects.some((e) => e.is(closeWikilinkMenuEffect))) return null;
      if (!tr.docChanged && !tr.selection) return value;

      if (tr.docChanged) {
        let triggered: WikilinkTriggerState | null = null;
        tr.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
          if (toB - fromB === 1 && inserted.toString() === "[" && fromB > 0 && tr.state.sliceDoc(fromB - 1, fromB) === "[") {
            triggered = { open: true, triggerPos: toB };
          }
        });
        if (triggered) return triggered;
      }

      if (!value?.open) return null;

      const pos = tr.state.selection.main.head;
      if (pos < value.triggerPos) return null;
      if (tr.state.sliceDoc(Math.max(0, value.triggerPos - 2), value.triggerPos) !== "[[") return null;
      const query = tr.state.sliceDoc(value.triggerPos, pos);
      if (query.includes("]") || query.includes("\n")) return null;
      return value;
    },
  });

  const wikilinkMenuSyncListener = EditorView.updateListener.of((update) => {
    const value = update.state.field(wikilinkTriggerField);
    if (!value?.open) {
      wikilinkMenu.set({ open: false, query: "", triggerPos: 0, coords: null });
      return;
    }
    const pos = update.state.selection.main.head;
    const query = update.state.sliceDoc(value.triggerPos, pos);
    const rect = update.view.coordsAtPos(value.triggerPos);
    wikilinkMenu.set({
      open: true,
      query,
      triggerPos: value.triggerPos,
      coords: rect ? { left: rect.left, bottom: rect.bottom } : null,
    });
  });

  // Split out of app.ts's old combined keymap array, which also held
  // Mod-b/Mod-i/Mod-k (Phase D's formatting shortcuts, still app.ts's) —
  // this phase's own trigger fields only.
  const menuEscapeKeymap = keymap.of([
    {
      key: "Escape",
      run: (v: EditorView) => {
        if (v.state.field(slashTriggerField)?.open) {
          v.dispatch({ effects: closeSlashMenuEffect.of(null) });
          return true;
        }
        if (v.state.field(wikilinkTriggerField)?.open) {
          v.dispatch({ effects: closeWikilinkMenuEffect.of(null) });
          return true;
        }
        return false;
      },
    },
  ]);
```

- [ ] **Step 3: Wire the fields and keymap into `buildExtensions()`**

Add `menuEscapeKeymap,`, `slashTriggerField,`, `slashMenuSyncListener,`,
`wikilinkTriggerField,`, `wikilinkMenuSyncListener,` after the
`commentDraftSyncListener,` line Task 2 added, and update the comment
above the `...window.MDE.getEditorExtensions()` spread one more time
(nothing phase-owned left to name except Phase C/D's own pieces):

```svelte
      commentMarkerField,
      commentDraftSyncListener,
      menuEscapeKeymap,
      slashTriggerField,
      slashMenuSyncListener,
      wikilinkTriggerField,
      wikilinkMenuSyncListener,
      // Everything Phase C/D still own (formatting keymaps, markdown
      // language, the save/preview updateListener) — see app.ts's own
      // buildEditorExtensions() and its doc comment.
      ...window.MDE.getEditorExtensions(),
```

- [ ] **Step 4: Split the Escape handler out of app.ts's keymap, and shrink `buildEditorExtensions()`**

In `client/src/app.ts`, change `buildEditorExtensions()` from (current
state after Tasks 1-2):

```typescript
  function buildEditorExtensions(): Extension[] {
    return [
      keymap.of([
        { key: "Mod-b", run: () => { wrapSelection("**", "**", "bold text"); return true; } },
        { key: "Mod-i", run: () => { wrapSelection("_", "_", "italic text"); return true; } },
        { key: "Mod-k", run: () => { insertLink(); return true; } },
        {
          key: "Escape",
          run: (view) => {
            if (view.state.field(slashTriggerField)?.open) {
              view.dispatch({ effects: closeSlashMenuEffect.of(null) });
              return true;
            }
            if (view.state.field(wikilinkTriggerField)?.open) {
              view.dispatch({ effects: closeWikilinkMenuEffect.of(null) });
              return true;
            }
            return false;
          },
        },
      ]),
      keymap.of([indentWithTab]),
      keymap.of(markdownKeymap),
      keymap.of(defaultKeymap),
      markdown({ extensions: [GFM] }),
      EditorView.lineWrapping,
      slashTriggerField,
      slashMenuSyncListener,
      wikilinkTriggerField,
      wikilinkMenuSyncListener,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          scheduleSave();
          updatePreview();
          updateCounts();
          activeDocContent.set(cm.state.doc.toString());
        }
        if (update.selectionSet) updateCursorPos();
        if (update.docChanged || update.selectionSet) followCursorInPreview();
      }),
    ];
  }
```

to:

```typescript
  // Editor.svelte (mounted at #editor-mount) owns the actual EditorView
  // construction/mount/destroy lifecycle, the readOnly/editing-mode/
  // focus-mode/keybindings compartments, the base theme/highlighting
  // extensions, and (as of Phase B of the editor-core migration) the
  // image/comment marker fields, slash-command and wikilink-autocomplete
  // fields, and the Escape keymap that closes their popups — see
  // docs/superpowers/specs/2026-08-19-editor-core-migration-phase-b-design.md.
  // This builds only what app.ts still owns — formatting keymaps, the
  // markdown language, and the save/preview updateListener — which
  // Editor.svelte splices in via window.MDE.getEditorExtensions().
  function buildEditorExtensions(): Extension[] {
    return [
      keymap.of([
        { key: "Mod-b", run: () => { wrapSelection("**", "**", "bold text"); return true; } },
        { key: "Mod-i", run: () => { wrapSelection("_", "_", "italic text"); return true; } },
        { key: "Mod-k", run: () => { insertLink(); return true; } },
      ]),
      // Tab/Shift-Tab indent-select-lines by default (indentWithTab
      // captures Tab entirely — it no longer moves focus out of the
      // editor via keyboard, a deliberate trade-off every code editor
      // with Tab-to-indent makes).
      keymap.of([indentWithTab]),
      keymap.of(markdownKeymap),
      keymap.of(defaultKeymap),
      markdown({ extensions: [GFM] }),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          scheduleSave();
          updatePreview();
          updateCounts();
          // Undebounced (unlike doc.content, which only syncs on the
          // debounced save) — DocList.svelte's outline for whichever doc
          // is active reads this so it stays live as-you-type.
          activeDocContent.set(cm.state.doc.toString());
        }
        if (update.selectionSet) updateCursorPos();
        if (update.docChanged || update.selectionSet) followCursorInPreview();
      }),
    ];
  }
```

(This replaces the old doc comment above `buildEditorExtensions()` too —
the one starting "Editor.svelte (mounted at #editor-mount) owns..." a few
lines above the function, which currently still lists "comment/image/
slash/wikilink fields, the save/preview updateListener, paste/drop
handlers" as app.ts-owned. Replace that whole comment with the one shown
above.)

- [ ] **Step 5: Delete the moved code and now-unused imports from `client/src/app.ts`**

Delete lines 406-522 (the full "---------- Slash commands ----------"
section through the end of `wikilinkMenuSyncListener` — this also removes
the `interface SlashTriggerState`/`interface WikilinkTriggerState`
declarations).

Remove the now-fully-unused `StateField` and `StateEffect` imports from
app.ts's `@codemirror/state` import (line 2). Before:

```typescript
import { StateField, StateEffect, Transaction, type Extension } from "@codemirror/state";
```

After:

```typescript
import { Transaction, type Extension } from "@codemirror/state";
```

Confirm first: `grep -n "StateField\.\|StateEffect\." client/src/app.ts`
should return nothing (image and comment fields are already gone from
Tasks 1-2; this task removes the last two users).

Remove the now-unused `slashMenu` import — app.ts:39
(`import { slashMenu } from "./stores/slashMenu";`) — and `wikilinkMenu`
import — app.ts:49 (`import { wikilinkMenu } from "./stores/wikilinkMenu";`).
Confirm first: `grep -n "slashMenu\.\|wikilinkMenu\." client/src/app.ts`
should return nothing.

Leave `transformWikilinks`/`resolveWikilinkTarget` (app.ts:48) alone —
those back the *rendered preview's* wikilink handling
(`initWikilinkNavigation()`, Phase C territory), a completely separate
concern from the *editor's* autocomplete trigger field this task moves.

- [ ] **Step 6: Update `client/src/types.ts`'s `getEditorExtensions()` doc comment**

Change (currently, after Phase A):

```typescript
  // Editor.svelte owns the EditorView's construction/mount/destroy
  // lifecycle AND, as of Phase A of the app.ts migration, the readOnly/
  // editing-mode/focus-mode/keybindings compartments and their base
  // theme/highlighting extensions. This asks app.ts for whatever it
  // still owns (Phase B/C/D territory — formatting keymaps, markdown
  // language, comment/image/slash/wikilink fields, the save/preview
  // updateListener, paste/drop handlers) to splice into the final list.
  getEditorExtensions(): Extension[];
```

to:

```typescript
  // Editor.svelte owns the EditorView's construction/mount/destroy
  // lifecycle and, as of Phase A and Phase B of the app.ts migration, the
  // readOnly/editing-mode/focus-mode/keybindings compartments, their base
  // theme/highlighting extensions, and the image/comment marker fields,
  // slash-command and wikilink-autocomplete fields, and paste/drop
  // handling. This asks app.ts for whatever it still owns (Phase C/D
  // territory — formatting keymaps, markdown language, the save/preview
  // updateListener) to splice into the final list.
  getEditorExtensions(): Extension[];
```

- [ ] **Step 7: Type-check and verify**

```bash
cd client && npx tsc --noEmit
```

Expected: clean.

```bash
npx svelte-check --tsconfig ./tsconfig.json
```

Expected: `0 ERRORS 0 WARNINGS`.

```bash
cd .. && npm test 2>&1 | tail -10
```

Expected: all existing tests pass (473, same count as before this
phase — no tests added or removed).

- [ ] **Step 8: Live-verify — every Phase B feature, plus a Phase A regression spot-check**

Start the dev server and seed `localStorage` with a test document, same
technique used for Phase A's live-verification (see
`docs/superpowers/plans/2026-08-19-editor-core-migration-phase-a.md`'s
own Step 19 for the exact seeding shape — one doc, one workspace, `mde:docs`/
`mde:workspaces`/`mde:active`/`mde:activeWorkspace`/`mde:whatsNewSeen` in
`localStorage`, then navigate to `/d/<docId>`):

```bash
cd client && npm run dev -- --port 5269
```

Then, via browser automation on that page:

1. **Image upload — paste**: copy an image to the clipboard (or use a
   data-URL/file fixture), paste into the editor. Confirm the
   `![Encoding ...]()` placeholder appears immediately, then resolves to
   a real `![alt](imagekey)` embedded image shortly after (check
   `window.MDE.getEditor().state.doc.toString()` before/after).
2. **Image upload — drop**: same check via a simulated drop event, or
   skip if the automation tooling can't synthesize `DataTransfer` — paste
   coverage already exercises the same `insertImageWithUpload` code path.
3. **Image upload — oversized file**: construct a `File` larger than 2MB
   (`new File([new Uint8Array(3 * 1024 * 1024)], "big.png", { type:
   "image/png" })`) and call
   `window.MDE.insertImageWithUpload(file)` directly via the browser
   console; confirm the doc gets the `"image too large, 2MB max"` inline
   message, not a placeholder.
4. **Image upload — toolbar file-picker path**: confirm
   `window.MDE.insertImageWithUpload` is defined
   (`typeof window.MDE.insertImageWithUpload === "function"`) — this is
   the function `initImageUploads()`'s `#imageFileInput` change listener
   now calls; a full click-through of the hidden file input isn't
   practical via automation, so this existence + type check plus the
   paste-path coverage above stands in for it.
5. **Comment markers**: seed a document with a `notes` entry (matching
   whatever shape `CommentsPanel.svelte` reads — check
   `client/src/stores/docs.ts`'s `Note` type / `addDocNote` for the exact
   field names before seeding), open the Comments panel, confirm the
   marker highlight renders at the right range in the editor and the
   panel entry is clickable; select some text, confirm the comment-draft
   popup UI appears; delete the note via the panel, confirm the highlight
   disappears.
6. **Slash commands**: click into the editor at the start of an empty
   line, type `/`, confirm the slash menu opens (check
   `document.querySelector` for whatever `SlashMenu.svelte` renders, or
   read the `slashMenu` store's value via a console import); type a few
   more characters, confirm the query updates; press Escape, confirm the
   menu closes and no text was inserted; repeat and instead pick a
   command (e.g. click "Heading 1"), confirm it runs and the menu closes.
7. **Wikilink autocomplete**: with at least two documents in the seeded
   workspace, click into the editor, type `[[`, confirm the wikilink menu
   opens; type part of the other document's name, confirm it filters;
   press Escape, confirm it closes without inserting `]]`.
8. **Phase A regression spot-check**: re-run a quick version of Phase A's
   own live-verification — switch keybinding mode to Vim via Settings,
   confirm the status-bar indicator updates and a real vim motion (e.g.
   pressing `i` then checking the indicator reads `INSERT`) works;
   toggle Focus Mode via the View menu, confirm `document.body` gets the
   `focus-mode` class; call `window.MDE.undo()`/`window.MDE.redo()` after
   an edit, confirm the content round-trips. This phase touches the same
   file Phase A did, so a regression here is plausible and cheap to rule
   out.

Stop the dev server when done.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/Editor.svelte client/src/app.ts client/src/types.ts
git commit -m "$(cat <<'EOF'
feat: move slash commands and wikilink autocomplete into Editor.svelte

Phase B (part 3, final) of the editor-core migration: slashTriggerField
and wikilinkTriggerField, their sync listeners, and the Escape keymap
that closes their popups move from app.ts into Editor.svelte. The
Escape handler splits out of its old shared keymap array (Mod-b/Mod-i/
Mod-k stay in app.ts, Phase D's). app.ts's buildEditorExtensions() is
now down to formatting keymaps, the markdown language, and the
save/preview updateListener.
EOF
)"
```

---

## Post-plan note

Same category of gap Phase A flagged: nothing in this phase's live
verification exercises the collab (shared-room) path — comment markers,
image markers, and the trigger fields all interact with the same
`editingModeCompartment`/Yjs undo stack Phase A already noted needs
`wrangler dev` to verify for real. This plan's Step 8 covers the local
(non-collab) path only, consistent with Phase A's own scope.

## Self-review

- **Spec coverage**: every Goals-section item in the Phase B design spec
  has a task — image markers/upload (Task 1), comment markers (Task 2),
  slash commands + wikilink autocomplete + Escape-keymap split (Task 3),
  `setCommentMarkers`/`insertImageWithUpload` bridge changes (Tasks 1-2),
  `getEditorExtensions()`'s doc-comment update (Task 3 Step 6). The
  spec's Non-goals (formatting keymaps, `#imageFileInput`'s own element,
  save/preview pipeline, `runCmd`'s `"image"` case) are explicitly left
  untouched — confirmed by name in each task's deletion steps calling out
  exactly what's *not* removed.
- **Placeholder scan**: none — every step's code block is the actual
  verbatim content (read directly from the current worktree state) or an
  exact diff, not a description.
- **Type consistency**: `insertImageWithUpload(file: File, pos?: number): void`
  matches between Task 1's Editor.svelte implementation, its
  `types.ts` declaration, and Task 3's live-verification Step 8's direct
  call. `setCommentMarkers(entries: { id: string; from: number; to: number }[]): void`
  matches between Task 2's Editor.svelte implementation, its `types.ts`
  declaration, and the unchanged `CommentsPanel.svelte` call sites.
- **Task boundaries**: each task is independently compilable and
  verifiable (`tsc`/`svelte-check`/`npm test` after every task) even
  though later tasks build on earlier ones' imports — Task 2 depends on
  Task 1 having already added `StateEffect` to Editor.svelte's imports,
  Task 3 depends on both. This mirrors how the underlying app.ts code
  itself is laid out today (all four fields share the same
  `buildEditorExtensions()` array), so splitting further (e.g. one task
  per field) would just fragment single logical array edits across more
  commits without making any task easier to review in isolation.
