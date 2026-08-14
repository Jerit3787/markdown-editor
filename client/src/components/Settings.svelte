<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import { githubUsername } from "../stores/github";

  const STORAGE_THEME = "mde:theme";
  const STORAGE_CUSTOM_CSS = "mde:customExportCss";
  const STORAGE_KEYBINDINGS = "mde:keybindings";

  let hidden = $state(true);
  let theme = $state(localStorage.getItem(STORAGE_THEME) || "light");
  let customCss = $state(localStorage.getItem(STORAGE_CUSTOM_CSS) || "");
  let keybindings = $state(localStorage.getItem(STORAGE_KEYBINDINGS) || "normal");

  function applyTheme(next: string) {
    theme = next;
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(STORAGE_THEME, next);
    // The editor's own colors are CSS custom properties (see cm-facade.ts's
    // editorTheme) that already flip with data-theme above — no separate
    // CodeMirror-side reconfiguration needed.
  }

  function saveCustomCss(next: string) {
    customCss = next;
    localStorage.setItem(STORAGE_CUSTOM_CSS, next);
  }

  function applyKeybindings(next: "normal" | "vim" | "emacs") {
    keybindings = next;
    window.MDE.setKeybindings(next);
  }

  function open() {
    hidden = false;
  }
  function close() {
    hidden = true;
  }

  function signIn() {
    window.MDE.openGithubSignInPopup();
  }
  function disconnect() {
    location.href = "/api/auth/github/logout";
  }

  onMount(() => {
    // Applies the saved theme to <html> on load — previously app.ts's
    // initTheme() did this; now that Settings owns theme state, it does
    // too. Just needs to (re)apply the <html> attribute + icon/label.
    applyTheme(theme);
    document.getElementById("settingsBtn")?.addEventListener("click", open);

    // app.ts's global Escape handler deliberately skips
    // [data-svelte-modal] backdrops (see initModalEscapeKey) since it can
    // only mutate the DOM `hidden` attribute directly, which wouldn't
    // update this component's own `hidden` state — so this modal closes
    // itself on Escape instead.
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !hidden) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if !hidden}
  <Modal title="Settings" icon="icon-settings" labelledBy="settingsModalTitle" onClose={close}>
    {#snippet quickAction()}
      <Toggletip>Theme applies instantly and remembers your choice. Connecting GitHub is what gates both Publish to Gist and Share — it's optional otherwise.</Toggletip>
    {/snippet}
    <div class="menu-section-label">Appearance</div>
    <div class="tab-switch" role="tablist" aria-label="Theme">
      <button type="button" class="tab-switch-btn" class:active={theme === "light"} role="tab" aria-selected={theme === "light"} onclick={() => applyTheme("light")}>
        <svg class="icon"><use href="#icon-sun"></use></svg> Light
      </button>
      <button type="button" class="tab-switch-btn" class:active={theme === "dark"} role="tab" aria-selected={theme === "dark"} onclick={() => applyTheme("dark")}>
        <svg class="icon"><use href="#icon-moon"></use></svg> Dark
      </button>
    </div>
    <div class="menu-divider"></div>
    <div class="menu-section-label">Editor</div>
    <div class="tab-switch" role="tablist" aria-label="Keybindings">
      <button type="button" class="tab-switch-btn" class:active={keybindings === "normal"} role="tab" aria-selected={keybindings === "normal"} onclick={() => applyKeybindings("normal")}>Normal</button>
      <button type="button" class="tab-switch-btn" class:active={keybindings === "vim"} role="tab" aria-selected={keybindings === "vim"} onclick={() => applyKeybindings("vim")}>Vim</button>
      <button type="button" class="tab-switch-btn" class:active={keybindings === "emacs"} role="tab" aria-selected={keybindings === "emacs"} onclick={() => applyKeybindings("emacs")}>Emacs</button>
    </div>
    <div class="menu-divider"></div>
    <div class="menu-section-label">GitHub</div>
    <div class="share-row">
      <span class="status-dot {$githubUsername ? 'status-shared' : 'status-idle'}"></span>
      <span>{$githubUsername ? `Signed in as ${$githubUsername}` : "Not connected"}</span>
    </div>
    {#if !$githubUsername}
      <button class="secondary-btn" type="button" onclick={signIn}>
        <svg class="icon"><use href="#icon-github"></use></svg> Sign in with GitHub
      </button>
    {:else}
      <button class="secondary-btn" type="button" onclick={disconnect}>
        <svg class="icon"><use href="#icon-log-out"></use></svg> Disconnect
      </button>
    {/if}
    <div class="menu-divider"></div>
    <div class="menu-section-label">Export</div>
    <p class="hint-text">
      Custom CSS applied to HTML and PDF exports only — the live preview is unaffected.
    </p>
    <textarea
      class="custom-css-input"
      rows="6"
      placeholder={"e.g. body { font-family: Georgia, serif; }"}
      value={customCss}
      oninput={(e) => saveCustomCss((e.target as HTMLTextAreaElement).value)}
    ></textarea>
  </Modal>
{/if}
