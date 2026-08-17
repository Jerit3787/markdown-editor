<script lang="ts">
  import Modal from "./Modal.svelte";
  import { shareChoiceRequest, type ShareChoiceResult } from "../stores/shareChoice";

  function respond(choice: ShareChoiceResult) {
    $shareChoiceRequest?.resolve(choice);
    shareChoiceRequest.set(null);
  }
</script>

{#if $shareChoiceRequest}
  <Modal title={`Share "${$shareChoiceRequest.docName}"?`} icon="icon-users" wide labelledBy="shareChoiceTitle" onClose={() => respond("cancel")} elevated>
    <div class="empty-state" style="padding: 12px 0 24px;">
      <svg class="empty-state-icon"><use href="#icon-users"></use></svg>
      <div class="empty-state-desc" style="margin-bottom: 0; margin-top: 16px;">
        This document is one of {$shareChoiceRequest.docCount} in "{$shareChoiceRequest.workspaceName}." Share just this document, or the whole workspace together?
      </div>
    </div>
    {#snippet footer()}
      <button type="button" class="secondary-btn" onclick={() => respond("cancel")}>Cancel</button>
      <span class="spacer"></span>
      <button type="button" class="secondary-btn" onclick={() => respond("document")}>Just this document</button>
      <button type="button" class="primary-btn" onclick={() => respond("workspace")}>
        Share whole workspace ({$shareChoiceRequest.docCount})
      </button>
    {/snippet}
  </Modal>
{/if}
