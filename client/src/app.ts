/* Markdown Editor — static, client-side, localStorage-backed */
import { Transaction, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import type { Doc, MDEBridge } from "./types";
import { formatRelativeTime } from "./relative-time";
import {
  activeIdStore,
  activeDocContent,
  docsStore,
  getActiveDoc,
  createDoc,
  switchDoc as storeSwitchDoc,
  renameDoc,
  saveActiveDocContent,
  setDocImage,
  setActiveDocMetadata,
  setActiveDocCitations,
  refreshDocNoteAnchors,
  findCollidingDoc,
  persistDocs,
} from "./stores/docs";
import { serializeMetadataBlock } from "./mmd-metadata";
import { DEFAULT_CITATION_PREFS } from "./mmd-citations";
import { ensureUniqueName } from "./doc-naming";
import { workspacesStore, createWorkspace } from "./stores/workspaces";
import { initRouter, pushDocUrl, replaceDocUrl, replaceToRoot } from "./router";
import { showToast } from "./stores/toast";
import { viewMode } from "./stores/view";
import { commentsPanelOpen } from "./stores/commentsPanel";
import { docListActiveTab } from "./stores/docList";
import { githubSignInModalOpen, githubSignInModalHint } from "./stores/githubSignInModal";
import { linkModalOpen, linkModalPrefillText } from "./stores/linkModal";
import { imagesModalOpen } from "./stores/imagesModal";
import { shortcutsModalOpen } from "./stores/shortcutsModal";
import { aboutModalOpen } from "./stores/aboutModals";
import { focusMode } from "./stores/focusMode";
import { resolveDiagramRefs } from "./diagram-refs";
import { escapeHtml } from "./escape-html";
import { diagramEditorOpen, diagramEditorRef } from "./stores/diagramEditor";
import { maybeSnapshotVersion } from "./history";
import { relocateAnchor } from "./anchor";
import { renameCollision } from "./stores/renameCollision";
import { get } from "svelte/store";
// Unlike Mermaid's SVGs (which bake their own <style> in at render time),
// KaTeX's HTML output has no self-contained styling — it's entirely
// dependent on this stylesheet. buildStandaloneHtml()'s exported <style>
// block is hand-written and independent of the app's own bundled CSS
// (where the normal @import in style.css lives), so it needs its own
// copy inlined here or math would render broken/unstyled in exported
// HTML files.
import katexCss from "katex/dist/katex.min.css?raw";

(function () {
  "use strict";

  const STORAGE_THEME = "mde:theme";
  const APP_NAME = "Markdown Editor";

  function updatePageTitle(docName: string) {
    document.title = docName ? `${APP_NAME} - ${docName}` : APP_NAME;
  }

  // ---------- State ----------
  let cm: EditorView = null as unknown as EditorView;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  // ---------- Storage helpers ----------
  // ---------- Init ----------
  document.addEventListener("DOMContentLoaded", init);

  function init() {
    // Must run before the activeIdStore.subscribe below: it may switch the
    // active document (and workspace) synchronously from the current URL,
    // and that subscription's first fire needs to already reflect it —
    // otherwise the editor briefly loads the wrong document before
    // flashing to the right one.
    initRouter();

    // cm is already populated by this point — Editor.svelte constructs the
    // EditorView in its own onMount and hands it back via
    // window.MDE.registerEditor(), and main.ts's mount() calls (which
    // trigger that) run synchronously before this DOMContentLoaded handler
    // ever fires, same guarantee every other Svelte component here relies on.
    initImageUploads();
    initToolbar();
    initSaveStatus();
    initSidebar();
    initImport();
    initShortStatus();
    initImagesManager();
    initModalEscapeKey();
    // Desktop can Escape out of Focus Mode; mobile has no such key, and
    // #topbar (the View menu's own toggle) is itself hidden while Focus
    // Mode is on, so this floating button (mobile-only, see style.css)
    // is the only way back out there.
    // Focus mode is a store now (Editor.svelte reacts to it via $effect)
    // — this button only ever turns focus mode off, never on, so a plain
    // set(false) is correct (unlike MenuBar.svelte's toggle button).
    document.getElementById("focusModeExitBtn")?.addEventListener("click", () => focusMode.set(false));
    initEmptyState();

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
      const isFirstFire = firstFire;
      firstFire = false;
      lastLoadedId = id;
      loadDocIntoEditor(getActiveDoc());
      window.MDE.updatePreview?.();
      updateCounts();
      // The very first (synchronous, load-time) fire establishes the
      // starting URL via replaceState, not pushState — this document may
      // have become active via a deep link (whose URL is already
      // correct, so this is a harmless no-op) or via the localStorage
      // fallback (whose URL is still bare "/" until this runs). Either
      // way, a tab's baseline history entry must reflect a real document
      // whenever one is active — otherwise navigating back to it later
      // finds no docId in the URL and leaves the current document
      // unchanged instead of restoring anything. Every later fire is a
      // genuine change (switchDoc, "Open Recent", Command Palette,
      // workspace switching via ensureActiveDocInWorkspace — all of them
      // end up here, since this subscription is the one thing every path
      // to changing activeIdStore already funnels through) and gets a
      // real pushState entry instead.
      if (isFirstFire) {
        if (id) replaceDocUrl(id);
        else replaceToRoot();
      } else {
        if (id) pushDocUrl(id);
        else replaceToRoot();
      }
    });

    // updateEmptyStateVariant's "no-workspace" class depends on
    // workspacesStore's length, but it's normally only re-run as a side
    // effect of loadDocIntoEditor above, which only fires when
    // activeIdStore's value actually changes. Deleting the very last
    // workspace doesn't necessarily change activeIdStore (it's typically
    // already null — the workspace was empty of docs before it could be
    // deleted), so that path alone can leave the wrong empty-state variant
    // showing. Subscribe to workspacesStore directly so the variant is
    // re-evaluated any time the workspace count changes, independent of
    // whether the active document also changed.
    //
    // Deliberately calls only the narrow updateEmptyStateVariant, NOT the
    // full updateMainView — every workspace mutation goes through
    // workspacesStore (create/rename/delete, including renaming a
    // workspace while sitting in an empty one, or the auto-focus into a
    // rename input right after creating one), and updateMainView's other
    // side effects (collapseSidebarForMobile() chief among them) must
    // stay reachable only from genuine "which document is active"
    // transitions via the activeIdStore subscription above — otherwise a
    // workspace rename mid-interaction on mobile collapses the sidebar
    // out from under the very input the user is typing into.
    workspacesStore.subscribe(() => {
      updateEmptyStateVariant(!getActiveDoc());
      (document.getElementById("newDocBtn") as HTMLButtonElement).disabled = get(workspacesStore).length === 0;
    });
  }

  function initModalEscapeKey() {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (get(focusMode)) focusMode.set(false);
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
    document.getElementById("emptyNewWorkspaceBtn").addEventListener("click", () => {
      const ws = createWorkspace("New workspace");
      updateMainView(true); // re-run the empty-state check now that a workspace exists
      // Focus the new workspace's name for immediate renaming, same as
      // the switcher's own "New workspace" button — see WorkspaceSwitcher.svelte.
      document.getElementById("workspace-switcher-mount")?.querySelector("button")?.click();
    });
    document.getElementById("emptyOpenRepoBtn").addEventListener("click", () => {
      document.getElementById("menuOpenRepo").click();
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

  // Editor.svelte owns the EditorView itself and the compartments/
  // marker-fields/menu-fields from Phases A/B; Preview.svelte (Phase C)
  // owns the render pipeline, sync-scroll, and wikilink-navigation-in-
  // preview — see docs/superpowers/specs/2026-08-19-editor-core-migration-phase-c-design.md.
  // This builds only what app.ts still owns — formatting keymaps, the
  // markdown language, and the still-mixed-purpose updateListener below
  // (save/counts/doc-content-store stay app.ts's; its two preview calls
  // route through the bridge) — which Editor.svelte splices in via
  // window.MDE.getEditorExtensions().
  function buildEditorExtensions(): Extension[] {
    return [
      keymap.of([
        {
          key: "Mod-b",
          run: () => {
            window.MDE.runCmd?.("bold");
            return true;
          },
        },
        {
          key: "Mod-i",
          run: () => {
            window.MDE.runCmd?.("italic");
            return true;
          },
        },
        {
          key: "Mod-k",
          run: () => {
            window.MDE.runCmd?.("link");
            return true;
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
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          scheduleSave();
          window.MDE.updatePreview?.();
          updateCounts();
          // Undebounced (unlike doc.content, which only syncs on the
          // debounced save) — DocList.svelte's outline for whichever doc
          // is active reads this so it stays live as-you-type.
          activeDocContent.set(cm.state.doc.toString());
        }
        if (update.selectionSet) updateCursorPos();
        if (update.docChanged || update.selectionSet) window.MDE.followCursorInPreview?.();
      }),
    ];
  }

  // ---------- Edit menu clipboard commands ----------
  // The browser's native Ctrl/Cmd+X/C/V already work on the editor without
  // any of this — these three only exist to back the Edit-menu Cut/Copy/Paste
  // items, since a menu click has no native clipboard access of its own.
  async function menuClipboardCut() {
    const { from, to } = cm.state.selection.main;
    if (from === to) {
      cm.focus();
      return;
    }
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
    if (from === to) {
      cm.focus();
      return;
    }
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
  // Image markers and insertImageWithUpload live in Editor.svelte now
  // (Phase B of the editor-core migration) — this just wires the
  // toolbar/menu file-picker's raw #imageFileInput element (still
  // index.html-owned, out of scope for this phase) to the moved logic
  // via the bridge.
  function initImageUploads() {
    document.getElementById("imageFileInput").addEventListener("change", (e) => {
      const file = (e.target as HTMLInputElement).files[0];
      if (file) window.MDE.insertImageWithUpload?.(file);
      (e.target as HTMLInputElement).value = "";
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
    document.getElementById("imagesManagerBtn")?.addEventListener("click", () => {
      imagesModalOpen.set(true);
    });
  }

  // Just the #emptyState visibility + which-variant-shows ("no workspace"
  // vs. "no document") class toggle — split out from updateMainView so
  // the workspacesStore subscription above can re-evaluate this narrow
  // bit on every workspace mutation without also re-running
  // updateMainView's other DOM side effects (collapseSidebarForMobile()
  // especially — see that subscription's own comment for why).
  function updateEmptyStateVariant(empty: boolean) {
    document.getElementById("emptyState").hidden = !empty;
    document.getElementById("emptyState").classList.toggle("no-workspace", get(workspacesStore).length === 0);
  }

  // Toggles between the editor/preview panes and the empty-state welcome
  // screen (#emptyState) — the only reachable "no document" case is
  // deleting the last remaining doc, or a brand-new visitor with nothing
  // in storage yet (loadDocs() no longer seeds a Welcome doc).
  function updateMainView(empty: boolean) {
    updateEmptyStateVariant(empty);
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
    (document.getElementById("shareDropdownBtn") as HTMLButtonElement).disabled = empty;
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
    // collabUndoManager/editingModeCompartment now live in Editor.svelte
    // (Phase A of the editor-core migration) — window.MDE.exitCollabMode()
    // does the exact same reset. Defense-in-depth: collab.ts's
    // onBeforeDocLoad hook already calls this before this function runs,
    // but a stale collab extension config bound to the OLD room's Y.Text
    // must never survive into whatever doc loads next, so this doesn't
    // rely solely on that hook having fired. A separate dispatch from
    // the content-swap below, but harmless: it carries no document
    // changes, so CM6's own history extension never records it as an
    // undo-able entry.
    window.MDE.exitCollabMode?.();
    cm.dispatch({
      changes: { from: 0, to: cm.state.doc.length, insert: content },
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
      window.MDE.setCommentMarkers?.([]);
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
      window.MDE.setCommentMarkers?.(relocated);
    } else {
      window.MDE.setCommentMarkers?.([]);
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
      void maybeSnapshotVersion(doc.id, doc.content, undefined, doc.images);
      refreshDocNoteAnchors(doc.content);
    }
    setSaveStatus(savedLabel(doc));
  }

  // Everything always lives in this browser's localStorage first; the
  // status text just also surfaces whether it's *also* linked elsewhere,
  // since that's the part that's easy to lose track of. A doc's repo
  // link isn't on the doc itself (repoPath/repoLink live one level up,
  // on its containing Workspace — see types.ts) — resolve through
  // workspacesStore rather than checking doc.repoPath alone, since a
  // workspace can be repo-linked before any of its docs have actually
  // synced to a path yet.
  function docWorkspaceRepoLinked(doc: Doc | undefined): boolean {
    if (!doc) return false;
    return !!get(workspacesStore).find((w) => w.id === doc.workspaceId)?.repoLink;
  }

  function savedLabel(doc: Doc | undefined) {
    if (!doc) return "Saved locally";
    const links = [doc.gistId && "linked to Gist", docWorkspaceRepoLinked(doc) && "linked to repo"].filter(Boolean);
    return links.length ? `Saved locally · ${links.join(" · ")}` : "Saved locally";
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

    const repoLink = document.getElementById("saveStatusRepoLink") as HTMLAnchorElement;
    const workspaceRepoLink = doc && get(workspacesStore).find((w) => w.id === doc.workspaceId)?.repoLink;
    repoLink.hidden = !workspaceRepoLink;
    if (workspaceRepoLink) {
      // Links straight to this doc's own file once it's actually synced
      // to a path (repoPath is set the first time it's pulled or
      // pushed) — falls back to the repo's root for a doc that's in a
      // repo-linked workspace but hasn't synced yet itself.
      repoLink.href = doc.repoPath
        ? `https://github.com/${workspaceRepoLink.owner}/${workspaceRepoLink.repo}/blob/${workspaceRepoLink.branch}/${doc.repoPath}`
        : `https://github.com/${workspaceRepoLink.owner}/${workspaceRepoLink.repo}`;
    }
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
      window.MDE.onDocRenamed?.(doc.id, name);
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

    const mql = window.matchMedia("(max-width: 780px)");
    mql.addEventListener("change", (e) => {
      if (e.matches) collapseSidebarForMobile();
    });

    document.getElementById("sidebarToggleIn").addEventListener("click", toggleSidebar);
    document.getElementById("sidebarToggleOut").addEventListener("click", toggleSidebar);
    document.getElementById("sidebarBackdrop").addEventListener("click", toggleSidebar);

    document.getElementById("newDocBtn").addEventListener("click", createNewDoc);
  }

  // Shared by the sidebar's "+" button and File > New document (MenuBar.svelte
  // via window.MDE.newDoc). Guarded here (not just via a disabled button)
  // so the Command Palette's own "New document" entry — which calls
  // window.MDE.newDoc() directly — is covered too.
  function createNewDoc() {
    if (get(workspacesStore).length === 0) {
      showToast("Create a workspace first", "error");
      return;
    }
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
        // Native disabled buttons already suppress the click listener
        // above, but mouse events like mouseenter aren't suppressed —
        // without this check, a disabled trigger's flyout could still
        // open by hovering even though clicking it does nothing.
        if ((trigger as HTMLButtonElement).disabled) return;
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

  function serializeCitationsBlock(doc: Doc | undefined, content: string): string {
    const citations = doc?.citations;
    if (!citations || citations.prefs.bibliographySource !== "structured" || citations.bibliography.length === 0) return content;
    const marker = citations.prefs.markerStyle === "pandoc" ? "@" : "#";
    const lines = citations.bibliography.map((entry) => `[${marker}${entry.key}]: ${entry.text}`).join("\n");
    return `${content.replace(/\n+$/, "")}\n\n${lines}\n`;
  }

  async function exportAs(format: string) {
    saveNow();
    const base = currentFileBase();
    const raw = cm.state.doc.toString();

    if (format === "md") {
      const doc = getActiveDoc();
      const resolved = resolveDiagramRefs(resolveImageRefs(raw, doc), doc?.diagrams);
      const withMetadata = serializeMetadataBlock(doc?.metadata ?? [], resolved);
      const withCitations = serializeCitationsBlock(doc, withMetadata);
      downloadBlob(new Blob([withCitations], { type: "text/markdown;charset=utf-8" }), `${base}.md`);
      showToast(`Exported ${base}.md`, "success");
      return;
    }

    // txt/html/pdf all read #preview's rendered DOM — make sure any
    // in-flight or still-scheduled mermaid/math render has landed first,
    // so a diagram or formula pasted right before exporting doesn't
    // export as raw source.
    await window.MDE.flushPreviewRenders?.();

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

  async function printDocument() {
    // Same reasoning as exportAs()'s txt/html/pdf branches — an in-flight
    // mermaid/math render triggered by a very recent edit shouldn't still
    // be showing its placeholder when the print dialog opens.
    await window.MDE.flushPreviewRenders?.();
    window.print();
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
    const customCssBlock = rawCustomCss ? `<style>${rawCustomCss.replace(/<\/style/gi, "<\\/style")}</style>` : "";
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

  // Dynamically imported (not a top-level import) — html2pdf.js bundles
  // jsPDF + html2canvas, several hundred KB that only ever matter for
  // this one occasional export action, not the initial page load.
  async function exportPdf(base: string) {
    const { default: html2pdf } = await import("html2pdf.js");
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
    // Editor text with any ![](refName) image references inlined back to
    // their real data URIs — what gets published to a Gist, since a Gist
    // needs to stand on its own outside this app.
    getResolvedContent() {
      const doc = getActiveDoc();
      const resolved = resolveDiagramRefs(resolveImageRefs(cm.state.doc.toString(), doc), doc?.diagrams);
      return serializeCitationsBlock(doc, serializeMetadataBlock(doc?.metadata ?? [], resolved));
    },
    setDocImage(key, dataUrl) {
      setDocImage(key, dataUrl);
      window.MDE.updatePreview?.();
    },
    onImageAdded: null,
    // Called by collab.ts when a collaborator renames a shared document
    // (its Y.Doc "meta" map changed remotely). Re-applies the same
    // global-uniqueness rule createDoc/importRemoteDocs use rather than
    // trusting the incoming name as-is — a remote rename that happens to
    // collide with an unrelated local document must not silently break
    // wikilink resolution's exact-match assumption.
    setDocName(id, name) {
      const finalName = ensureUniqueName(name || "Untitled", get(docsStore), id);
      renameDoc(id, finalName);
      persistDocs();
      if (getActiveDoc()?.id === id) {
        (document.getElementById("docTitle") as HTMLInputElement).value = finalName;
        resizeDocTitle();
        updatePageTitle(finalName);
      }
    },
    onDocRenamed: null,
    setDocMetadata(id, metadata) {
      if (getActiveDoc()?.id !== id) return;
      setActiveDocMetadata(metadata);
    },
    onDocMetadataChanged: null,
    setDocCitations(id, citations) {
      if (getActiveDoc()?.id !== id) return;
      setActiveDocCitations(citations);
    },
    onDocCitationsChanged: null,
    toggleDropdown,
    closeAllDropdowns,
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
    cutSelection: menuClipboardCut,
    copySelection: menuClipboardCopy,
    pasteClipboard: menuClipboardPaste,
    newDoc: createNewDoc,
    openLocalFile() {
      if (get(workspacesStore).length === 0) {
        showToast("Create a workspace first", "error");
        return;
      }
      document.getElementById("importInput").click();
    },
    exportAs,
    printDocument,
    toggleSidebar,
    collapseSidebarForMobile,
    openImagesManager() {
      imagesModalOpen.set(true);
    },
    openShortcuts() {
      shortcutsModalOpen.set(true);
    },
    openAbout() {
      aboutModalOpen.set(true);
    },
    openDiagramEditor() {
      diagramEditorRef.set(null);
      diagramEditorOpen.set(true);
    },
    formatRelativeTime,
  };
  window.MDE = bridge;
})();
