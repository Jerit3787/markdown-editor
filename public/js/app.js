/* Markdown Editor — static, client-side, localStorage-backed */
(function () {
  "use strict";

  const STORAGE_DOCS = "mde:docs";
  const STORAGE_ACTIVE = "mde:active";
  const STORAGE_THEME = "mde:theme";
  const STORAGE_VIEW = "mde:view";

  const WELCOME = `# Welcome to Markdown Editor

A fast, distraction-free markdown editor that runs entirely in your browser — no server, no account, nothing leaves your machine.

## Features

- **Live preview** as you type
- Multiple documents, saved automatically to this browser
- Export to **.md**, **.html**, **.pdf**, or **.txt**
- Formatting toolbar and keyboard shortcuts (\`Ctrl/Cmd+B\`, \`Ctrl/Cmd+I\`, \`Ctrl/Cmd+K\`)
- Light and dark themes

## Try it

1. Edit this text
2. Click **+** in the sidebar to start a new document
3. Click **Export** to download your work

> Everything is saved locally in your browser as you type.

\`\`\`js
function hello() {
  console.log("Happy writing!");
}
\`\`\`

| Format | Good for |
|---|---|
| Markdown | Editing, version control |
| HTML | Sharing, publishing |
| PDF | Printing, archiving |
`;

  // ---------- State ----------
  let docs = [];
  let activeId = null;
  let cm = null;
  let saveTimer = null;

  // ---------- Storage helpers ----------
  function loadDocs() {
    try {
      const raw = localStorage.getItem(STORAGE_DOCS);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore corrupt storage */ }
    const id = uid();
    return [{ id, name: "Welcome", content: WELCOME, updatedAt: Date.now() }];
  }

  function persistDocs() {
    localStorage.setItem(STORAGE_DOCS, JSON.stringify(docs));
  }

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function getActiveDoc() {
    return docs.find((d) => d.id === activeId) || docs[0];
  }

  // ---------- Init ----------
  document.addEventListener("DOMContentLoaded", init);

  function init() {
    docs = loadDocs();
    activeId = localStorage.getItem(STORAGE_ACTIVE) || docs[0].id;
    if (!docs.find((d) => d.id === activeId)) activeId = docs[0].id;

    initTheme();
    initEditor();
    initImageUploads();
    initToolbar();
    initSidebar();
    initExport();
    initOpenMenu();
    initViewToggle();
    initImport();
    initShortStatus();
    initMoreMenu();

    renderDocList();
    loadDocIntoEditor(getActiveDoc());
    updatePreview();
    updateCounts();
  }

  // ---------- Theme ----------
  function initTheme() {
    const saved = localStorage.getItem(STORAGE_THEME) || "light";
    setTheme(saved);
    document.getElementById("themeToggle").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      setTheme(cur);
    });
  }

  function setTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    document.getElementById("themeIconUse").setAttribute("href", theme === "dark" ? "#icon-sun" : "#icon-moon");
    document.querySelector("#themeToggle .tool-label").textContent = theme === "dark" ? "Light mode" : "Dark mode";
    localStorage.setItem(STORAGE_THEME, theme);
    if (cm) cm.setOption("theme", theme === "dark" ? "material-darker" : "default");
  }

  // ---------- Editor (CodeMirror) ----------
  function initEditor() {
    const textarea = document.getElementById("editor");
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
    });

    cm.on("cursorActivity", updateCursorPos);
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
      const file = e.target.files[0];
      if (file) insertImageWithUpload(file);
      e.target.value = "";
    });
  }

  function imageFilesFrom(dataTransfer) {
    if (!dataTransfer || !dataTransfer.files) return [];
    return Array.from(dataTransfer.files).filter((f) => f.type.startsWith("image/"));
  }

  function insertImageWithUpload(file, pos) {
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
        if (range) cm.replaceRange(`![${altTextFromFilename(file.name)}](${dataUrl})`, range.from, range.to);
      })
      .catch((err) => {
        const range = marker.find();
        marker.clear();
        if (range) cm.replaceRange(`![image failed to load: ${err.message}]()`, range.from, range.to);
      });
  }

  function altTextFromFilename(name) {
    return name.replace(/\.[^.]+$/, "") || "image";
  }

  function readImageAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("read failed"));
      reader.readAsDataURL(file);
    });
  }

  function loadDocIntoEditor(doc) {
    window.MDE.onBeforeDocLoad && window.MDE.onBeforeDocLoad();
    cm.setValue(doc.content || "");
    document.getElementById("docTitle").value = doc.name || "Untitled";
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
  function savedLabel(doc) {
    return doc && doc.gistId ? "Saved locally · linked to Gist" : "Saved locally";
  }

  function setSaveStatus(text) {
    document.getElementById("saveStatus").textContent = text;
  }

  // ---------- Preview ----------
  function updatePreview() {
    const raw = cm.getValue();
    const html = marked.parse(raw, { gfm: true, breaks: false });
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
      const btn = e.target.closest("button[data-cmd]");
      if (!btn) return;
      runCmd(btn.dataset.cmd);
      cm.focus();
    });

    document.getElementById("docTitle").addEventListener("input", (e) => {
      const doc = getActiveDoc();
      if (!doc) return;
      doc.name = e.target.value || "Untitled";
      renderDocList();
      scheduleSave();
    });
  }

  function runCmd(cmd) {
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

  function wrapSelection(before, after, placeholder) {
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

  function prefixLine(prefix) {
    const cursor = cm.getCursor();
    const line = cm.getLine(cursor.line);
    if (line.startsWith(prefix)) {
      cm.replaceRange(line.slice(prefix.length), { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
    } else {
      cm.replaceRange(prefix, { line: cursor.line, ch: 0 });
    }
  }

  function insertLink() {
    const sel = cm.getSelection();
    const label = sel || "link text";
    cm.replaceSelection(`[${label}](https://)`);
  }

  function insertImage() {
    document.getElementById("imageFileInput").click();
  }

  function insertTable() {
    insertBlock(
      "\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |\n| Cell | Cell | Cell |\n"
    );
  }

  function insertBlock(block) {
    const cursor = cm.getCursor();
    cm.replaceRange(block, cursor);
  }

  // ---------- View toggle ----------
  function initViewToggle() {
    const main = document.getElementById("main");
    const saved = localStorage.getItem(STORAGE_VIEW) || "split";
    setView(saved);

    document.querySelectorAll(".view-btn").forEach((btn) => {
      btn.addEventListener("click", () => setView(btn.dataset.view));
    });

    function setView(view) {
      main.className = `mode-${view}`;
      document.querySelectorAll(".view-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
      localStorage.setItem(STORAGE_VIEW, view);
      setTimeout(() => cm && cm.refresh(), 0);
    }
  }

  // ---------- Sidebar / documents ----------
  const isMobile = () => window.matchMedia("(max-width: 780px)").matches;

  function initSidebar() {
    // On a phone-width screen the sidebar is a full-height overlay (see
    // css), so starting it open covers the whole editor on first load.
    if (isMobile()) document.getElementById("sidebar").classList.add("collapsed");

    document.getElementById("sidebarToggle").addEventListener("click", () => {
      document.getElementById("sidebar").classList.toggle("collapsed");
      setTimeout(() => cm && cm.refresh(), 150);
    });

    document.getElementById("newDocBtn").addEventListener("click", () => {
      saveNow();
      const doc = { id: uid(), name: "Untitled", content: "", updatedAt: Date.now() };
      docs.unshift(doc);
      activeId = doc.id;
      persistDocs();
      localStorage.setItem(STORAGE_ACTIVE, activeId);
      renderDocList();
      loadDocIntoEditor(doc);
      updatePreview();
      updateCounts();
      document.getElementById("docTitle").focus();
      document.getElementById("docTitle").select();
    });
  }

  function switchDoc(id) {
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

  function deleteDoc(id) {
    const doc = docs.find((d) => d.id === id);
    if (!doc) return;
    if (!confirm(`Delete "${doc.name}"? This can't be undone.`)) return;
    docs = docs.filter((d) => d.id !== id);
    if (docs.length === 0) {
      docs.push({ id: uid(), name: "Untitled", content: "", updatedAt: Date.now() });
    }
    if (activeId === id) {
      activeId = docs[0].id;
      loadDocIntoEditor(getActiveDoc());
      updatePreview();
      updateCounts();
    }
    localStorage.setItem(STORAGE_ACTIVE, activeId);
    persistDocs();
    renderDocList();
  }

  function renderDocList() {
    const list = document.getElementById("docList");
    list.innerHTML = "";
    const sorted = [...docs].sort((a, b) => b.updatedAt - a.updatedAt);
    sorted.forEach((doc) => {
      const li = document.createElement("li");
      li.className = doc.id === activeId ? "active" : "";
      li.innerHTML = `<span class="doc-name">${escapeHtml(doc.name || "Untitled")}</span><button class="doc-delete" title="Delete"><svg class="icon"><use href="#icon-x"></use></svg></button>`;
      li.addEventListener("click", (e) => {
        if (e.target.closest(".doc-delete")) return;
        switchDoc(doc.id);
      });
      li.querySelector(".doc-delete").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteDoc(doc.id);
      });
      list.appendChild(li);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- Open (local file / Gist) ----------
  function initOpenMenu() {
    const btn = document.getElementById("openBtn");
    const menu = document.getElementById("openMenu");

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.toggle("open");
    });
    document.addEventListener("click", () => menu.classList.remove("open"));
    menu.addEventListener("click", (e) => e.stopPropagation());

    document.getElementById("openLocalBtn").addEventListener("click", () => {
      document.getElementById("importInput").click();
      menu.classList.remove("open");
    });
  }

  // ---------- Import ----------
  function initImport() {
    document.getElementById("importInput").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        saveNow();
        const name = file.name.replace(/\.(md|markdown|txt)$/i, "");
        const doc = { id: uid(), name: name || "Imported", content: String(reader.result), updatedAt: Date.now() };
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
      e.target.value = "";
    });
  }

  // ---------- Export ----------
  // Mobile-only "⋮" panel holding view-toggle/theme/share/export (see
  // .topbar-tools in css) — a persistent side panel, not a fleeting
  // popover, so clicks inside it (switching view/theme, opening the
  // nested share/export menus) shouldn't dismiss it; only tapping ⋮
  // again or tapping outside the panel should.
  function initMoreMenu() {
    const btn = document.getElementById("moreBtn");
    const tools = document.getElementById("topbarTools");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      tools.classList.toggle("open");
    });
    tools.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => tools.classList.remove("open"));
  }

  function initExport() {
    const btn = document.getElementById("exportBtn");
    const menu = document.getElementById("exportMenu");

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.toggle("open");
    });
    document.addEventListener("click", () => menu.classList.remove("open"));

    menu.addEventListener("click", (e) => {
      const item = e.target.closest("button[data-export]");
      if (!item) return;
      exportAs(item.dataset.export);
      menu.classList.remove("open");
    });
  }

  function currentFileBase() {
    const doc = getActiveDoc();
    const name = (doc && doc.name ? doc.name : "document").trim();
    return name.replace(/[\\/:*?"<>|]+/g, "-") || "document";
  }

  function exportAs(format) {
    saveNow();
    const base = currentFileBase();
    const raw = cm.getValue();

    if (format === "md") {
      downloadBlob(new Blob([raw], { type: "text/markdown;charset=utf-8" }), `${base}.md`);
      return;
    }

    if (format === "txt") {
      const text = document.getElementById("preview").innerText;
      downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), `${base}.txt`);
      return;
    }

    if (format === "html") {
      const bodyHtml = document.getElementById("preview").innerHTML;
      const doc = buildStandaloneHtml(base, bodyHtml);
      downloadBlob(new Blob([doc], { type: "text/html;charset=utf-8" }), `${base}.html`);
      return;
    }

    if (format === "pdf") {
      exportPdf(base);
      return;
    }
  }

  function buildStandaloneHtml(title, bodyHtml) {
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

  function exportPdf(base) {
    const source = document.getElementById("preview");
    const clone = source.cloneNode(true);
    clone.style.padding = "0";
    const wrapper = document.createElement("div");
    wrapper.style.padding = "20px 30px";
    wrapper.appendChild(clone);

    const opt = {
      margin: 12,
      filename: `${base}.pdf`,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["css", "legacy"] },
    };

    setSaveStatus("Generating PDF…");
    html2pdf().set(opt).from(wrapper).save().then(() => setSaveStatus("Saved"));
  }

  function downloadBlob(blob, filename) {
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

  // ---------- Bridge for js/collab.js (live collaboration) ----------
  // collab.js runs as a separate module with no access to this closure, so
  // it drives doc switching/creation and reads the CodeMirror instance
  // through this small surface instead of reaching into internals directly.
  window.MDE = {
    getEditor: () => cm,
    getActiveDoc,
    switchDoc,
    persistDocs,
    renderDocList,
    refreshSaveStatus() {
      setSaveStatus(savedLabel(getActiveDoc()));
    },
    findDocByRoomId(roomId) {
      return docs.find((d) => d.roomId === roomId);
    },
    createDoc(partial) {
      saveNow();
      const doc = Object.assign({ id: uid(), name: "Untitled", content: "", updatedAt: Date.now() }, partial);
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
    setActiveDocRoomId(roomId) {
      const doc = getActiveDoc();
      if (!doc) return null;
      doc.roomId = roomId;
      doc.updatedAt = Date.now();
      persistDocs();
      renderDocList();
      return doc;
    },
    clearActiveDocRoomId() {
      const doc = getActiveDoc();
      if (!doc) return;
      delete doc.roomId;
      persistDocs();
      renderDocList();
    },
    setActiveDocGistId(gistId) {
      const doc = getActiveDoc();
      if (!doc) return null;
      doc.gistId = gistId;
      doc.updatedAt = Date.now();
      persistDocs();
      return doc;
    },
    // Set by collab.js. Called by loadDocIntoEditor() right before/after the
    // editor content is swapped, so collab.js can unbind the outgoing doc's
    // room before CodeMirror's setValue() fires a bogus "edit".
    onBeforeDocLoad: null,
    onActiveDocChanged: null,
  };
})();
