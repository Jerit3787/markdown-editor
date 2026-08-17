<script lang="ts">
  import Modal from "./Modal.svelte";
  import { moveToWorkspaceDocId, closeMoveToWorkspaceModal } from "../stores/moveToWorkspace";
  import { docsStore, activeIdStore, findDocById, moveDocToWorkspace, ensureActiveDocInWorkspace } from "../stores/docs";
  import { workspacesStore, activeWorkspaceIdStore } from "../stores/workspaces";

  const doc = $derived($moveToWorkspaceDocId ? findDocById($moveToWorkspaceDocId) : undefined);
  const otherWorkspaces = $derived($workspacesStore.filter((w) => w.id !== doc?.workspaceId));
  const docCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const d of $docsStore) counts.set(d.workspaceId, (counts.get(d.workspaceId) || 0) + 1);
    return counts;
  });

  function pick(workspaceId: string) {
    const docId = $moveToWorkspaceDocId;
    if (!docId) return;
    moveDocToWorkspace(docId, workspaceId);
    // Moving the currently-open document out of the active workspace
    // needs the same active-doc fixup switching workspaces does.
    if (docId === $activeIdStore && $activeWorkspaceIdStore) ensureActiveDocInWorkspace($activeWorkspaceIdStore);
    closeMoveToWorkspaceModal();
  }
</script>

{#if $moveToWorkspaceDocId && doc}
  <Modal title={`Move "${doc.name || "Untitled"}" to Workspace`} labelledBy="moveToWorkspaceModalTitle" onClose={closeMoveToWorkspaceModal}>
    <div class="images-list">
      {#each otherWorkspaces as ws (ws.id)}
        {@const count = docCounts.get(ws.id) || 0}
        <div class="gist-item">
          <div class="gist-meta">
            <div class="gist-name">{ws.name}</div>
            <div class="gist-date">{count} document{count === 1 ? "" : "s"}</div>
          </div>
          <button class="secondary-btn" type="button" onclick={() => pick(ws.id)}>Move</button>
        </div>
      {:else}
        <div class="empty-state">
          <div class="empty-state-title">No other workspaces</div>
          <div class="empty-state-desc">Create another workspace first to move this document into it.</div>
        </div>
      {/each}
    </div>
  </Modal>
{/if}
