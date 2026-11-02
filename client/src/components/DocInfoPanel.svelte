<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import { docInfoPanelOpen } from "../stores/docInfoPanel";
  import { docEditModalOpen } from "../stores/docEditModalOpen";
  import { activeIdStore, activeDocContent, getActiveDoc, docsStore, switchDoc } from "../stores/docs";
  import { workspacesStore } from "../stores/workspaces";
  import { findBacklinks } from "../wikilinks";
  import { fetchRepoDocDates, type RepoDocDates } from "../repo-doc-dates";
  import { scanMarkdownCompatibility, type CompatIssue } from "../markdown-compat";
  import { DEFAULT_CITATION_PREFS } from "../mmd-citations";
  import { workspaceRepoLinked } from "../stores/repoSync";
  import { collabIsOwner } from "../stores/collabMode";

  const COMPAT_CATEGORIES = ["app-only", "flavor-specific"] as const;

  // $docsStore.find(...) read directly (not just getActiveDoc(), which
  // unwraps docsStore via the non-reactive get() internally) so this
  // recomputes when the active doc's own fields change in place — e.g.
  // a new image/diagram added — not only when $activeIdStore switches
  // to a different document. Same fix ManageImagesModal.svelte already
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
  // different. Only the doc's repo COORDINATES are tracked (path + the
  // workspace's repoLink fields), not the whole derived `doc` object:
  // every autosave replaces that object, which used to abort and re-fire
  // the GitHub commits request on each keystroke.
  const repoDocPath = $derived(doc?.repoPath);
  const docWorkspace = $derived(doc ? $workspacesStore.find((w) => w.id === doc.workspaceId) : undefined);
  const repoLink = $derived(docWorkspace?.repoLink);
  const repoOwner = $derived(repoLink?.owner);
  const repoName = $derived(repoLink?.repo);
  const repoBranch = $derived(repoLink?.branch);
  $effect(() => {
    const path = repoDocPath;
    const owner = repoOwner;
    const repo = repoName;
    const branch = repoBranch;
    repoDates = undefined;
    if (!path || !owner || !repo || !branch) return;
    const controller = new AbortController();
    fetchRepoDocDates(owner, repo, branch, path, controller.signal).then((dates) => {
      if (!controller.signal.aborted) repoDates = dates;
    });
    return () => controller.abort();
  });

  const displayCreatedAt = $derived(repoDates?.createdAt ?? doc?.createdAt ?? 0);
  const displayUpdatedAt = $derived(repoDates?.updatedAt ?? doc?.updatedAt ?? 0);

  const citationPrefs = $derived(doc?.citations?.prefs ?? DEFAULT_CITATION_PREFS);
  const bibliography = $derived(doc?.citations?.bibliography ?? []);
  const citationMarkerLabel = $derived(citationPrefs.markerStyle === "pandoc" ? "Pandoc [@key]" : "MultiMarkdown [#key]");
  const citationSourceLabel = $derived(citationPrefs.bibliographySource === "structured" ? "Structured" : "Plain text");
  const citationStyleLabel = $derived(citationPrefs.displayStyle === "author-year" ? "Author-year" : "Numbered");

  function close() {
    docInfoPanelOpen.set(false);
  }

  function openEdit() {
    docEditModalOpen.set(true);
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
    {#snippet quickAction()}
      <button type="button" class="doc-info-edit-btn" onclick={openEdit}>Edit</button>
    {/snippet}
    <div class="doc-info-row">
      <span class="doc-info-primary">Name</span>
      <span class="doc-info-secondary">{doc.name}</span>
    </div>
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
    <div class="menu-section-label">Metadata</div>
    {#if (doc.metadata ?? []).length === 0}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-list"></use></svg>
        <div class="empty-state-title">No metadata</div>
        <div class="empty-state-desc">This document has no metadata fields yet.</div>
      </div>
    {:else}
      <div class="doc-info-metadata-list">
        {#each doc.metadata ?? [] as pair}
          <div class="doc-info-row">
            <span class="doc-info-primary">{pair.key || "—"}</span>
            <span class="doc-info-secondary">{pair.value || "—"}</span>
          </div>
        {/each}
      </div>
    {/if}
    <div class="menu-section-label">Citations</div>
    <div class="doc-info-row">
      <span class="doc-info-primary">Preferences</span>
      <span class="doc-info-secondary">{citationMarkerLabel} · {citationSourceLabel} · {citationStyleLabel}</span>
    </div>
    {#if citationPrefs.bibliographySource === "structured" && bibliography.length > 0}
      <div class="doc-info-metadata-list">
        {#each bibliography as entry}
          <div class="doc-info-row">
            <span class="doc-info-primary">{entry.author || "—"} {entry.year ? `(${entry.year})` : ""}</span>
            <span class="doc-info-secondary">{entry.text || "—"}{entry.key ? ` — [${entry.key}]` : ""}</span>
          </div>
        {/each}
      </div>
    {/if}
    {#if doc.repoPath || doc.gistId || doc.driveExportId || (doc.driveFileId && docWorkspace?.driveLink) || ($workspaceRepoLinked && !$collabIsOwner)}
      <div class="menu-section-label">Synced to</div>
      {#if doc.repoPath}
        {#if docWorkspace?.repoLink}
          <div class="doc-info-row">
            <span class="doc-info-primary">Repo</span>
            <a
              class="doc-info-secondary doc-info-link"
              href={`https://github.com/${docWorkspace.repoLink.owner}/${docWorkspace.repoLink.repo}/blob/${docWorkspace.repoLink.branch}/${doc.repoPath}`}
              target="_blank"
              rel="noopener"
            >
              {docWorkspace.repoLink.owner}/{docWorkspace.repoLink.repo} — {doc.repoPath}
            </a>
          </div>
        {/if}
      {:else if $workspaceRepoLinked && !$collabIsOwner}
        <div class="doc-info-row">
          <span class="doc-info-primary">Repo</span>
          <span class="doc-info-secondary">Synced to a GitHub repo, managed by the workspace owner</span>
        </div>
      {/if}
      {#if doc.gistId}
        <div class="doc-info-row">
          <span class="doc-info-primary">Gist</span>
          <a class="doc-info-secondary doc-info-link" href={`https://gist.github.com/${doc.gistId}`} target="_blank" rel="noopener">
            View on GitHub
          </a>
        </div>
      {/if}
      {#if doc.driveFileId && docWorkspace?.driveLink}
        <div class="doc-info-row">
          <span class="doc-info-primary">Google Drive folder</span>
          <a
            class="doc-info-secondary doc-info-link"
            href={`https://drive.google.com/file/d/${doc.driveFileId}/view`}
            target="_blank"
            rel="noopener"
          >
            {docWorkspace.driveLink.folderName}{doc.drivePath ? ` — ${doc.drivePath}` : ""}
          </a>
        </div>
      {/if}
      {#if doc.driveExportId}
        <div class="doc-info-row">
          <span class="doc-info-primary">Google Drive</span>
          <a
            class="doc-info-secondary doc-info-link"
            href={`https://drive.google.com/file/d/${doc.driveExportId}/view`}
            target="_blank"
            rel="noopener"
          >
            {doc.driveExportName || "Saved file"}
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
