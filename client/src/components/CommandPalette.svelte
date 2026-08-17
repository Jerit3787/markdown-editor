<script lang="ts">
  import { onMount } from "svelte";
  import { docsStore, activeIdStore, deleteDoc } from "../stores/docs";
  import { githubUsername } from "../stores/github";
  import { gistBusyLabel } from "../stores/gist";
  import { viewMode } from "../stores/view";
  import { focusMode } from "../stores/focusMode";
  import { diagramEditorOpen, diagramEditorRef } from "../stores/diagramEditor";
  import { workspacesStore } from "../stores/workspaces";
  import { fuzzyScore } from "../fuzzy-match";

  interface PaletteCommand {
    id: string;
    label: string;
    category: string;
    run: () => void;
    // Mirrors the same disabled={...} conditions MenuBar.svelte's
    // equivalent buttons already use — "doc" for anything that acts on
    // the current document/editor, "workspace" for anything that needs
    // somewhere to put a new document. Palette entries don't render a
    // visible disabled state (unlike menu buttons), so unmet
    // requirements are hidden from the results entirely instead.
    requires?: "doc" | "workspace";
  }

  interface PaletteEntry {
    kind: "document" | "command";
    id: string;
    label: string;
    sublabel?: string;
    score: number;
    run: () => void;
  }

  let hidden = $state(true);
  let query = $state("");
  let selectedIndex = $state(0);
  let inputEl: HTMLInputElement;

  const activeDoc = $derived($docsStore.find((d) => d.id === $activeIdStore));
  const hasActiveDoc = $derived(!!activeDoc);
  const hasWorkspace = $derived($workspacesStore.length > 0);
  const hasGist = $derived(!!activeDoc?.gistId);
  const gistLabel = $derived($gistBusyLabel ?? (hasGist ? "Update Gist" : "Publish to Gist"));
  const gistBusy = $derived($gistBusyLabel !== null);

  function run(fn: () => void) {
    fn();
    close();
  }

  // Thin wrappers around the exact same window.MDE.* calls
  // Toolbar.svelte/MenuBar.svelte already use — no new application
  // behavior, just a new way to reach it.
  const commands = $derived.by((): PaletteCommand[] => [
    // Format
    { id: "bold", label: "Bold", category: "Format", run: () => window.MDE.runCmd("bold"), requires: "doc" },
    { id: "italic", label: "Italic", category: "Format", run: () => window.MDE.runCmd("italic"), requires: "doc" },
    { id: "strike", label: "Strikethrough", category: "Format", run: () => window.MDE.runCmd("strike"), requires: "doc" },
    { id: "h1", label: "Heading 1", category: "Format", run: () => window.MDE.runCmd("h1"), requires: "doc" },
    { id: "h2", label: "Heading 2", category: "Format", run: () => window.MDE.runCmd("h2"), requires: "doc" },
    { id: "h3", label: "Heading 3", category: "Format", run: () => window.MDE.runCmd("h3"), requires: "doc" },
    { id: "quote", label: "Blockquote", category: "Format", run: () => window.MDE.runCmd("quote"), requires: "doc" },
    { id: "code", label: "Inline code", category: "Format", run: () => window.MDE.runCmd("code"), requires: "doc" },
    { id: "codeblock", label: "Code block", category: "Format", run: () => window.MDE.runCmd("codeblock"), requires: "doc" },
    { id: "ul", label: "Bullet list", category: "Format", run: () => window.MDE.runCmd("ul"), requires: "doc" },
    { id: "ol", label: "Numbered list", category: "Format", run: () => window.MDE.runCmd("ol"), requires: "doc" },
    { id: "task", label: "Task list", category: "Format", run: () => window.MDE.runCmd("task"), requires: "doc" },
    { id: "table", label: "Table", category: "Format", run: () => window.MDE.runCmd("table"), requires: "doc" },
    { id: "hr", label: "Horizontal rule", category: "Format", run: () => window.MDE.runCmd("hr"), requires: "doc" },
    { id: "link", label: "Insert link", category: "Format", run: () => window.MDE.runCmd("link"), requires: "doc" },
    { id: "image", label: "Insert image", category: "Format", run: () => window.MDE.runCmd("image"), requires: "doc" },
    { id: "math", label: "Math", category: "Format", run: () => window.MDE.runCmd("math"), requires: "doc" },
    { id: "footnote", label: "Footnote", category: "Format", run: () => window.MDE.runCmd("footnote"), requires: "doc" },
    // Insert
    { id: "diagram", label: "Insert diagram", category: "Insert", run: () => { diagramEditorRef.set(null); diagramEditorOpen.set(true); }, requires: "doc" },
    { id: "manage-images", label: "Manage images", category: "Insert", run: () => window.MDE.openImagesManager(), requires: "doc" },
    // File
    { id: "new-doc", label: "New document", category: "File", run: () => window.MDE.newDoc(), requires: "workspace" },
    { id: "open-local", label: "Open from device", category: "File", run: () => window.MDE.openLocalFile() },
    { id: "open-gist", label: "Open from GitHub Gist", category: "File", run: () => window.MDE.openGistPicker?.() },
    { id: "delete-doc", label: "Delete document", category: "File", run: () => deleteDoc($activeIdStore ?? ""), requires: "doc" },
    {
      id: "publish-gist",
      label: $githubUsername ? gistLabel : "Publish to Gist",
      category: "File",
      run: () => {
        if (gistBusy) return;
        if (!$githubUsername) window.MDE.requireGithubSignIn("Publishing to Gist needs a connected GitHub account. Sign in to continue.");
        else window.MDE.publishGist?.();
      },
      requires: "doc",
    },
    // Export
    { id: "export-md", label: "Export as Markdown", category: "Export", run: () => window.MDE.exportAs("md"), requires: "doc" },
    { id: "export-html", label: "Export as HTML", category: "Export", run: () => window.MDE.exportAs("html"), requires: "doc" },
    { id: "export-pdf", label: "Export as PDF", category: "Export", run: () => window.MDE.exportAs("pdf"), requires: "doc" },
    { id: "export-txt", label: "Export as Plain text", category: "Export", run: () => window.MDE.exportAs("txt"), requires: "doc" },
    // View
    { id: "view-editor", label: "Switch to Editor view", category: "View", run: () => window.MDE.setView("editor") },
    { id: "view-split", label: "Switch to Split view", category: "View", run: () => window.MDE.setView("split") },
    { id: "view-preview", label: "Switch to Preview view", category: "View", run: () => window.MDE.setView("preview") },
    { id: "toggle-sidebar", label: "Toggle Sidebar", category: "View", run: () => window.MDE.toggleSidebar() },
    { id: "toggle-focus", label: $focusMode ? "Turn off Focus Mode" : "Turn on Focus Mode", category: "View", run: () => window.MDE.toggleFocusMode() },
    // Edit
    { id: "undo", label: "Undo", category: "Edit", run: () => window.MDE.undo(), requires: "doc" },
    { id: "redo", label: "Redo", category: "Edit", run: () => window.MDE.redo(), requires: "doc" },
    { id: "cut", label: "Cut", category: "Edit", run: () => window.MDE.cutSelection(), requires: "doc" },
    { id: "copy", label: "Copy", category: "Edit", run: () => window.MDE.copySelection(), requires: "doc" },
    { id: "paste", label: "Paste", category: "Edit", run: () => window.MDE.pasteClipboard(), requires: "doc" },
    // Help
    { id: "shortcuts", label: "Keyboard Shortcuts", category: "Help", run: () => window.MDE.openShortcuts() },
    { id: "about", label: "About & Privacy", category: "Help", run: () => window.MDE.openAbout() },
    { id: "settings", label: "Open Settings", category: "Help", run: () => document.getElementById("settingsBtn")?.click() },
  ]);

  const filteredEntries = $derived.by((): PaletteEntry[] => {
    const docEntries: PaletteEntry[] = $docsStore
      .map((doc) => {
        const label = doc.name || "Untitled";
        const score = fuzzyScore(query, label);
        return score === null ? null : {
          kind: "document" as const,
          id: doc.id,
          label,
          sublabel: window.MDE.formatRelativeTime(doc.updatedAt),
          score,
          run: () => window.MDE.switchDoc(doc.id),
        };
      })
      .filter((e): e is PaletteEntry => e !== null)
      .sort((a, b) => a.score - b.score)
      .slice(0, 8);

    const commandEntries: PaletteEntry[] = commands
      .filter((cmd) => {
        if (cmd.requires === "doc") return hasActiveDoc;
        if (cmd.requires === "workspace") return hasWorkspace;
        return true;
      })
      .map((cmd) => {
        const score = fuzzyScore(query, cmd.label);
        return score === null ? null : {
          kind: "command" as const,
          id: cmd.id,
          label: cmd.label,
          sublabel: cmd.category,
          score,
          run: cmd.run,
        };
      })
      .filter((e): e is PaletteEntry => e !== null)
      .sort((a, b) => a.score - b.score);

    return [...docEntries, ...commandEntries];
  });

  function open() {
    hidden = false;
    query = "";
    selectedIndex = 0;
    // Wait for the input to actually render (it's inside {#if !hidden})
    // before focusing it.
    setTimeout(() => inputEl?.focus(), 0);
  }

  function close() {
    hidden = true;
  }

  function backdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  function onInputKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = filteredEntries.length === 0 ? 0 : (selectedIndex + 1) % filteredEntries.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = filteredEntries.length === 0 ? 0 : (selectedIndex - 1 + filteredEntries.length) % filteredEntries.length;
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = filteredEntries[selectedIndex];
      if (entry) run(entry.run);
    } else if (e.key === "Escape") {
      close();
    }
  }

  onMount(() => {
    const onGlobalKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        open();
      }
    };
    document.addEventListener("keydown", onGlobalKeydown);
    return () => document.removeEventListener("keydown", onGlobalKeydown);
  });
