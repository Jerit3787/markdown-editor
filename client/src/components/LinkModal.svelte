<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import { linkModalOpen, linkModalPrefillText } from "../stores/linkModal";

  let text = $state("");
  let url = $state("");

  $effect(() => {
    if ($linkModalOpen) {
      text = get(linkModalPrefillText);
      url = "";
    }
  });

  function close() {
    linkModalOpen.set(false);
  }
  function confirmInsert() {
    window.MDE.insertLinkIntoEditor(text, url);
    close();
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $linkModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $linkModalOpen}
  <Modal title="Insert link" icon="icon-link" labelledBy="linkModalTitle" onClose={close}>
    {#snippet quickAction()}
      <Toggletip>Select text first to prefill it as the link text — leave Text blank and it defaults to "link text" instead.</Toggletip>
    {/snippet}
    <label class="modal-field">
      <span>Text</span>
      <input type="text" placeholder="Link text" bind:value={text} onkeydown={(e) => e.key === "Enter" && confirmInsert()} />
    </label>
    <label class="modal-field">
      <span>URL</span>
      <input type="text" placeholder="https://example.com" bind:value={url} onkeydown={(e) => e.key === "Enter" && confirmInsert()} />
    </label>
    {#snippet footer()}
      <button type="button" class="secondary-btn" onclick={close}>Cancel</button>
      <button type="button" class="primary-btn" onclick={confirmInsert}>Insert</button>
    {/snippet}
  </Modal>
{/if}
