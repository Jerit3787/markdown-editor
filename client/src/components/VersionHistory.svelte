<script lang="ts">
  import { get } from "svelte/store";
  import { onMount } from "svelte";
  import { versionHistoryOpen } from "../stores/versionHistory";
  import { getActiveDoc, activeDocContent, replaceDocImages } from "../stores/docs";
  import { workspacesStore } from "../stores/workspaces";
  import {
    listVersions,
    getVersionContent,
    getVersionImages,
    restoreLocalVersion,
    restoreLocalVersionContent,
    listSharedVersions,
    getSharedVersionSnapshot,
    restoreSharedVersion,
    restoreSharedVersionContent,
  } from "../history";
  import { renderVersionPreview } from "../version-preview";
  import { showToast } from "../stores/toast";
  import DiffView from "./DiffView.svelte";

  interface LocalEntry {
    kind: "local";
    id: string;
    timestamp: number;
  }
  interface CommitEntry {
    kind: "commit";
    id: string;
    timestamp: number;
    message: string;
    author: string;
    html_url: string;
  }
  type HistoryEntry = LocalEntry | CommitEntry;

  function isDocShared(doc: ReturnType<typeof getActiveDoc>): boolean {
    return !!(doc && get(workspacesStore).find((w) => w.id === doc.workspaceId)?.shared);
  }

  let versions = $state<HistoryEntry[]>([]);
  let selectedId = $state<string | null>(null);
  let selectedEntry = $state<HistoryEntry | null>(null);
  let selectedContent = $state<string | undefined>(undefined);
  let selectedImages = $state<Record<string, string> | undefined>(undefined);
  let viewMode = $state<"preview" | "diff">("preview");
  let previewEl: HTMLDivElement | undefined = $state();
  let loading = $state(false);
  let restoring = $state(false);
  // Re-checked each time the overlay opens (see loadVersions) — a local
  // document is always restorable; a shared one only if this client
  // currently has editor access, mirroring the server's own 403 gate so
  // the button isn't shown as available when it would just fail.
  let restoreAllowed = $state(true);

  function close() {
    versionHistoryOpen.set(false);
  }

  function firstLine(message: string): string {
    return message.split("\n")[0] || message;
  }

  async function fetchCommitContent(doc: ReturnType<typeof getActiveDoc>, sha: string): Promise<string | undefined> {
    if (!doc?.repoPath) return undefined;
    const ws = get(workspacesStore).find((w) => w.id === doc.workspaceId);
    const repoLink = ws?.repoLink;
    if (!repoLink) return undefined;
    const encodedPath = doc.repoPath.split("/").map(encodeURIComponent).join("/");
    const res = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { content: string; encoding: string };
    if (data.encoding !== "base64") return data.content;
    return atob(data.content.replace(/\n/g, ""));
  }

  async function loadCommitEntries(doc: ReturnType<typeof getActiveDoc>): Promise<CommitEntry[]> {
    if (!doc?.repoPath) return [];
    const ws = get(workspacesStore).find((w) => w.id === doc.workspaceId);
    const repoLink = ws?.repoLink;
    if (!repoLink) return [];
    try {
      const encodedPath = doc.repoPath.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(
        `/api/repo/${repoLink.owner}/${repoLink.repo}/commits?branch=${encodeURIComponent(repoLink.branch)}&page=1&path=${encodedPath}`
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { sha: string; commit: { message: string; author: { name: string; date: string } }; html_url: string }[];
      return data.map((c) => ({
        kind: "commit" as const,
        id: c.sha,
        timestamp: new Date(c.commit.author.date).getTime(),
        message: firstLine(c.commit.message),
        author: c.commit.author.name,
        html_url: c.html_url,
      }));
    } catch (err) {
      return [];
    }
  }

  async function selectVersion(doc: ReturnType<typeof getActiveDoc>, isShared: boolean, entry: HistoryEntry) {
    selectedId = entry.id;
    selectedEntry = entry;
    selectedContent = undefined;
    selectedImages = undefined;
    if (!doc) return;
    if (entry.kind === "local") {
      if (isShared) {
        const result = await getSharedVersionSnapshot(doc.workspaceId, doc.id, entry.id);
        if (result === undefined) {
          showToast("Couldn't load this version's content", "error");
          return;
        }
        selectedContent = result.content;
        selectedImages = result.images;
      } else {
        const content = await getVersionContent(doc.id, entry.id);
        if (content === undefined) {
          showToast("Couldn't load this version's content", "error");
          return;
        }
        selectedContent = content;
        selectedImages = await getVersionImages(doc.id, entry.id);
      }
    } else {
      const content = await fetchCommitContent(doc, entry.id);
      if (content === undefined) {
        showToast("Couldn't load this version's content", "error");
        return;
      }
      selectedContent = content;
    }
  }

  async function loadVersions() {
    const doc = getActiveDoc();
    if (!doc) {
      versions = [];
      return;
    }
    const isShared = isDocShared(doc);
    restoreAllowed = !isShared || !window.MDE.getEditor().state.readOnly;
    loading = true;
    const localList = isShared ? await listSharedVersions(doc.workspaceId, doc.id) : await listVersions(doc.id);
    const localEntries: HistoryEntry[] = localList.map((v) => ({ kind: "local" as const, id: v.id, timestamp: v.timestamp }));
    const commitEntries: HistoryEntry[] = await loadCommitEntries(doc);
    versions = [...localEntries, ...commitEntries].sort((a, b) => b.timestamp - a.timestamp);
    loading = false;
    if (versions.length > 0) await selectVersion(doc, isShared, versions[0]!);
    else {
      selectedId = null;
      selectedEntry = null;
    }
  }

  async function restore() {
    const doc = getActiveDoc();
    if (!doc || !selectedEntry || restoring || selectedContent === undefined) return;
    restoring = true;
    const isShared = isDocShared(doc);
    const entry = selectedEntry;
    const content = selectedContent;
    if (isShared) {
      const ok =
        entry.kind === "local"
          ? await restoreSharedVersion(doc.workspaceId, doc.id, entry.id)
          : await restoreSharedVersionContent(doc.workspaceId, doc.id, content);
      if (ok) {
        showToast("Version restored", "success");
        close();
      } else {
        showToast("Couldn't restore this version", "error");
      }
    } else if (entry.kind === "local") {
      const restored = await restoreLocalVersion(doc.id, entry.id);
      if (restored !== undefined) {
        const cm = window.MDE.getEditor();
        cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: restored.content } });
        replaceDocImages(doc.id, restored.images);
        showToast("Version restored", "success");
        close();
      } else {
        showToast("Couldn't restore this version", "error");
      }
    } else {
      await restoreLocalVersionContent(doc.id, content, undefined, selectedImages);
      const cm = window.MDE.getEditor();
      cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: content } });
      replaceDocImages(doc.id, selectedImages);
      showToast("Version restored", "success");
      close();
    }
    restoring = false;
  }

  function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleString();
  }

  $effect(() => {
    if ($versionHistoryOpen) void loadVersions();
  });

  // Re-renders the plain preview whenever the selected content changes
  // or the toggle switches back to "preview" — separate from
  // selectVersion() so switching modes on an already-selected entry
  // doesn't need to re-fetch anything.
  $effect(() => {
    if (viewMode === "preview" && selectedContent !== undefined && previewEl) {
      const doc = getActiveDoc();
      if (doc) void renderVersionPreview(selectedContent, doc, previewEl);
    }
  });

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $versionHistoryOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    // Topbar icon button, next to Share — same open() this component's own
    // File-menu entry (MenuBar.svelte) triggers, matching Settings.svelte's
    // own #settingsBtn wiring pattern for a header-icon-triggered overlay.
    const open = () => versionHistoryOpen.set(true);
    document.getElementById("versionHistoryBtn")?.addEventListener("click", open);
    return () => {
      document.removeEventListener("keydown", onKeydown);
      document.getElementById("versionHistoryBtn")?.removeEventListener("click", open);
    };
  });
