<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import DiffView from "./DiffView.svelte";
  import { repoInfoPanelOpen } from "../stores/repoInfoPanel";
  import { activeWorkspaceIdStore, workspacesStore } from "../stores/workspaces";
  import { activeIdStore, getActiveDoc } from "../stores/docs";
  import { showToast } from "../stores/toast";

  interface CommitEntry {
    sha: string;
    commit: { message: string; author: { name: string; date: string } };
    html_url: string;
  }

  const activeWorkspace = $derived($workspacesStore.find((w) => w.id === $activeWorkspaceIdStore));
  const repoLink = $derived(activeWorkspace?.repoLink);
  const activeDoc = $derived($activeIdStore ? getActiveDoc() : undefined);

  let commits = $state<CommitEntry[]>([]);
  let loading = $state(false);
  let loadingMore = $state(false);
  let hasMore = $state(true);
  let page = $state(1);

  let viewMode = $state<"list" | "diff">("list");
  let selectedShas = $state<string[]>([]);
  let comparing = $state(false);
  let diffBefore = $state("");
  let diffAfter = $state("");

  const compareDisabledReason = $derived(
    !activeDoc?.repoPath ? "This document hasn't been synced to the repo yet" : selectedShas.length !== 2 ? "Select two commits to compare" : undefined
  );

  function firstLine(message: string): string {
    return message.split("\n")[0] || message;
  }

  function commitIndex(sha: string): number {
    return commits.findIndex((c) => c.sha === sha);
  }

  function toggleSelect(sha: string) {
    if (selectedShas.includes(sha)) {
      selectedShas = selectedShas.filter((s) => s !== sha);
    } else if (selectedShas.length >= 2) {
      selectedShas = [selectedShas[1]!, sha];
    } else {
      selectedShas = [...selectedShas, sha];
    }
  }

  async function fetchFileAtRef(ref: string): Promise<string | null> {
    if (!repoLink || !activeDoc?.repoPath) return null;
    const encodedPath = activeDoc.repoPath
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const res = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { content: string; encoding: string };
    if (data.encoding !== "base64") return data.content;
    return atob(data.content.replace(/\n/g, ""));
  }

  async function compare() {
    if (compareDisabledReason || comparing) return;
    const sorted = [...selectedShas].sort((a, b) => commitIndex(b) - commitIndex(a));
    const [olderSha, newerSha] = sorted;
    comparing = true;
    const [before, after] = await Promise.all([fetchFileAtRef(olderSha!), fetchFileAtRef(newerSha!)]);
    comparing = false;
    if (before === null || after === null) {
      showToast("Couldn't load this document's content at one of the selected commits", "error");
      return;
    }
    diffBefore = before;
    diffAfter = after;
    viewMode = "diff";
  }

  function backToList() {
    viewMode = "list";
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
    viewMode = "list";
    selectedShas = [];
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
    {#if viewMode === "diff"}
      <div class="repo-commit-compare-bar">
        <button type="button" class="secondary-btn" onclick={backToList}>
          <svg class="icon"><use href="#icon-chevron-left"></use></svg> Back to commits
        </button>
      </div>
      <DiffView before={diffBefore} after={diffAfter} />
    {:else}
      <div class="repo-commit-compare-bar">
        <button type="button" class="secondary-btn" disabled={!!compareDisabledReason || comparing} title={compareDisabledReason} onclick={compare}>
          {comparing ? "Comparing…" : "Compare"}
        </button>
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
            <div class="repo-commit-row">
              <input type="checkbox" checked={selectedShas.includes(c.sha)} onchange={() => toggleSelect(c.sha)} aria-label={`Select commit: ${firstLine(c.commit.message)}`} />
              <a class="repo-commit-link" href={c.html_url} target="_blank" rel="noopener">
                <span>{firstLine(c.commit.message)}</span>
                <span class="doc-info-secondary">{c.commit.author.name} • {window.MDE.formatRelativeTime(new Date(c.commit.author.date).getTime())}</span>
              </a>
            </div>
          {/each}
        </div>
        {#if hasMore}
          <button type="button" class="secondary-btn" disabled={loadingMore} onclick={loadMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        {/if}
      {/if}
    {/if}
  </Modal>
{/if}
