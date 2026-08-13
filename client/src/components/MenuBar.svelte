<script lang="ts">
  import { onMount } from "svelte";
  import { docsStore, activeIdStore, deleteDoc } from "../stores/docs";
  import { githubUsername } from "../stores/github";
  import { gistBusyLabel } from "../stores/gist";
  import { viewMode } from "../stores/view";
  import { focusMode } from "../stores/focusMode";
  import { whatsNewOpen } from "../stores/whatsNew";
  import { versionHistoryOpen } from "../stores/versionHistory";

  let fileMenuBtn: HTMLButtonElement, fileMenu: HTMLDivElement;
  let editMenuBtn: HTMLButtonElement, editMenu: HTMLDivElement;
  let viewMenuBtn: HTMLButtonElement, viewMenu: HTMLDivElement;
  let helpMenuBtn: HTMLButtonElement, helpMenu: HTMLDivElement;

  const activeDoc = $derived($docsStore.find((d) => d.id === $activeIdStore));
  const hasGist = $derived(!!activeDoc?.gistId);
  const gistLabel = $derived($gistBusyLabel ?? (hasGist ? "Update Gist" : "Publish to Gist"));
  const gistBusy = $derived($gistBusyLabel !== null);
  const recentDocs = $derived([...$docsStore].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8));

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
      <button id="menuNewDoc" type="button" onclick={() => act(() => window.MDE.newDoc())}>
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
      <button id="menuPublishSignedOut" type="button" hidden={!!$githubUsername} onclick={() => act(() => window.MDE.requireGithubSignIn("Publishing to Gist needs a connected GitHub account. Sign in to continue."))}>
        <svg class="icon"><use href="#icon-rocket"></use></svg> Publish to Gist
      </button>
      <div class="menu-submenu" id="publishSubmenu" hidden={!$githubUsername}>
        <button class="menu-submenu-trigger" type="button">
          <svg class="icon"><use href="#icon-rocket"></use></svg> Publish <svg class="icon menu-chevron"><use href="#icon-chevron-right"></use></svg>
        </button>
        <div class="menu-submenu-panel">
          <button id="menuPublishGist" type="button" disabled={gistBusy} onclick={() => act(() => window.MDE.publishGist?.())}>
            <svg class="icon"><use href="#icon-github"></use></svg> <span id="menuGistLabel">{gistLabel}</span>
          </button>
          <a id="gistViewLink" class="menu-link-item" href={hasGist ? `https://gist.github.com/${activeDoc?.gistId}` : "#"} target="_blank" rel="noopener" hidden={!hasGist}>
            <svg class="icon"><use href="#icon-external-link"></use></svg> View Gist
          </a>
        </div>
      </div>

      <div class="menu-divider"></div>
      <div class="menu-submenu">
        <button class="menu-submenu-trigger" type="button">
          <svg class="icon"><use href="#icon-download"></use></svg> Export <svg class="icon menu-chevron"><use href="#icon-chevron-right"></use></svg>
        </button>
        <div class="menu-submenu-panel">
          <button type="button" onclick={() => act(() => window.MDE.exportAs("md"))}><svg class="icon"><use href="#icon-download"></use></svg> Markdown (.md)</button>
          <button type="button" onclick={() => act(() => window.MDE.exportAs("html"))}><svg class="icon"><use href="#icon-download"></use></svg> HTML (.html)</button>
          <button type="button" onclick={() => act(() => window.MDE.exportAs("pdf"))}><svg class="icon"><use href="#icon-download"></use></svg> PDF (.pdf)</button>
          <button type="button" onclick={() => act(() => window.MDE.exportAs("txt"))}><svg class="icon"><use href="#icon-download"></use></svg> Plain text (.txt)</button>
        </div>
      </div>

      <div class="menu-divider"></div>
      <button id="menuVersionHistory" type="button" onclick={() => act(() => versionHistoryOpen.set(true))}>
        <svg class="icon"><use href="#icon-history"></use></svg> Version history
      </button>

      <div class="menu-divider"></div>
      <button id="menuDeleteDoc" type="button" onclick={() => act(() => deleteDoc($activeIdStore ?? ""))}>
        <svg class="icon"><use href="#icon-trash-2"></use></svg> Delete document
      </button>
    </div>
  </div>

  <div class="dropdown">
    <button bind:this={editMenuBtn} id="editMenuBtn" class="menubar-btn" type="button">Edit</button>
    <div bind:this={editMenu} id="editMenu" class="dropdown-menu menubar-menu">
      <button id="menuUndo" type="button" onclick={() => act(() => window.MDE.undo())}><svg class="icon"><use href="#icon-undo-2"></use></svg> Undo <kbd>Ctrl+Z</kbd></button>
      <button id="menuRedo" type="button" onclick={() => act(() => window.MDE.redo())}><svg class="icon"><use href="#icon-redo-2"></use></svg> Redo <kbd>Ctrl+Shift+Z</kbd></button>
      <div class="menu-divider"></div>
      <button id="menuCut" type="button" onclick={() => act(() => window.MDE.cutSelection())}><svg class="icon"><use href="#icon-scissors"></use></svg> Cut <kbd>Ctrl+X</kbd></button>
      <button id="menuCopy" type="button" onclick={() => act(() => window.MDE.copySelection())}><svg class="icon"><use href="#icon-copy"></use></svg> Copy <kbd>Ctrl+C</kbd></button>
      <button id="menuPaste" type="button" onclick={() => act(() => window.MDE.pasteClipboard())}><svg class="icon"><use href="#icon-clipboard"></use></svg> Paste <kbd>Ctrl+V</kbd></button>
      <div class="menu-divider"></div>
      <button id="menuBold" type="button" class="menu-glyph-btn" onclick={() => act(() => formatCmd("bold"))}><b>B</b> Bold <kbd>Ctrl+B</kbd></button>
      <button id="menuItalic" type="button" class="menu-glyph-btn" onclick={() => act(() => formatCmd("italic"))}><i>I</i> Italic <kbd>Ctrl+I</kbd></button>
      <button id="menuStrike" type="button" onclick={() => act(() => formatCmd("strike"))}><svg class="icon"><use href="#icon-strikethrough"></use></svg> Strikethrough</button>
      <div class="menu-divider"></div>
      <button id="menuLink" type="button" onclick={() => act(() => window.MDE.runCmd("link"))}><svg class="icon"><use href="#icon-link"></use></svg> Insert Link... <kbd>Ctrl+K</kbd></button>
      <button id="menuImage" type="button" onclick={() => act(() => window.MDE.runCmd("image"))}><svg class="icon"><use href="#icon-image"></use></svg> Insert Image...</button>
      <button id="menuManageImages" type="button" onclick={() => act(() => window.MDE.openImagesManager())}><svg class="icon"><use href="#icon-images"></use></svg> Manage Images...</button>
    </div>
  </div>

  <div class="dropdown">
    <button bind:this={viewMenuBtn} id="viewMenuBtn" class="menubar-btn" type="button">View</button>
    <div bind:this={viewMenu} id="viewMenu" class="dropdown-menu menubar-menu">
      <button class="menu-view-btn" class:active={$viewMode === "editor"} type="button" onclick={() => act(() => window.MDE.setView("editor"))}>
        <svg class="icon menu-check"><use href="#icon-check"></use></svg> Editor
      </button>
      <button class="menu-view-btn" class:active={$viewMode === "split"} type="button" onclick={() => act(() => window.MDE.setView("split"))}>
        <svg class="icon menu-check"><use href="#icon-check"></use></svg> Split
      </button>
      <button class="menu-view-btn" class:active={$viewMode === "preview"} type="button" onclick={() => act(() => window.MDE.setView("preview"))}>
        <svg class="icon menu-check"><use href="#icon-check"></use></svg> Preview
      </button>
      <div class="menu-divider"></div>
      <button id="menuToggleSidebar" type="button" onclick={() => act(() => window.MDE.toggleSidebar())}>
        <svg class="icon"><use href="#icon-panel-left"></use></svg> Toggle Sidebar
      </button>
      <div class="menu-divider"></div>
      <button class="menu-view-btn" class:active={$focusMode} type="button" onclick={() => act(() => window.MDE.toggleFocusMode())}>
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

  <div class="spacer"></div>
  <button
    id="expandPreviewBtn"
    class="icon-btn"
    class:active={$viewMode === "preview"}
    type="button"
    title={$viewMode === "preview" ? "Collapse preview" : "Expand preview"}
    aria-label="Expand preview"
    aria-pressed={$viewMode === "preview"}
    onclick={() => window.MDE.toggleExpandPreview()}
  >
    <svg class="icon"><use href="#icon-panel-right"></use></svg>
  </button>
</nav>
