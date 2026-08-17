<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import RepoPicker from "./RepoPicker.svelte";
  import { openRepoModalOpen } from "../stores/repoSync";
  import { createWorkspaceFromRepo } from "../repo-sync";
  import { showToast } from "../stores/toast";

  function close() {
    openRepoModalOpen.set(false);
  }

  async function pickRepo(owner: string, repo: string, branch: string) {
    try {
      await createWorkspaceFromRepo(owner, repo, branch);
      close();
      showToast(`Opened ${owner}/${repo}`, "success");
    } catch (err: any) {
      showToast(err.message || "Couldn't open that repo", "error");
    }
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $openRepoModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $openRepoModalOpen}
  <Modal title="Open GitHub Repo as Workspace" icon="icon-github" wide labelledBy="openRepoModalTitle" onClose={close}>
    {#snippet quickAction()}
      <Toggletip>Creates a new workspace, links it to the repo you pick, and pulls every .md file in right away. Already have a workspace linked to that repo? Switches to it instead of making a duplicate.</Toggletip>
    {/snippet}
    <RepoPicker open={$openRepoModalOpen} pickLabel="Open" pickBusyLabel="Opening…" createLabel="Create & Open" onPick={pickRepo} />
  </Modal>
{/if}
