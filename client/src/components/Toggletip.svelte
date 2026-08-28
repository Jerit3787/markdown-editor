<script lang="ts">
  import { onMount } from "svelte";
  import type { Snippet } from "svelte";

  interface Props {
    children: Snippet;
    // Defaults to a plain "?" glyph (the original, still used by e.g.
    // ImagesModal.svelte's header quick-action). Pass an icon sprite id
    // (e.g. "icon-info") to render that instead, for inline uses where
    // an info icon reads better than a question mark.
    icon?: string;
    // Extra class(es) for the root .toggletip element — needed wherever
    // this is used somewhere other than a Modal header's quickAction
    // slot, since .toggletip's own margin-left:auto (which pushes it to
    // that slot's right edge) would otherwise misplace it inline.
    class?: string;
  }
  let { children, icon, class: className }: Props = $props();

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

<div class="toggletip {className ?? ''}" bind:this={rootEl}>
  <button type="button" class="hint-toggle-btn" class:active={open} aria-label="What is this?" aria-expanded={open} onclick={toggle}>
    {#if icon}<svg class="icon"><use href="#{icon}"></use></svg>{:else}?{/if}
  </button>
  {#if open}
    <div class="toggletip-bubble" role="tooltip">
      {@render children()}
    </div>
  {/if}
</div>
