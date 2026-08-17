<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import RepoPicker from "./RepoPicker.svelte";
  import { openRepoModalOpen } from "../stores/repoSync";
  import { createWorkspaceFromRepo } from "../repo-sync";

  function close() {
    openRepoModalOpen.set(false);
  }

  async function pickRepo(owner: string, repo: string, branch: string) {
    // Closed immediately, before the pull even starts — otherwise this
    // modal stays open the whole time, its own busy-button state
    // competing with createWorkspaceFromRepo's separate progress toast
    // for attention instead of the toast being the sole indicator.
    close();
    try {
      await createWorkspaceFromRepo(owner, repo, branch);
    } catch (err: any) {
      // createWorkspaceFromRepo already finished its own progress toast
      // as an error — nothing left to show here.
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
