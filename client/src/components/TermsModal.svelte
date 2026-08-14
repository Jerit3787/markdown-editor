<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { termsModalOpen } from "../stores/aboutModals";

  function close() {
    termsModalOpen.set(false);
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $termsModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $termsModalOpen}
  <Modal title="Terms of Service" icon="icon-file" wide labelledBy="termsModalTitle" onClose={close}>
    <p>Markdown Editor is provided as-is, free to use, with no warranty of any kind — use it at your own risk, the same as any other free tool.</p>
    <p>Don't use the sharing or collaboration features to distribute content you don't have the right to share, or to do anything unlawful.</p>
    <p>The service can change, be interrupted, or shut down at any time. Documents you haven't shared live only in your browser's local storage, so nothing on our end is lost if that happens — but nothing on our end is backed up for you either.</p>
    <p>It's open source — read the code or self-host your own copy from the link in About.</p>
  </Modal>
{/if}
