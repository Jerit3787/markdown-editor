<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import { docInfoPanelOpen } from "../stores/docInfoPanel";
  import { activeIdStore, activeDocContent, getActiveDoc, docsStore, switchDoc } from "../stores/docs";
  import { workspacesStore } from "../stores/workspaces";
  import { findBacklinks } from "../wikilinks";
  import { fetchRepoDocDates, type RepoDocDates } from "../repo-doc-dates";
  import { scanMarkdownCompatibility, type CompatIssue } from "../markdown-compat";

  const COMPAT_CATEGORIES = ["app-only", "flavor-specific"] as const;

  // $docsStore.find(...) read directly (not just getActiveDoc(), which
  // unwraps docsStore via the non-reactive get() internally) so this
  // recomputes when the active doc's own fields change in place — e.g.
  // a new image/diagram added — not only when $activeIdStore switches
  // to a different document. Same fix ImagesModal.svelte already
  // applies to this exact trap.
  const doc = $derived($activeIdStore ? $docsStore.find((d) => d.id === $activeIdStore) || getActiveDoc() : undefined);
  const backlinks = $derived(doc ? findBacklinks(doc.name, $docsStore, doc.id) : []);
  const wordCount = $derived.by(() => {
    const text = $activeDocContent.trim();
    return text.length ? text.split(/\s+/).length : 0;
  });
  const charCount = $derived($activeDocContent.length);
  const compatIssues = $derived.by(() => (doc ? scanMarkdownCompatibility($activeDocContent, doc.images, doc.diagrams) : []));
  let compatExpanded = $state(false);

  let repoDates = $state<RepoDocDates | undefined>(undefined);

  // Repo-linked docs show their real commit history instead of local
  // timestamps once it resolves — local timestamps render first (no
  // loading flicker) and get replaced in place if this finds something
  // different. Re-runs whenever the panel switches to a different doc;
  // the abort on cleanup stops a slow fetch for a previously-viewed doc
  // from landing after the panel has already moved on and overwriting
  // the wrong document's display.
  $effect(() => {
    repoDates = undefined;
    if (!doc?.repoPath) return;
    const workspace = $workspacesStore.find((w) => w.id === doc.workspaceId);
    const repoLink = workspace?.repoLink;
    if (!repoLink) return;
    const controller = new AbortController();
    fetchRepoDocDates(repoLink.owner, repoLink.repo, repoLink.branch, doc.repoPath, controller.signal).then((dates) => {
      if (!controller.signal.aborted) repoDates = dates;
    });
    return () => controller.abort();
  });

  const displayCreatedAt = $derived(repoDates?.createdAt ?? doc?.createdAt ?? 0);
  const displayUpdatedAt = $derived(repoDates?.updatedAt ?? doc?.updatedAt ?? 0);

  function close() {
    docInfoPanelOpen.set(false);
  }

  function jumpTo(id: string) {
    switchDoc(id);
    close();
  }

  function jumpToIssue(issue: CompatIssue) {
    const cm = window.MDE.getEditor();
    cm.dispatch({ selection: { anchor: issue.from, head: issue.to }, scrollIntoView: true });
    cm.focus();
    close();
  }

  // formatRelativeTime (the window.MDE bridge method) is deliberately
  // compact ("Today") for where it's used elsewhere (the Open Recent
  // submenu) — this panel is the one place precise enough to want the
  // full timestamp alongside it.
  function formatFullTimestamp(ts: number): string {
    return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $docInfoPanelOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $docInfoPanelOpen && doc}
  <Modal title="Document info" icon="icon-info" labelledBy="docInfoTitle" onClose={close}>
    <div class="doc-info-row">
      <span class="doc-info-primary">Created</span>
      <span class="doc-info-secondary">{window.MDE.formatRelativeTime(displayCreatedAt)} • {formatFullTimestamp(displayCreatedAt)}</span>
    </div>
    <div class="doc-info-row">
      <span class="doc-info-primary">Edited</span>
      <span class="doc-info-secondary">{window.MDE.formatRelativeTime(displayUpdatedAt)} • {formatFullTimestamp(displayUpdatedAt)}</span>
    </div>
    <div class="doc-info-row">
      <span class="doc-info-primary">Length</span>
      <span class="doc-info-secondary">{wordCount} word{wordCount === 1 ? "" : "s"}, {charCount} character{charCount === 1 ? "" : "s"}</span>
    </div>
    <div class="doc-info-row">
      <span class="doc-info-primary">Compatibility</span>
      <button type="button" class="doc-info-secondary doc-info-link" onclick={() => (compatExpanded = !compatExpanded)}>
        {compatIssues.length === 0 ? "No issues" : `${compatIssues.length} issue${compatIssues.length === 1 ? "" : "s"}`}
      </button>
    </div>
    {#if compatExpanded && compatIssues.length > 0}
      <div class="doc-info-compat-list">
        {#each COMPAT_CATEGORIES as category}
          {@const categoryIssues = compatIssues.filter((i) => i.category === category)}
          {#if categoryIssues.length > 0}
            <div class="doc-info-compat-category">
              {category === "app-only" ? "App-only" : "Flavor-specific"}
              <Toggletip icon="icon-info" class="toggletip-inline">
                {category === "app-only" ? "Won't render elsewhere at all." : "Works here and on GitHub, not guaranteed elsewhere."}
              </Toggletip>
            </div>
            {#each categoryIssues as issue}
              <button type="button" class="doc-info-backlink-row" onclick={() => jumpToIssue(issue)}>{issue.label}</button>
            {/each}
          {/if}
        {/each}
      </div>
    {/if}
    {#if doc.repoPath || doc.gistId}
      <div class="menu-section-label">Synced to</div>
      {#if doc.repoPath}
        {@const workspace = $workspacesStore.find((w) => w.id === doc.workspaceId)}
        {#if workspace?.repoLink}
          <div class="doc-info-row">
            <span class="doc-info-primary">Repo</span>
            <a
              class="doc-info-secondary doc-info-link"
              href={`https://github.com/${workspace.repoLink.owner}/${workspace.repoLink.repo}/blob/${workspace.repoLink.branch}/${doc.repoPath}`}
              target="_blank"
              rel="noopener"
            >
              {workspace.repoLink.owner}/{workspace.repoLink.repo} — {doc.repoPath}
            </a>
          </div>
        {/if}
      {/if}
      {#if doc.gistId}
        <div class="doc-info-row">
          <span class="doc-info-primary">Gist</span>
          <a class="doc-info-secondary doc-info-link" href={`https://gist.github.com/${doc.gistId}`} target="_blank" rel="noopener">
            View on GitHub
          </a>
        </div>
      {/if}
    {/if}
    <div class="menu-section-label">Linked from</div>
    {#if backlinks.length === 0}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-link"></use></svg>
        <div class="empty-state-title">No backlinks</div>
        <div class="empty-state-desc">No other documents link here yet.</div>
      </div>
    {:else}
      <div class="doc-info-backlinks">
        {#each backlinks as link (link.id)}
          <button type="button" class="doc-info-backlink-row" onclick={() => jumpTo(link.id)}>{link.name}</button>
        {/each}
      </div>
    {/if}
  </Modal>
{/if}
