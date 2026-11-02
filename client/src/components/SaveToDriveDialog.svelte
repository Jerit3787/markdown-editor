<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { driveExportRequest } from "../stores/driveExport";

  let name = $state("");
  let folderId = $state<string | undefined>(undefined);
  let folderName = $state<string | null>(null);
  let busy = $state(false);

  // Re-seed the fields every time a new save request opens the dialog.
  $effect(() => {
    if ($driveExportRequest) {
      name = $driveExportRequest.defaultName;
      folderId = undefined;
      folderName = null;
    }
  });

  function cancel() {
    $driveExportRequest?.resolve(null);
    driveExportRequest.set(null);
  }

  async function chooseFolder() {
    busy = true;
    try {
      const folder = await window.MDE.pickDriveFolder?.();
      if (folder) {
        folderId = folder.id;
        folderName = folder.name;
      }
    } finally {
      busy = false;
    }
  }

  function save() {
    if (!$driveExportRequest || !name.trim()) return;
    $driveExportRequest.resolve({ name: name.trim(), parentFolderId: folderId, parentFolderName: folderName ?? undefined });
    driveExportRequest.set(null);
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $driveExportRequest) cancel();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $driveExportRequest}
  <Modal title="Save to Google Drive" icon="icon-cloud" labelledBy="saveToDriveTitle" onClose={cancel}>
    <label for="driveExportName" class="menu-section-label">File name</label>
    <input
      id="driveExportName"
      type="text"
      bind:value={name}
      onkeydown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          save();
        }
      }}
    />
    <div class="drive-folder-row">
      <span class="menu-hint">Folder: {folderName ?? "My Drive"}</span>
      <button type="button" class="secondary-btn" onclick={chooseFolder} disabled={busy}>Choose folder…</button>
    </div>
    {#snippet footer()}
      <button type="button" class="secondary-btn" onclick={cancel}>Cancel</button>
      <button type="button" class="primary-btn" onclick={save} disabled={!name.trim() || busy}>Save</button>
    {/snippet}
  </Modal>
{/if}

<style>
  .drive-folder-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 14px;
  }
  .menu-hint {
    font-size: 13px;
    opacity: 0.75;
  }
</style>
