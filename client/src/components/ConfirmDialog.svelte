<script lang="ts">
  import Modal from "./Modal.svelte";
  import { confirmRequest } from "../stores/confirmDialog";

  function respond(confirmed: boolean) {
    $confirmRequest?.resolve(confirmed);
    confirmRequest.set(null);
  }
</script>

{#if $confirmRequest}
  <Modal title={$confirmRequest.title} icon={$confirmRequest.danger ? "icon-trash-2" : "icon-info"} labelledBy="confirmDialogTitle" onClose={() => respond(false)} elevated>
    <div class="empty-state" style="padding: 12px 0 24px;">
      {#if $confirmRequest.danger}
        <svg class="empty-state-icon" style="opacity: 0.8; color: var(--danger);"><use href="#icon-trash-2"></use></svg>
      {:else}
        <svg class="empty-state-icon"><use href="#icon-info"></use></svg>
      {/if}
      <div class="empty-state-desc" style="margin-bottom: 0; margin-top: 16px;">{$confirmRequest.message}</div>
    </div>
    {#snippet footer()}
      <button type="button" class="secondary-btn" onclick={() => respond(false)}>Cancel</button>
      <button type="button" class="primary-btn" class:danger={$confirmRequest?.danger} onclick={() => respond(true)}>
        {$confirmRequest?.confirmLabel}
      </button>
    {/snippet}
  </Modal>
{/if}
