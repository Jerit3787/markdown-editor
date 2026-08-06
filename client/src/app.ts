/* Markdown Editor — static, client-side, localStorage-backed */
import CodeMirror from "codemirror";
import "codemirror/mode/markdown/markdown";
import "codemirror/mode/xml/xml";
import "codemirror/addon/mode/overlay";
import "codemirror/mode/gfm/gfm";
import "codemirror/addon/edit/continuelist";
import "codemirror/addon/display/placeholder";
import "codemirror/lib/codemirror.css";
import "codemirror/theme/material-darker.css";
import { marked } from "marked";
import DOMPurify from "dompurify";
import html2pdf from "html2pdf.js";
import type { Doc, MDEBridge } from "./types";
import { docsStore, activeIdStore, activeDocContent } from "./stores/docs";
import { showToast } from "./stores/toast";

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
  let cm: CodeMirror.Editor = null as unknown as CodeMirror.Editor;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

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

    initEditor();
    initImageUploads();
    initToolbar();
    initSaveStatus();
    initSidebar();
    initViewToggle();
    initImport();
    initShortStatus();
    initImagesManager();
    initLinkModal();
    initMenuBar();
    initShortcutsModal();
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
  // DOMContentLoaded). initEditor() below still reads localStorage
  // directly for CodeMirror's own initial theme option.

  // ---------- Editor (CodeMirror) ----------
  function initEditor() {
    const textarea = document.getElementById("editor") as HTMLTextAreaElement;
    cm = CodeMirror.fromTextArea(textarea, {
      mode: "gfm",
      lineWrapping: true,
      lineNumbers: false,
      theme: (localStorage.getItem(STORAGE_THEME) === "dark") ? "material-darker" : "default",
      extraKeys: {
        "Cmd-B": () => wrapSelection("**", "**"),
        "Ctrl-B": () => wrapSelection("**", "**"),
        "Cmd-I": () => wrapSelection("_", "_"),
        "Ctrl-I": () => wrapSelection("_", "_"),
        "Cmd-K": () => insertLink(),
        "Ctrl-K": () => insertLink(),
        "Enter": "newlineAndIndentContinueMarkdownList",
      },
    });

    cm.on("change", () => {
      scheduleSave();
      updatePreview();
      updateCounts();
      // Undebounced (unlike doc.content, which only syncs on the debounced
      // save) — DocList.svelte's outline for whichever doc is active reads
      // this so it stays live as-you-type, same as the old behavior.
      activeDocContent.set(cm.getValue());
    });

    cm.on("cursorActivity", updateCursorPos);
  }

  // ---------- Edit menu clipboard commands ----------
  // The browser's native Ctrl/Cmd+X/C/V already work on the editor without
  // any of this — these three only exist to back the Edit-menu Cut/Copy/Paste
  // items, since a menu click has no native clipboard access of its own.
  async function menuClipboardCut() {
    const sel = cm.getSelection();
    if (!sel) { cm.focus(); return; }
    try {
      await navigator.clipboard.writeText(sel);
      cm.replaceSelection("");
    } catch {
      cm.focus();
      document.execCommand("cut");
    }
    cm.focus();
  }

  async function menuClipboardCopy() {
    const sel = cm.getSelection();
    if (!sel) { cm.focus(); return; }
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
      cm.replaceSelection(text);
    } catch {
      alert("Couldn't read the clipboard automatically — press Ctrl/Cmd+V instead, or allow clipboard access for this site.");
    }
  }

  // ---------- Image embedding (paste / drop / toolbar) ----------
  // Images are embedded directly as base64 data URIs in the markdown — no
  // upload, no server involved. Kept fairly small since it counts against
  // both localStorage's ~5-10MB quota and, for shared documents, the size
  // of every Yjs sync payload sent to collaborators.
  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

  function initImageUploads() {
    cm.on("paste", (instance, e) => {
      const files = imageFilesFrom(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      files.forEach((file) => insertImageWithUpload(file));
    });

    cm.on("drop", (instance, e) => {
      const files = imageFilesFrom(e.dataTransfer);
      if (files.length === 0) return;
      e.preventDefault();
      const pos = cm.coordsChar({ left: e.clientX, top: e.clientY });
      files.forEach((file) => insertImageWithUpload(file, pos));
    });

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

  function insertImageWithUpload(file: File, pos?: CodeMirror.Position) {
    const from = pos || cm.getCursor();
    if (file.size > MAX_IMAGE_BYTES) {
      cm.replaceRange(`![${file.name}: image too large, 2MB max]()`, from);
      return;
    }

    const placeholder = `![Encoding ${file.name}…]()`;
    cm.replaceRange(placeholder, from);
    const to = cm.posFromIndex(cm.indexFromPos(from) + placeholder.length);
    // markText tracks the placeholder's position live as other edits (local
    // typing, or a collaborator's) land while the file is being read.
    const marker = cm.markText(from, to, { className: "cm-image-uploading" });

    readImageAsDataURL(file)
      .then((dataUrl) => {
        const range = marker.find();
        marker.clear();
        if (!range) return; // doc was switched away mid-read; drop it
        const doc = getActiveDoc();
        doc.images = doc.images || {};
        const key = imageKey(file.name, doc.images);
        doc.images[key] = dataUrl;
        persistDocs();
        window.MDE.onImageAdded && window.MDE.onImageAdded(key, dataUrl);
        cm.replaceRange(`![${altTextFromFilename(file.name)}](${key})`, (range as any).from, (range as any).to);
        updatePreview();
      })
      .catch((err) => {
        const range = marker.find();
        marker.clear();
        if (range) cm.replaceRange(`![image failed to load: ${err.message}]()`, (range as any).from, (range as any).to);
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

  function loadDocIntoEditor(doc: Doc | undefined) {
    window.MDE.onBeforeDocLoad && window.MDE.onBeforeDocLoad();
    updateMainView(!doc);
    if (!doc) {
      cm.setValue("");
      (document.getElementById("docTitle") as HTMLInputElement).value = "";
      resizeDocTitle();
      updatePageTitle("");
      cm.clearHistory();
      setSaveStatus("");
      window.MDE.onActiveDocChanged && window.MDE.onActiveDocChanged(undefined as unknown as Doc);
      return;
    }
    cm.setValue(doc.content || "");
    (document.getElementById("docTitle") as HTMLInputElement).value = doc.name || "Untitled";
    resizeDocTitle();
    updatePageTitle(doc.name || "Untitled");
    cm.clearHistory();
    setTimeout(() => cm.refresh(), 0);
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
    doc.content = cm.getValue();
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
    const raw = cm.getValue();
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
    const text = cm.getValue();
    const words = text.trim().length ? text.trim().split(/\s+/).length : 0;
    document.getElementById("wordCount").textContent = `${words} word${words === 1 ? "" : "s"}`;
    document.getElementById("charCount").textContent = `${text.length} character${text.length === 1 ? "" : "s"}`;
  }

  function updateCursorPos() {
    const pos = cm.getCursor();
    document.getElementById("cursorPos").textContent = `Ln ${pos.line + 1}, Col ${pos.ch + 1}`;
  }

  function initShortStatus() {
    updateCursorPos();
  }

  // ---------- Toolbar formatting ----------
  function initToolbar() {
    document.getElementById("toolbar").addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("button[data-cmd]") as HTMLElement;
      if (!btn) return;
      runCmd(btn.dataset.cmd);
      cm.focus();
    });

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
    const sel = cm.getSelection();
    const text = sel || placeholder || "";
    cm.replaceSelection(before + text + after);
    if (!sel && placeholder) {
      const from = cm.getCursor();
      cm.setSelection(
        { line: from.line, ch: from.ch - after.length - placeholder.length },
        { line: from.line, ch: from.ch - after.length }
      );
    }
  }

  function prefixLine(prefix: string) {
    const cursor = cm.getCursor();
    const line = cm.getLine(cursor.line);
    if (line.startsWith(prefix)) {
      cm.replaceRange(line.slice(prefix.length), { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
    } else {
      cm.replaceRange(prefix, { line: cursor.line, ch: 0 });
    }
  }

  // A popup instead of dropping raw `[text](https://)` markdown into the
  // editor — friendlier for anyone not already fluent in markdown syntax.
  function insertLink() {
    const sel = cm.getSelection();
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
      cm.replaceSelection(`[${text}](${url})`);
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
    const cursor = cm.getCursor();
    cm.replaceRange(block, cursor);
  }

  // ---------- View toggle ----------
  function initViewToggle() {
    const main = document.getElementById("main");
    const expandBtn = document.getElementById("expandPreviewBtn") as HTMLButtonElement;
    const saved = localStorage.getItem(STORAGE_VIEW) || "split";
    // Remembered so the expand-preview button can restore whichever mode
    // the user was actually in (editor or split) rather than always
    // snapping back to split.
    let lastNonPreviewView = saved === "preview" ? "split" : saved;
    setView(saved);

    document.querySelectorAll(".menu-view-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        setView((btn as HTMLElement).dataset.view);
        document.getElementById("viewMenu").classList.remove("open");
      });
    });

    // A one-click shortcut for the same "Preview" mode already reachable
    // via View > Preview — sits right next to the menu bar instead of
    // requiring that menu to be opened first (item #21).
    expandBtn.addEventListener("click", () => {
      setView(main.classList.contains("mode-preview") ? lastNonPreviewView : "preview");
    });

    function setView(view: string) {
      if (view !== "preview") lastNonPreviewView = view;
      main.className = `mode-${view}`;
      document.querySelectorAll(".menu-view-btn").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.view === view));
      expandBtn.classList.toggle("active", view === "preview");
      expandBtn.setAttribute("aria-pressed", String(view === "preview"));
      expandBtn.title = view === "preview" ? "Collapse preview" : "Expand preview";
      localStorage.setItem(STORAGE_VIEW, view);
      setTimeout(() => cm && cm.refresh(), 0);
    }
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
    setTimeout(() => cm && cm.refresh(), 150);
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

    document.getElementById("newDocBtn").addEventListener("click", () => {
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
    });
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
    cm.setCursor({ line, ch: 0 });
    cm.scrollIntoView({ line, ch: 0 }, 100);
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
    document.addEventListener("click", closeAllDropdowns);
    menu.addEventListener("click", (e) => e.stopPropagation());
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

  // ---------- Menu bar (File / Edit / View / Help) ----------
  function initMenuBar() {
    const menuBarPairs = [
      { btn: document.getElementById("fileMenuBtn"), menu: document.getElementById("fileMenu") },
      { btn: document.getElementById("editMenuBtn"), menu: document.getElementById("editMenu") },
      { btn: document.getElementById("viewMenuBtn"), menu: document.getElementById("viewMenu") },
      { btn: document.getElementById("helpMenuBtn"), menu: document.getElementById("helpMenu") },
    ];
    menuBarPairs.forEach(({ btn, menu }) => toggleDropdown(btn, menu));
    enableMenuBarHoverSwitch(menuBarPairs);

    const fileMenu = document.getElementById("fileMenu");
    const closeFileMenu = () => {
      fileMenu.classList.remove("open");
      closeSubmenus(fileMenu);
    };
    initSubmenus(fileMenu);

    document.getElementById("menuNewDoc").addEventListener("click", () => {
      document.getElementById("newDocBtn").click();
      closeFileMenu();
    });
    document.getElementById("menuOpenLocal").addEventListener("click", () => {
      document.getElementById("importInput").click();
      closeFileMenu();
    });
    document.getElementById("menuDeleteDoc").addEventListener("click", () => {
      deleteDoc(activeId);
      closeFileMenu();
    });

    fileMenu.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest("button[data-export]") as HTMLElement;
      if (!item) return;
      exportAs(item.dataset.export);
      closeFileMenu();
    });

    renderRecentMenu();

    const editMenu = document.getElementById("editMenu");
    const closeEditMenu = () => editMenu.classList.remove("open");
    document.getElementById("menuUndo").addEventListener("click", () => { cm.undo(); cm.focus(); closeEditMenu(); });
    document.getElementById("menuRedo").addEventListener("click", () => { cm.redo(); cm.focus(); closeEditMenu(); });
    document.getElementById("menuCut").addEventListener("click", () => { menuClipboardCut(); closeEditMenu(); });
    document.getElementById("menuCopy").addEventListener("click", () => { menuClipboardCopy(); closeEditMenu(); });
    document.getElementById("menuPaste").addEventListener("click", () => { menuClipboardPaste(); closeEditMenu(); });
    document.getElementById("menuBold").addEventListener("click", () => { runCmd("bold"); cm.focus(); closeEditMenu(); });
    document.getElementById("menuItalic").addEventListener("click", () => { runCmd("italic"); cm.focus(); closeEditMenu(); });
    document.getElementById("menuStrike").addEventListener("click", () => { runCmd("strike"); cm.focus(); closeEditMenu(); });
    document.getElementById("menuLink").addEventListener("click", () => { closeEditMenu(); runCmd("link"); });
    document.getElementById("menuImage").addEventListener("click", () => { closeEditMenu(); runCmd("image"); });
    document.getElementById("menuManageImages").addEventListener("click", () => {
      closeEditMenu();
      document.getElementById("imagesManagerBtn").click();
    });

    document.getElementById("menuToggleSidebar").addEventListener("click", () => {
      toggleSidebar();
      document.getElementById("viewMenu").classList.remove("open");
    });

    const helpMenu = document.getElementById("helpMenu");
    document.getElementById("menuShortcuts").addEventListener("click", () => {
      helpMenu.classList.remove("open");
      document.getElementById("shortcutsModal").hidden = false;
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

  function renderRecentMenu() {
    const list = document.getElementById("menuRecentList");
    list.innerHTML = "";
    const sorted = [...docs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
    if (sorted.length === 0) {
      list.innerHTML = `<div class="menu-recent-empty">No documents yet.</div>`;
      return;
    }
    sorted.forEach((doc) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "menu-recent-item";
      item.innerHTML = `<span class="menu-recent-name">${escapeHtml(doc.name || "Untitled")}</span><span class="menu-recent-time">${formatRelativeTime(doc.updatedAt)}</span>`;
      item.addEventListener("click", () => {
        switchDoc(doc.id);
        const fileMenu = document.getElementById("fileMenu");
        fileMenu.classList.remove("open");
        closeSubmenus(fileMenu);
      });
      list.appendChild(item);
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
    const raw = cm.getValue();

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
      return resolveImageRefs(cm.getValue(), getActiveDoc());
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
      return doc;
    },
    // Set by collab.ts. Called by loadDocIntoEditor() right before/after the
    // editor content is swapped, so collab.ts can unbind the outgoing doc's
    // room before CodeMirror's setValue() fires a bogus "edit".
    onBeforeDocLoad: null,
    onActiveDocChanged: null,
  };
  window.MDE = bridge;
})();
