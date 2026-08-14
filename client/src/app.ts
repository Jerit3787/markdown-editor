/* Markdown Editor — static, client-side, localStorage-backed */
import { EditorState, StateField, StateEffect, Compartment, Transaction, type Extension } from "@codemirror/state";
import { EditorView, Decoration, drawSelection, keymap, type DecorationSet } from "@codemirror/view";
import { history, historyKeymap, undo as cmUndo, redo as cmRedo, defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { marked } from "marked";
import DOMPurify from "dompurify";
import html2pdf from "html2pdf.js";
import type { Doc, MDEBridge } from "./types";
import {
  activeIdStore,
  activeDocContent,
  getActiveDoc,
  createDoc,
  switchDoc as storeSwitchDoc,
  renameDoc,
  saveActiveDocContent,
  setDocImage,
  deleteDocImage,
  refreshDocNoteAnchors,
  findCollidingDoc,
  docsStore,
} from "./stores/docs";
import { showToast } from "./stores/toast";
import { viewMode } from "./stores/view";
import { commentsPanelOpen } from "./stores/commentsPanel";
import { docListActiveTab } from "./stores/docList";
import { githubSignInModalOpen, githubSignInModalHint } from "./stores/githubSignInModal";
import { linkModalOpen, linkModalPrefillText } from "./stores/linkModal";
import { mermaidCodeRenderer, mermaidThemeFor, renderMermaidDiagrams } from "./mermaid-preview";
import { extractMathSpans, renderMathPlaceholders, type MathSource } from "./math-preview";
import { computeBlockLineStarts } from "./scroll-sync";
import { activeParagraphRange } from "./focus-mode";
import { focusMode } from "./stores/focusMode";
import { slashMenu } from "./stores/slashMenu";
import { vim, getCM } from "@replit/codemirror-vim";
import { emacs } from "@replit/codemirror-emacs";
import { resolveDiagramRefs } from "./diagram-refs";
import { diagramEditorOpen, diagramEditorRef } from "./stores/diagramEditor";
import { debounceWithFlush } from "./debounce";
import { maybeSnapshotVersion } from "./history";
import { commentDraft } from "./stores/commentDraft";
import { relocateAnchor } from "./anchor";
import { imageKey } from "./image-key";
import { renameCollision } from "./stores/renameCollision";
import { transformWikilinks, resolveWikilinkTarget } from "./wikilinks";
import { wikilinkMenu } from "./stores/wikilinkMenu";
import { get } from "svelte/store";
// Unlike Mermaid's SVGs (which bake their own <style> in at render time),
// KaTeX's HTML output has no self-contained styling — it's entirely
// dependent on this stylesheet. buildStandaloneHtml()'s exported <style>
// block is hand-written and independent of the app's own bundled CSS
// (where the normal @import in style.css lives), so it needs its own
// copy inlined here or math would render broken/unstyled in exported
// HTML files.
import katexCss from "katex/dist/katex.min.css?raw";
import markedFootnote from "marked-footnote";

// Registered once, at module scope — marked.use() mutates the shared
// marked singleton permanently, so this must never run inside
// updatePreview() or any other per-render function. Verified directly
// (a throwaway Node spike, not shipped) that this composes correctly
// with this file's existing pattern of creating a *fresh*
// marked.Renderer() per updatePreview() call and passing it via
// marked.parse(text, { renderer, ... }) — both the extension's footnote
// handling and the custom renderer overrides apply together correctly,
// and re-parsing the same content repeatedly (matching this app's
// per-keystroke re-render) produces identical output each time rather
// than accumulating state across calls.
//
// headingClass: "sr-only" — the package's default heading text
// ("Footnotes") for the trailing section is meant to be visually hidden
// but screen-reader-visible; style.css defines .sr-only for this.
// refMarkers left at its default (false) for bare superscript numbers,
// matching GitHub's own footnote rendering.
marked.use(markedFootnote({ headingClass: "sr-only" }));

(function () {
  "use strict";

  const STORAGE_THEME = "mde:theme";
  const STORAGE_VIEW = "mde:view";
  const STORAGE_KEYBINDINGS = "mde:keybindings";
  const APP_NAME = "Markdown Editor";

  function updatePageTitle(docName: string) {
    document.title = docName ? `${APP_NAME} - ${docName}` : APP_NAME;
  }

  // ---------- State ----------
  let cm: EditorView = null as unknown as EditorView;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  // Runs after every mermaid render pass — adds a hover-revealed "Edit"
  // button to each diagram backed by a real ref (see mermaid-preview.ts's
  // data-diagram-ref). Idempotent: skips a block that already has one, so
  // it's safe to call after every render, not just the first.
  function addDiagramEditButtons() {
    const preview = document.getElementById("preview");
    if (!preview) return;
    preview.querySelectorAll(".mermaid[data-diagram-ref]").forEach((block) => {
      if (block.querySelector(".mermaid-edit-btn")) return;
      const ref = block.getAttribute("data-diagram-ref");
      if (!ref) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mermaid-edit-btn";
      btn.textContent = "Edit";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        diagramEditorRef.set(ref);
        diagramEditorOpen.set(true);
      });
      block.appendChild(btn);
    });
  }

  // Diagrams re-render on a debounce (mirrors the save debounce below) so
  // typing inside/near a ```mermaid fence doesn't re-layout SVG on every
  // keystroke; theme changes and export force an immediate run instead —
  // see mermaidRenderScheduler.runNow()/.flush() call sites.
  const mermaidRenderScheduler = debounceWithFlush(() => {
    const preview = document.getElementById("preview");
    if (!preview) return;
    const theme = mermaidThemeFor(document.documentElement.getAttribute("data-theme"));
    return renderMermaidDiagrams(preview, theme).then(addDiagramEditButtons);
  }, 400);

  // Set at the top of updatePreview(), right before mathRenderScheduler is
  // triggered — the scheduler's callback reads whatever this currently
  // points to, same pattern mermaidRenderScheduler uses implicitly by just
  // reading the DOM #preview already wrote.
  let currentMathSources: Map<string, MathSource> = new Map();

  const mathRenderScheduler = debounceWithFlush(() => {
    const preview = document.getElementById("preview");
    if (!preview) return;
    return renderMathPlaceholders(preview, currentMathSources);
  }, 400);

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
  // ---------- Init ----------
  document.addEventListener("DOMContentLoaded", init);

  function init() {
    // cm is already populated by this point — Editor.svelte constructs the
    // EditorView in its own onMount and hands it back via
    // window.MDE.registerEditor(), and main.ts's mount() calls (which
    // trigger that) run synchronously before this DOMContentLoaded handler
    // ever fires, same guarantee every other Svelte component here relies on.
    initSyncScroll();
    initWikilinkNavigation();
    initImageUploads();
    initToolbar();
    initSaveStatus();
    initSidebar();
    initViewToggle();
    initImport();
    initShortStatus();
    initImagesManager();
    initShortcutsModal();
    initInfoModal();
    initModalHints();
    initModalEscapeKey();
    initEmptyState();
    initKeybindingIndicator();

    // stores/docs.ts owns docs/activeId (self-initialized from localStorage
    // at module-evaluation time, before this ever runs) — this just reacts
    // to it. A writable's subscriber fires immediately with the current
    // value AND synchronously on every future .set(), so this both does
    // the initial editor load and replaces every explicit
    // loadDocIntoEditor()/updatePreview()/updateCounts() call that used to
    // follow every doc-switching mutation (switchDoc/createDoc/deleteDoc/
    // duplicateDoc all funnel through activeIdStore now). The id===last
    // guard matters because activeIdStore.set() has no equality check of
    // its own — e.g. markActiveDocShared/setDocImage mutate docsStore
    // without changing which doc is active, and must not re-trigger a
    // reload (which would reset cursor position/undo history for no reason).
    let lastLoadedId: string | null | undefined;
    let firstFire = true;
    activeIdStore.subscribe((id) => {
      if (!firstFire && id === lastLoadedId) return;
      firstFire = false;
      lastLoadedId = id;
      loadDocIntoEditor(getActiveDoc());
      updatePreview();
      updateCounts();
    });
  }

  function formatRelativeTime(ts: number) {
    const diff = Date.now() - ts;
    const day = 86400000;
    if (diff < day) return "Today";
    if (diff < day * 2) return "Yesterday";
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function initModalEscapeKey() {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (focusModeOn) toggleFocusMode();
      // [data-svelte-modal] backdrops (e.g. Settings) manage their own
      // `hidden`-equivalent as reactive component state, not the DOM
      // `hidden` attribute — mutating that attribute directly from outside
      // wouldn't tell the component anything changed, leaving its state
      // out of sync with the DOM. Those components listen for Escape
      // themselves instead (see Settings.svelte).
      document.querySelectorAll(".modal-backdrop:not([hidden]):not([data-svelte-modal])").forEach((m) => {
        (m as HTMLElement & { hidden: boolean }).hidden = true;
      });
    });
  }

  // Empty-state action buttons just trigger the equivalent existing
  // control rather than duplicating its logic — "New document" is
  // #newDocBtn's own handler, "Open from device"/"Open from GitHub Gist"
  // are the File menu's own submenu buttons, all wired elsewhere.
  function initEmptyState() {
    document.getElementById("emptyNewDocBtn").addEventListener("click", () => {
      document.getElementById("newDocBtn").click();
    });
    document.getElementById("emptyOpenLocalBtn").addEventListener("click", () => {
      document.getElementById("importInput").click();
    });
    document.getElementById("emptyOpenGistBtn").addEventListener("click", () => {
      document.getElementById("menuOpenGist").click();
    });
  }

  // Theme is now owned by the Settings Svelte component (see
  // client/src/components/Settings.svelte) — it applies the saved theme to
  // <html> on mount, which happens before this module's own init() runs
  // (Settings mounts eagerly in main.ts, not gated behind
  // DOMContentLoaded). The editor's own colors are CSS custom properties
  // (see editorTheme below) that already flip with that attribute, so it
  // needs no separate reconfiguration when the theme changes.

  // ---------- Editor (CodeMirror 6) ----------
  const editorTheme = EditorView.theme({
    "&": { color: "var(--text)", backgroundColor: "var(--bg)", height: "100%" },
    ".cm-content": { fontFamily: "var(--mono)", fontSize: "14.5px", lineHeight: "1.6", padding: "4px 0", caretColor: "var(--text)" },
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

  // ---- image-upload placeholder marker ----
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
    cm.dispatch({ effects: addImageMarkerEffect.of({ id, from, to }) });
    return id;
  }

  function findImageMarker(id: number): { from: number; to: number } | undefined {
    let found: { from: number; to: number } | undefined;
    cm.state.field(imageMarkerField).between(0, cm.state.doc.length, (from, to, deco) => {
      if ((deco.spec as { id: number }).id === id) {
        found = { from, to };
        return false;
      }
    });
    return found;
  }

  function removeImageMarker(id: number) {
    cm.dispatch({ effects: removeImageMarkerEffect.of(id) });
  }

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
    cm.dispatch({
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

  // ---------- Slash commands ----------
  interface SlashTriggerState {
    open: boolean;
    triggerPos: number;
  }

  const closeSlashMenuEffect = StateEffect.define<null>();

  // Mirrors imageMarkerField's shape — a plain StateField (no
  // decorations to provide) tracking whether the slash-command popup
  // should be open and, if so, where the triggering "/" is.
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

  type KeybindingMode = "normal" | "vim" | "emacs";

  // drawSelection() is now in the base extension list (see
  // buildEditorExtensions) — vim mode needs it (the vim package's own
  // docs call it out as required for correct visual-mode selection
  // rendering when not using CM6's basicSetup, which this app doesn't
  // use) and it's already unconditional, so it isn't added again here.
  function keybindingsExtensionsFor(mode: KeybindingMode): Extension[] {
    if (mode === "vim") return [vim()];
    if (mode === "emacs") return [emacs()];
    return [];
  }

  // Editor.svelte (mounted at #editor-mount) owns the actual EditorView
  // construction/mount/destroy lifecycle — this just builds the extension
  // list, since that's almost entirely app.ts's own callbacks/state
  // (scheduleSave, wrapSelection, the collab compartments, ...) and has
  // nothing to do with where the DOM host element lives. The component
  // calls this from onMount and hands the resulting view back via
  // window.MDE.registerEditor.
  function buildEditorExtensions(): Extension[] {
    // vim()/emacs() must come before every other keymap-providing
    // extension for correct keybinding precedence (both packages'
    // own docs require this) — keybindingsCompartment is deliberately
    // first here, unlike every other compartment in this array, none
    // of which have an ordering requirement.
    const savedKeybindingMode = (localStorage.getItem(STORAGE_KEYBINDINGS) as KeybindingMode) || "normal";
    return [
      keybindingsCompartment.of(keybindingsExtensionsFor(savedKeybindingMode)),
      readOnlyCompartment.of(EditorState.readOnly.of(false)),
      editingModeCompartment.of(localEditingModeExtensions()),
      focusModeCompartment.of([]),
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
      // Tab/Shift-Tab indent-select-lines by default (indentWithTab
      // captures Tab entirely — it no longer moves focus out of the
      // editor via keyboard, a deliberate trade-off every code editor
      // with Tab-to-indent makes).
      keymap.of([indentWithTab]),
      keymap.of(markdownKeymap),
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
      slashTriggerField,
      slashMenuSyncListener,
      wikilinkTriggerField,
      wikilinkMenuSyncListener,
      commentMarkerField,
      commentDraftSyncListener,
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
      EditorView.domEventHandlers({
        paste: (event) => {
          const files = imageFilesFrom(event.clipboardData);
          if (files.length === 0) return false;
          event.preventDefault();
          files.forEach((file) => insertImageWithUpload(file));
          return true;
        },
        drop: (event, view) => {
          const files = imageFilesFrom(event.dataTransfer);
          if (files.length === 0) return false;
          event.preventDefault();
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          files.forEach((file) => insertImageWithUpload(file, pos ?? undefined));
          return true;
        },
      }),
    ];
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

  function setKeybindings(mode: KeybindingMode) {
    localStorage.setItem(STORAGE_KEYBINDINGS, mode);
    cm.dispatch({ effects: keybindingsCompartment.reconfigure(keybindingsExtensionsFor(mode)) });
    updateKeybindingIndicator(mode);
  }

  function updateKeybindingIndicator(mode: KeybindingMode) {
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
    el.hidden = false;
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
    updateKeybindingIndicator(mode);
  }

  // ---------- Synced scrolling (editor <-> preview, split mode only) ----------
  // Line-mapped, not proportional to the whole document — see
  // updatePreview()'s data-line tagging. A pure whole-document percentage
  // match used to desync badly once a single block's rendered height (a
  // tall diagram, a large image) was very disproportionate to how many
  // source lines it represents. This finds which tagged block a line (or
  // scroll position) falls inside, then interpolates *within* that
  // block using each side's own actual pixel height for its line range
  // — not the line count itself. A long-but-unwrapped-in-source
  // paragraph can occupy a single logical line yet many wrapped rows (so
  // many editor pixels) — line-count interpolation treated that whole
  // wrapped span as one fixed point (0% into the block, unmoving while
  // scrolling through it), then jumped through any short block right
  // after it almost instantly, since a short block's line count bought
  // it almost no share of the editor's scroll range even though its
  // preview footprint could be much taller. Pixel-to-pixel interpolation
  // (each side's own rendered height for the block, not source line
  // count) doesn't have this failure mode.
  //
  // Shared across initSyncScroll()'s explicit-scroll listeners and
  // followCursorInPreview() below (cursor/typing-driven, not scroll-event
  // driven) so the two can't fight each other via feedback loops.
  let syncingScroll = false;

  interface PreviewBlockMatch {
    element: HTMLElement;
    startLine: number;
    endLine: number; // exclusive — the next block's start line, or doc.lines for the last block
    top: number; // this block's offsetTop
    bottom: number; // the next block's offsetTop, or the preview's full scrollHeight for the last block
  }

  function taggedPreviewBlocks(preview: HTMLElement): { element: HTMLElement; line: number }[] {
    return Array.from(preview.querySelectorAll<HTMLElement>("[data-line]")).map((element) => ({
      element,
      line: Number(element.getAttribute("data-line")),
    }));
  }

  function previewBlockForLine(preview: HTMLElement, line: number, totalLines: number): PreviewBlockMatch | undefined {
    const blocks = taggedPreviewBlocks(preview);
    let idx = -1;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].line <= line) idx = i;
      else break; // tagged elements are in document order — line numbers are non-decreasing
    }
    if (idx === -1) return undefined;
    const endLine = idx + 1 < blocks.length ? blocks[idx + 1].line : totalLines;
    const bottom = idx + 1 < blocks.length ? blocks[idx + 1].element.offsetTop : preview.scrollHeight;
    return { element: blocks[idx].element, startLine: blocks[idx].line, endLine, top: blocks[idx].element.offsetTop, bottom };
  }

  function previewBlockForScrollTop(preview: HTMLElement, scrollTop: number, totalLines: number): PreviewBlockMatch | undefined {
    const blocks = taggedPreviewBlocks(preview);
    if (blocks.length === 0) return undefined;
    let idx = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].element.offsetTop <= scrollTop) idx = i;
      else break;
    }
    const endLine = idx + 1 < blocks.length ? blocks[idx + 1].line : totalLines;
    const bottom = idx + 1 < blocks.length ? blocks[idx + 1].element.offsetTop : preview.scrollHeight;
    return { element: blocks[idx].element, startLine: blocks[idx].line, endLine, top: blocks[idx].element.offsetTop, bottom };
  }

  // The editor's own rendered pixel range for a block's [startLine, endLine)
  // span — e.g. a heavily-wrapped single-line paragraph reports a tall
  // range here despite being one source line, which is exactly the
  // signal line-count interpolation was blind to.
  function editorPixelRangeForLines(startLine: number, endLine: number): { top: number; bottom: number } {
    const totalLines = cm.state.doc.lines;
    const top = cm.lineBlockAt(cm.state.doc.line(Math.min(startLine + 1, totalLines)).from).top;
    const bottom = endLine < totalLines
      ? cm.lineBlockAt(cm.state.doc.line(endLine + 1).from).top
      : cm.scrollDOM.scrollHeight;
    return { top, bottom };
  }

  // Maps pos's fraction through [fromTop, fromBottom) onto [toTop, toBottom).
  function interpolateAcross(pos: number, fromTop: number, fromBottom: number, toTop: number, toBottom: number): number {
    const span = Math.max(1, fromBottom - fromTop);
    const fraction = Math.min(1, Math.max(0, (pos - fromTop) / span));
    return toTop + fraction * (toBottom - toTop);
  }

  // How close to a pane's absolute max scrollTop still counts as "at the
  // end" for the at-max special case below. CodeMirror's own
  // scroll-cursor-into-view behavior (e.g. Cmd+Down to the document end)
  // was observed leaving a few px of unscrolled slack rather than
  // landing on the exact pixel — likely scroller padding/line-height
  // rounding — so a strict `>= max` check missed it.
  const SYNC_SCROLL_END_SLACK_PX = 8;

  function initSyncScroll() {
    const body = document.getElementById("body") as HTMLElement;
    const preview = document.getElementById("preview") as HTMLElement;

    cm.scrollDOM.addEventListener("scroll", () => {
      if (syncingScroll || !body.classList.contains("mode-split")) return;
      const el = cm.scrollDOM;
      const editorMax = el.scrollHeight - el.clientHeight;
      if (editorMax <= 0) return;
      // At the editor's true end: mirror the preview's true end too,
      // rather than the interpolated position below, which can fall
      // short of it — the last block's own bottom doesn't necessarily
      // line up with the true bottom of the scrollable preview content
      // once trailing padding/margins don't exactly fill the remaining
      // viewport height. Without this, scrolling either pane to its
      // actual end could leave the other pane visibly short of its own
      // end.
      if (el.scrollTop >= editorMax - SYNC_SCROLL_END_SLACK_PX) {
        syncingScroll = true;
        preview.scrollTop = preview.scrollHeight - preview.clientHeight;
        requestAnimationFrame(() => { syncingScroll = false; });
        return;
      }
      const topLine = cm.state.doc.lineAt(cm.lineBlockAtHeight(el.scrollTop).from).number - 1;
      const match = previewBlockForLine(preview, topLine, cm.state.doc.lines);
      if (!match) return;
      const editorRange = editorPixelRangeForLines(match.startLine, match.endLine);
      syncingScroll = true;
      preview.scrollTop = interpolateAcross(el.scrollTop, editorRange.top, editorRange.bottom, match.top, match.bottom);
      requestAnimationFrame(() => { syncingScroll = false; });
    });

    preview.addEventListener("scroll", () => {
      if (syncingScroll || !body.classList.contains("mode-split")) return;
      const previewMax = preview.scrollHeight - preview.clientHeight;
      if (previewMax <= 0) return;
      // Mirrors the editor-at-max case above, in the other direction.
      if (preview.scrollTop >= previewMax - SYNC_SCROLL_END_SLACK_PX) {
        syncingScroll = true;
        cm.dispatch({ effects: EditorView.scrollIntoView(cm.state.doc.length, { y: "end" }) });
        requestAnimationFrame(() => { syncingScroll = false; });
        return;
      }
      const match = previewBlockForScrollTop(preview, preview.scrollTop, cm.state.doc.lines);
      if (!match) return;
      const editorRange = editorPixelRangeForLines(match.startLine, match.endLine);
      syncingScroll = true;
      cm.scrollDOM.scrollTop = interpolateAcross(preview.scrollTop, match.top, match.bottom, editorRange.top, editorRange.bottom);
      requestAnimationFrame(() => { syncingScroll = false; });
    });
  }

  // ---------- Wikilinks ----------
  // One delegated listener on the stable #preview container, not
  // per-element — updatePreview() replaces the whole innerHTML on every
  // keystroke, so per-element listeners would need constant
  // re-attachment (same reasoning as every other preview-content
  // interaction in this file).
  function initWikilinkNavigation() {
    const previewEl = document.getElementById("preview");
    previewEl.addEventListener("click", (e) => {
      const link = (e.target as HTMLElement).closest<HTMLElement>(".wikilink");
      if (!link) return;
      e.preventDefault();
      const name = link.getAttribute("data-doc-name");
      if (!name) return;
      const target = resolveWikilinkTarget(name, get(docsStore));
      if (target) {
        storeSwitchDoc(target.id);
      } else {
        createDoc({ name });
      }
    });
  }

  // initSyncScroll()'s listeners only react to explicit scroll *events* —
  // typing or moving the cursor onto a line that's already visible in the
  // editor's current viewport (so the editor itself never scrolls) never
  // fired them, even when the *preview's* corresponding position was
  // well out of view (e.g. below a tall diagram or image, or elsewhere
  // within a tall block). Called on every doc change and cursor move;
  // brings the cursor's interpolated position into view only when it
  // isn't already visible, so the preview doesn't jump around on every
  // keystroke while editing something already on screen.
  function followCursorInPreview() {
    const body = document.getElementById("body") as HTMLElement;
    if (!body.classList.contains("mode-split")) return;
    const preview = document.getElementById("preview") as HTMLElement;
    const cursorPos = cm.state.selection.main.head;
    const cursorLine = cm.state.doc.lineAt(cursorPos).number - 1;
    const match = previewBlockForLine(preview, cursorLine, cm.state.doc.lines);
    if (!match) return;
    const editorRange = editorPixelRangeForLines(match.startLine, match.endLine);
    const cursorEditorTop = cm.lineBlockAt(cursorPos).top;
    const targetScrollTop = interpolateAcross(cursorEditorTop, editorRange.top, editorRange.bottom, match.top, match.bottom);
    if (targetScrollTop >= preview.scrollTop && targetScrollTop <= preview.scrollTop + preview.clientHeight) return; // already visible
    syncingScroll = true;
    preview.scrollTop = targetScrollTop;
    requestAnimationFrame(() => { syncingScroll = false; });
  }

  // ---------- Edit menu clipboard commands ----------
  // The browser's native Ctrl/Cmd+X/C/V already work on the editor without
  // any of this — these three only exist to back the Edit-menu Cut/Copy/Paste
  // items, since a menu click has no native clipboard access of its own.
  async function menuClipboardCut() {
    const { from, to } = cm.state.selection.main;
    if (from === to) { cm.focus(); return; }
    const sel = cm.state.sliceDoc(from, to);
    try {
      await navigator.clipboard.writeText(sel);
      cm.dispatch({ changes: { from, to, insert: "" } });
    } catch {
      cm.focus();
      document.execCommand("cut");
    }
    cm.focus();
  }

  async function menuClipboardCopy() {
    const { from, to } = cm.state.selection.main;
    if (from === to) { cm.focus(); return; }
    const sel = cm.state.sliceDoc(from, to);
    try {
      await navigator.clipboard.writeText(sel);
    } catch {
      cm.focus();
      document.execCommand("copy");
    }
    cm.focus();
  }

  async function menuClipboardPaste() {
    cm.focus();
    try {
      const text = await navigator.clipboard.readText();
      cm.dispatch(cm.state.replaceSelection(text));
    } catch {
      alert("Couldn't read the clipboard automatically — press Ctrl/Cmd+V instead, or allow clipboard access for this site.");
    }
  }

  // ---------- Image embedding (paste / drop / toolbar) ----------
  // Images are embedded directly as base64 data URIs in the markdown — no
  // upload, no server involved. Kept fairly small since it counts against
  // both localStorage's ~5-10MB quota and, for shared documents, the size
  // of every Yjs sync payload sent to collaborators. Paste/drop themselves
  // are wired in initEditor() (EditorView.domEventHandlers) — this only
  // needs the toolbar/menu's own file-picker input.
  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

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
    const from = pos ?? cm.state.selection.main.head;
    if (file.size > MAX_IMAGE_BYTES) {
      cm.dispatch({ changes: { from, insert: `![${file.name}: image too large, 2MB max]()` } });
      return;
    }

    const placeholder = `![Encoding ${file.name}…]()`;
    const to = from + placeholder.length;
    cm.dispatch({ changes: { from, insert: placeholder } });
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
        setDocImage(key, dataUrl);
        window.MDE.onImageAdded && window.MDE.onImageAdded(key, dataUrl);
        cm.dispatch({ changes: { from: range.from, to: range.to, insert: `![${altTextFromFilename(file.name)}](${key})` } });
        updatePreview();
      })
      .catch((err) => {
        const range = findImageMarker(markerId);
        removeImageMarker(markerId);
        if (range) cm.dispatch({ changes: { from: range.from, to: range.to, insert: `![image failed to load: ${err.message}]()` } });
      });
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


  function resolveImageRefs(text: string, doc: Doc | undefined) {
    if (!doc || !doc.images) return text;
    return text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt, ref) => {
      const dataUrl = doc.images[ref];
      return dataUrl ? `![${alt}](${dataUrl})` : match;
    });
  }

  // ---------- Images manager ----------
  function initImagesManager() {
    const btn = document.getElementById("imagesManagerBtn");
    const modal = document.getElementById("imagesModal");
    const closeBtn = document.getElementById("imagesCloseBtn");

    btn.addEventListener("click", () => {
      renderImagesList();
      modal.hidden = false;
    });
    closeBtn.addEventListener("click", () => { modal.hidden = true; });
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });
  }

  function renderImagesList() {
    const doc = getActiveDoc();
    const images = (doc && doc.images) || {};
    const keys = Object.keys(images);
    const list = document.getElementById("imagesList");
    const emptyHint = document.getElementById("imagesEmptyHint");
    list.innerHTML = "";
    emptyHint.hidden = keys.length > 0;

    // Removing an image's markdown reference from the text doesn't
    // delete it from doc.images — same "don't destroy data the user
    // might want back" stance orphaned comment anchors already take
    // (see Note.orphaned) — but showing it identically to an
    // actively-used image made it look like the manager just doesn't
    // notice references being removed. Flagged here instead, against
    // the live editor buffer (not the last-saved doc.content) so it's
    // accurate immediately after an edit, before the debounced save.
    const rawContent = cm.state.doc.toString();
    keys.forEach((key) => {
      const dataUrl = images[key];
      const used = rawContent.includes(`](${key})`);
      const item = document.createElement("div");
      item.className = "image-item";
      if (!used) item.classList.add("unused");
      item.innerHTML = `
        <img src="${dataUrl}" alt="">
        <div class="image-meta">
          <div class="image-name">${escapeHtml(key)}${used ? "" : ' <span class="image-unused-label">(not used in this document)</span>'}</div>
          <div class="image-size">${formatBytes(dataUrl.length)}</div>
        </div>
        <button class="icon-btn" title="Delete image" aria-label="Delete ${escapeHtml(key)}"><svg class="icon"><use href="#icon-trash-2"></use></svg></button>
      `;
      item.querySelector("button").addEventListener("click", () => {
        if (!confirm(`Delete "${key}"? Any reference to it in the text will show as a broken image.`)) return;
        deleteDocImage(key);
        updatePreview();
        renderImagesList();
      });
      list.appendChild(item);
    });
  }

  function formatBytes(base64Length: number) {
    const bytes = Math.round(base64Length * 0.75);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  // Toggles between the editor/preview panes and the empty-state welcome
  // screen (#emptyState) — the only reachable "no document" case is
  // deleting the last remaining doc, or a brand-new visitor with nothing
  // in storage yet (loadDocs() no longer seeds a Welcome doc).
  function updateMainView(empty: boolean) {
    document.getElementById("emptyState").hidden = !empty;
    (document.getElementById("editorPane") as HTMLElement).style.display = empty ? "none" : "";
    (document.getElementById("previewPane") as HTMLElement).style.display = empty ? "none" : "";
    (document.getElementById("divider") as HTMLElement).style.display = empty ? "none" : "";
    (document.getElementById("toolbar") as HTMLElement).style.display = empty ? "none" : "";
    (document.querySelector(".view-selector") as HTMLElement).style.display = empty ? "none" : "";

    // On mobile the sidebar is a full-height overlay (see css) — if it was
    // open (e.g. the user just deleted the last doc from the doc list),
    // landing on the empty state would otherwise stay hidden behind it.
    if (empty) collapseSidebarForMobile();

    // Nothing to rename/save/share/browse/preview when there's no document
    // open — lock down the topbar/sidebar/menu-bar controls that would
    // otherwise imply there is one, rather than leaving them clickable
    // no-ops.
    (document.getElementById("docTitle") as HTMLInputElement).disabled = empty;
    document.getElementById("saveStatusBtn").hidden = empty;
    (document.getElementById("sidebarToggleIn") as HTMLButtonElement).disabled = empty;
    (document.getElementById("shareBtn") as HTMLButtonElement).disabled = empty;
    (document.getElementById("commentsBtn") as HTMLButtonElement).disabled = empty;
    (document.getElementById("versionHistoryBtn") as HTMLButtonElement).disabled = empty;
  }

  // Replaces the whole document and resets the local (non-collab) undo
  // history in one transaction — matches the old setValue()+clearHistory()
  // pair used on every doc switch. Marked addToHistory:false so the load
  // itself never becomes an undo-able entry (undo should do nothing right
  // after opening a document, not revert to the previous one's content).
  // Also resets editingModeCompartment to local mode: collab.ts's
  // onBeforeDocLoad hook already tears any active room down before this
  // runs, but a stale collab extension config (bound to the OLD room's
  // Y.Text) must not survive into whatever doc loads next.
  function setEditorContent(content: string) {
    collabUndoManager = null;
    cm.dispatch({
      changes: { from: 0, to: cm.state.doc.length, insert: content },
      effects: editingModeCompartment.reconfigure(localEditingModeExtensions()),
      annotations: Transaction.addToHistory.of(false),
      selection: { anchor: 0 },
    });
  }

  function loadDocIntoEditor(doc: Doc | undefined) {
    window.MDE.onBeforeDocLoad && window.MDE.onBeforeDocLoad();
    updateMainView(!doc);
    if (!doc) {
      setEditorContent("");
      (document.getElementById("docTitle") as HTMLInputElement).value = "Welcome";
      resizeDocTitle();
      updatePageTitle("Welcome");
      setSaveStatus("");
      setCommentMarkers([]);
      window.MDE.onActiveDocChanged && window.MDE.onActiveDocChanged(undefined as unknown as Doc);
      return;
    }
    setEditorContent(doc.content || "");
    (document.getElementById("docTitle") as HTMLInputElement).value = doc.name || "Untitled";
    resizeDocTitle();
    updatePageTitle(doc.name || "Untitled");
    setSaveStatus(savedLabel(doc));
    // Local notes' markers are set directly here (synchronous, no
    // network). Shared documents' thread markers are set later, once
    // CommentsPanel.svelte fetches them (asynchronous) — clear here so a
    // switch away from a doc with local-note markers doesn't leave them
    // showing on a shared doc that hasn't loaded its own threads yet.
    if (!doc.shared) {
      const relocated = (doc.notes || [])
        .map((n) => {
          const r = relocateAnchor(doc.content || "", n);
          return r ? { id: n.id, from: r.from, to: r.to } : null;
        })
        .filter((x): x is { id: string; from: number; to: number } => x !== null);
      setCommentMarkers(relocated);
    } else {
      setCommentMarkers([]);
    }
    window.MDE.onActiveDocChanged && window.MDE.onActiveDocChanged(doc);
  }

  // ---------- Save ----------
  function scheduleSave() {
    setSaveStatus("Saving…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  function saveNow() {
    saveActiveDocContent();
    const doc = getActiveDoc();
    // Once a document has ever been shared, CollabRoom (server-side) is
    // the sole owner of its history — see history.ts's own comment.
    if (doc && !doc.shared) {
      void maybeSnapshotVersion(doc.id, doc.content);
      refreshDocNoteAnchors(doc.content);
    }
    setSaveStatus(savedLabel(doc));
  }

  // Everything always lives in this browser's localStorage first; the
  // status text just also surfaces whether it's *also* linked elsewhere,
  // since that's the part that's easy to lose track of.
  function savedLabel(doc: Doc | undefined) {
    return doc && doc.gistId ? "Saved locally · linked to Gist" : "Saved locally";
  }

  function setSaveStatus(text: string) {
    const btn = document.getElementById("saveStatusBtn");
    const saving = /ing…$/.test(text);
    btn.classList.toggle("saving", saving);
    btn.title = text;
    btn.setAttribute("aria-label", text);
    document.getElementById("saveStatusIcon").setAttribute("href", saving ? "#icon-cloud" : "#icon-cloud-check");
    renderSaveStatusPopup(saving);
  }

  function relativeTime(ts: number) {
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 5) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.round(hr / 24)}d ago`;
  }

  function initSaveStatus() {
    const btn = document.getElementById("saveStatusBtn");
    const popup = document.getElementById("saveStatusPopup");
    // Refresh the "last saved Xs ago" text right before it's shown, not
    // just whenever a save happens — otherwise it goes stale the longer
    // the popup sits closed between saves.
    btn.addEventListener("click", () => renderSaveStatusPopup(btn.classList.contains("saving")));
    toggleDropdown(btn, popup);
  }

  function renderSaveStatusPopup(saving: boolean) {
    const doc = getActiveDoc();
    document.getElementById("saveStatusHeadline").textContent = saving ? "Saving…" : "Saved";
    document.getElementById("saveStatusDetail").textContent =
      doc && doc.updatedAt && !saving
        ? `Last saved ${relativeTime(doc.updatedAt)}, to this browser's local storage.`
        : "Saved to this browser's local storage.";
    const gistLink = document.getElementById("saveStatusGistLink") as HTMLAnchorElement;
    const hasGist = doc && doc.gistId;
    gistLink.hidden = !hasGist;
    if (hasGist) gistLink.href = `https://gist.github.com/${doc.gistId}`;
  }

  // ---------- Preview ----------
  function updatePreview() {
    const raw = cm.state.doc.toString();
    const doc = getActiveDoc();
    const renderer = new marked.Renderer();
    // ![alt](refName) resolves against doc.images; anything not a known
    // ref (a real URL, or an old doc predating this feature that still has
    // the full data URI inline) passes through untouched. marked 12's
    // built-in image renderer takes positional (href, title, text), not a
    // token object — verified against the actual loaded version.
    renderer.image = (href: string, title: string | null, text: string) => {
      const resolved = doc && doc.images && doc.images[href] ? doc.images[href] : href;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(resolved)}" alt="${escapeHtml(text || "")}"${titleAttr}>`;
    };
    // ```mermaid fences render as diagrams (see mermaid-preview.ts); every
    // other language falls through to marked's own default code renderer.
    const defaultCodeRenderer = marked.Renderer.prototype.code.bind(renderer);
    renderer.code = (code: string, infostring: string | undefined, escaped: boolean) =>
      mermaidCodeRenderer(code, infostring, escaped, defaultCodeRenderer, doc?.diagrams);
    // [[Name]] links (see wikilinks.ts's transformWikilinks, applied
    // below) become "wikilink:"-scheme links — resolved against the
    // current document list at render time so a rename/delete elsewhere
    // is reflected on the next keystroke, same as every other preview
    // content.
    const defaultLinkRenderer = marked.Renderer.prototype.link.bind(renderer);
    renderer.link = (href: string, title: string | null, text: string) => {
      if (!href.startsWith("wikilink:")) return defaultLinkRenderer(href, title, text);
      const name = decodeURIComponent(href.slice("wikilink:".length));
      const exists = !!resolveWikilinkTarget(name, get(docsStore));
      const cls = exists ? "wikilink" : "wikilink wikilink-missing";
      return `<a href="#" class="${cls}" data-doc-name="${escapeHtml(name)}">${escapeHtml(text)}</a>`;
    };
    const { text: extractedRaw, sources } = extractMathSpans(transformWikilinks(raw));
    currentMathSources = sources;
    const html = marked.parse(extractedRaw, { gfm: true, breaks: false, renderer }) as string;
    // KaTeX's output includes a MathML companion tree (for accessibility)
    // alongside its visible HTML — DOMPurify's default allowlist is
    // HTML-only and strips MathML entirely without ADD_TAGS/ADD_ATTR
    // below. Verified against real katex.renderToString() output
    // (sqrt, frac, sum, matrix, vector/underline) — nothing else needed.
    const clean = DOMPurify.sanitize(html, {
      ADD_TAGS: ["math", "semantics", "mrow", "mi", "mn", "mo", "msup", "msub", "msubsup", "msqrt", "mroot", "mfrac", "mtable", "mtr", "mtd", "mspace", "mtext", "mstyle", "mover", "munder", "munderover", "mpadded", "annotation"],
      ADD_ATTR: ["target", "mathvariant", "encoding", "xmlns"],
    });
    const previewEl = document.getElementById("preview");
    // marked.parse() always regenerates every ```mermaid fence as its raw
    // source text (mermaidCodeRenderer has no way to know a diagram was
    // already rendered), and this whole function re-runs on every
    // keystroke anywhere in the document — so without this, every
    // existing diagram would flash back to raw source text on every
    // keystroke, only catching up once mermaidRenderScheduler's debounced
    // pass fires ~400ms later. Snapshot already-rendered diagrams here,
    // keyed by the exact source they were rendered from (same identity
    // mermaid-preview.ts itself uses for its own data-mermaid-source
    // cache), and splice the still-current ones back in immediately below
    // — only a diagram whose source actually changed, or one seen for the
    // first time, still needs to wait for the real re-render.
    const renderedDiagrams = new Map<string, Element>();
    previewEl.querySelectorAll("pre.mermaid.mermaid-rendered[data-mermaid-source]").forEach((el) => {
      const source = el.getAttribute("data-mermaid-source");
      if (source !== null) renderedDiagrams.set(source, el);
    });
    previewEl.innerHTML = clean;
    if (renderedDiagrams.size > 0) {
      previewEl.querySelectorAll("pre.mermaid").forEach((el) => {
        const cached = renderedDiagrams.get(el.textContent ?? "");
        if (cached) el.replaceWith(cached);
      });
    }
    // Tags each top-level preview block with the source line it was
    // rendered from, for sync-scroll (see initSyncScroll()) to snap to
    // instead of using raw scroll percentage — which breaks down badly
    // once a block's rendered height (a tall diagram, a large image) is
    // very disproportionate to how many source lines it represents.
    // computeBlockLineStarts() runs on the *original* raw text (not
    // extractedRaw) — see its own comment for why. Non-space top-level
    // tokens and top-level DOM children correspond 1:1 in order for
    // every standard block type; the length-capped loop degrades
    // gracefully (leaving a mismatched tail untagged) rather than
    // throwing if some edge case ever breaks that correspondence.
    const lineStarts = computeBlockLineStarts(raw);
    const previewChildren = Array.from(previewEl.children);
    for (let i = 0; i < lineStarts.length && i < previewChildren.length; i++) {
      previewChildren[i].setAttribute("data-line", String(lineStarts[i]));
    }
    mermaidRenderScheduler.trigger();
    mathRenderScheduler.trigger();
  }

  // ---------- Counts / cursor ----------
  function updateCounts() {
    const text = cm.state.doc.toString();
    const words = text.trim().length ? text.trim().split(/\s+/).length : 0;
    document.getElementById("wordCount").textContent = `${words} word${words === 1 ? "" : "s"}`;
    document.getElementById("charCount").textContent = `${text.length} character${text.length === 1 ? "" : "s"}`;
  }

  function updateCursorPos() {
    const pos = cm.state.selection.main.head;
    const line = cm.state.doc.lineAt(pos);
    document.getElementById("cursorPos").textContent = `Ln ${line.number}, Col ${pos - line.from + 1}`;
  }

  function initShortStatus() {
    updateCursorPos();
  }

  // ---------- Document title ----------
  // The formatting toolbar itself is Toolbar.svelte now (mounted at
  // #toolbar-mount) — its buttons call window.MDE.runCmd() directly
  // instead of a delegated click listener here.
  function initToolbar() {
    const docTitleInput = document.getElementById("docTitle") as HTMLInputElement;
    // Captured on focus, read on blur — doc.name has already been
    // rewritten to the (possibly colliding) in-progress value by every
    // "input" event by the time blur fires, so this is the only place
    // "what it was before this edit" is still available.
    let nameBeforeEdit = "";
    docTitleInput.addEventListener("input", (e) => {
      const doc = getActiveDoc();
      if (!doc) return;
      const name = (e.target as HTMLInputElement).value || "Untitled";
      renameDoc(doc.id, name);
      scheduleSave();
      resizeDocTitle();
      updatePageTitle(name);
    });
    // "Untitled" is the real stored name for a never-renamed doc, not just
    // a placeholder — but making the user delete it by hand before typing
    // a real title is annoying (same reasoning as createNewDoc's own
    // focus+select on a brand-new doc, just triggered by focus generally
    // instead of only right after creation). Only the exact generic
    // default gets cleared this way — an actual title the user chose
    // (even one that happens to need a small edit) is left alone.
    docTitleInput.addEventListener("focus", () => {
      const doc = getActiveDoc();
      nameBeforeEdit = doc ? doc.name : "";
      if (docTitleInput.value === "Untitled") docTitleInput.value = "";
    });
    // Left blank without typing a replacement (or typed-then-deleted, which
    // the input handler above already renamed back to "Untitled" — this
    // just makes the field's own display catch up) — show "Untitled" again
    // rather than leaving the field looking empty. Collision-checking is
    // deliberately skipped for this empty-then-restored case (see the
    // design doc's Error handling section) — only a real, non-empty,
    // actually-changed name triggers it.
    docTitleInput.addEventListener("blur", () => {
      if (!docTitleInput.value.trim()) {
        docTitleInput.value = "Untitled";
        resizeDocTitle();
        return;
      }
      const doc = getActiveDoc();
      if (!doc) return;
      const finalName = docTitleInput.value;
      if (finalName === nameBeforeEdit) return;
      const colliding = findCollidingDoc(doc.id, finalName);
      if (colliding) {
        renameCollision.set({ docId: doc.id, pendingName: finalName, previousName: nameBeforeEdit, collidingDocId: colliding.id });
      }
    });
    // Enter commits the rename (via the existing blur handler above)
    // and moves focus to the editor — same as clicking away, just
    // reachable from the keyboard without tabbing.
    docTitleInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      docTitleInput.blur();
      cm.focus();
    });
    resizeDocTitle();
  }

  // #docTitle grows with its content (min/max-width still clamp it, see
  // css) instead of staying a fixed size — measured via an identically
  // styled, invisible mirror span since inputs don't size to their value.
  function resizeDocTitle() {
    const input = document.getElementById("docTitle") as HTMLInputElement;
    const mirror = document.getElementById("docTitleMirror");
    mirror.textContent = input.value || input.placeholder || "";
    input.style.width = mirror.offsetWidth + "px";
  }

  function runCmd(cmd: string) {
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

  function wrapSelection(before: string, after: string, placeholder?: string) {
    const { from, to } = cm.state.selection.main;
    const sel = cm.state.sliceDoc(from, to);
    const text = sel || placeholder || "";
    const insert = before + text + after;
    if (!sel && placeholder) {
      // Select just the inserted placeholder so typing immediately
      // replaces it, instead of leaving the cursor after it.
      const selFrom = from + before.length;
      const selTo = selFrom + placeholder.length;
      cm.dispatch({ changes: { from, to, insert }, selection: { anchor: selFrom, head: selTo } });
    } else {
      cm.dispatch(cm.state.replaceSelection(insert));
    }
  }

  function prefixLine(prefix: string) {
    const line = cm.state.doc.lineAt(cm.state.selection.main.head);
    if (line.text.startsWith(prefix)) {
      cm.dispatch({ changes: { from: line.from, to: line.from + prefix.length, insert: "" } });
    } else {
      // Without an explicit selection, an insertion landing exactly at
      // the cursor's position (the common case — an empty line) maps
      // the cursor to stay *before* the inserted text by default,
      // leaving it sitting in front of "# " instead of ready to type
      // after it.
      const head = cm.state.selection.main.head;
      cm.dispatch({ changes: { from: line.from, insert: prefix }, selection: { anchor: head + prefix.length } });
    }
  }

  // A popup instead of dropping raw `[text](https://)` markdown into the
  // editor — friendlier for anyone not already fluent in markdown syntax.
  function insertLink() {
    const { from, to } = cm.state.selection.main;
    linkModalPrefillText.set(cm.state.sliceDoc(from, to));
    linkModalOpen.set(true);
  }

  function insertLinkIntoEditor(text: string, url: string) {
    cm.dispatch(cm.state.replaceSelection(`[${text || "link text"}](${url || "https://"})`));
    cm.focus();
  }

  function insertImage() {
    document.getElementById("imageFileInput").click();
  }

  function insertTable() {
    insertBlock(
      "\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |\n| Cell | Cell | Cell |\n"
    );
  }

  function insertBlock(block: string) {
    const pos = cm.state.selection.main.head;
    cm.dispatch({ changes: { from: pos, insert: block }, selection: { anchor: pos + block.length } });
  }

  // Inserts a block math snippet with the cursor on the blank line
  // between the delimiters, so typing immediately starts the LaTeX
  // source — same "insert and place the cursor usefully" shape as
  // insertTable()/insertBlock(), just with an interior cursor position
  // rather than one trailing the whole insert.
  function insertMathSnippet() {
    const pos = cm.state.selection.main.head;
    const block = "$$\n\n$$";
    const cursorPos = pos + 3; // after "$$\n"
    cm.dispatch({ changes: { from: pos, insert: block }, selection: { anchor: cursorPos } });
  }

  // Inserts a [^N] reference at the cursor and a [^N]: definition at the
  // document's end, auto-numbered past any existing numeric footnote
  // references — a hand-written named footnote like [^note] is ignored
  // by the scan (matches [^(\d+)] only) and never collides with this
  // button's own numbering. One atomic transaction (both changes
  // dispatched together) — a single undo step, not two.
  function insertFootnoteSnippet() {
    const text = cm.state.doc.toString();
    const existingLabels = [...text.matchAll(/\[\^(\d+)\]/g)]
      .map((m) => parseInt(m[1], 10))
      .filter((n) => !Number.isNaN(n));
    const nextLabel = existingLabels.length > 0 ? Math.max(...existingLabels) + 1 : 1;
    const pos = cm.state.selection.main.head;
    const ref = `[^${nextLabel}]`;
    const def = `\n\n[^${nextLabel}]: `;
    const docEnd = cm.state.doc.length;
    cm.dispatch({
      changes: [
        { from: pos, insert: ref },
        { from: docEnd, insert: def },
      ],
      selection: { anchor: docEnd + ref.length + def.length },
    });
  }

  // ---------- View toggle ----------
  function initViewToggle() {
    const saved = (localStorage.getItem(STORAGE_VIEW) as "editor" | "split" | "preview") || "split";
    setView(saved);
  }

  function setView(view: "editor" | "split" | "preview") {
    document.getElementById("body").className = `mode-${view}`;
    localStorage.setItem(STORAGE_VIEW, view);
    viewMode.set(view);
  }

  // ---------- Sidebar / documents ----------
  const isMobile = () => window.matchMedia("(max-width: 780px)").matches;

  // On a phone-width screen the sidebar is a full-height overlay (see css)
  // — collapsing it is a one-way "get out of the way" action (as opposed
  // to toggleSidebar()'s toggle), used wherever something just navigated
  // the user to content the still-open sidebar would otherwise hide:
  // initial page load, switching docs, or landing on the empty state
  // (e.g. after deleting the last remaining document).
  // #sidebarToggleOut is always visible now (a real toggle with an
  // active/inactive state — active means the sidebar is currently open —
  // rather than a button that appears/disappears depending on sidebar
  // state). Shared by both entry points below so the button's state
  // never drifts from the sidebar's actual collapsed/expanded state.
  function setSidebarToggleState(expanded: boolean) {
    const btn = document.getElementById("sidebarToggleOut") as HTMLButtonElement;
    btn.classList.toggle("active", expanded);
    const label = expanded ? "Hide documents panel" : "Show documents panel";
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }

  function collapseSidebarForMobile() {
    if (!isMobile()) return;
    document.getElementById("sidebar").classList.add("collapsed");
    document.getElementById("sidebarBackdrop").classList.remove("visible");
    setSidebarToggleState(false);
  }

  // .visible drives an opacity transition (see style.css's mobile media
  // query) instead of the old hidden-attribute toggle — display:none
  // (which `hidden` sets) can't be transitioned, which is what made the
  // backdrop snap in/out instantly while #sidebar's slide and the
  // #topbar/#toolbar dim overlay both faded smoothly. The class's visual
  // effect is itself scoped to that same mobile media query, so setting
  // it outside mobile width is harmless — no need to also guard on
  // isMobile() here the way the old hidden-attribute logic did.
  function toggleSidebar() {
    const collapsed = document.getElementById("sidebar").classList.toggle("collapsed");
    document.getElementById("sidebarBackdrop").classList.toggle("visible", isMobile() && !collapsed);
    setSidebarToggleState(!collapsed);
    if (isMobile() && !collapsed) {
      commentsPanelOpen.set(false);
      // DocList.svelte stays mounted continuously (the sheet's open/closed
      // state is a CSS transform, not conditional rendering), so its tab
      // selection would otherwise persist across close/reopen — reset it
      // here so the sheet always opens back on "Documents".
      docListActiveTab.set("documents");
    }
  }

  function initSidebar() {
    // Starting open on a phone-width screen would cover the whole editor.
    // On desktop the sidebar starts expanded (no .collapsed class), so
    // the toggle button's initial active state needs setting explicitly
    // — collapseSidebarForMobile() only sets it when actually collapsing.
    collapseSidebarForMobile();
    setSidebarToggleState(!document.getElementById("sidebar").classList.contains("collapsed"));

    document.getElementById("sidebarToggleIn").addEventListener("click", toggleSidebar);
    document.getElementById("sidebarToggleOut").addEventListener("click", toggleSidebar);
    document.getElementById("sidebarBackdrop").addEventListener("click", toggleSidebar);

    document.getElementById("newDocBtn").addEventListener("click", createNewDoc);
  }

  // Shared by the sidebar's "+" button and File > New document (MenuBar.svelte
  // via window.MDE.newDoc).
  function createNewDoc() {
    createDoc();
    (document.getElementById("docTitle") as HTMLInputElement).focus();
    (document.getElementById("docTitle") as HTMLInputElement).select();
  }

  // stores/docs.ts's switchDoc/deleteDoc/duplicateDoc own the actual data
  // mutation + persistence now; the reactive activeIdStore subscription in
  // init() handles loading the new content into the editor. This wrapper
  // only adds the one piece of UI that's specific to this call site
  // (collapsing the mobile sidebar) — storeSwitchDoc's return value says
  // whether a switch actually happened, same guard the old inline
  // `if (id === activeId) return` used to provide.
  function switchDoc(id: string) {
    if (!storeSwitchDoc(id)) return;
    collapseSidebarForMobile();
  }

  // Clicking a heading in DocList.svelte (either the desktop per-row
  // outline or the mobile Headings tab) — switches to that doc first if
  // it isn't already active, since CodeMirror only ever holds one buffer.
  // The Headings tab always targets the *active* doc, so switchDoc(id)
  // is a same-id no-op there and never triggers its own
  // collapseSidebarForMobile() side effect — call it explicitly instead
  // of relying on that, so tapping a heading always closes the mobile
  // sheet regardless of whether a doc switch actually happened.
  function jumpToLine(id: string, line: number) {
    switchDoc(id);
    const lineInfo = cm.state.doc.line(Math.min(line + 1, cm.state.doc.lines));
    cm.dispatch({ selection: { anchor: lineInfo.from }, effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }) });
    cm.focus();
    collapseSidebarForMobile();
  }

  function escapeHtml(str: string) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- Dropdowns ----------
  // Shared by every dropdown (File/Edit/View/Help menus, Share, Settings —
  // the latter two also used from collab.ts/gist.ts via window.MDE) so
  // opening one closes any other that's already open instead of them
  // stacking. closeAllDropdowns() clears everything unconditionally; the
  // triggering button then re-opens/re-activates itself right after, which
  // is simpler than threading an "except" argument through every caller.
  function closeAllDropdowns() {
    document.querySelectorAll(".dropdown-menu.open").forEach((m) => m.classList.remove("open"));
    document.querySelectorAll(".dropdown-trigger.active").forEach((b) => b.classList.remove("active"));
    // Nested flyouts (File > Open/Export/etc) aren't part of the
    // .dropdown-menu/.dropdown-trigger pair above, so closing the parent
    // menu left them marked .open — reopening File later showed whichever
    // submenu had been expanded before, still expanded. Close those too.
    document.querySelectorAll(".menu-submenu.open").forEach((sub) => {
      sub.classList.remove("open");
      sub.querySelector(".menu-submenu-trigger")?.classList.remove("active");
    });
  }

  // Closes every open dropdown/submenu, but only for a click that actually
  // landed outside all of them — a plain document-level closeAllDropdowns
  // listener with no such check would also fire (and close everything) for
  // clicks ON menu items themselves as they bubble up, which is why this
  // exists as its own named function rather than an inline arrow passed to
  // toggleDropdown: passing the same function reference on every
  // toggleDropdown() call (File/Edit/View/Help menus, the save-status
  // popup) lets addEventListener's natural de-duplication keep this to one
  // real listener instead of five identical ones.
  function closeDropdownsOnOutsideClick(e: MouseEvent) {
    if ((e.target as HTMLElement).closest(".dropdown-menu.open, .menu-submenu-panel")) return;
    closeAllDropdowns();
  }

  function toggleDropdown(btn: HTMLElement, menu: HTMLElement) {
    btn.classList.add("dropdown-trigger");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = !menu.classList.contains("open");
      closeAllDropdowns();
      if (willOpen) {
        menu.classList.add("open");
        btn.classList.add("active");
      }
    });
    // Deliberately NOT menu.addEventListener("click", stopPropagation) (the
    // old approach here) — that would stop an in-menu click from ever
    // reaching Svelte 5's own delegated event listener. MenuBar.svelte's
    // onclick={} buttons live inside `menu`, and Svelte delegates common
    // events like click to a shared ancestor instead of attaching
    // per-element, so stopping propagation partway up the tree silently
    // kills them before Svelte ever sees the click. Every interactive
    // element inside a dropdown already closes it explicitly itself (see
    // MenuBar.svelte's act() helper, or this file's menu-item handlers),
    // so closeDropdownsOnOutsideClick only needs to skip clicks that
    // landed inside an open dropdown/submenu, not rely on stopPropagation.
    document.addEventListener("click", closeDropdownsOnOutsideClick);
  }

  // Native-menu-bar-style behavior: once one of File/Edit/View/Help is
  // open (via a real click), hovering a sibling switches straight to it
  // without needing another click — matches how OS/desktop-app menu bars
  // behave. Scoped to just this sibling group (via the explicit pairs
  // list), not a generic property of every toggleDropdown() consumer —
  // the save-status popup has no siblings to switch between.
  function enableMenuBarHoverSwitch(pairs: { btn: HTMLElement; menu: HTMLElement }[]) {
    if (!supportsHover()) return; // see supportsHover's comment — same synthetic-mouseenter issue on touch
    pairs.forEach(({ btn, menu }) => {
      btn.addEventListener("mouseenter", () => {
        if (btn.classList.contains("active")) return;
        const anyOpen = pairs.some(({ btn: b }) => b.classList.contains("active"));
        if (!anyOpen) return;
        closeAllDropdowns();
        menu.classList.add("open");
        btn.classList.add("active");
      });
    });
  }

  // True on devices with a real, hover-capable pointer (mouse/trackpad) —
  // false on touch. Touch browsers synthesize a mouseenter right before
  // the click on a tapped element, so wiring hover-to-expand unconditionally
  // made every tap open-then-immediately-close on mobile: the synthetic
  // mouseenter opened the submenu first, then the click's own
  // already-open check treated that same tap as a close. A second tap
  // then "worked" only because most mobile browsers don't re-fire
  // mouseenter for a repeat tap on the same element. Scoping the
  // hover listeners to real hover-capable pointers avoids the synthetic
  // event entirely instead of trying to out-guess it.
  const supportsHover = () => window.matchMedia("(hover: hover)").matches;

  // Nested flyouts within a single dropdown-menu (e.g. File > Open, Open
  // Recent, Export). The parent menu already stops outside clicks from
  // closing it (see toggleDropdown), so this only needs to manage which
  // submenu, if any, is open within that one parent at a time.
  function initSubmenus(root: HTMLElement) {
    root.querySelectorAll(".menu-submenu").forEach((sub) => {
      const trigger = sub.querySelector(".menu-submenu-trigger");
      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        const willOpen = !sub.classList.contains("open");
        closeSubmenus(root);
        if (willOpen) {
          sub.classList.add("open");
          trigger.classList.add("active");
        }
      });
      if (!supportsHover()) return;
      // Native-menu-bar-style: once the parent dropdown is open, hovering
      // a row with a flyout expands it immediately, same as File > Open
      // expanding on hover in a real desktop app menu (item #38 — the
      // top-level File/Edit/View/Help hover-switch already worked, this
      // was the "/submenu" half of that item, never actually wired).
      trigger.addEventListener("mouseenter", () => {
        if (sub.classList.contains("open")) return;
        closeSubmenus(root);
        sub.classList.add("open");
        trigger.classList.add("active");
      });
    });

    if (!supportsHover()) return;
    // Hovering any other row (not a submenu trigger) collapses whichever
    // flyout is currently open — otherwise moving the mouse from an open
    // "Export" flyout back up to "New document" would leave Export open
    // and floating over unrelated items.
    [...root.children].forEach((child) => {
      if (!(child as HTMLElement).classList.contains("menu-submenu")) {
        child.addEventListener("mouseenter", () => closeSubmenus(root));
      }
    });
  }

  function closeSubmenus(root: HTMLElement) {
    root.querySelectorAll(".menu-submenu.open").forEach((sub) => {
      sub.classList.remove("open");
      sub.querySelector(".menu-submenu-trigger").classList.remove("active");
    });
  }

  // ---------- Import ----------
  function initImport() {
    document.getElementById("importInput").addEventListener("change", (e) => {
      const file = (e.target as HTMLInputElement).files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const name = file.name.replace(/\.(md|markdown|txt)$/i, "");
        createDoc({ name: name || "Imported", content: String(reader.result) });
      };
      reader.readAsText(file);
      (e.target as HTMLInputElement).value = "";
    });
  }

  function initShortcutsModal() {
    const modal = document.getElementById("shortcutsModal");
    document.getElementById("shortcutsCloseBtn").addEventListener("click", () => {
      modal.hidden = true;
    });
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.hidden = true;
    });
  }

  function initInfoModal() {
    document.getElementById("appVersion").textContent = `v${__APP_VERSION__}`;
    const modal = document.getElementById("infoModal");
    const termsModal = document.getElementById("termsModal");
    const privacyModal = document.getElementById("privacyModal");
    const licensesModal = document.getElementById("licensesModal");

    document.getElementById("infoCloseBtn").addEventListener("click", () => { modal.hidden = true; });
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });

    document.getElementById("termsCloseBtn").addEventListener("click", () => { termsModal.hidden = true; });
    termsModal.addEventListener("click", (e) => { if (e.target === termsModal) termsModal.hidden = true; });

    document.getElementById("privacyCloseBtn").addEventListener("click", () => { privacyModal.hidden = true; });
    privacyModal.addEventListener("click", (e) => { if (e.target === privacyModal) privacyModal.hidden = true; });

    document.getElementById("licensesCloseBtn").addEventListener("click", () => { licensesModal.hidden = true; });
    licensesModal.addEventListener("click", (e) => { if (e.target === licensesModal) licensesModal.hidden = true; });

    document.getElementById("menuTerms").addEventListener("click", () => {
      modal.hidden = true;
      termsModal.hidden = false;
    });
    document.getElementById("menuPrivacy").addEventListener("click", () => {
      modal.hidden = true;
      privacyModal.hidden = false;
    });
    document.getElementById("menuLicenses").addEventListener("click", () => {
      modal.hidden = true;
      licensesModal.hidden = false;
    });

    renderLicensesList();
  }

  function renderLicensesList() {
    const container = document.getElementById("licensesList");
    container.innerHTML = __OSS_LICENSES__.map((entry) => {
      const nameHtml = entry.url
        ? `<a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener">${escapeHtml(entry.name)}</a>`
        : escapeHtml(entry.name);
      return `<div class="shortcuts-row"><span>${nameHtml}</span><kbd>${escapeHtml(entry.license)} · v${escapeHtml(entry.version)}</kbd></div>`;
    }).join("");
  }

  // A small "?" toggle in a modal's own header, next to its title — reveals
  // a one-line explanation of what that modal is for. Delegated on
  // document so it works for both the plain HTML modals here and the
  // Svelte-rendered ones (Share, Settings), whose markup doesn't exist in
  // the DOM until they're first opened.
  function initModalHints() {
    document.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(".hint-toggle-btn") as HTMLElement | null;
      if (!btn) return;
      const box = btn.closest(".modal-box");
      const hint = box?.querySelector(".hint-text") as HTMLElement | null;
      if (!hint) return;
      hint.hidden = !hint.hidden;
      btn.classList.toggle("active", !hint.hidden);
    });
  }



  function openGithubSignInPopup() {
    const width = 600;
    const height = 700;
    const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
    window.open("/api/auth/github/login", "github-oauth", `width=${width},height=${height},left=${left},top=${top}`);
  }

  function currentFileBase() {
    const doc = getActiveDoc();
    const name = (doc && doc.name ? doc.name : "document").trim();
    return name.replace(/[\\/:*?"<>|]+/g, "-") || "document";
  }

  async function exportAs(format: string) {
    saveNow();
    const base = currentFileBase();
    const raw = cm.state.doc.toString();

    if (format === "md") {
      const doc = getActiveDoc();
      const resolved = resolveDiagramRefs(resolveImageRefs(raw, doc), doc?.diagrams);
      downloadBlob(new Blob([resolved], { type: "text/markdown;charset=utf-8" }), `${base}.md`);
      showToast(`Exported ${base}.md`, "success");
      return;
    }

    // txt/html/pdf all read #preview's rendered DOM — make sure any
    // in-flight or still-scheduled mermaid/math render has landed first,
    // so a diagram or formula pasted right before exporting doesn't
    // export as raw source.
    await mermaidRenderScheduler.flush();
    await mathRenderScheduler.flush();

    if (format === "txt") {
      const text = (document.getElementById("preview") as HTMLElement).innerText;
      downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), `${base}.txt`);
      showToast(`Exported ${base}.txt`, "success");
      return;
    }

    if (format === "html") {
      const bodyHtml = document.getElementById("preview").innerHTML;
      const doc = buildStandaloneHtml(base, bodyHtml);
      downloadBlob(new Blob([doc], { type: "text/html;charset=utf-8" }), `${base}.html`);
      showToast(`Exported ${base}.html`, "success");
      return;
    }

    if (format === "pdf") {
      exportPdf(base);
      return;
    }
  }

  function buildStandaloneHtml(title: string, bodyHtml: string) {
    // Only paid for documents that actually rendered math — katex.min.css
    // is ~24KB, not worth adding to every export when most won't use it.
    const mathCss = bodyHtml.includes('class="katex"') ? `<style>${katexCss}</style>` : "";
    // Escapes any "</style" so the user's own CSS (even unintentionally,
    // e.g. inside a comment or string) can't prematurely close the tag
    // and inject arbitrary markup into their own downloaded file. HTML
    // end-tag matching is case-insensitive ("</STYLE>", "</Style>", ...
    // all close a <style> element), so this must be too — a case-
    // sensitive check would miss those variants. This HTML is never sent
    // to a server or rendered inside the app itself — the only person a
    // broken escape could affect is the exporting user opening their own
    // file — but it costs nothing to guard correctly.
    const rawCustomCss = localStorage.getItem("mde:customExportCss") || "";
    const customCssBlock = rawCustomCss
      ? `<style>${rawCustomCss.replace(/<\/style/gi, "<\\/style")}</style>`
      : "";
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.7; color: #1f2328; max-width: 780px; margin: 40px auto; padding: 0 24px; }
  h1, h2, h3 { line-height: 1.3; }
  h1 { font-size: 1.9em; border-bottom: 1px solid #e2e5e9; padding-bottom: 0.25em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #e2e5e9; padding-bottom: 0.2em; }
  code { font-family: SFMono-Regular, Consolas, Menlo, monospace; background: #f6f7f9; padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.88em; }
  pre { background: #f6f7f9; padding: 14px 16px; border-radius: 8px; overflow-x: auto; border: 1px solid #e2e5e9; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3px solid #2563eb; margin: 0; padding: 2px 16px; color: #6b7280; background: #f6f7f9; border-radius: 0 6px 6px 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #e2e5e9; padding: 6px 10px; }
  th { background: #f6f7f9; }
  img { max-width: 100%; border-radius: 6px; }
  a { color: #2563eb; }
  hr { border: none; border-top: 1px solid #e2e5e9; margin: 24px 0; }
  .katex { color: #1f2328; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .footnotes { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e5e9; font-size: 0.9em; color: #6b7280; }
  .footnotes ol { padding-left: 20px; }
  [data-footnote-ref], [data-footnote-backref] { color: #2563eb; text-decoration: none; }
</style>
${customCssBlock}
${mathCss}
</head>
<body>
${bodyHtml}
</body>
</html>`;
  }

  function exportPdf(base: string) {
    const source = document.getElementById("preview");
    const clone = source.cloneNode(true) as HTMLElement;
    clone.style.padding = "0";
    const wrapper = document.createElement("div");
    wrapper.style.padding = "20px 30px";
    wrapper.appendChild(clone);

    // Uses createElement + textContent (not a template string) — DOM
    // APIs don't parse textContent as markup, so there's no </style>
    // escaping concern here, unlike the HTML export path.
    const rawCustomCss = localStorage.getItem("mde:customExportCss") || "";
    if (rawCustomCss) {
      const styleEl = document.createElement("style");
      styleEl.textContent = rawCustomCss;
      wrapper.appendChild(styleEl);
    }

    const opt = {
      margin: 12,
      filename: `${base}.pdf`,
      image: { type: "jpeg" as const, quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" as const },
      pagebreak: { mode: ["css", "legacy"] },
    };

    setSaveStatus("Generating PDF…");
    html2pdf()
      .set(opt)
      .from(wrapper)
      .save()
      .then(() => {
        setSaveStatus("Saved");
        showToast(`Exported ${base}.pdf`, "success");
      })
      .catch(() => {
        setSaveStatus("Saved");
        showToast("Couldn't generate the PDF", "error");
      });
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.addEventListener("beforeunload", saveNow);

  // The editor theme (see editorTheme above) flips automatically via CSS
  // keyed off [data-theme] — mermaid can't do that, since it bakes theme
  // into the rendered SVG, so it needs an explicit re-render whenever
  // Settings.svelte's applyTheme() changes documentElement's data-theme.
  new MutationObserver(() => {
    void mermaidRenderScheduler.runNow();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ---------- Bridge for js/collab.ts (live collaboration) ----------
  // collab.ts runs as a separate module with no access to this closure, so
  // it drives doc switching/creation and reads the CodeMirror instance
  // through this small surface instead of reaching into internals directly.
  const bridge: MDEBridge = {
    getEditor: () => cm,
    // Editor.svelte's construction handoff — see buildEditorExtensions().
    getEditorExtensions: buildEditorExtensions,
    registerEditor(view) {
      cm = view;
    },
    // getActiveDoc/findDocById/createDoc/deleteDoc/duplicateDoc/
    // markActiveDocShared/setActiveDocGistId are no longer on the bridge —
    // collab.ts and gist.ts import them directly from ./stores/docs now,
    // same as DocList.svelte/MenuBar.svelte already did for docsStore/
    // activeIdStore. switchDoc/jumpToLine/setDocImage stay here since they
    // each need something only this closure has (mobile-sidebar DOM state,
    // the live CodeMirror instance, or a preview refresh).
    switchDoc,
    jumpToLine,
    refreshSaveStatus() {
      setSaveStatus(savedLabel(getActiveDoc()));
    },
    // Re-runs the full marked parse pass. Needed after editing an existing
    // diagram through DiagramEditor.svelte: saving there updates
    // doc.diagrams[ref] but never touches the document's own text (the
    // fence still just holds the ref), so the normal "re-render on doc
    // change" path never fires on its own — this forces it.
    refreshPreview() {
      updatePreview();
    },
    // Editor text with any ![](refName) image references inlined back to
    // their real data URIs — what gets published to a Gist, since a Gist
    // needs to stand on its own outside this app.
    getResolvedContent() {
      const doc = getActiveDoc();
      return resolveDiagramRefs(resolveImageRefs(cm.state.doc.toString(), doc), doc?.diagrams);
    },
    setDocImage(key, dataUrl) {
      setDocImage(key, dataUrl);
      updatePreview();
    },
    onImageAdded: null,
    toggleDropdown,
    closeAllDropdowns,
    insertLinkIntoEditor,
    requireGithubSignIn(hint) {
      if (hint) githubSignInModalHint.set(hint);
      githubSignInModalOpen.set(true);
    },
    openGithubSignInPopup,
    githubUsername: null, // kept in sync by gist.ts's checkSession()
    // Set by collab.ts. Called by loadDocIntoEditor() right before/after the
    // editor content is swapped, so collab.ts can unbind the outgoing doc's
    // room before CodeMirror's setValue() fires a bogus "edit".
    onBeforeDocLoad: null,
    onActiveDocChanged: null,

    // ---- Menu bar (MenuBar.svelte) ----
    enableMenuBarHoverSwitch,
    initSubmenus,
    closeSubmenus,
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
    cutSelection: menuClipboardCut,
    copySelection: menuClipboardCopy,
    pasteClipboard: menuClipboardPaste,
    runCmd,
    insertAtCursor: (text: string) => insertBlock(text),
    newDoc: createNewDoc,
    openLocalFile() {
      document.getElementById("importInput").click();
    },
    exportAs,
    toggleSidebar,
    collapseSidebarForMobile,
    openImagesManager() {
      renderImagesList();
      document.getElementById("imagesModal").hidden = false;
    },
    openShortcuts() {
      document.getElementById("shortcutsModal").hidden = false;
    },
    openAbout() {
      document.getElementById("infoModal").hidden = false;
    },
    setView,
    toggleFocusMode,
    openDiagramEditor() {
      diagramEditorRef.set(null);
      diagramEditorOpen.set(true);
    },
    setCommentMarkers(entries) {
      setCommentMarkers(entries);
    },
    setKeybindings,
    formatRelativeTime,
  };
  window.MDE = bridge;
})();
