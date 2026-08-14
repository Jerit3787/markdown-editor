<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { licensesModalOpen } from "../stores/aboutModals";

  function close() {
    licensesModalOpen.set(false);
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $licensesModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $licensesModalOpen}
  <Modal title="Open Source Licenses" icon="icon-file" wide labelledBy="licensesModalTitle" onClose={close}>
    <p class="modal-hint">This app is built with these open-source packages.</p>
    <div class="shortcuts-list images-list">
      {#each __OSS_LICENSES__ as entry (entry.name)}
        <div class="shortcuts-row">
          <span>
            {#if entry.url}<a href={entry.url} target="_blank" rel="noopener">{entry.name}</a>{:else}{entry.name}{/if}
          </span>
          <kbd>{entry.license} · v{entry.version}</kbd>
        </div>
      {/each}
    </div>
  </Modal>
{/if}
