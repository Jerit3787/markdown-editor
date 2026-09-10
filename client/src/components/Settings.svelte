<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import { keybindingMode, setKeybindingMode } from "../stores/keybindings";
  import { settingsModalOpen } from "../stores/settingsModal";
  import { analyticsAvailable } from "../analytics";
  import { analyticsConsent, setConsent } from "../stores/analyticsConsent";
  import { driveConnected } from "../stores/driveSync";

  const STORAGE_THEME = "mde:theme";
  const STORAGE_CUSTOM_CSS = "mde:customExportCss";

  // Opened from the top-bar account menu (TopbarAccount.svelte) via this
  // store — see the per-modal-store pattern in stores/.
  let hidden = $derived(!$settingsModalOpen);
  let theme = $state(localStorage.getItem(STORAGE_THEME) || "light");
  let customCss = $state(localStorage.getItem(STORAGE_CUSTOM_CSS) || "");

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

  function close() {
    settingsModalOpen.set(false);
  }

  onMount(() => {
    // Applies the saved theme to <html> on load — previously app.ts's
    // initTheme() did this; now that Settings owns theme state, it does
    // too. Just needs to (re)apply the <html> attribute + icon/label.
    applyTheme(theme);

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
      <Toggletip>Theme applies instantly and remembers your choice. Connecting GitHub (from the account menu, top right) is what gates both Publish to Gist and Share — it's optional otherwise.</Toggletip>
    {/snippet}
    <div class="setting-row">
      <div class="setting-label">
        <span class="setting-title">Appearance</span>
      </div>
      <div class="tab-switch" role="tablist" aria-label="Theme" style="margin: 0; min-width: 160px;">
        <button type="button" class="tab-switch-btn" class:active={theme === "light"} role="tab" aria-selected={theme === "light"} onclick={() => applyTheme("light")}>
          <svg class="icon"><use href="#icon-sun"></use></svg> Light
        </button>
        <button type="button" class="tab-switch-btn" class:active={theme === "dark"} role="tab" aria-selected={theme === "dark"} onclick={() => applyTheme("dark")}>
          <svg class="icon"><use href="#icon-moon"></use></svg> Dark
        </button>
      </div>
    </div>
    
    <div class="setting-row">
      <div class="setting-label">
        <span class="setting-title">Editor</span>
      </div>
      <div class="tab-switch" role="tablist" aria-label="Keybindings" style="margin: 0; min-width: 220px;">
        <button type="button" class="tab-switch-btn" class:active={$keybindingMode === "normal"} role="tab" aria-selected={$keybindingMode === "normal"} onclick={() => setKeybindingMode("normal")}>Normal</button>
        <button type="button" class="tab-switch-btn" class:active={$keybindingMode === "vim"} role="tab" aria-selected={$keybindingMode === "vim"} onclick={() => setKeybindingMode("vim")}>Vim</button>
        <button type="button" class="tab-switch-btn" class:active={$keybindingMode === "emacs"} role="tab" aria-selected={$keybindingMode === "emacs"} onclick={() => setKeybindingMode("emacs")}>Emacs</button>
      </div>
    </div>

    {#if analyticsAvailable}
      <div class="setting-row">
        <div class="setting-label">
          <span class="setting-title">Analytics cookies</span>
          <span class="setting-desc">
            Anonymous, content-free usage stats are always cookieless. Turn this on to allow a cookie for more accurate visit counts.
          </span>
        </div>
        <div class="tab-switch" role="tablist" aria-label="Analytics cookies" style="margin: 0; min-width: 140px;">
          <button
            type="button"
            class="tab-switch-btn"
            class:active={$analyticsConsent === "granted"}
            role="tab"
            aria-selected={$analyticsConsent === "granted"}
            onclick={() => setConsent("granted")}
          >
            On
          </button>
          <button
            type="button"
            class="tab-switch-btn"
            class:active={$analyticsConsent !== "granted"}
            role="tab"
            aria-selected={$analyticsConsent !== "granted"}
            onclick={() => setConsent("denied")}
          >
            Off
          </button>
        </div>
      </div>
    {/if}

    {#if $driveConnected}
      <div class="setting-row">
        <div class="setting-label">
          <span class="setting-title">Google Drive</span>
          <span class="setting-desc">Connected — open markdown files straight from your Drive via File ▸ Open.</span>
        </div>
        <button type="button" class="secondary-btn" onclick={() => window.MDE.disconnectGoogleDrive?.()}>Disconnect</button>
      </div>
    {/if}

    <div class="setting-row stacked">
      <div class="setting-label">
        <span class="setting-title">Custom CSS</span>
        <span class="setting-desc">Applied to HTML and PDF exports only — live preview is unaffected.</span>
      </div>
      <textarea
        class="custom-css-input"
        rows="6"
        placeholder={"e.g. body { font-family: Georgia, serif; }"}
        value={customCss}
        oninput={(e) => saveCustomCss((e.target as HTMLTextAreaElement).value)}
      ></textarea>
    </div>
  </Modal>
{/if}
