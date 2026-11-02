<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { openDriveModalOpen, driveSyncBusyLabel, driveConnected } from "../stores/driveSync";
  import { repoConflictModalOpen, repoConflictState } from "../stores/repoSync";
  import { openDriveFolderAsWorkspace, DriveReconnectError } from "../drive-sync";
  import { showProgressToast, updateProgressToast, finishProgressToast, dismissToast } from "../stores/toast";
  import { docsInWorkspace } from "../stores/docs";

  interface DriveFolder {
    folderId: string;
    folderName: string;
    workspaceId: string | null;
    modifiedTime: string | null;
  }

  let folders = $state<DriveFolder[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  function close() {
    openDriveModalOpen.set(false);
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await fetch("/api/drive/folders");
      if (res.status === 401) {
        driveConnected.set(false);
        close();
        window.MDE.connectGoogleDrive?.();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { folders?: DriveFolder[] };
      folders = data.folders ?? [];
    } catch (err) {
      error = err instanceof Error ? err.message : "Couldn't list Drive folders";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if ($openDriveModalOpen) void load();
  });

  function modifiedLabel(folder: DriveFolder): string {
    if (!folder.modifiedTime) return "";
    const timestamp = Date.parse(folder.modifiedTime);
    return Number.isFinite(timestamp) ? `Modified ${window.MDE.formatRelativeTime(timestamp)}` : "";
  }

  function docNameFor(workspaceId: string, docId: string): string {
    return docsInWorkspace(workspaceId).find((doc) => doc.id === docId)?.name || "Untitled";
  }

  async function choose(folder: DriveFolder): Promise<void> {
    close();
    driveSyncBusyLabel.set("Opening…");
    const toastId = showProgressToast("Opening from Google Drive…");
    try {
      const result = await openDriveFolderAsWorkspace(folder, (message) => updateProgressToast(toastId, message));
      if (result.kind === "switch") {
        finishProgressToast(toastId, `Switched to ${folder.folderName}`, "success");
        return;
      }
      if (result.plan.conflicts.length > 0 || result.plan.deletions.length > 0) {
        dismissToast(toastId);
        repoConflictState.set({
          kind: "pull",
          source: "drive",
          conflicts: result.plan.conflicts.map((conflict) => ({
            docId: conflict.docId,
            docName: docNameFor(result.workspace.id, conflict.docId),
            repoPath: conflict.drivePath,
          })),
          deletions: result.plan.deletions.map((deletion) => ({
            docId: deletion.docId,
            docName: docNameFor(result.workspace.id, deletion.docId),
            repoPath: deletion.drivePath,
          })),
          onResolve: result.applyResolved,
        });
        repoConflictModalOpen.set(true);
      } else {
        finishProgressToast(toastId, `Opened ${folder.folderName} from Google Drive`, "success");
      }
    } catch (err) {
      if (err instanceof DriveReconnectError) {
        driveConnected.set(false);
        finishProgressToast(toastId, "Google Drive disconnected — reconnect to sync", "error");
        window.MDE.connectGoogleDrive?.();
      } else {
        finishProgressToast(toastId, err instanceof Error ? err.message : "Couldn't open that folder", "error");
      }
    } finally {
      driveSyncBusyLabel.set(null);
    }
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $openDriveModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $openDriveModalOpen}
  <Modal title="Open a synced folder" icon="icon-cloud" wide labelledBy="openDriveModalTitle" onClose={close}>
    <p class="menu-hint">Folders this app created in your Google Drive. Opening one pulls its markdown and images into a new workspace.</p>
    {#if loading}
      <div class="empty-state"><div class="empty-state-desc">Loading folders…</div></div>
    {:else if error}
      <div class="empty-state"><div class="empty-state-title">Couldn't list folders</div><div class="empty-state-desc">{error}</div></div>
    {:else if folders.length === 0}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-cloud"></use></svg>
        <div class="empty-state-title">No synced folders yet</div>
        <div class="empty-state-desc">Link a workspace to Google Drive first, or connect on another device and push.</div>
      </div>
    {:else}
      {#each folders as folder (folder.folderId)}
        <button type="button" class="gist-item open-drive-row" onclick={() => choose(folder)}>
          <span class="gist-meta">
            <span class="gist-name">{folder.folderName}</span>
            <span class="gist-date">{modifiedLabel(folder)}</span>
          </span>
          <svg class="icon"><use href="#icon-chevron-right"></use></svg>
        </button>
      {/each}
    {/if}
  </Modal>
{/if}

<style>
  .open-drive-row {
    width: 100%;
    justify-content: space-between;
  }
</style>