</script>

{#if !hidden}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop command-palette-backdrop" onclick={backdropClick}>
    <div class="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <div class="command-palette-input-row">
        <svg class="icon"><use href="#icon-search"></use></svg>
        <input
          bind:this={inputEl}
          type="text"
          class="command-palette-input"
          placeholder="Search commands or documents..."
          bind:value={query}
          oninput={() => (selectedIndex = 0)}
          onkeydown={onInputKeydown}
        />
      </div>
      <div class="command-palette-results">
        {#if filteredEntries.length === 0}
        <div class="empty-state">
          <svg class="empty-state-icon"><use href="#icon-search"></use></svg>
          <div class="empty-state-title">No results</div>
          <div class="empty-state-desc">No matching commands or documents.</div>
        </div>
        {:else}
          {#each filteredEntries as entry, i (entry.kind + entry.id)}
            {#if i === 0 || filteredEntries[i - 1].kind !== entry.kind}
              <div class="menu-section-label">{entry.kind === "document" ? "Documents" : "Commands"}</div>
            {/if}
            <button
              type="button"
              class="shortcuts-row command-palette-row"
              class:active={i === selectedIndex}
              onclick={() => run(entry.run)}
              onmouseenter={() => (selectedIndex = i)}
            >
              <span>{entry.label}</span>
              {#if entry.sublabel}<kbd>{entry.sublabel}</kbd>{/if}
            </button>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}
