<script lang="ts">
  import { onMount } from "svelte";
  import { whatsNewOpen } from "../stores/whatsNew";

  // Bumped only when there's a new entry worth announcing — not tied to
  // every patch release. Matches package.json's version at the time this
  // was last updated; the two are allowed to drift (a patch release with
  // nothing to announce shouldn't reopen this for everyone).
  const CURRENT_VERSION = "1.3.0";
  const STORAGE_KEY = "mde:whatsNewSeen";

  function dismiss() {
    whatsNewOpen.set(false);
    localStorage.setItem(STORAGE_KEY, CURRENT_VERSION);
  }
  function backdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) dismiss();
  }

  onMount(() => {
    if (localStorage.getItem(STORAGE_KEY) !== CURRENT_VERSION) {
      whatsNewOpen.set(true);
    }
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $whatsNewOpen) dismiss();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $whatsNewOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" data-svelte-modal onclick={backdropClick}>
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="whatsNewTitle">
      <h2 id="whatsNewTitle"><svg class="icon"><use href="#icon-rocket"></use></svg> What's new</h2>
      <div class="menu-section-label">Diagram export</div>
      <p class="hint-text">
        Copy a diagram as SVG or download it as a PNG straight from the diagram editor's new
        Export menu.
      </p>
      <div class="menu-divider"></div>
      <div class="menu-section-label">Pan &amp; zoom</div>
      <p class="hint-text">
        Scroll to zoom and drag to pan around a diagram in the editor's preview, with a
        one-click "Reset view" to snap back.
      </p>
      <div class="menu-divider"></div>
      <div class="menu-section-label">Syntax highlighting</div>
      <p class="hint-text">
        The diagram editor's code pane now highlights Mermaid syntax — keywords, arrows, and
        labels — for every supported diagram type.
      </p>
      <div class="modal-actions">
        <button class="primary-btn" type="button" onclick={dismiss}>Got it</button>
      </div>
    </div>
  </div>
{/if}
