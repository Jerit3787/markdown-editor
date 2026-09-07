<script lang="ts">
  import { onMount } from "svelte";
  import { effectiveMode, modesAllowed, collabRole, setChosenMode, type Mode } from "../stores/collabMode";

  let open = $state(false);

  const LABELS: Record<Mode, string> = { editing: "Editing", suggesting: "Suggesting", viewing: "Viewing" };
  const ICONS: Record<Mode, string> = { editing: "icon-pencil", suggesting: "icon-message-square", viewing: "icon-eye" };

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
    <button type="button" class="mode-switcher-btn icon-btn" onclick={toggle} aria-haspopup="menu" aria-expanded={open}>
      <svg class="icon"><use href="#{ICONS[$effectiveMode]}"></use></svg>
      <span class="mode-switcher-label">{LABELS[$effectiveMode]}</span>
      {#if $modesAllowed.length > 1}<svg class="icon menu-chevron"><use href="#icon-chevron-down"></use></svg>{/if}
    </button>
    {#if open && $modesAllowed.length > 1}
      <div class="dropdown-menu mode-switcher-menu" role="menu">
        {#each $modesAllowed as m (m)}
          <button type="button" role="menuitem" class="dropdown-item" class:active={m === $effectiveMode} onclick={() => pick(m)}>
            <svg class="icon"><use href="#{ICONS[m]}"></use></svg>
            {LABELS[m]}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}
