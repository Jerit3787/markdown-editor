<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    icon?: string;
    wide?: boolean;
    labelledBy: string;
    onClose: () => void;
    quickAction?: Snippet;
    footer?: Snippet;
    children: Snippet;
  }
  let { title, icon, wide = false, labelledBy, onClose, quickAction, footer, children }: Props = $props();

  function backdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" data-svelte-modal onclick={backdropClick}>
  <div class="modal-box-v2" class:modal-box-wide={wide} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
    <div class="modal-header">
      <h2 id={labelledBy}>
        {#if icon}<svg class="icon"><use href="#{icon}"></use></svg>{/if}
        {title}
      </h2>
      {#if quickAction}{@render quickAction()}{/if}
      <button type="button" class="secondary-btn" onclick={onClose}>Close</button>
    </div>
    <div class="modal-body">
      {@render children()}
    </div>
    {#if footer}
      <div class="modal-footer">
        {@render footer()}
      </div>
    {/if}
  </div>
</div>
