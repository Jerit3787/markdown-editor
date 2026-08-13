<script lang="ts">
  import { wikilinkMenu } from "../stores/wikilinkMenu";
  import { docsStore } from "../stores/docs";
  import { fuzzyScore } from "../fuzzy-match";
  import type { Doc } from "../types";

  let selectedIndex = $state(0);

  const filtered = $derived.by(() => {
    return $docsStore
      .map((doc) => ({ doc, score: fuzzyScore($wikilinkMenu.query, doc.name) }))
      .filter((e): e is { doc: Doc; score: number } => e.score !== null)
      .sort((a, b) => a.score - b.score);
  });

  $effect(() => {
    $wikilinkMenu.query;
    selectedIndex = 0;
  });

  function selectDoc(name: string) {
    const cm = window.MDE.getEditor();
    const pos = cm.state.selection.main.head;
    cm.dispatch({
      changes: { from: $wikilinkMenu.triggerPos, to: pos, insert: `${name}]]` },
      selection: { anchor: $wikilinkMenu.triggerPos + name.length + 2 },
    });
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
      if (entry) selectDoc(entry.doc.name);
    }
    // Escape is handled by app.ts's own CodeMirror keymap, same as
    // SlashMenu.svelte — not duplicated here.
  }

  $effect(() => {
    if (!$wikilinkMenu.open) return;
    window.addEventListener("keydown", onKeydown, true);
    return () => window.removeEventListener("keydown", onKeydown, true);
  });
</script>

{#if $wikilinkMenu.open && $wikilinkMenu.coords}
  <div class="slash-menu" style="left: {$wikilinkMenu.coords.left}px; top: {$wikilinkMenu.coords.bottom + 4}px;">
    {#if filtered.length === 0}
      <p class="modal-hint">No matching documents.</p>
    {:else}
      {#each filtered as entry, i (entry.doc.id)}
        <button
          type="button"
          class="shortcuts-row slash-menu-row"
          class:active={i === selectedIndex}
          onclick={() => selectDoc(entry.doc.name)}
          onmouseenter={() => (selectedIndex = i)}
        >
          <span>{entry.doc.name}</span>
        </button>
      {/each}
    {/if}
  </div>
{/if}
