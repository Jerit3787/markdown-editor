<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { aboutModalOpen, termsModalOpen, privacyModalOpen, licensesModalOpen } from "../stores/aboutModals";

  function close() {
    aboutModalOpen.set(false);
  }
  function openTerms() {
    close();
    termsModalOpen.set(true);
  }
  function openPrivacy() {
    close();
    privacyModalOpen.set(true);
  }
  function openLicenses() {
    close();
    licensesModalOpen.set(true);
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $aboutModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $aboutModalOpen}
  <Modal title="About" icon="icon-info" labelledBy="infoModalTitle" onClose={close}>
    <div class="about-brand">
      <img src="/logo.svg" width="40" height="40" alt="" />
      <div>
        <div class="about-title">Markdown Editor <span class="about-version">v{__APP_VERSION__}</span></div>
        <p class="modal-hint">A fast, free markdown editor with live preview and real-time collaboration.</p>
      </div>
    </div>
    <div class="about-links">
      <button class="menu-link-item" type="button" onclick={openTerms}><svg class="icon"><use href="#icon-file"></use></svg> Terms of Service</button>
      <button class="menu-link-item" type="button" onclick={openPrivacy}><svg class="icon"><use href="#icon-lock"></use></svg> Privacy Policy</button>
      <button class="menu-link-item" type="button" onclick={openLicenses}><svg class="icon"><use href="#icon-file"></use></svg> Open Source Licenses</button>
      <a class="menu-link-item" href="https://github.com/Jerit3787/markdown-editor" target="_blank" rel="noopener"><svg class="icon"><use href="#icon-github"></use></svg> View Source on GitHub</a>
    </div>
  </Modal>
{/if}
