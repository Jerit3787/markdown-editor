<script lang="ts">
  import { githubUsername } from "../stores/github";
  import { showToast } from "../stores/toast";

  interface Props {
    open: boolean;
    pickLabel?: string;
    pickBusyLabel?: string;
    createLabel?: string;
    onPick: (owner: string, repo: string, branch: string) => void | Promise<void>;
  }
  let { open, pickLabel = "Link", pickBusyLabel = "Linking…", createLabel = "Create & Link", onPick }: Props = $props();

  let repos = $state<any[]>([]);
  let listTitle = $state("");
  let listHint = $state("Sign in with GitHub to see your own repos here.");
  let manualInput = $state("");
  let newRepoName = $state("");
  let newRepoPrivate = $state(true);
  let busyKey = $state<string | null>(null);
  const CREATE_KEY = "__create__";
  const MANUAL_KEY = "__manual__";

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

  async function pick(fullName: string, defaultBranch: string, key: string) {
    busyKey = key;
    try {
      const [owner, repo] = fullName.split("/");
      await onPick(owner!, repo!, defaultBranch);
    } finally {
      busyKey = null;
    }
  }

  async function pickFromManualInput() {
    const trimmed = manualInput.trim().replace(/^https?:\/\/github\.com\//, "");
    const [owner, repo] = trimmed.split("/");
    if (!owner || !repo) {
      showToast("Enter a repo as owner/repo", "error");
      return;
    }
    busyKey = MANUAL_KEY;
    try {
      await onPick(owner, repo.replace(/\.git$/, ""), "main");
    } finally {
      busyKey = null;
    }
  }

  async function createAndPick() {
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
      await onPick(owner, repo, data.default_branch || "main");
    } catch {
      showToast("Couldn't create the repo", "error");
    } finally {
      busyKey = null;
    }
  }

  $effect(() => {
    if (open) {
      manualInput = "";
      newRepoName = "";
      void loadRepoList();
    }
  });
</script>

<label class="modal-field">
  <span>owner/repo</span>
  <div class="share-row">
    <input type="text" placeholder="owner/repo or a GitHub URL" aria-label="owner/repo" bind:value={manualInput} onkeydown={(e) => e.key === "Enter" && pickFromManualInput()} />
    <button class="secondary-btn" type="button" disabled={busyKey === MANUAL_KEY} onclick={pickFromManualInput}>{pickLabel}</button>
  </div>
</label>

<div class="menu-divider"></div>
<div class="menu-section-label">Create a new repo</div>
<div class="share-row">
  <input type="text" placeholder="Repo name" aria-label="New repo name" bind:value={newRepoName} onkeydown={(e) => e.key === "Enter" && createAndPick()} />
  <label><input type="checkbox" bind:checked={newRepoPrivate} /> Private</label>
  <button class="secondary-btn" type="button" disabled={busyKey === CREATE_KEY || !newRepoName.trim()} onclick={createAndPick}>
    {busyKey === CREATE_KEY ? "Creating…" : createLabel}
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
      <button class="secondary-btn" type="button" disabled={busyKey === repo.full_name} onclick={() => pick(repo.full_name, repo.default_branch, repo.full_name)}>
        {busyKey === repo.full_name ? pickBusyLabel : pickLabel}
      </button>
    </div>
  {/each}
</div>
