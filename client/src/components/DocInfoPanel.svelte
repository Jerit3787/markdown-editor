<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
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
  <Modal title="Document info" icon="icon-info" labelledBy="docInfoTitle" onClose={close}>
    <div class="doc-info-row">
      <span class="doc-info-primary">Created</span>
      <span class="doc-info-secondary">{window.MDE.formatRelativeTime(doc.createdAt)} • {formatFullTimestamp(doc.createdAt)}</span>
    </div>
    <div class="doc-info-row">
      <span class="doc-info-primary">Edited</span>
      <span class="doc-info-secondary">{window.MDE.formatRelativeTime(doc.updatedAt)} • {formatFullTimestamp(doc.updatedAt)}</span>
    </div>
    <div class="doc-info-row">
      <span class="doc-info-primary">Length</span>
      <span class="doc-info-secondary">{wordCount} word{wordCount === 1 ? "" : "s"}, {charCount} character{charCount === 1 ? "" : "s"}</span>
    </div>
    <div class="menu-section-label">Linked from</div>
    {#if backlinks.length === 0}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-link"></use></svg>
        <div class="empty-state-title">No backlinks</div>
        <div class="empty-state-desc">No other documents link here yet.</div>
      </div>
    {:else}
      <div class="doc-info-backlinks">
        {#each backlinks as link (link.id)}
          <button type="button" class="doc-info-backlink-row" onclick={() => jumpTo(link.id)}>{link.name}</button>
        {/each}
      </div>
    {/if}
  </Modal>
{/if}
