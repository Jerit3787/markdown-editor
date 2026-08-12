<script lang="ts">
  import { slashMenu } from "../stores/slashMenu";
  import { fuzzyScore } from "../fuzzy-match";

  interface SlashCommand {
    id: string;
    label: string;
    run: () => void;
  }

  let selectedIndex = $state(0);

  // Block-level insertions only — matches window.MDE.runCmd(...)'s
  // exact same command IDs Toolbar.svelte/CommandPalette.svelte already
  // use. Deliberately not shared with CommandPalette.svelte's own list
  // (that one also includes inline-formatting commands that don't
  // belong here — see the design doc's Non-goals).
  const commands: SlashCommand[] = [
    { id: "h1", label: "Heading 1", run: () => window.MDE.runCmd("h1") },
    { id: "h2", label: "Heading 2", run: () => window.MDE.runCmd("h2") },
    { id: "h3", label: "Heading 3", run: () => window.MDE.runCmd("h3") },
    { id: "quote", label: "Blockquote", run: () => window.MDE.runCmd("quote") },
    { id: "codeblock", label: "Code block", run: () => window.MDE.runCmd("codeblock") },
    { id: "ul", label: "Bullet list", run: () => window.MDE.runCmd("ul") },
    { id: "ol", label: "Numbered list", run: () => window.MDE.runCmd("ol") },
    { id: "task", label: "Task list", run: () => window.MDE.runCmd("task") },
    { id: "table", label: "Table", run: () => window.MDE.runCmd("table") },
    { id: "hr", label: "Horizontal rule", run: () => window.MDE.runCmd("hr") },
    { id: "image", label: "Image", run: () => window.MDE.runCmd("image") },
    { id: "math", label: "Math", run: () => window.MDE.runCmd("math") },
    { id: "footnote", label: "Footnote", run: () => window.MDE.runCmd("footnote") },
    {
      id: "diagram",
      label: "Insert diagram",
      run: () => {
        // Matches CommandPalette.svelte's own "Insert diagram" entry —
        // opens the full diagram editor rather than inserting text
        // directly, since a diagram's content isn't a fixed snippet.
        window.MDE.openDiagramEditor();
      },
    },
  ];

  const filtered = $derived.by(() => {
    return commands
      .map((cmd) => ({ cmd, score: fuzzyScore($slashMenu.query, cmd.label) }))
      .filter((e): e is { cmd: SlashCommand; score: number } => e.score !== null)
      .sort((a, b) => a.score - b.score);
  });

  $effect(() => {
    // Reset selection whenever the query (and thus the filtered list)
    // changes, so a stale index from a longer list never points past
    // the end of a newly-shortened one.
    $slashMenu.query;
    selectedIndex = 0;
  });

  function selectCommand(cmd: SlashCommand) {
    const cm = window.MDE.getEditor();
    const pos = cm.state.selection.main.head;
    // Removes "/" through the current cursor (the query text typed
    // after it), then runs the command — it reads the now-clean cursor
    // position fresh, the same way every existing toolbar command
    // already does. This doc change also naturally closes the slash
    // field on its own (the cursor lands exactly at triggerPos, which
    // slashTriggerField's own validity check treats as "moved before
    // the trigger").
    cm.dispatch({ changes: { from: $slashMenu.triggerPos, to: pos, insert: "" } });
    cmd.run();
    cm.focus();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      selectedIndex = filtered.length === 0 ? 0 : (selectedIndex + 1) % filtered.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      selectedIndex = filtered.length === 0 ? 0 : (selectedIndex - 1 + filtered.length) % filtered.length;
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      const entry = filtered[selectedIndex];
      if (entry) selectCommand(entry.cmd);
    }
    // Escape is handled by app.ts's own CodeMirror keymap (it needs to
    // dispatch a CodeMirror effect, not just hide this component) —
    // not duplicated here.
  }

  // CodeMirror's own keymap is attached directly on its content DOM, which
  // fires before a window-level bubble-phase listener ever would (Enter's
  // default "insert newline" always wins the race, and Arrow keys would too
  // in a multi-line doc). Listening on the CAPTURE phase at window fires
  // before CodeMirror sees the event at all; stopPropagation (only for the
  // keys handled above) keeps CodeMirror from processing them further,
  // while every other key — the query text itself — passes through
  // untouched to reach CodeMirror normally.
  $effect(() => {
    if (!$slashMenu.open) return;
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  });
</script>

{#if $slashMenu.open && $slashMenu.coords}
  <div class="slash-menu" style="left: {$slashMenu.coords.left}px; top: {$slashMenu.coords.bottom + 4}px;">
    {#if filtered.length === 0}
      <p class="modal-hint">No matching commands.</p>
    {:else}
      {#each filtered as entry, i (entry.cmd.id)}
        <button
          type="button"
          class="shortcuts-row slash-menu-row"
          class:active={i === selectedIndex}
          onclick={() => selectCommand(entry.cmd)}
          onmouseenter={() => (selectedIndex = i)}
        >
          <span>{entry.cmd.label}</span>
        </button>
      {/each}
    {/if}
  </div>
{/if}
