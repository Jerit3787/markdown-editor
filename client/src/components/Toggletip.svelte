<script lang="ts">
  import { onMount } from "svelte";
  import type { Snippet } from "svelte";

  interface Props {
    children: Snippet;
  }
  let { children }: Props = $props();

  let open = $state(false);
  let rootEl: HTMLDivElement | undefined = $state();

  function toggle() {
    open = !open;
  }
  function close() {
    open = false;
  }

  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (open && rootEl && !rootEl.contains(e.target as Node)) close();
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) close();
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeydown);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKeydown);
    };
  });
</script>

<div class="toggletip" bind:this={rootEl}>
  <button type="button" class="hint-toggle-btn" class:active={open} aria-label="What is this?" aria-expanded={open} onclick={toggle}>?</button>
  {#if open}
    <div class="toggletip-bubble" role="tooltip">
      {@render children()}
    </div>
  {/if}
</div>
