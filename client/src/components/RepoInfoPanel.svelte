<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { repoInfoPanelOpen } from "../stores/repoInfoPanel";
  import { activeWorkspaceIdStore, workspacesStore } from "../stores/workspaces";
  import { showToast } from "../stores/toast";

  interface CommitEntry {
    sha: string;
    commit: { message: string; author: { name: string; date: string } };
    html_url: string;
  }

  const activeWorkspace = $derived($workspacesStore.find((w) => w.id === $activeWorkspaceIdStore));
  const repoLink = $derived(activeWorkspace?.repoLink);

  let commits = $state<CommitEntry[]>([]);
  let loading = $state(false);
  let loadingMore = $state(false);
  let hasMore = $state(true);
  let page = $state(1);

  function firstLine(message: string): string {
    return message.split("\n")[0] || message;
  }

  async function loadPage(targetPage: number): Promise<CommitEntry[] | null> {
    if (!repoLink) return null;
    const res = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/commits?branch=${encodeURIComponent(repoLink.branch)}&page=${targetPage}`);
    if (!res.ok) {
      showToast("Couldn't load commit history", "error");
      return null;
    }
    return (await res.json()) as CommitEntry[];
  }

  async function loadFirstPage() {
    if (!repoLink) return;
    loading = true;
    page = 1;
    const result = await loadPage(1);
    commits = result ?? [];
    hasMore = (result?.length ?? 0) === 30;
    loading = false;
  }

  async function loadMore() {
    loadingMore = true;
    const nextPage = page + 1;
    const result = await loadPage(nextPage);
    if (result) {
      commits = [...commits, ...result];
      page = nextPage;
      hasMore = result.length === 30;
    }
    loadingMore = false;
  }

  function close() {
    repoInfoPanelOpen.set(false);
  }

  $effect(() => {
    if ($repoInfoPanelOpen) void loadFirstPage();
  });

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $repoInfoPanelOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $repoInfoPanelOpen && repoLink}
  <Modal title="Repo info" icon="icon-github" labelledBy="repoInfoTitle" onClose={close}>
    <div class="doc-info-row">
      <span class="doc-info-primary">Repo</span>
      <a class="doc-info-secondary doc-info-link" href={`https://github.com/${repoLink.owner}/${repoLink.repo}/tree/${repoLink.branch}`} target="_blank" rel="noopener">
        {repoLink.owner}/{repoLink.repo} ({repoLink.branch})
      </a>
    </div>
    <div class="menu-section-label">Commits</div>
    {#if loading}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-history"></use></svg>
        <div class="empty-state-title">Loading…</div>
      </div>
    {:else if commits.length === 0}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-github"></use></svg>
        <div class="empty-state-title">No commits found</div>
      </div>
    {:else}
      <div class="doc-info-backlinks">
        {#each commits as c (c.sha)}
          <a class="doc-info-backlink-row" href={c.html_url} target="_blank" rel="noopener">
            <span>{firstLine(c.commit.message)}</span>
            <span class="doc-info-secondary">{c.commit.author.name} • {window.MDE.formatRelativeTime(new Date(c.commit.author.date).getTime())}</span>
          </a>
        {/each}
      </div>
      {#if hasMore}
        <button type="button" class="secondary-btn" disabled={loadingMore} onclick={loadMore}>
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      {/if}
    {/if}
  </Modal>
{/if}
