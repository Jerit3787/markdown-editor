<script lang="ts">
  import { onMount } from "svelte";
  import { githubUsername } from "../stores/github";

  const STORAGE_THEME = "mde:theme";

  let hidden = $state(true);
  let theme = $state(localStorage.getItem(STORAGE_THEME) || "light");

  function applyTheme(next: string) {
    theme = next;
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(STORAGE_THEME, next);
    // The editor already exists by the time anyone can click this (it's
    // behind a modal opened well after init) — window.MDE is always
    // populated first, see main.ts's import order.
    const cm = window.MDE.getEditor();
    if (cm) cm.setOption("theme", next === "dark" ? "material-darker" : "default");
  }

  function open() {
    hidden = false;
  }
  function close() {
    hidden = true;
  }
  function backdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
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
    // too. CodeMirror itself still reads localStorage directly at creation
    // time in app.ts's initEditor() (runs before this component could),
    // so this only needs to (re)apply the <html> attribute + icon/label.
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
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- Click-outside-to-dismiss backdrop — Escape (handled in onMount above)
       is the keyboard equivalent, and the dialog itself carries the real
       role="dialog"/aria-modal; this div is just the click-catcher. -->
  <div class="modal-backdrop" data-svelte-modal onclick={backdropClick}>
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="settingsModalTitle">
      <h2 id="settingsModalTitle"><svg class="icon"><use href="#icon-settings"></use></svg> Settings</h2>
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
      <div class="modal-actions">
        <button class="secondary-btn" type="button" onclick={close}>Close</button>
      </div>
    </div>
  </div>
{/if}
