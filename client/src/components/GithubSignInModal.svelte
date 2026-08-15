<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { githubSignInModalOpen, githubSignInModalHint } from "../stores/githubSignInModal";

  function close() {
    githubSignInModalOpen.set(false);
  }
  function signIn() {
    window.MDE.openGithubSignInPopup();
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $githubSignInModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);

    // Sign-in happens in a popup (github-auth.ts's callback page posts
    // the result here and closes itself) — moved here verbatim from
    // app.ts's initGithubSignInModal().
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || !e.data || e.data.type !== "mde-github-auth") return;
      if (e.data.ok) {
        close();
        window.MDE.onGithubAuthComplete && window.MDE.onGithubAuthComplete();
      } else {
        alert(`GitHub sign-in failed: ${e.data.message || "unknown error"}`);
      }
    };
    window.addEventListener("message", onMessage);

    return () => {
      document.removeEventListener("keydown", onKeydown);
      window.removeEventListener("message", onMessage);
    };
  });
</script>

{#if $githubSignInModalOpen}
  <Modal labelledBy="githubSignInModalTitle" maxWidth="380px" onClose={close}>
    <div class="empty-state" style="padding: 12px 0 24px;">
      <svg class="empty-state-icon" style="opacity: 0.8;"><use href="#icon-github"></use></svg>
      <div class="empty-state-title" id="githubSignInModalTitle">Sign in required</div>
      <div class="empty-state-desc" style="margin-bottom: 0;">{$githubSignInModalHint || "This feature needs a connected GitHub account. Sign in to continue."}</div>
    </div>
    {#snippet footer()}
      <button type="button" class="secondary-btn" onclick={close}>Cancel</button>
      <button type="button" class="primary-btn" onclick={signIn}><svg class="icon"><use href="#icon-github"></use></svg> Sign in with GitHub</button>
    {/snippet}
  </Modal>
{/if}
