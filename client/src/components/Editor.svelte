<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { EditorView, Decoration, drawSelection, keymap, type DecorationSet } from "@codemirror/view";
  import { EditorState, Compartment, StateField, StateEffect, type Extension } from "@codemirror/state";
  import { history, historyKeymap, undo as cmUndo, redo as cmRedo } from "@codemirror/commands";
  import { syntaxHighlighting } from "@codemirror/language";
  import { editorTheme, markdownHighlightStyle } from "../editor-theme";
  import { keybindingMode, type KeybindingMode } from "../stores/keybindings";
  import { focusMode } from "../stores/focusMode";
  import { activeParagraphRange } from "../focus-mode";
  import { getActiveDoc } from "../stores/docs";
  import { imageKey } from "../image-key";

  let hostEl: HTMLDivElement | undefined = $state();
  // $state (not a plain let): the two $effects below guard their real work
  // behind `if (view)`, and that read has to be tracked even on the first
  // run — when view is still undefined, before onMount assigns it — or
  // Svelte never registers $keybindingMode/$focusMode as dependencies and
  // the effects go permanently inert (confirmed live: vim/emacs mode
  // never re-fired the dynamic import after that first no-op run).
  let view: EditorView | undefined = $state();

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
    window.MDE.insertImageWithUpload = insertImageWithUpload;
  });

  onDestroy(() => {
    view?.destroy();
  });
</script>

<div id="editorWrap">
  <div bind:this={hostEl} class="cm-host"></div>
</div>
