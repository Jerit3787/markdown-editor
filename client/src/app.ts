/* Markdown Editor — static, client-side, localStorage-backed */
import { EditorState, StateField, StateEffect, Compartment, Transaction, type Extension } from "@codemirror/state";
import { EditorView, Decoration, keymap, type DecorationSet } from "@codemirror/view";
import { history, historyKeymap, undo as cmUndo, redo as cmRedo, defaultKeymap } from "@codemirror/commands";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { marked } from "marked";
import DOMPurify from "dompurify";
import html2pdf from "html2pdf.js";
import type { Doc, MDEBridge } from "./types";
import { docsStore, activeIdStore, activeDocContent } from "./stores/docs";
import { showToast } from "./stores/toast";
import { viewMode } from "./stores/view";

(function () {
  "use strict";

  const STORAGE_DOCS = "mde:docs";
  const STORAGE_ACTIVE = "mde:active";
  const STORAGE_THEME = "mde:theme";
  const STORAGE_VIEW = "mde:view";
  const APP_NAME = "Markdown Editor";

  function updatePageTitle(docName: string) {
    document.title = docName ? `${APP_NAME} - ${docName}` : APP_NAME;
  }

  // ---------- State ----------
  let docs: Doc[] = [];
  let activeId: string | null = null;
  let cm: EditorView = null as unknown as EditorView;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

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
  function loadDocs(): Doc[] {
    try {
      const raw = localStorage.getItem(STORAGE_DOCS);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore corrupt storage */ }
    // No seeded Welcome doc — a brand-new visitor (or someone who deletes
    // every document) sees the empty state instead, same as VS Code with
    // no folder/file open.
    return [];
  }

  function persistDocs() {
    try {
      localStorage.setItem(STORAGE_DOCS, JSON.stringify(docs));
    } catch (e) {
      // Most commonly a full storage quota (large embedded images) — this
      // used to fail silently, leaving the in-memory doc looking "saved"
      // (the status pill doesn't know the write itself failed) while
      // nothing actually persisted.
      showToast("Couldn't save — your browser's local storage may be full", "error");
    }
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function getActiveDoc(): Doc | undefined {
    return docs.find((d) => d.id === activeId) || docs[0];
  }

  // ---------- Init ----------
  document.addEventListener("DOMContentLoaded", init);

  function init() {
    docs = loadDocs();
    activeId = localStorage.getItem(STORAGE_ACTIVE) || (docs[0] ? docs[0].id : null);
    if (activeId && !docs.find((d) => d.id === activeId)) activeId = docs[0] ? docs[0].id : null;

    // cm is already populated by this point — Editor.svelte constructs the
    // EditorView in its own onMount and hands it back via
    // window.MDE.registerEditor(), and main.ts's mount() calls (which
    // trigger that) run synchronously before this DOMContentLoaded handler
    // ever fires, same guarantee every other Svelte component here relies on.
    initSyncScroll();
    initImageUploads();
    initToolbar();
    initSaveStatus();
    initSidebar();
    initViewToggle();
    initImport();
    initShortStatus();
    initImagesManager();
    initLinkModal();
    initShortcutsModal();
    initInfoModal();
    initModalHints();
    initGithubSignInModal();
    initModalEscapeKey();
    initEmptyState();

    renderDocList();
    loadDocIntoEditor(getActiveDoc());
    updatePreview();
    updateCounts();
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

  // Editor.svelte (mounted at #editor-mount) owns the actual EditorView
  // construction/mount/destroy lifecycle — this just builds the extension
  // list, since that's almost entirely app.ts's own callbacks/state
  // (scheduleSave, wrapSelection, the collab compartments, ...) and has
  // nothing to do with where the DOM host element lives. The component
  // calls this from onMount and hands the resulting view back via
  // window.MDE.registerEditor.
  function buildEditorExtensions(): Extension[] {
    return [
      readOnlyCompartment.of(EditorState.readOnly.of(false)),
      editingModeCompartment.of(localEditingModeExtensions()),
      keymap.of([
        { key: "Mod-b", run: () => { wrapSelection("**", "**", "bold text"); return true; } },
        { key: "Mod-i", run: () => { wrapSelection("_", "_", "italic text"); return true; } },
        { key: "Mod-k", run: () => { insertLink(); return true; } },
      ]),
      keymap.of(markdownKeymap),
      keymap.of(defaultKeymap),
      markdown({ extensions: [GFM] }),
      syntaxHighlighting(markdownHighlightStyle),
      editorTheme,
      EditorView.lineWrapping,
      imageMarkerField,
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

  // ---------- Synced scrolling (editor <-> preview, split mode only) ----------
  // Proportional (scroll-percentage) sync rather than line-mapped — the
  // rendered preview's DOM has no reliable 1:1 correspondence to source
  // lines (headings collapse whitespace, tables/images change height,
  // etc.), so matching "how far down the document" each pane is reads as
  // closely in sync as this app's editor/renderer pairing can support.
  function initSyncScroll() {
    const main = document.getElementById("main") as HTMLElement;
    const preview = document.getElementById("preview") as HTMLElement;
    let syncing = false;

    cm.scrollDOM.addEventListener("scroll", () => {
      if (syncing || !main.classList.contains("mode-split")) return;
      const el = cm.scrollDOM;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return;
      const previewMax = preview.scrollHeight - preview.clientHeight;
      syncing = true;
      preview.scrollTop = (el.scrollTop / max) * previewMax;
      requestAnimationFrame(() => { syncing = false; });
    });

    preview.addEventListener("scroll", () => {
      if (syncing || !main.classList.contains("mode-split")) return;
      const max = preview.scrollHeight - preview.clientHeight;
      if (max <= 0) return;
      const el = cm.scrollDOM;
      syncing = true;
      el.scrollTop = (preview.scrollTop / max) * (el.scrollHeight - el.clientHeight);
      requestAnimationFrame(() => { syncing = false; });
    });
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
        doc.images = doc.images || {};
        const key = imageKey(file.name, doc.images);
        doc.images[key] = dataUrl;
        persistDocs();
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

  // Short reference name instead of the full base64 blob living inline in
  // the editor text — e.g. "screenshot.png" or "screenshot-2.png" if that
  // name's taken. The preview/export resolve it back to the real data URI
  // (see the marked image renderer in updatePreview and resolveImageRefs).
  function imageKey(filename: string, images: Record<string, string>) {
    const match = (filename || "image").match(/^(.*?)(\.[^.]+)?$/);
    const base = (match[1] || "image").trim().replace(/[^a-zA-Z0-9-_ ]+/g, "").trim() || "image";
    const ext = match[2] || ".png";
    let key = `${base}${ext}`;
    let n = 2;
    while (images[key]) {
      key = `${base}-${n}${ext}`;
      n++;
    }
    return key;
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

    keys.forEach((key) => {
      const dataUrl = images[key];
      const item = document.createElement("div");
      item.className = "image-item";
      item.innerHTML = `
        <img src="${dataUrl}" alt="">
        <div class="image-meta">
          <div class="image-name">${escapeHtml(key)}</div>
          <div class="image-size">${formatBytes(dataUrl.length)}</div>
        </div>
        <button class="icon-btn" title="Delete image" aria-label="Delete ${escapeHtml(key)}"><svg class="icon"><use href="#icon-trash-2"></use></svg></button>
      `;
      item.querySelector("button").addEventListener("click", () => {
        if (!confirm(`Delete "${key}"? Any reference to it in the text will show as a broken image.`)) return;
        delete doc.images[key];
        persistDocs();
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
      (document.getElementById("docTitle") as HTMLInputElement).value = "";
      resizeDocTitle();
      updatePageTitle("");
      setSaveStatus("");
      window.MDE.onActiveDocChanged && window.MDE.onActiveDocChanged(undefined as unknown as Doc);
      return;
    }
    setEditorContent(doc.content || "");
    (document.getElementById("docTitle") as HTMLInputElement).value = doc.name || "Untitled";
    resizeDocTitle();
    updatePageTitle(doc.name || "Untitled");
    setSaveStatus(savedLabel(doc));
    window.MDE.onActiveDocChanged && window.MDE.onActiveDocChanged(doc);
  }

  // ---------- Save ----------
  function scheduleSave() {
    setSaveStatus("Saving…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  function saveNow() {
    const doc = getActiveDoc();
    if (!doc) return;
    doc.content = cm.state.doc.toString();
    doc.updatedAt = Date.now();
    persistDocs();
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
    const html = marked.parse(raw, { gfm: true, breaks: false, renderer }) as string;
    const clean = DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
    document.getElementById("preview").innerHTML = clean;
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
    document.getElementById("docTitle").addEventListener("input", (e) => {
      const doc = getActiveDoc();
      if (!doc) return;
      doc.name = (e.target as HTMLInputElement).value || "Untitled";
      renderDocList();
      scheduleSave();
      resizeDocTitle();
      updatePageTitle(doc.name);
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
      cm.dispatch({ changes: { from: line.from, insert: prefix } });
    }
  }

  // A popup instead of dropping raw `[text](https://)` markdown into the
  // editor — friendlier for anyone not already fluent in markdown syntax.
  function insertLink() {
    const { from, to } = cm.state.selection.main;
    const sel = cm.state.sliceDoc(from, to);
    (document.getElementById("linkTextInput") as HTMLInputElement).value = sel || "";
    (document.getElementById("linkUrlInput") as HTMLInputElement).value = "";
    document.getElementById("linkModal").hidden = false;
    document.getElementById(sel ? "linkUrlInput" : "linkTextInput").focus();
  }

  function initLinkModal() {
    const modal = document.getElementById("linkModal");
    const textInput = document.getElementById("linkTextInput") as HTMLInputElement;
    const urlInput = document.getElementById("linkUrlInput") as HTMLInputElement;

    function close() {
      modal.hidden = true;
    }
    function confirmInsert() {
      const text = textInput.value.trim() || "link text";
      const url = urlInput.value.trim() || "https://";
      cm.dispatch(cm.state.replaceSelection(`[${text}](${url})`));
      close();
      cm.focus();
    }

    document.getElementById("linkCancelBtn").addEventListener("click", close);
    document.getElementById("linkInsertBtn").addEventListener("click", confirmInsert);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) close();
    });
    [textInput, urlInput].forEach((input) => {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") confirmInsert();
      });
    });
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

  // ---------- View toggle ----------
  // Remembered so the expand-preview button can restore whichever mode the
  // user was actually in (editor or split) rather than always snapping
  // back to split. Owned here (not MenuBar.svelte) since app.ts is the
  // source of truth for main.className/localStorage — the component only
  // reads viewMode (stores/view.ts) and calls setView()/
  // toggleExpandPreview() through the bridge.
  let lastNonPreviewView: "editor" | "split" = "split";

  function initViewToggle() {
    const saved = (localStorage.getItem(STORAGE_VIEW) as "editor" | "split" | "preview") || "split";
    lastNonPreviewView = saved === "preview" ? "split" : saved;
    setView(saved);
  }

  function setView(view: "editor" | "split" | "preview") {
    if (view !== "preview") lastNonPreviewView = view;
    document.getElementById("main").className = `mode-${view}`;
    localStorage.setItem(STORAGE_VIEW, view);
    viewMode.set(view);
  }

  // A one-click shortcut for the same "Preview" mode already reachable via
  // View > Preview — sits right next to the menu bar instead of requiring
  // that menu to be opened first (item #21).
  function toggleExpandPreview() {
    const isPreview = document.getElementById("main").classList.contains("mode-preview");
    setView(isPreview ? lastNonPreviewView : "preview");
  }

  // ---------- Sidebar / documents ----------
  const isMobile = () => window.matchMedia("(max-width: 780px)").matches;

  function toggleSidebar() {
    const collapsed = document.getElementById("sidebar").classList.toggle("collapsed");
    // #sidebarToggleIn lives inside #sidebar and slides off-screen with it
    // automatically — only the toolbar copy (and its separator) needs
    // manual show/hide, since it has nothing else to hide it while expanded.
    document.getElementById("sidebarToggleOut").hidden = !collapsed;
    document.getElementById("sidebarToggleOutSep").hidden = !collapsed;
  }

  function initSidebar() {
    // On a phone-width screen the sidebar is a full-height overlay (see
    // css), so starting it open covers the whole editor on first load.
    if (isMobile()) {
      document.getElementById("sidebar").classList.add("collapsed");
      document.getElementById("sidebarToggleOut").hidden = false;
      document.getElementById("sidebarToggleOutSep").hidden = false;
    }

    document.getElementById("sidebarToggleIn").addEventListener("click", toggleSidebar);
    document.getElementById("sidebarToggleOut").addEventListener("click", toggleSidebar);

    document.getElementById("newDocBtn").addEventListener("click", createNewDoc);
  }

  // Shared by the sidebar's "+" button and File > New document (MenuBar.svelte
  // via window.MDE.newDoc).
  function createNewDoc() {
    saveNow();
    const doc: Doc = { id: uid(), name: "Untitled", content: "", updatedAt: Date.now() };
    docs.unshift(doc);
    activeId = doc.id;
    persistDocs();
    localStorage.setItem(STORAGE_ACTIVE, activeId);
    renderDocList();
    loadDocIntoEditor(doc);
    updatePreview();
    updateCounts();
    (document.getElementById("docTitle") as HTMLInputElement).focus();
    (document.getElementById("docTitle") as HTMLInputElement).select();
  }

  function switchDoc(id: string) {
    if (id === activeId) return;
    saveNow();
    activeId = id;
    localStorage.setItem(STORAGE_ACTIVE, activeId);
    renderDocList();
    loadDocIntoEditor(getActiveDoc());
    updatePreview();
    updateCounts();
    if (isMobile()) document.getElementById("sidebar").classList.add("collapsed");
  }

  function deleteDoc(id: string) {
    const doc = docs.find((d) => d.id === id);
    if (!doc) return;
    if (!confirm(`Delete "${doc.name}"? This can't be undone.`)) return;
    docs = docs.filter((d) => d.id !== id);
    if (activeId === id) {
      // Deleting the last remaining doc leaves docs empty and activeId
      // null — loadDocIntoEditor(undefined) shows the empty state rather
      // than force-creating a placeholder "Untitled" doc.
      activeId = docs[0] ? docs[0].id : null;
      if (activeId) localStorage.setItem(STORAGE_ACTIVE, activeId);
      else localStorage.removeItem(STORAGE_ACTIVE);
      loadDocIntoEditor(getActiveDoc());
      updatePreview();
      updateCounts();
    }
    persistDocs();
    renderDocList();
    showToast(`Deleted "${doc.name || "Untitled"}"`, "success");
  }

  // Doc-row "..." menu action (DocList.svelte) — not a rename/edit, a full
  // copy, same as Google Docs' tab context menu's "Duplicate".
  function duplicateDoc(id: string) {
    const doc = docs.find((d) => d.id === id);
    if (!doc) return;
    saveNow();
    const copy: Doc = { ...doc, id: uid(), name: `${doc.name || "Untitled"} (copy)`, updatedAt: Date.now() };
    // A duplicate is a fresh, unshared, unpublished document — it must not
    // carry over the room/gist identity of the doc it was copied from.
    delete copy.shared;
    delete copy.gistId;
    docs.unshift(copy);
    activeId = copy.id;
    persistDocs();
    localStorage.setItem(STORAGE_ACTIVE, activeId);
    renderDocList();
    loadDocIntoEditor(copy);
    updatePreview();
    updateCounts();
    showToast(`Duplicated as "${copy.name}"`, "success");
  }

  // Clicking a heading in a doc-row's outline (DocList.svelte) — switches
  // to that doc first if it isn't already active, since CodeMirror only
  // ever holds one buffer.
  function jumpToLine(id: string, line: number) {
    if (id !== activeId) switchDoc(id);
    const lineInfo = cm.state.doc.line(Math.min(line + 1, cm.state.doc.lines));
    cm.dispatch({ selection: { anchor: lineInfo.from }, effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }) });
    cm.focus();
  }

  // The actual <ul id="docList"> markup is DocList.svelte now (mounted at
  // #doclist-mount in main.ts) — this just pushes current state into the
  // stores it reads, same as every other renderDocList() call site already
  // did for the old DOM-rebuilding version.
  //
  // docs.map(d => ({...d})) rather than docs (or even [...docs]): doc
  // objects are mutated in place elsewhere (e.g. doc.name on rename), not
  // reassigned, so a keyed {#each doc.id} in DocList.svelte sees the same
  // object reference at that key across renders and skips re-rendering its
  // bound content — Svelte's reuse optimization assumes "same reference"
  // means "same content". A fresh shallow clone of every doc on every push
  // guarantees each render is actually a distinct object, however it was
  // mutated underneath.
  function renderDocList() {
    docsStore.set(docs.map((d) => ({ ...d })));
    activeIdStore.set(activeId);
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
        saveNow();
        const name = file.name.replace(/\.(md|markdown|txt)$/i, "");
        const doc: Doc = { id: uid(), name: name || "Imported", content: String(reader.result), updatedAt: Date.now() };
        docs.unshift(doc);
        activeId = doc.id;
        persistDocs();
        localStorage.setItem(STORAGE_ACTIVE, activeId);
        renderDocList();
        loadDocIntoEditor(doc);
        updatePreview();
        updateCounts();
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
    const modal = document.getElementById("infoModal");
    const termsModal = document.getElementById("termsModal");
    const privacyModal = document.getElementById("privacyModal");

    document.getElementById("infoCloseBtn").addEventListener("click", () => { modal.hidden = true; });
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });

    document.getElementById("termsCloseBtn").addEventListener("click", () => { termsModal.hidden = true; });
    termsModal.addEventListener("click", (e) => { if (e.target === termsModal) termsModal.hidden = true; });

    document.getElementById("privacyCloseBtn").addEventListener("click", () => { privacyModal.hidden = true; });
    privacyModal.addEventListener("click", (e) => { if (e.target === privacyModal) privacyModal.hidden = true; });

    document.getElementById("menuTerms").addEventListener("click", () => {
      modal.hidden = true;
      termsModal.hidden = false;
    });
    document.getElementById("menuPrivacy").addEventListener("click", () => {
      modal.hidden = true;
      privacyModal.hidden = false;
    });
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



  // Shared by gist.ts (Publish to Gist) and collab.ts (Share) — both gate a
  // feature behind GitHub sign-in and pop this same modal when signed out.
  function initGithubSignInModal() {
    const modal = document.getElementById("githubSignInModal");
    document.getElementById("githubSignInModalCancelBtn").addEventListener("click", () => {
      modal.hidden = true;
    });
    document.getElementById("githubSignInModalSignInBtn").addEventListener("click", () => {
      openGithubSignInPopup();
    });
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.hidden = true;
    });

    // Sign-in happens in a popup (src/github-auth.ts's callback page posts
    // the result here and closes itself) instead of a full-page redirect,
    // so the app never has to reload — just re-check the session in place.
    window.addEventListener("message", (e) => {
      if (e.origin !== location.origin || !e.data || e.data.type !== "mde-github-auth") return;
      if (e.data.ok) {
        modal.hidden = true;
        window.MDE.onGithubAuthComplete && window.MDE.onGithubAuthComplete();
      } else {
        alert(`GitHub sign-in failed: ${e.data.message || "unknown error"}`);
      }
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

  function exportAs(format: string) {
    saveNow();
    const base = currentFileBase();
    const raw = cm.state.doc.toString();

    if (format === "md") {
      const resolved = resolveImageRefs(raw, getActiveDoc());
      downloadBlob(new Blob([resolved], { type: "text/markdown;charset=utf-8" }), `${base}.md`);
      showToast(`Exported ${base}.md`, "success");
      return;
    }

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
</style>
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
    getActiveDoc,
    switchDoc,
    deleteDoc,
    duplicateDoc,
    jumpToLine,
    persistDocs,
    renderDocList,
    refreshSaveStatus() {
      setSaveStatus(savedLabel(getActiveDoc()));
    },
    // Editor text with any ![](refName) image references inlined back to
    // their real data URIs — what gets published to a Gist, since a Gist
    // needs to stand on its own outside this app.
    getResolvedContent() {
      return resolveImageRefs(cm.state.doc.toString(), getActiveDoc());
    },
    setDocImage(key, dataUrl) {
      const doc = getActiveDoc();
      if (!doc) return;
      doc.images = doc.images || {};
      doc.images[key] = dataUrl;
      persistDocs();
      updatePreview();
    },
    onImageAdded: null,
    toggleDropdown,
    closeAllDropdowns,
    findDocById(id) {
      return docs.find((d) => d.id === id);
    },
    requireGithubSignIn(hint) {
      const modal = document.getElementById("githubSignInModal");
      if (hint) document.getElementById("githubSignInModalHint").textContent = hint;
      modal.hidden = false;
    },
    openGithubSignInPopup,
    githubUsername: null, // kept in sync by gist.ts's checkSession()
    createDoc(partial) {
      saveNow();
      const doc: Doc = Object.assign({ id: uid(), name: "Untitled", content: "", updatedAt: Date.now() }, partial);
      docs.unshift(doc);
      activeId = doc.id;
      persistDocs();
      localStorage.setItem(STORAGE_ACTIVE, activeId);
      renderDocList();
      loadDocIntoEditor(doc);
      updatePreview();
      updateCounts();
      return doc;
    },
    // The doc's own id doubles as its collab room id (see collab.ts) — this
    // just tracks locally whether the doc has ever been shared, so
    // switching to/loading it knows whether to attempt rejoining the room.
    markActiveDocShared(shared) {
      const doc = getActiveDoc();
      if (!doc) return null;
      if (shared) doc.shared = true;
      else delete doc.shared;
      doc.updatedAt = Date.now();
      persistDocs();
      renderDocList();
      return doc;
    },
    setActiveDocGistId(gistId) {
      const doc = getActiveDoc();
      if (!doc) return null;
      doc.gistId = gistId;
      doc.updatedAt = Date.now();
      persistDocs();
      renderDocList();
      return doc;
    },
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
    newDoc: createNewDoc,
    openLocalFile() {
      document.getElementById("importInput").click();
    },
    exportAs,
    toggleSidebar,
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
    toggleExpandPreview,
    formatRelativeTime,
  };
  window.MDE = bridge;
})();
