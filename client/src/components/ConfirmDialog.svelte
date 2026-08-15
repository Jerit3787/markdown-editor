<script lang="ts">
  import Modal from "./Modal.svelte";
  import { confirmRequest } from "../stores/confirmDialog";

  function respond(confirmed: boolean) {
    $confirmRequest?.resolve(confirmed);
    confirmRequest.set(null);
  }
</script>

{#if $confirmRequest}
  <Modal title={$confirmRequest.title} icon="icon-alert-triangle" labelledBy="confirmDialogTitle" onClose={() => respond(false)} elevated>
    <p class="modal-hint" style="margin-top: 8px;">{$confirmRequest.message}</p>
    {#snippet footer()}
      <button type="button" class="secondary-btn" onclick={() => respond(false)}>Cancel</button>
      <button type="button" class="primary-btn" class:danger={$confirmRequest?.danger} onclick={() => respond(true)}>
        {$confirmRequest?.confirmLabel}
      </button>
    {/snippet}
  </Modal>
{/if}
