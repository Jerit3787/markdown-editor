<script lang="ts">
  import { onMount } from "svelte";
  import { docsStore, activeIdStore, deleteDoc } from "../stores/docs";
  import { githubUsername } from "../stores/github";
  import { gistBusyLabel } from "../stores/gist";
  import { viewMode, viewModeLocked, isEditorOn, isPreviewOn, toggleEditorPane, togglePreviewPane } from "../stores/view";
  import { focusMode } from "../stores/focusMode";
  import { whatsNewOpen } from "../stores/whatsNew";
  import { versionHistoryOpen } from "../stores/versionHistory";
  import { commentsPanelOpen, unresolvedCommentCount } from "../stores/commentsPanel";
  import { pendingSuggestionCount } from "../stores/suggestions";
  import { docInfoPanelOpen } from "../stores/docInfoPanel";
  import { workspacesStore, activeWorkspaceIdStore } from "../stores/workspaces";
  import { repoSyncBusyLabel } from "../stores/repoSync";
  import { openFindBar } from "../stores/findReplace";

  let fileMenuBtn: HTMLButtonElement, fileMenu: HTMLDivElement;
  let editMenuBtn: HTMLButtonElement, editMenu: HTMLDivElement;
  let formatMenuBtn: HTMLButtonElement, formatMenu: HTMLDivElement;
  let insertMenuBtn: HTMLButtonElement, insertMenu: HTMLDivElement;
  let viewMenuBtn: HTMLButtonElement, viewMenu: HTMLDivElement;
  let helpMenuBtn: HTMLButtonElement, helpMenu: HTMLDivElement;

  const activeDoc = $derived($docsStore.find((d) => d.id === $activeIdStore));
  const hasActiveDoc = $derived(!!activeDoc);
  const hasWorkspace = $derived($workspacesStore.length > 0);
  const hasGist = $derived(!!activeDoc?.gistId);
  const gistLabel = $derived($gistBusyLabel ?? (hasGist ? "Update Gist" : "Publish to Gist"));
  const gistBusy = $derived($gistBusyLabel !== null);
  const recentDocs = $derived([...$docsStore].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8));
  const viewEditorOn = $derived(isEditorOn($viewMode));
  const viewPreviewOn = $derived(isPreviewOn($viewMode));
  const activeWorkspace = $derived($workspacesStore.find((w) => w.id === $activeWorkspaceIdStore));
  const hasRepoLink = $derived(!!activeWorkspace?.repoLink);
  const repoLinkLabel = $derived(activeWorkspace?.repoLink ? `${activeWorkspace.repoLink.owner}/${activeWorkspace.repoLink.repo}` : "");
  const repoLastSyncedLabel = $derived(activeWorkspace?.repoLastSyncedAt ? `Synced ${window.MDE.formatRelativeTime(activeWorkspace.repoLastSyncedAt)}` : "");

  // #suggestionsBtn/#suggestionsBadge are plain HTML (index.html), not this
  // component's own markup — same reasoning as CommentsPanel.svelte's own
  // #commentsBtn/#commentsBadge sync. No dedicated "suggestions panel"
  // component exists to own this (unlike comments), so it lives here on
  // MenuBar, which is always mounted regardless of active document.
  $effect(() => {
    const btn = document.getElementById("suggestionsBtn");
    const badge = document.getElementById("suggestionsBadge");
    if (!btn || !badge) return;
    const count = $pendingSuggestionCount;
    btn.hidden = count === 0;
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? "99+" : String(count);
  });

  // Every action below closes the menu it came from afterward — matching
  // the old per-menu closeFileMenu()/closeEditMenu()/etc., which
  // window.MDE.closeAllDropdowns() covers just as well since only one
  // top-level menu is ever open at a time (toggleDropdown enforces that).
  function act(fn: () => void) {
    fn();
    window.MDE.closeAllDropdowns();
  }

  function formatCmd(cmd: string) {
    window.MDE.runCmd(cmd);
    window.MDE.getEditor().focus();
  }

  onMount(() => {
    // Reuses app.ts's exact, already-proven dropdown/submenu/hover-switch
    // mechanics (see window.MDE) against these Svelte-rendered elements —
    // same DOM shape as the markup they replace, just sourced via bind:this
    // instead of getElementById.
    const pairs = [
      { btn: fileMenuBtn, menu: fileMenu },
      { btn: editMenuBtn, menu: editMenu },
      { btn: formatMenuBtn, menu: formatMenu },
      { btn: insertMenuBtn, menu: insertMenu },
      { btn: viewMenuBtn, menu: viewMenu },
      { btn: helpMenuBtn, menu: helpMenu },
    ];
    pairs.forEach(({ btn, menu }) => window.MDE.toggleDropdown(btn, menu));
    window.MDE.enableMenuBarHoverSwitch(pairs);
    window.MDE.initSubmenus(fileMenu);
  });
