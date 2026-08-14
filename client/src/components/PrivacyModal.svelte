<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { privacyModalOpen } from "../stores/aboutModals";

  function close() {
    privacyModalOpen.set(false);
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $privacyModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $privacyModalOpen}
  <Modal title="Privacy Policy" icon="icon-lock" wide labelledBy="privacyModalTitle" onClose={close}>
    <p>Documents are stored only in your own browser's local storage, on your device — never on our servers — unless you explicitly Publish to Gist or Share a document.</p>
    <p>Signing in with GitHub (for Publish to Gist) sends your GitHub access token to this app's server, which encrypts it into an HttpOnly cookie your browser holds — it's never exposed to this page's own JavaScript, and is only used to call GitHub's API on your behalf.</p>
    <p>Sharing a document creates a temporary collaboration room that holds that document's content (via Cloudflare Durable Objects) for as long as the room exists, visible to whoever the room's access settings allow.</p>
    <p>No analytics, tracking, or advertising scripts run in this app. Cloudflare, which hosts it, keeps standard request logs briefly to operate the service — the same as any web host.</p>
  </Modal>
{/if}
