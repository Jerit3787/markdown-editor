<script lang="ts">
  import { onMount } from "svelte";
  import { githubUsername } from "../stores/github";

  let open = $state(false);
  let imgFailed = $state(false);

  function toggle() {
    window.MDE.closeAllDropdowns?.();
    open = !open;
  }
  function signIn() {
    window.MDE.openGithubSignInPopup();
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

{#if $githubUsername}
  <div class="topbar-account dropdown">
    <button
      type="button"
      class="topbar-account-btn icon-btn tooltip-end"
      onclick={toggle}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={$githubUsername}
      data-tooltip={$githubUsername}
    >
      {#if !imgFailed}
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
      <div class="dropdown-menu topbar-account-menu" role="menu" style="right: 0; min-width: 200px">
        <div class="menu-section-label">{$githubUsername}</div>
        <button type="button" role="menuitem" class="dropdown-item" onclick={signOut}>
          <svg class="icon"><use href="#icon-log-out"></use></svg> Sign out
        </button>
      </div>
    {/if}
  </div>
{:else}
  <button
    type="button"
    class="topbar-account-btn icon-btn"
    onclick={signIn}
    aria-label="Sign in with GitHub"
    data-tooltip="Sign in"
  >
    <svg class="icon"><use href="#icon-user"></use></svg>
  </button>
{/if}
