<script lang="ts">
  import { onMount } from "svelte";
  import { docsStore, activeIdStore, deleteDoc } from "../stores/docs";
  import { githubUsername } from "../stores/github";
  import { gistBusyLabel } from "../stores/gist";
  import { viewMode } from "../stores/view";
  import { focusMode } from "../stores/focusMode";
  import { diagramEditorOpen, diagramEditorRef } from "../stores/diagramEditor";
  import { fuzzyScore } from "../fuzzy-match";

  interface PaletteCommand {
    id: string;
    label: string;
    category: string;
    run: () => void;
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
    { id: "bold", label: "Bold", category: "Format", run: () => window.MDE.runCmd("bold") },
    { id: "italic", label: "Italic", category: "Format", run: () => window.MDE.runCmd("italic") },
    { id: "strike", label: "Strikethrough", category: "Format", run: () => window.MDE.runCmd("strike") },
    { id: "h1", label: "Heading 1", category: "Format", run: () => window.MDE.runCmd("h1") },
    { id: "h2", label: "Heading 2", category: "Format", run: () => window.MDE.runCmd("h2") },
    { id: "h3", label: "Heading 3", category: "Format", run: () => window.MDE.runCmd("h3") },
    { id: "quote", label: "Blockquote", category: "Format", run: () => window.MDE.runCmd("quote") },
    { id: "code", label: "Inline code", category: "Format", run: () => window.MDE.runCmd("code") },
    { id: "codeblock", label: "Code block", category: "Format", run: () => window.MDE.runCmd("codeblock") },
    { id: "ul", label: "Bullet list", category: "Format", run: () => window.MDE.runCmd("ul") },
    { id: "ol", label: "Numbered list", category: "Format", run: () => window.MDE.runCmd("ol") },
    { id: "task", label: "Task list", category: "Format", run: () => window.MDE.runCmd("task") },
    { id: "table", label: "Table", category: "Format", run: () => window.MDE.runCmd("table") },
    { id: "hr", label: "Horizontal rule", category: "Format", run: () => window.MDE.runCmd("hr") },
    { id: "link", label: "Insert link", category: "Format", run: () => window.MDE.runCmd("link") },
    { id: "image", label: "Insert image", category: "Format", run: () => window.MDE.runCmd("image") },
    { id: "math", label: "Math", category: "Format", run: () => window.MDE.runCmd("math") },
    { id: "footnote", label: "Footnote", category: "Format", run: () => window.MDE.runCmd("footnote") },
    // Insert
    { id: "diagram", label: "Insert diagram", category: "Insert", run: () => { diagramEditorRef.set(null); diagramEditorOpen.set(true); } },
    { id: "manage-images", label: "Manage images", category: "Insert", run: () => window.MDE.openImagesManager() },
    // File
    { id: "new-doc", label: "New document", category: "File", run: () => window.MDE.newDoc() },
    { id: "open-local", label: "Open from device", category: "File", run: () => window.MDE.openLocalFile() },
    { id: "open-gist", label: "Open from GitHub Gist", category: "File", run: () => window.MDE.openGistPicker?.() },
    { id: "delete-doc", label: "Delete document", category: "File", run: () => deleteDoc($activeIdStore ?? "") },
    {
      id: "publish-gist",
      label: $githubUsername ? gistLabel : "Publish to Gist",
      category: "File",
      run: () => {
        if (gistBusy) return;
        if (!$githubUsername) window.MDE.requireGithubSignIn("Publishing to Gist needs a connected GitHub account. Sign in to continue.");
        else window.MDE.publishGist?.();
      },
    },
    // Export
    { id: "export-md", label: "Export as Markdown", category: "Export", run: () => window.MDE.exportAs("md") },
    { id: "export-html", label: "Export as HTML", category: "Export", run: () => window.MDE.exportAs("html") },
    { id: "export-pdf", label: "Export as PDF", category: "Export", run: () => window.MDE.exportAs("pdf") },
    { id: "export-txt", label: "Export as Plain text", category: "Export", run: () => window.MDE.exportAs("txt") },
    // View
    { id: "view-editor", label: "Switch to Editor view", category: "View", run: () => window.MDE.setView("editor") },
    { id: "view-split", label: "Switch to Split view", category: "View", run: () => window.MDE.setView("split") },
    { id: "view-preview", label: "Switch to Preview view", category: "View", run: () => window.MDE.setView("preview") },
    { id: "toggle-sidebar", label: "Toggle Sidebar", category: "View", run: () => window.MDE.toggleSidebar() },
    { id: "toggle-focus", label: $focusMode ? "Turn off Focus Mode" : "Turn on Focus Mode", category: "View", run: () => window.MDE.toggleFocusMode() },
    // Edit
    { id: "undo", label: "Undo", category: "Edit", run: () => window.MDE.undo() },
    { id: "redo", label: "Redo", category: "Edit", run: () => window.MDE.redo() },
    { id: "cut", label: "Cut", category: "Edit", run: () => window.MDE.cutSelection() },
    { id: "copy", label: "Copy", category: "Edit", run: () => window.MDE.copySelection() },
    { id: "paste", label: "Paste", category: "Edit", run: () => window.MDE.pasteClipboard() },
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
          <p class="modal-hint">No matching commands or documents.</p>
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
