<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import RepoPicker from "./RepoPicker.svelte";
  import { repoLinkModalOpen, repoSyncBusyLabel, repoConflictModalOpen, repoConflictState } from "../stores/repoSync";
  import { activeWorkspaceIdStore } from "../stores/workspaces";
  import { docsInWorkspace } from "../stores/docs";
  import { linkWorkspaceAndSync } from "../repo-sync";
  import { finishProgressToast, dismissToast } from "../stores/toast";

  function close() {
    repoLinkModalOpen.set(false);
  }

  function docNameFor(workspaceId: string, docId: string): string {
    return docsInWorkspace(workspaceId).find((d) => d.id === docId)?.name || "Untitled";
  }

  async function linkWorkspace(owner: string, repo: string, branch: string) {
    const workspaceId = $activeWorkspaceIdStore;
    if (!workspaceId) return;
    // Closed immediately, before the sync even starts — same reasoning
    // as OpenRepoModal.svelte's pickRepo: the progress toast should be
    // the only "what's happening" indicator on screen, not competing
    // with a still-open modal for the whole operation's duration. Both
    // possible outcomes below (push-conflict / pull results with
    // conflicts) open their OWN separate modal (repoConflictModalOpen),
    // which is unaffected by whether this modal already closed.
    close();
    try {
      const result = await linkWorkspaceAndSync(workspaceId, { owner, repo, branch });
      if (result.kind === "push-conflict") {
        dismissToast(result.progressToastId);
        repoConflictState.set({
          kind: "push",
          conflicts: result.pushPlan.conflicts.map((c) => ({ docId: c.docId, docName: docNameFor(workspaceId, c.docId), repoPath: c.repoPath })),
          deletions: [],
          onResolve: result.applyPushResolved,
        });
        repoConflictModalOpen.set(true);
        return;
      }
      const { pullPlan, applyPullResolved, progressToastId } = result;
      if (pullPlan.conflicts.length > 0 || pullPlan.deletions.length > 0) {
        dismissToast(progressToastId);
        repoConflictState.set({
          kind: "pull",
          conflicts: pullPlan.conflicts.map((c) => ({ docId: c.docId, docName: docNameFor(workspaceId, c.docId), repoPath: c.repoPath })),
          deletions: pullPlan.deletions.map((d) => ({ docId: d.docId, docName: docNameFor(workspaceId, d.docId), repoPath: d.repoPath })),
          onResolve: applyPullResolved,
        });
        repoConflictModalOpen.set(true);
      } else {
        finishProgressToast(progressToastId, `Linked to ${owner}/${repo}`, "success");
      }
    } catch (err: any) {
      // linkWorkspaceAndSync already finished the progress toast as an
      // error before rethrowing — nothing left to show here.
    } finally {
      repoSyncBusyLabel.set(null);
    }
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $repoLinkModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $repoLinkModalOpen}
  <Modal title="Link Workspace to GitHub Repo" icon="icon-github" wide labelledBy="repoLinkModalTitle" onClose={close}>
    {#snippet quickAction()}
      <Toggletip>Every .md file in the repo's tree becomes a doc in this workspace. Pick an existing repo, paste one, or create a new one.</Toggletip>
    {/snippet}
    <RepoPicker open={$repoLinkModalOpen} onPick={linkWorkspace} />
  </Modal>
{/if}