</script>

<nav id="menuBar" class="topbar-row" aria-label="Main menu">
  <div class="dropdown">
    <button bind:this={fileMenuBtn} id="fileMenuBtn" class="menubar-btn" type="button">File</button>
    <div bind:this={fileMenu} id="fileMenu" class="dropdown-menu menubar-menu">
      <button id="menuNewDoc" type="button" disabled={!hasWorkspace} onclick={() => act(() => window.MDE.newDoc())}>
        <svg class="icon"><use href="#icon-file-plus"></use></svg> New document
      </button>

      <div class="menu-submenu">
        <button class="menu-submenu-trigger" type="button">
          <svg class="icon"><use href="#icon-upload"></use></svg> Open <svg class="icon menu-chevron"><use href="#icon-chevron-right"></use></svg>
        </button>
        <div class="menu-submenu-panel">
          <button id="menuOpenLocal" type="button" onclick={() => act(() => window.MDE.openLocalFile())}>
            <svg class="icon"><use href="#icon-upload"></use></svg> From this device
          </button>
          <input id="importInput" type="file" accept=".md,.markdown,.txt" hidden>
          <div class="menu-divider"></div>
          <button id="menuOpenGist" type="button" onclick={() => act(() => window.MDE.openGistPicker?.())}>
            <svg class="icon"><use href="#icon-github"></use></svg> From GitHub Gist...
          </button>
          <button id="menuOpenRepo" type="button" onclick={() => act(() => window.MDE.openRepoModal?.())}>
            <svg class="icon"><use href="#icon-github"></use></svg> From GitHub Repo...
          </button>
        </div>
      </div>

      <div class="menu-submenu">
        <button class="menu-submenu-trigger" type="button">
          <svg class="icon"><use href="#icon-history"></use></svg> Open Recent <svg class="icon menu-chevron"><use href="#icon-chevron-right"></use></svg>
        </button>
        <div class="menu-submenu-panel">
          {#each recentDocs as doc (doc.id)}
            <button type="button" class="menu-recent-item" onclick={() => act(() => window.MDE.switchDoc(doc.id))}>
              <span class="menu-recent-name">{doc.name || "Untitled"}</span>
              <span class="menu-recent-time">{window.MDE.formatRelativeTime(doc.updatedAt)}</span>
            </button>
          {:else}
            <div class="menu-recent-empty">No documents yet.</div>
          {/each}
        </div>
      </div>

      <div class="menu-divider"></div>
      <!-- Signed out: plain button, click opens a sign-in prompt. Signed
           in: submenu with the publish action + a link to the live gist.
           Both always exist (toggled via hidden, not {#if}) so the
           submenu's flyout trigger is wired once by initSubmenus at
           mount, regardless of which one is visible when that runs. -->
      <button id="menuPublishSignedOut" type="button" disabled={!hasActiveDoc} hidden={!!$githubUsername} onclick={() => act(() => window.MDE.requireGithubSignIn("Publishing to Gist needs a connected GitHub account. Sign in to continue."))}>
        <svg class="icon"><use href="#icon-rocket"></use></svg> Publish to Gist
      </button>
      <div class="menu-submenu" id="publishSubmenu" hidden={!$githubUsername}>
        <button class="menu-submenu-trigger" type="button" disabled={!hasActiveDoc}>
          <svg class="icon"><use href="#icon-rocket"></use></svg> Publish <svg class="icon menu-chevron"><use href="#icon-chevron-right"></use></svg>
        </button>
        <div class="menu-submenu-panel">
          <button id="menuPublishGist" type="button" disabled={gistBusy || !hasActiveDoc} onclick={() => act(() => window.MDE.publishGist?.())}>
            <svg class="icon"><use href="#icon-github"></use></svg> <span id="menuGistLabel">{gistLabel}</span>
          </button>
          <a id="gistViewLink" class="menu-link-item" href={hasGist ? `https://gist.github.com/${activeDoc?.gistId}` : "#"} target="_blank" rel="noopener" hidden={!hasGist}>
            <svg class="icon"><use href="#icon-external-link"></use></svg> View Gist
          </a>
        </div>
      </div>

      <div class="menu-submenu">
        <button class="menu-submenu-trigger" type="button" disabled={!hasWorkspace}>
          <svg class="icon"><use href="#icon-github"></use></svg> GitHub Repo <svg class="icon menu-chevron"><use href="#icon-chevron-right"></use></svg>
        </button>
        <div class="menu-submenu-panel">
          {#if !hasRepoLink}
            <button type="button" onclick={() => act(() => window.MDE.openRepoLinkModal?.())}>
              <svg class="icon"><use href="#icon-github"></use></svg> Link Workspace to Repo...
            </button>
          {:else}
            <div class="menu-section-label">{repoLinkLabel}</div>
            {#if repoLastSyncedLabel}
              <div class="menu-section-label menu-section-sublabel">{repoLastSyncedLabel}</div>
            {/if}
            <button type="button" disabled={!!$repoSyncBusyLabel} onclick={() => act(() => window.MDE.pullFromRepoAction?.())}>
              <svg class="icon"><use href="#icon-download"></use></svg> {$repoSyncBusyLabel === "Pulling…" ? "Pulling…" : "Pull from Repo"}
            </button>
            <button type="button" disabled={!!$repoSyncBusyLabel} onclick={() => act(() => window.MDE.pushToRepoAction?.())}>
              <svg class="icon"><use href="#icon-upload"></use></svg> {$repoSyncBusyLabel === "Pushing…" ? "Pushing…" : "Push to Repo"}
            </button>
            <button type="button" onclick={() => act(() => window.MDE.unlinkRepo?.())}>
              <svg class="icon"><use href="#icon-x"></use></svg> Unlink Repo
            </button>
          {/if}
        </div>
      </div>

      <div class="menu-divider"></div>
      <div class="menu-submenu">
        <button class="menu-submenu-trigger" type="button" disabled={!hasActiveDoc}>
          <svg class="icon"><use href="#icon-download"></use></svg> Export <svg class="icon menu-chevron"><use href="#icon-chevron-right"></use></svg>
        </button>
        <div class="menu-submenu-panel">
          <button type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.exportAs("md"))}><svg class="icon"><use href="#icon-download"></use></svg> Markdown (.md)</button>
          <button type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.exportAs("html"))}><svg class="icon"><use href="#icon-download"></use></svg> HTML (.html)</button>
          <button type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.exportAs("pdf"))}><svg class="icon"><use href="#icon-download"></use></svg> PDF (.pdf)</button>
          <button type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.exportAs("txt"))}><svg class="icon"><use href="#icon-download"></use></svg> Plain text (.txt)</button>
        </div>
      </div>

      <div class="menu-divider"></div>
      <button type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.printDocument())}>
        <svg class="icon"><use href="#icon-printer"></use></svg> Print
      </button>

      <div class="menu-divider"></div>
      <button id="menuComments" type="button" disabled={!hasActiveDoc} onclick={() => act(() => commentsPanelOpen.set(true))}>
        <svg class="icon"><use href="#icon-message-square"></use></svg> Comments
        {#if $unresolvedCommentCount > 0}
          <span class="menu-badge">{$unresolvedCommentCount > 99 ? "99+" : $unresolvedCommentCount}</span>
        {/if}
      </button>

      <div class="menu-divider"></div>
      <button id="menuVersionHistory" type="button" disabled={!hasActiveDoc} onclick={() => act(() => versionHistoryOpen.set(true))}>
        <svg class="icon"><use href="#icon-history"></use></svg> Version history
      </button>

      <div class="menu-divider"></div>
      <button id="menuDocInfo" type="button" disabled={!hasActiveDoc} onclick={() => act(() => docInfoPanelOpen.set(true))}>
        <svg class="icon"><use href="#icon-info"></use></svg> Document info
      </button>

      <div class="menu-divider"></div>
      <button id="menuDeleteDoc" type="button" disabled={!hasActiveDoc} onclick={() => act(() => deleteDoc($activeIdStore ?? ""))}>
        <svg class="icon"><use href="#icon-trash-2"></use></svg> Delete document
      </button>
    </div>
  </div>

  <div class="dropdown">
    <button bind:this={editMenuBtn} id="editMenuBtn" class="menubar-btn" type="button">Edit</button>
    <div bind:this={editMenu} id="editMenu" class="dropdown-menu menubar-menu">
      <button id="menuUndo" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.undo())}><svg class="icon"><use href="#icon-undo-2"></use></svg> Undo <kbd>Ctrl+Z</kbd></button>
      <button id="menuRedo" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.redo())}><svg class="icon"><use href="#icon-redo-2"></use></svg> Redo <kbd>Ctrl+Shift+Z</kbd></button>
      <div class="menu-divider"></div>
      <button id="menuFind" type="button" disabled={!hasActiveDoc} onclick={() => act(() => openFindBar("find"))}><svg class="icon"><use href="#icon-search"></use></svg> Find... <kbd>Ctrl+F</kbd></button>
      <button id="menuFindReplace" type="button" disabled={!hasActiveDoc} onclick={() => act(() => openFindBar("replace"))}><svg class="icon"><use href="#icon-search"></use></svg> Find and Replace... <kbd>Ctrl+H</kbd></button>
      <div class="menu-divider"></div>
      <button id="menuCut" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.cutSelection())}><svg class="icon"><use href="#icon-scissors"></use></svg> Cut <kbd>Ctrl+X</kbd></button>
      <button id="menuCopy" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.copySelection())}><svg class="icon"><use href="#icon-copy"></use></svg> Copy <kbd>Ctrl+C</kbd></button>
      <button id="menuPaste" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.pasteClipboard())}><svg class="icon"><use href="#icon-clipboard"></use></svg> Paste <kbd>Ctrl+V</kbd></button>
    </div>
  </div>

  <div class="dropdown">
    <button bind:this={formatMenuBtn} id="formatMenuBtn" class="menubar-btn" type="button">Format</button>
    <div bind:this={formatMenu} id="formatMenu" class="dropdown-menu menubar-menu">
      <button id="menuBold" type="button" class="menu-glyph-btn" disabled={!hasActiveDoc} onclick={() => act(() => formatCmd("bold"))}><b>B</b> Bold <kbd>Ctrl+B</kbd></button>
      <button id="menuItalic" type="button" class="menu-glyph-btn" disabled={!hasActiveDoc} onclick={() => act(() => formatCmd("italic"))}><i>I</i> Italic <kbd>Ctrl+I</kbd></button>
      <button id="menuStrike" type="button" disabled={!hasActiveDoc} onclick={() => act(() => formatCmd("strike"))}><svg class="icon"><use href="#icon-strikethrough"></use></svg> Strikethrough</button>
    </div>
  </div>

  <div class="dropdown">
    <button bind:this={insertMenuBtn} id="insertMenuBtn" class="menubar-btn" type="button">Insert</button>
    <div bind:this={insertMenu} id="insertMenu" class="dropdown-menu menubar-menu">
      <button id="menuLink" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.runCmd("link"))}><svg class="icon"><use href="#icon-link"></use></svg> Insert Link... <kbd>Ctrl+K</kbd></button>
      <button id="menuImage" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.runCmd("image"))}><svg class="icon"><use href="#icon-image"></use></svg> Insert Image...</button>
      <button id="menuManageImages" type="button" disabled={!hasActiveDoc} onclick={() => act(() => window.MDE.openImagesManager())}><svg class="icon"><use href="#icon-images"></use></svg> Manage Images...</button>
    </div>
  </div>

  <div class="dropdown">
    <button bind:this={viewMenuBtn} id="viewMenuBtn" class="menubar-btn" type="button">View</button>
    <div bind:this={viewMenu} id="viewMenu" class="dropdown-menu menubar-menu">
      {#if !$viewModeLocked}
        <button class="menu-view-btn" class:active={viewEditorOn} type="button" onclick={() => act(toggleEditorPane)}>
          <svg class="icon menu-check"><use href="#icon-check"></use></svg> Editor pane
        </button>
        <button class="menu-view-btn" class:active={viewPreviewOn} type="button" onclick={() => act(togglePreviewPane)}>
          <svg class="icon menu-check"><use href="#icon-check"></use></svg> Preview pane
        </button>
      {/if}
      <div class="menu-divider"></div>
      <button id="menuToggleSidebar" type="button" onclick={() => act(() => window.MDE.toggleSidebar())}>
        <svg class="icon"><use href="#icon-panel-left"></use></svg> Toggle Sidebar
      </button>
      <div class="menu-divider"></div>
      <button class="menu-view-btn" class:active={$focusMode} type="button" onclick={() => act(() => focusMode.update((v) => !v))}>
        <svg class="icon menu-check"><use href="#icon-check"></use></svg> Focus Mode
      </button>
    </div>
  </div>

  <div class="dropdown">
    <button bind:this={helpMenuBtn} id="helpMenuBtn" class="menubar-btn" type="button">Help</button>
    <div bind:this={helpMenu} id="helpMenu" class="dropdown-menu menubar-menu">
      <button id="menuCommandPalette" type="button" onclick={() => act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true, shiftKey: true })))}>
        <svg class="icon"><use href="#icon-search"></use></svg> Command Palette <kbd>Ctrl+Shift+P</kbd>
      </button>
      <button id="menuShortcuts" type="button" onclick={() => act(() => window.MDE.openShortcuts())}>
        <svg class="icon"><use href="#icon-keyboard"></use></svg> Keyboard Shortcuts
      </button>
      <button id="menuInfo" type="button" onclick={() => act(() => window.MDE.openAbout())}>
        <svg class="icon"><use href="#icon-info"></use></svg> About &amp; Privacy
      </button>
      <button type="button" onclick={() => act(() => whatsNewOpen.set(true))}>
        <svg class="icon"><use href="#icon-rocket"></use></svg> What's New
      </button>
      <a class="menu-link-item" href="https://github.com/Jerit3787/markdown-editor" target="_blank" rel="noopener">
        <svg class="icon"><use href="#icon-github"></use></svg> View Source on GitHub
      </a>
    </div>
  </div>

</nav>
