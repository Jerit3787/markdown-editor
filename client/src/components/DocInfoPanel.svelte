<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { docInfoPanelOpen } from "../stores/docInfoPanel";
  import { activeIdStore, activeDocContent, getActiveDoc, docsStore, switchDoc } from "../stores/docs";
  import { workspacesStore } from "../stores/workspaces";
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
    {#if doc.repoPath || doc.gistId}
      <div class="menu-section-label">Synced to</div>
      {#if doc.repoPath}
        {@const workspace = $workspacesStore.find((w) => w.id === doc.workspaceId)}
        {#if workspace?.repoLink}
          <div class="doc-info-row">
            <span class="doc-info-primary">Repo</span>
            <a
              class="doc-info-secondary doc-info-link"
              href={`https://github.com/${workspace.repoLink.owner}/${workspace.repoLink.repo}/blob/${workspace.repoLink.branch}/${doc.repoPath}`}
              target="_blank"
              rel="noopener"
            >
              {workspace.repoLink.owner}/{workspace.repoLink.repo} — {doc.repoPath}
            </a>
          </div>
        {/if}
      {/if}
      {#if doc.gistId}
        <div class="doc-info-row">
          <span class="doc-info-primary">Gist</span>
          <a class="doc-info-secondary doc-info-link" href={`https://gist.github.com/${doc.gistId}`} target="_blank" rel="noopener">
            View on GitHub
          </a>
        </div>
      {/if}
    {/if}
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
