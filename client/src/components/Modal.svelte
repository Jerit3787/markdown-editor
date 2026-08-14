<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    icon?: string;
    wide?: boolean;
    // For dialogs that can be triggered from inside an already-open
    // modal (currently just ConfirmDialog) — every modal shares the
    // same base z-index, so without this, which one paints on top is
    // decided by DOM/mount order rather than which one actually opened
    // more recently. Bumps this instance above every non-elevated one.
    elevated?: boolean;
    labelledBy: string;
    onClose: () => void;
    quickAction?: Snippet;
    // Optional tab strip rendered below the header, above the body —
    // not consumed by anything yet (no modal in this app currently
    // needs sub-sections), built ahead of a real need since it's part
    // of Modal's own shared surface, not something a consumer could
    // bolt on itself without duplicating the header/body boundary.
    tabs?: Snippet;
    footer?: Snippet;
    children: Snippet;
  }
  let { title, icon, wide = false, elevated = false, labelledBy, onClose, quickAction, tabs, footer, children }: Props = $props();

  function backdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-backdrop" class:elevated data-svelte-modal onclick={backdropClick}>
  <div class="modal-box-v2" class:modal-box-wide={wide} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
    <div class="modal-header">
      <button type="button" class="modal-close-btn" onclick={onClose} aria-label="Close">
        <svg class="icon"><use href="#icon-x"></use></svg>
      </button>
      <h2 id={labelledBy}>
        {#if icon}<svg class="icon"><use href="#{icon}"></use></svg>{/if}
        {title}
      </h2>
      {#if quickAction}{@render quickAction()}{/if}
    </div>
    {#if tabs}
      <div class="modal-tabs" role="tablist">{@render tabs()}</div>
    {/if}
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