</script>

{#if $versionHistoryOpen}
  <div class="version-history-overlay" role="dialog" aria-modal="true" aria-labelledby="versionHistoryTitle">
    <div class="version-history-header">
      <h2 id="versionHistoryTitle">Version history</h2>
      <button type="button" class="secondary-btn" onclick={close}>Close</button>
    </div>
    <div class="version-history-body">
      <div class="version-history-list">
        {#if loading}
          <div class="empty-state">
            <svg class="empty-state-icon"><use href="#icon-history"></use></svg>
            <div class="empty-state-title">Loading…</div>
          </div>
        {:else if versions.length === 0}
          <div class="empty-state">
            <svg class="empty-state-icon"><use href="#icon-history"></use></svg>
            <div class="empty-state-title">No versions yet</div>
            <div class="empty-state-desc">History builds up automatically as you edit.</div>
          </div>
        {:else}
          {#each versions as v, i (v.id)}
            <button
              type="button"
              class="version-history-row"
              class:active={v.id === selectedId}
              onclick={() => selectVersion(getActiveDoc(), isDocShared(getActiveDoc()), v)}
            >
              <span class="version-history-row-label">
                {#if v.kind === "commit"}
                  <svg class="icon"><use href="#icon-github"></use></svg>
                  {v.message}
                {:else}
                  {formatTimestamp(v.timestamp)}
                {/if}
              </span>
              {#if i === 0}<span class="version-history-current">(current)</span>{/if}
            </button>
          {/each}
        {/if}
      </div>
      <div class="version-history-preview-wrap">
        <div class="version-history-view-toggle">
          <button type="button" class:active={viewMode === "preview"} onclick={() => (viewMode = "preview")}>Preview</button>
          <button type="button" class:active={viewMode === "diff"} onclick={() => (viewMode = "diff")}>Diff</button>
        </div>
        {#if viewMode === "diff"}
          <div class="version-history-preview">
            <DiffView before={selectedContent ?? ""} after={$activeDocContent} beforeImages={selectedImages} afterImages={getActiveDoc()?.images} />
          </div>
        {:else}
          <div class="version-history-preview" bind:this={previewEl}></div>
        {/if}
        <div class="version-history-actions">
          <button type="button" class="primary-btn" disabled={!selectedId || restoring || !restoreAllowed || selectedId === versions[0]?.id} onclick={restore}>
            Restore this version
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
