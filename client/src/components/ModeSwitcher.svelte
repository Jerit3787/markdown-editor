<script lang="ts">
  import { onMount } from "svelte";
  import { effectiveMode, modesAllowed, collabRole, setChosenMode, type Mode } from "../stores/collabMode";

  let open = $state(false);

  const LABELS: Record<Mode, string> = { editing: "Editing", suggesting: "Suggesting", viewing: "Viewing" };
  const ICONS: Record<Mode, string> = { editing: "icon-pencil", suggesting: "icon-message-square", viewing: "icon-eye" };
  // Matches Google Docs' mode-switcher dropdown copy.
  const DESCRIPTIONS: Record<Mode, string> = {
    editing: "Edit document directly",
    suggesting: "Edits become suggestions",
    viewing: "Read or print final document",
  };

  function pick(m: Mode) {
    setChosenMode(m);
    open = false;
  }

  function toggle() {
    if ($modesAllowed.length < 2) return; // a viewer has nothing to choose
    window.MDE.closeAllDropdowns?.();
    open = !open;
  }

  onMount(() => {
    const onDoc = (e: MouseEvent) => {
      if (open && !(e.target as HTMLElement).closest(".mode-switcher")) open = false;
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  });
</script>

{#if $collabRole && $effectiveMode}
  <div class="mode-switcher dropdown">
    <button
      type="button"
      class="mode-switcher-btn icon-btn"
      onclick={toggle}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={LABELS[$effectiveMode]}
      data-tooltip={LABELS[$effectiveMode]}
    >
      <svg class="icon"><use href="#{ICONS[$effectiveMode]}"></use></svg>
      {#if $modesAllowed.length < 2}
        <span class="mode-switcher-label">{LABELS[$effectiveMode]}</span>
      {/if}
      {#if $modesAllowed.length > 1}<svg class="icon menu-chevron"><use href="#icon-chevron-down"></use></svg>{/if}
    </button>
    {#if open && $modesAllowed.length > 1}
      <div class="dropdown-menu mode-switcher-menu" role="menu">
        {#each $modesAllowed as m (m)}
          <button type="button" role="menuitem" class="mode-switcher-item dropdown-item" class:active={m === $effectiveMode} onclick={() => pick(m)}>
            <svg class="icon"><use href="#{ICONS[m]}"></use></svg>
            <span class="mode-switcher-item-text">
              <span class="mode-switcher-item-label">{LABELS[m]}</span>
              <span class="mode-switcher-desc">{DESCRIPTIONS[m]}</span>
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}
