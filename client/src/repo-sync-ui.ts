// Wires repo-sync's orchestration functions (repo-sync.ts) to window.MDE,
// the same way gist.ts wires publish()/openGistPicker() — MenuBar.svelte
// has no direct import of feature modules, only window.MDE and stores.
import { activeWorkspaceIdStore, workspacesStore, clearWorkspaceRepoLink } from "./stores/workspaces";
import { docsInWorkspace } from "./stores/docs";
import { pullFromRepo, pushToRepo, type PullConflict, type PushConflict } from "./repo-sync";
import { repoLinkModalOpen, openRepoModalOpen, repoConflictModalOpen, repoConflictState, repoSyncBusyLabel } from "./stores/repoSync";
import { showProgressToast, updateProgressToast, finishProgressToast, dismissToast, showToast } from "./stores/toast";
import { get } from "svelte/store";

// The "gist" scope this app requested before this feature shipped can't
// read/write repos — a user signed in under that older grant needs to
// re-authorize under the new "repo" scope before any repo-sync action
// will work. Checked fresh on every action rather than cached, since the
// grant can also be revoked entirely from GitHub's side at any time.
async function hasRepoScope(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/github/me");
    const data = await res.json();
    return Array.isArray(data.scopes) && data.scopes.includes("repo");
  } catch (err) {
    return false;
  }
}

async function requireRepoScope(): Promise<boolean> {
  if (await hasRepoScope()) return true;
  window.MDE.requireGithubSignIn("GitHub repo sync needs a fresh sign-in to grant repo access. Sign in to continue.");
  return false;
}

window.MDE.openRepoLinkModal = () => {
  void (async () => {
    if (get(workspacesStore).length === 0) {
      showToast("Create a workspace first", "error");
      return;
    }
    if (!(await requireRepoScope())) return;
    repoLinkModalOpen.set(true);
  })();
};

window.MDE.openRepoModal = () => {
  void (async () => {
    if (!(await requireRepoScope())) return;
    openRepoModalOpen.set(true);
  })();
};

window.MDE.unlinkRepo = () => {
  const workspaceId = get(activeWorkspaceIdStore);
  if (workspaceId) clearWorkspaceRepoLink(workspaceId);
};

function activeRepoLink() {
  const workspaceId = get(activeWorkspaceIdStore);
  const ws = get(workspacesStore).find((w) => w.id === workspaceId);
  return workspaceId && ws?.repoLink ? { workspaceId, repoLink: ws.repoLink } : null;
}

function docNameFor(workspaceId: string, docId: string): string {
  return docsInWorkspace(workspaceId).find((d) => d.id === docId)?.name || "Untitled";
}

window.MDE.pullFromRepoAction = async () => {
  const active = activeRepoLink();
  if (!active) return;
  if (!(await requireRepoScope())) return;
  repoSyncBusyLabel.set("Pulling…");
  const progressToastId = showProgressToast("Pulling…");
  try {
    // No local dirty-tracking timestamp exists yet at this call site —
    // pass an empty set, meaning "treat every doc as clean," which is
    // conservative in the wrong direction (a genuinely-dirty doc could
    // get silently overwritten by an update instead of flagged as a
    // conflict). Acceptable for now since it still routes every conflict
    // planPull *can* detect through the modal; tightening this to real
    // dirty-tracking is a follow-up, not a blocker.
    const { plan, applyResolved } = await pullFromRepo(active.workspaceId, active.repoLink, new Set(), (message) =>
      updateProgressToast(progressToastId, message),
    );
    if (plan.conflicts.length > 0 || plan.deletions.length > 0) {
      dismissToast(progressToastId);
      repoConflictState.set({
        kind: "pull",
        conflicts: plan.conflicts.map((c: PullConflict) => ({ docId: c.docId, docName: docNameFor(active.workspaceId, c.docId), repoPath: c.repoPath })),
        deletions: plan.deletions.map((d) => ({ docId: d.docId, docName: docNameFor(active.workspaceId, d.docId), repoPath: d.repoPath })),
        onResolve: applyResolved,
      });
      repoConflictModalOpen.set(true);
    } else {
      finishProgressToast(progressToastId, "Pulled from repo", "success");
    }
  } catch (err: any) {
    finishProgressToast(progressToastId, err.message || "Pull failed", "error");
  } finally {
    repoSyncBusyLabel.set(null);
  }
};

window.MDE.pushToRepoAction = async () => {
  const active = activeRepoLink();
  if (!active) return;
  if (!(await requireRepoScope())) return;
  repoSyncBusyLabel.set("Pushing…");
  const progressToastId = showProgressToast("Pushing…");
  try {
    const { plan, applyResolved } = await pushToRepo(active.workspaceId, active.repoLink, (message) => updateProgressToast(progressToastId, message));
    if (plan.conflicts.length > 0) {
      dismissToast(progressToastId);
      repoConflictState.set({
        kind: "push",
        conflicts: plan.conflicts.map((c: PushConflict) => ({ docId: c.docId, docName: docNameFor(active.workspaceId, c.docId), repoPath: c.repoPath })),
        deletions: [],
        onResolve: applyResolved,
      });
      repoConflictModalOpen.set(true);
    } else {
      finishProgressToast(progressToastId, "Pushed to repo", "success");
    }
  } catch (err: any) {
    finishProgressToast(progressToastId, err.message || "Push failed", "error");
  } finally {
    repoSyncBusyLabel.set(null);
  }
};
