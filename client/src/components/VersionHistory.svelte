<script lang="ts">
  import { onMount } from "svelte";
  import { versionHistoryOpen } from "../stores/versionHistory";
  import { getActiveDoc } from "../stores/docs";
  import {
    listVersions,
    getVersionContent,
    restoreLocalVersion,
    listSharedVersions,
    getSharedVersionContent,
    restoreSharedVersion,
    type VersionSummary,
  } from "../history";
  import { renderVersionPreview } from "../version-preview";
  import { showToast } from "../stores/toast";

  let versions = $state<VersionSummary[]>([]);
  let selectedId = $state<string | null>(null);
  let previewEl: HTMLDivElement | undefined = $state();
  let loading = $state(false);
  let restoring = $state(false);
  // Re-checked each time the overlay opens (see loadVersions) — a local
  // document is always restorable; a shared one only if this client
  // currently has editor access, mirroring the server's own 403 gate so
  // the button isn't shown as available when it would just fail.
  let restoreAllowed = $state(true);

  function close() {
    versionHistoryOpen.set(false);
  }

  async function selectVersion(doc: ReturnType<typeof getActiveDoc>, isShared: boolean, id: string) {
    selectedId = id;
    if (!doc || !previewEl) return;
    const content = isShared ? await getSharedVersionContent(doc.id, id) : await getVersionContent(doc.id, id);
    if (content !== undefined && previewEl) await renderVersionPreview(content, doc, previewEl);
  }

  async function loadVersions() {
    const doc = getActiveDoc();
    if (!doc) {
      versions = [];
      return;
    }
    const isShared = !!doc.shared;
    restoreAllowed = !isShared || !window.MDE.getEditor().state.readOnly;
    loading = true;
    versions = isShared ? await listSharedVersions(doc.id) : await listVersions(doc.id);
    loading = false;
    if (versions.length > 0) await selectVersion(doc, isShared, versions[0]!.id);
    else selectedId = null;
  }

  async function restore() {
    const doc = getActiveDoc();
    if (!doc || !selectedId || restoring) return;
    restoring = true;
    const isShared = !!doc.shared;
    if (isShared) {
      const ok = await restoreSharedVersion(doc.id, selectedId);
      if (ok) {
        showToast("Version restored", "success");
        close();
      } else {
        showToast("Couldn't restore this version", "error");
      }
    } else {
      const content = await restoreLocalVersion(doc.id, selectedId);
      if (content !== undefined) {
        const cm = window.MDE.getEditor();
        cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: content } });
        showToast("Version restored", "success");
        close();
      } else {
        showToast("Couldn't restore this version", "error");
      }
    }
    restoring = false;
  }

  function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  $effect(() => {
    if ($versionHistoryOpen) void loadVersions();
  });

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $versionHistoryOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    // Topbar icon button, next to Share — same open() this component's own
    // File-menu entry (MenuBar.svelte) triggers, matching Settings.svelte's
    // own #settingsBtn wiring pattern for a header-icon-triggered overlay.
    const open = () => versionHistoryOpen.set(true);
    document.getElementById("versionHistoryBtn")?.addEventListener("click", open);
    return () => {
      document.removeEventListener("keydown", onKeydown);
      document.getElementById("versionHistoryBtn")?.removeEventListener("click", open);
    };
  });
</script>

{#if $versionHistoryOpen}
  <div class="version-history-overlay" role="dialog" aria-modal="true" aria-labelledby="versionHistoryTitle">
    <div class="version-history-header">
      <h2 id="versionHistoryTitle">Version history</h2>
      <button type="button" class="secondary-btn" onclick={close}>Close</button>
    </div>
    <div class="version-history-body">
      <div class="version-history-list">
        {#if loading}
          <p class="modal-hint">Loading…</p>
        {:else if versions.length === 0}
          <p class="modal-hint">No versions yet — history builds up automatically as you edit.</p>
        {:else}
          {#each versions as v, i (v.id)}
            <button
              type="button"
              class="version-history-row"
              class:active={v.id === selectedId}
              onclick={() => selectVersion(getActiveDoc(), !!getActiveDoc()?.shared, v.id)}
            >
              <span>{formatTimestamp(v.timestamp)}</span>
              {#if i === 0}<span class="version-history-current">(current)</span>{/if}
            </button>
          {/each}
        {/if}
      </div>
      <div class="version-history-preview-wrap">
        <div class="version-history-preview" bind:this={previewEl}></div>
        <div class="version-history-actions">
          <button type="button" class="primary-btn" disabled={!selectedId || restoring || !restoreAllowed} onclick={restore}>
            Restore this version
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
