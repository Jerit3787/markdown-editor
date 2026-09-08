<script lang="ts">
  import { onMount } from "svelte";
  import { githubUsername } from "../stores/github";
  import { settingsModalOpen } from "../stores/settingsModal";

  let open = $state(false);
  let imgFailed = $state(false);

  function toggle() {
    window.MDE.closeAllDropdowns?.();
    open = !open;
  }
  function signIn() {
    open = false;
    window.MDE.openGithubSignInPopup();
  }
  function openSettings() {
    open = false;
    settingsModalOpen.set(true);
  }
  async function signOut() {
    open = false;
    await fetch("/api/auth/github/logout", { method: "POST" });
    location.reload();
  }

  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (open && !(e.target as HTMLElement).closest(".topbar-account")) open = false;
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) open = false;
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeydown);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeydown);
    };
  });

  // Reset the image-failed flag when the user changes (sign out, then
  // sign in as someone else) so the new avatar gets a fresh attempt.
  $effect(() => {
    $githubUsername;
    imgFailed = false;
  });
</script>

<div class="topbar-account dropdown">
  <button
    type="button"
    class="topbar-account-btn icon-btn tooltip-end"
    onclick={toggle}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={$githubUsername ? $githubUsername : "Account"}
    data-tooltip={$githubUsername ? $githubUsername : "Account"}
  >
    {#if $githubUsername && !imgFailed}
      <img
        class="topbar-account-avatar"
        src={`https://github.com/${$githubUsername}.png?size=80`}
        alt=""
        onerror={() => (imgFailed = true)}
      />
    {:else}
      <svg class="icon"><use href="#icon-user"></use></svg>
    {/if}
  </button>

  {#if open}
    <div class="dropdown-menu topbar-account-menu" role="menu" style="right: 0; min-width: 240px">
      <div class="topbar-account-header">
        <span class="topbar-account-header-avatar">
          {#if $githubUsername && !imgFailed}
            <img src={`https://github.com/${$githubUsername}.png?size=64`} alt="" onerror={() => (imgFailed = true)} />
          {:else}
            <svg class="icon"><use href="#icon-user"></use></svg>
          {/if}
        </span>
        <span class="topbar-account-header-text">
          <span class="topbar-account-header-name">{$githubUsername ?? "Not signed in"}</span>
          <span class="topbar-account-header-sub">
            {$githubUsername ? "Signed in via GitHub" : "Sign in to share & publish"}
          </span>
        </span>
      </div>
      <div class="dropdown-divider"></div>
      {#if !$githubUsername}
        <button type="button" role="menuitem" class="dropdown-item" onclick={signIn}>
          <svg class="icon"><use href="#icon-github"></use></svg> Sign in with GitHub
        </button>
      {/if}
      <button type="button" role="menuitem" class="dropdown-item" onclick={openSettings}>
        <svg class="icon"><use href="#icon-settings"></use></svg> Settings
      </button>
      {#if $githubUsername}
        <button type="button" role="menuitem" class="dropdown-item" onclick={signOut}>
          <svg class="icon"><use href="#icon-log-out"></use></svg> Sign out
        </button>
      {/if}
    </div>
  {/if}
</div>
