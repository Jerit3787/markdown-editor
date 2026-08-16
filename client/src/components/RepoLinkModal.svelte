<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import { repoLinkModalOpen } from "../stores/repoSync";
  import { githubUsername } from "../stores/github";
  import { activeWorkspaceIdStore } from "../stores/workspaces";
  import { setWorkspaceRepoLink } from "../stores/workspaces";
  import { showToast } from "../stores/toast";

  let repos = $state<any[]>([]);
  let listTitle = $state("");
  let listHint = $state("Sign in with GitHub to see your own repos here.");
  let manualInput = $state("");
  let newRepoName = $state("");
  let newRepoPrivate = $state(true);
  let busyKey = $state<string | null>(null);
  const CREATE_KEY = "__create__";
  const MANUAL_KEY = "__manual__";

  function close() {
    repoLinkModalOpen.set(false);
  }

  async function loadRepoList() {
    if (!$githubUsername) {
      listTitle = "Sign in required";
      listHint = "Sign in with GitHub to see your own repos here.";
      repos = [];
      return;
    }
    listTitle = "Loading…";
    listHint = "Loading your repos…";
    try {
      const res = await fetch("/api/repo/list");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      repos = await res.json();
      listTitle = repos.length === 0 ? "No repos" : "";
      listHint = repos.length === 0 ? "No repos found." : "";
    } catch {
      listTitle = "Error";
      listHint = "Couldn't load your repos.";
      repos = [];
    }
  }

  function linkWorkspace(owner: string, repo: string, branch: string) {
    const workspaceId = $activeWorkspaceIdStore;
    if (!workspaceId) return;
    setWorkspaceRepoLink(workspaceId, { owner, repo, branch });
    close();
    showToast(`Linked to ${owner}/${repo}`, "success");
  }

  async function link(fullName: string, defaultBranch: string, key: string) {
    busyKey = key;
    try {
      const [owner, repo] = fullName.split("/");
      linkWorkspace(owner!, repo!, defaultBranch);
    } finally {
      busyKey = null;
    }
  }

  function linkFromManualInput() {
    const trimmed = manualInput.trim().replace(/^https?:\/\/github\.com\//, "");
    const [owner, repo] = trimmed.split("/");
    if (!owner || !repo) {
      showToast("Enter a repo as owner/repo", "error");
      return;
    }
    linkWorkspace(owner, repo.replace(/\.git$/, ""), "main");
  }

  async function createAndLink() {
    const name = newRepoName.trim();
    if (!name) return;
    busyKey = CREATE_KEY;
    try {
      const res = await fetch("/api/repo/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, private: newRepoPrivate }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const [owner, repo] = data.full_name.split("/");
      linkWorkspace(owner, repo, data.default_branch || "main");
    } catch {
      showToast("Couldn't create the repo", "error");
    } finally {
      busyKey = null;
    }
  }

  $effect(() => {
    if ($repoLinkModalOpen) {
      manualInput = "";
      newRepoName = "";
      void loadRepoList();
    }
  });

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

    <label class="modal-field">
      <span>owner/repo</span>
      <div class="share-row">
        <input type="text" placeholder="owner/repo or a GitHub URL" aria-label="owner/repo" bind:value={manualInput} onkeydown={(e) => e.key === "Enter" && linkFromManualInput()} />
        <button class="secondary-btn" type="button" disabled={busyKey === MANUAL_KEY} onclick={linkFromManualInput}>Link</button>
      </div>
    </label>

    <div class="menu-divider"></div>
    <div class="menu-section-label">Create a new repo</div>
    <div class="share-row">
      <input type="text" placeholder="Repo name" aria-label="New repo name" bind:value={newRepoName} onkeydown={(e) => e.key === "Enter" && createAndLink()} />
      <label><input type="checkbox" bind:checked={newRepoPrivate} /> Private</label>
      <button class="secondary-btn" type="button" disabled={busyKey === CREATE_KEY || !newRepoName.trim()} onclick={createAndLink}>
        {busyKey === CREATE_KEY ? "Creating…" : "Create & Link"}
      </button>
    </div>

    <div class="menu-divider"></div>
    <div class="menu-section-label">Your Repos</div>
    {#if listHint}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-github"></use></svg>
        <div class="empty-state-title">{listTitle}</div>
        <div class="empty-state-desc">{listHint}</div>
        {#if !$githubUsername}
          <button type="button" class="primary-btn" onclick={() => window.MDE.openGithubSignInPopup()} style="margin-top: 8px;">
            <svg class="icon"><use href="#icon-github"></use></svg> Sign in with GitHub
          </button>
        {/if}
      </div>
    {/if}
    <div class="images-list">
      {#each repos as repo (repo.full_name)}
        <div class="gist-item">
          <div class="gist-meta">
            <div class="gist-name">{repo.full_name}</div>
            <div class="gist-date">{repo.private ? "Private" : "Public"}</div>
          </div>
          <button class="secondary-btn" type="button" disabled={busyKey === repo.full_name} onclick={() => link(repo.full_name, repo.default_branch, repo.full_name)}>
            {busyKey === repo.full_name ? "Linking…" : "Link"}
          </button>
        </div>
      {/each}
    </div>
  </Modal>
{/if}
