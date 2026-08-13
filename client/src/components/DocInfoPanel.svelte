<script lang="ts">
  import { onMount } from "svelte";
  import { docInfoPanelOpen } from "../stores/docInfoPanel";
  import { activeIdStore, activeDocContent, getActiveDoc, docsStore, switchDoc } from "../stores/docs";
  import { findBacklinks } from "../wikilinks";

  const doc = $derived($activeIdStore ? getActiveDoc() : undefined);
  const backlinks = $derived(doc ? findBacklinks(doc.name, $docsStore, doc.id) : []);
  const wordCount = $derived.by(() => {
    const text = $activeDocContent.trim();
    return text.length ? text.split(/\s+/).length : 0;
  });
  const charCount = $derived($activeDocContent.length);

  function close() {
    docInfoPanelOpen.set(false);
  }

  function backdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  function jumpTo(id: string) {
    switchDoc(id);
    close();
  }

  // formatRelativeTime (the window.MDE bridge method) is deliberately
  // compact ("Today") for where it's used elsewhere (the Open Recent
  // submenu) — this panel is the one place precise enough to want the
  // full timestamp alongside it.
  function formatFullTimestamp(ts: number): string {
    return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $docInfoPanelOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $docInfoPanelOpen && doc}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" data-svelte-modal onclick={backdropClick}>
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="docInfoTitle">
      <h2 id="docInfoTitle"><svg class="icon"><use href="#icon-info"></use></svg> Document info</h2>
      <div class="doc-info-row">
        <span>Created</span>
        <span class="doc-info-value">
          {window.MDE.formatRelativeTime(doc.createdAt)}
          <span class="doc-info-timestamp">{formatFullTimestamp(doc.createdAt)}</span>
        </span>
      </div>
      <div class="doc-info-row">
        <span>Edited</span>
        <span class="doc-info-value">
          {window.MDE.formatRelativeTime(doc.updatedAt)}
          <span class="doc-info-timestamp">{formatFullTimestamp(doc.updatedAt)}</span>
        </span>
      </div>
      <div class="doc-info-row"><span>Length</span><span>{wordCount} word{wordCount === 1 ? "" : "s"}, {charCount} character{charCount === 1 ? "" : "s"}</span></div>
      <div class="menu-section-label">Linked from</div>
      {#if backlinks.length === 0}
        <p class="modal-hint">No other documents link here yet.</p>
      {:else}
        <div class="doc-info-backlinks">
          {#each backlinks as link (link.id)}
            <button type="button" class="doc-info-backlink-row" onclick={() => jumpTo(link.id)}>{link.name}</button>
          {/each}
        </div>
      {/if}
      <div class="modal-actions">
        <button type="button" class="secondary-btn" onclick={close}>Close</button>
      </div>
    </div>
  </div>
{/if}
