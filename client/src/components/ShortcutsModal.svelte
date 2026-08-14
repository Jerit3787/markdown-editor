<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { shortcutsModalOpen } from "../stores/shortcutsModal";

  const SHORTCUTS: [string, string][] = [
    ["Bold", "Ctrl/Cmd+B"],
    ["Italic", "Ctrl/Cmd+I"],
    ["Insert link", "Ctrl/Cmd+K"],
    ["Undo", "Ctrl/Cmd+Z"],
    ["Redo", "Ctrl/Cmd+Shift+Z"],
    ["Continue list on new line", "Enter"],
  ];

  function close() {
    shortcutsModalOpen.set(false);
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $shortcutsModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $shortcutsModalOpen}
  <Modal title="Keyboard Shortcuts" icon="icon-keyboard" labelledBy="shortcutsModalTitle" onClose={close}>
    <div class="shortcuts-list">
      {#each SHORTCUTS as [label, keys] (label)}
        <div class="shortcuts-row"><span>{label}</span><kbd>{keys}</kbd></div>
      {/each}
    </div>
  </Modal>
{/if}
