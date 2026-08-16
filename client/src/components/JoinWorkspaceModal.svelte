<script lang="ts">
  import Modal from "./Modal.svelte";
  import { pendingJoin } from "../stores/joinWorkspace";
  import { workspacesStore, adoptSharedWorkspace, mergeSharedWorkspaceInto, switchWorkspace } from "../stores/workspaces";
  import { importRemoteDocs, switchDoc } from "../stores/docs";

  let mergeTargetId = $state<string | null>(null);

  function cancel() {
    pendingJoin.set(null);
  }

  function addAsNew() {
    const state = $pendingJoin;
    if (!state) return;
    const ws = adoptSharedWorkspace(state.remoteId, state.workspaceName);
    importRemoteDocs(ws.id, state.docs);
    switchWorkspace(ws.id);
    switchDoc(state.landOnDocId);
    pendingJoin.set(null);
  }

  function merge() {
    const state = $pendingJoin;
    if (!state || !mergeTargetId) return;
    mergeSharedWorkspaceInto(mergeTargetId, state.remoteId);
    importRemoteDocs(mergeTargetId, state.docs);
    switchWorkspace(mergeTargetId);
    switchDoc(state.landOnDocId);
    pendingJoin.set(null);
  }
</script>

{#if $pendingJoin}
  <Modal title="Join shared workspace" labelledBy="joinWorkspaceTitle" onClose={cancel}>
    <p>"{$pendingJoin.workspaceName}" has been shared with you. Add it as a new workspace of its own, or merge its documents into one you already have?</p>

    <div class="menu-section-label">Merge into an existing workspace</div>
    <select bind:value={mergeTargetId} aria-label="Choose a workspace to merge into">
      <option value={null}>Choose a workspace…</option>
      {#each $workspacesStore as ws (ws.id)}
        <option value={ws.id}>{ws.name}</option>
      {/each}
    </select>

    {#snippet footer()}
      <button type="button" class="secondary-btn" onclick={cancel}>Cancel</button>
      <button type="button" class="secondary-btn" disabled={!mergeTargetId} onclick={merge}>Merge in</button>
      <button type="button" class="primary-btn" onclick={addAsNew}>Add as new workspace</button>
    {/snippet}
  </Modal>
{/if}
