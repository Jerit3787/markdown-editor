<script lang="ts">
  import Modal from "./Modal.svelte";
  import { turnstilePromptOpen, turnstilePromptError } from "../stores/turnstile";

  function cancel() {
    turnstilePromptOpen.set(false);
    turnstilePromptError.set(false);
  }

  // The Cloudflare widget owns its own retry once rendered; this button
  // just clears our error banner so the widget (or a fresh join attempt)
  // can take over again.
  function retry() {
    turnstilePromptError.set(false);
  }
</script>

{#if $turnstilePromptOpen}
  <Modal title="Just checking you're human" icon="icon-lock" labelledBy="turnstilePromptTitle" maxWidth="420px" onClose={cancel}>
    <p class="modal-hint" id="turnstilePromptTitle">One quick check before this shared workspace loads. It usually takes a second.</p>
    <div id="turnstile-widget"></div>
    {#if $turnstilePromptError}
      <p class="modal-hint turnstile-prompt-error">That didn't go through.</p>
    {/if}
    {#snippet footer()}
      <button type="button" class="secondary-btn" onclick={cancel}>Cancel</button>
      {#if $turnstilePromptError}
        <button type="button" class="primary-btn" onclick={retry}>Retry</button>
      {/if}
    {/snippet}
  </Modal>
{/if}

<style>
  .turnstile-prompt-error {
    color: var(--danger, #d33);
  }
  #turnstile-widget {
    min-height: 65px;
    display: flex;
    align-items: center;
  }
</style>
