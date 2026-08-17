<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import RepoPicker from "./RepoPicker.svelte";
  import { repoLinkModalOpen } from "../stores/repoSync";
  import { activeWorkspaceIdStore, setWorkspaceRepoLink } from "../stores/workspaces";
  import { showToast } from "../stores/toast";

  function close() {
    repoLinkModalOpen.set(false);
  }

  function linkWorkspace(owner: string, repo: string, branch: string) {
    const workspaceId = $activeWorkspaceIdStore;
    if (!workspaceId) return;
    setWorkspaceRepoLink(workspaceId, { owner, repo, branch });
    close();
    showToast(`Linked to ${owner}/${repo}`, "success");
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
