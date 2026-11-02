<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { linkDriveModalOpen, driveSyncBusyLabel, driveConnected } from "../stores/driveSync";
  import { repoConflictModalOpen, repoConflictState } from "../stores/repoSync";
  import { activeWorkspaceIdStore, workspacesStore } from "../stores/workspaces";
  import { docsInWorkspace } from "../stores/docs";
  import { linkWorkspaceToDrive, DriveReconnectError } from "../drive-sync";
  import { showProgressToast, updateProgressToast, finishProgressToast, dismissToast } from "../stores/toast";
  import { track } from "../analytics";

  let folderName = $state("");
  let busy = $state(false);

  const workspace = $derived($workspacesStore.find((item) => item.id === $activeWorkspaceIdStore));

  $effect(() => {
    if ($linkDriveModalOpen) folderName = workspace?.name || "Notes";
  });

  function close() {
    linkDriveModalOpen.set(false);
  }

  function docNameFor(workspaceId: string, docId: string): string {
    return docsInWorkspace(workspaceId).find((doc) => doc.id === docId)?.name || "Untitled";
  }

  async function create(): Promise<void> {
    const workspaceId = $activeWorkspaceIdStore;
    const name = folderName.trim();
    if (!workspaceId || !name || busy) return;
    busy = true;
    close();
    driveSyncBusyLabel.set("Pushing…");
    const toastId = showProgressToast("Creating the Drive folder…");
    try {
      const { plan, result, applyResolved } = await linkWorkspaceToDrive(workspaceId, name, (message) => updateProgressToast(toastId, message));
      if (plan.conflicts.length > 0) {
        dismissToast(toastId);
        repoConflictState.set({
          kind: "push",
          source: "drive",
          conflicts: plan.conflicts.map((conflict) => ({
            docId: conflict.docId,
            docName: docNameFor(workspaceId, conflict.docId),
            repoPath: conflict.drivePath,
          })),
          deletions: [],
          onResolve: applyResolved,
        });
        repoConflictModalOpen.set(true);
        return;
      }
      if (result?.failed) {
        finishProgressToast(toastId, `Linked to “${name}” — ${result.failed} file${result.failed === 1 ? "" : "s"} failed to upload`, "info");
      } else {
        finishProgressToast(toastId, `Linked to “${name}” in Google Drive`, "success");
        track("linked_drive");
      }
    } catch (err) {
      if (err instanceof DriveReconnectError) {
        driveConnected.set(false);
        finishProgressToast(toastId, "Google Drive disconnected — reconnect to sync", "error");
        window.MDE.connectGoogleDrive?.();
      } else {
        finishProgressToast(toastId, err instanceof Error ? err.message : "Couldn't link this workspace", "error");
      }
    } finally {
      busy = false;
      driveSyncBusyLabel.set(null);
    }
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $linkDriveModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $linkDriveModalOpen}
  <Modal title="Link Workspace to Google Drive" icon="icon-cloud" labelledBy="linkDriveModalTitle" onClose={close}>
    {#snippet quickAction()}
      <p class="menu-hint">Creates a new folder in your Google Drive and pushes every document in this workspace into it. Later pulls and pushes stay in sync.</p>
    {/snippet}
    <label for="driveFolderName" class="menu-section-label">Folder name</label>
    <input
      id="driveFolderName"
      type="text"
      bind:value={folderName}
      onkeydown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void create();
        }
      }}
    />
    <div class="menu-hint link-drive-note">The folder is created by this app, so it stays accessible on every device where you connect Drive.</div>
    {#snippet footer()}
      <button type="button" class="secondary-btn" onclick={close} disabled={busy}>Cancel</button>
      <button type="button" class="primary-btn" onclick={create} disabled={busy || !folderName.trim()}>Create folder</button>
    {/snippet}
  </Modal>
{/if}

<style>
  .link-drive-note {
    margin-top: 12px;
  }
</style>
