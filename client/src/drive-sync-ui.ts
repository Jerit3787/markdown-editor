// Wires folder-sync orchestration (drive-sync.ts) to window.MDE and the
// conflict modal — the Drive sibling of repo-sync-ui.ts. MenuBar has no
// direct import of feature modules, only window.MDE and stores.
import { get } from "svelte/store";
import { activeWorkspaceIdStore, clearWorkspaceDriveLink, workspacesStore } from "./stores/workspaces";
import { docsInWorkspace } from "./stores/docs";
import { pullFromDrive, pushToDrive, DriveReconnectError } from "./drive-sync";
import { driveConnected, driveSyncBusyLabel, linkDriveModalOpen, openDriveModalOpen } from "./stores/driveSync";
import { repoConflictModalOpen, repoConflictState } from "./stores/repoSync";
import { showProgressToast, updateProgressToast, finishProgressToast, dismissToast, showToast } from "./stores/toast";
import { confirmAction } from "./stores/confirmDialog";

function activeDriveLink(): { workspaceId: string; folderId: string } | null {
  const workspaceId = get(activeWorkspaceIdStore);
  const workspace = get(workspacesStore).find((item) => item.id === workspaceId);
  return workspaceId && workspace?.driveLink ? { workspaceId, folderId: workspace.driveLink.folderId } : null;
}

function docNameFor(workspaceId: string, docId: string): string {
  return docsInWorkspace(workspaceId).find((doc) => doc.id === docId)?.name || "Untitled";
}

function openConflicts(
  kind: "pull" | "push",
  workspaceId: string,
  conflicts: { docId: string; docName: string; drivePath: string }[],
  deletions: { docId: string; docName: string; drivePath: string }[],
  onResolve: (resolutions: Record<string, "mine" | "theirs">) => Promise<void>,
): void {
  repoConflictState.set({
    kind,
    source: "drive",
    conflicts: conflicts.map((conflict) => ({ docId: conflict.docId, docName: docNameFor(workspaceId, conflict.docId), repoPath: conflict.drivePath })),
    deletions: deletions.map((deletion) => ({ docId: deletion.docId, docName: docNameFor(workspaceId, deletion.docId), repoPath: deletion.drivePath })),
    onResolve,
  });
  repoConflictModalOpen.set(true);
}

function handleDriveError(toastId: number, err: unknown, fallback: string): void {
  if (err instanceof DriveReconnectError) {
    driveConnected.set(false);
    finishProgressToast(toastId, "Google Drive disconnected — reconnect to sync", "error");
    window.MDE.connectGoogleDrive?.();
    return;
  }
  finishProgressToast(toastId, err instanceof Error ? err.message : fallback, "error");
}

window.MDE.openDriveFolderPicker = () => {
  if (!get(driveConnected)) {
    window.MDE.connectGoogleDrive?.();
    return;
  }
  openDriveModalOpen.set(true);
};

window.MDE.openDriveLinkModal = () => {
  if (get(workspacesStore).length === 0) {
    showToast("Create a workspace first", "error");
    return;
  }
  if (!get(driveConnected)) {
    window.MDE.connectGoogleDrive?.();
    return;
  }
  linkDriveModalOpen.set(true);
};

window.MDE.unlinkDrive = () => {
  const workspaceId = get(activeWorkspaceIdStore);
  if (!workspaceId) return;
  clearWorkspaceDriveLink(workspaceId);
  showToast("Unlinked from Google Drive — the folder was kept", "success");
};

window.MDE.disconnectDriveAction = async () => {
  const confirmed = await confirmAction(
    "Disconnect Google Drive?",
    "Every Drive-linked workspace stops syncing until you reconnect. The folders themselves are kept.",
    "Disconnect",
  );
  if (!confirmed) return;
  await window.MDE.disconnectGoogleDrive?.();
  showToast("Disconnected Google Drive", "success");
};

window.MDE.pullFromDriveAction = async () => {
  const active = activeDriveLink();
  if (!active) return;
  driveSyncBusyLabel.set("Pulling…");
  const toastId = showProgressToast("Pulling from Google Drive…");
  try {
    const { plan, applyResolved, failures } = await pullFromDrive(active.workspaceId, new Set(), (message) => updateProgressToast(toastId, message));
    if (plan.conflicts.length > 0 || plan.deletions.length > 0) {
      dismissToast(toastId);
      openConflicts("pull", active.workspaceId, plan.conflicts, plan.deletions, applyResolved);
    } else if (failures.length > 0) {
      finishProgressToast(toastId, `Pulled with ${failures.length} file${failures.length === 1 ? "" : "s"} failed — pull again to retry`, "info", 5000);
    } else {
      finishProgressToast(toastId, "Pulled from Google Drive", "success");
    }
  } catch (err) {
    handleDriveError(toastId, err, "Pull failed");
  } finally {
    driveSyncBusyLabel.set(null);
  }
};

window.MDE.pushToDriveAction = async () => {
  const active = activeDriveLink();
  if (!active) return;
  driveSyncBusyLabel.set("Pushing…");
  const toastId = showProgressToast("Pushing to Google Drive…");
  try {
    const { plan, result, applyResolved } = await pushToDrive(active.workspaceId, (message) => updateProgressToast(toastId, message));
    if (plan.conflicts.length > 0) {
      dismissToast(toastId);
      openConflicts("push", active.workspaceId, plan.conflicts, [], applyResolved);
      return;
    }
    const failed = result?.failed ?? 0;
    if (failed > 0) {
      const synced = result?.synced ?? 0;
      finishProgressToast(toastId, `Pushed ${synced} of ${synced + failed} files to Drive — push again to retry`, "info", 5000);
    } else {
      finishProgressToast(toastId, "Pushed to Google Drive", "success");
    }
  } catch (err) {
    handleDriveError(toastId, err, "Push failed");
  } finally {
    driveSyncBusyLabel.set(null);
  }
};
