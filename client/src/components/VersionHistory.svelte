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
  import { extractAssetImageRefs } from "../diff-image-row";
  import { decodeBase64Text, slugFromRepoPath, type TreeEntry } from "../repo-sync";
  import { fetchAndMergeRepoHistory } from "../repo-history-sync";
  import DiffView from "./DiffView.svelte";
  import { groupSnapshotsIntoSessions } from "../version-grouping";

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
  interface SessionEntry {
    kind: "session";
    id: string;
    timestamp: number;
    startTimestamp: number;
    endTimestamp: number;
    entries: LocalEntry[];
  }
  type HistoryEntry = LocalEntry | CommitEntry | SessionEntry;

  function isDocShared(doc: ReturnType<typeof getActiveDoc>): boolean {
    return !!(doc && get(workspacesStore).find((w) => w.id === doc.workspaceId)?.shared);
  }

  let versions = $state<HistoryEntry[]>([]);
  let selectedId = $state<string | null>(null);
  let selectedEntry = $state<HistoryEntry | null>(null);
  let selectedContent = $state<string | undefined>(undefined);
  let selectedImages = $state<Record<string, string> | undefined>(undefined);
  let compareId = $state<string>("__live__");
  let compareContent = $state<string | undefined>(undefined);
  let compareImages = $state<Record<string, string> | undefined>(undefined);
  let viewMode = $state<"preview" | "diff">("preview");
  let previewEl: HTMLDivElement | undefined = $state();
  let loading = $state(false);
  let restoring = $state(false);
  // Re-checked each time the overlay opens (see loadVersions) — a local
  // document is always restorable; a shared one only if this client
  // currently has editor access, mirroring the server's own 403 gate so
  // the button isn't shown as available when it would just fail.
  let restoreAllowed = $state(true);
  let expandedSessions = $state<Set<string>>(new Set());

  function toggleSession(id: string) {
    const next = new Set(expandedSessions);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedSessions = next;
  }

  function formatSessionLabel(start: number, end: number, count: number): string {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const sameDay = startDate.toDateString() === endDate.toDateString();
    const dateLabel = (d: Date) => (d.toDateString() === new Date().toDateString() ? "Today" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    const timeLabel = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const range = sameDay
      ? `${dateLabel(startDate)}, ${timeLabel(startDate)}–${timeLabel(endDate)}`
      : `${dateLabel(startDate)}, ${timeLabel(startDate)} – ${dateLabel(endDate)}, ${timeLabel(endDate)}`;
    return `${range} · ${count} edit${count === 1 ? "" : "s"}`;
  }

  function close() {
    versionHistoryOpen.set(false);
  }

  function firstLine(message: string): string {
    return message.split("\n")[0] || message;
  }

  // GitHub's commit-list-by-path endpoint (loadCommitEntries) follows
  // renames, so the commit list can include commits from before the
  // doc's file was renamed — but doc.repoPath is always the file's
  // CURRENT path, which didn't exist yet at those older commits.
  // contents/{currentPath}?ref={oldSha} 404s in that case; fall back to
  // searching that commit's own tree for a markdown file whose slug
  // matches ours case-insensitively (renames are almost always just a
  // case or wording change), the same slug convention planPush/pull
  // already use to match a doc to its repo file.
  async function findRenamedPathAtRef(owner: string, repo: string, sha: string, wantSlug: string): Promise<string | undefined> {
    const res = await fetch(`/api/repo/${owner}/${repo}/tree?sha=${encodeURIComponent(sha)}`);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { tree?: TreeEntry[] };
    const match = (data.tree || []).find(
      (e) => e.type === "blob" && /\.md$/i.test(e.path) && slugFromRepoPath(e.path).toLowerCase() === wantSlug.toLowerCase()
    );
    return match?.path;
  }

  async function fetchCommitContent(doc: ReturnType<typeof getActiveDoc>, sha: string): Promise<string | undefined> {
    if (!doc?.repoPath) return undefined;
    const ws = get(workspacesStore).find((w) => w.id === doc.workspaceId);
    const repoLink = ws?.repoLink;
    if (!repoLink) return undefined;
    const fetchAt = async (path: string): Promise<string | undefined> => {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`);
      if (!res.ok) return undefined;
      const data = (await res.json()) as { content: string; encoding: string };
      return data.encoding !== "base64" ? data.content : decodeBase64Text(data.content);
    };
    const direct = await fetchAt(doc.repoPath);
    if (direct !== undefined) return direct;
    const renamedPath = await findRenamedPathAtRef(repoLink.owner, repoLink.repo, sha, slugFromRepoPath(doc.repoPath));
    return renamedPath ? await fetchAt(renamedPath) : undefined;
  }

  async function fetchCommitImages(doc: ReturnType<typeof getActiveDoc>, sha: string, content: string): Promise<Record<string, string>> {
    if (!doc?.repoPath) return {};
    const ws = get(workspacesStore).find((w) => w.id === doc.workspaceId);
    const repoLink = ws?.repoLink;
    if (!repoLink) return {};
    const assetRefs = extractAssetImageRefs(content);
    const images: Record<string, string> = {};
    for (const assetPath of assetRefs) {
      const encodedPath = assetPath.split("/").map(encodeURIComponent).join("/");
      const res = await fetch(`/api/repo/${repoLink.owner}/${repoLink.repo}/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`);
      if (!res.ok) continue;
      const data = (await res.json()) as { content: string; encoding: string };
      // Never atob() this — it's binary image data, not text. Keeping the
      // base64 string as-is matches repo-sync.ts's own fetchAndApply
      // convention for the exact same kind of asset fetch during a pull.
      images[assetPath] = `data:image/*;base64,${data.content.replace(/\n/g, "")}`;
    }
    return images;
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

  async function loadEntryContent(
    doc: ReturnType<typeof getActiveDoc>,
    isShared: boolean,
    entry: LocalEntry | CommitEntry,
  ): Promise<{ content: string; images: Record<string, string> | undefined } | undefined> {
    if (!doc) return undefined;
    if (entry.kind === "local") {
      if (isShared) {
        const result = await getSharedVersionSnapshot(doc.workspaceId, doc.id, entry.id);
        if (result === undefined) {
          showToast("Couldn't load this version's content", "error");
          return undefined;
        }
        return result;
      }
      const content = await getVersionContent(doc.id, entry.id);
      if (content === undefined) {
        showToast("Couldn't load this version's content", "error");
        return undefined;
      }
      return { content, images: await getVersionImages(doc.id, entry.id) };
    }
    const content = await fetchCommitContent(doc, entry.id);
    if (content === undefined) {
      showToast("Couldn't load this version's content", "error");
      return undefined;
    }
    return { content, images: await fetchCommitImages(doc, entry.id, content) };
  }

  async function selectVersion(doc: ReturnType<typeof getActiveDoc>, isShared: boolean, entry: LocalEntry | CommitEntry) {
    selectedId = entry.id;
    selectedEntry = entry;
    selectedContent = undefined;
    selectedImages = undefined;
    const result = await loadEntryContent(doc, isShared, entry);
    if (result) {
      selectedContent = result.content;
      selectedImages = result.images;
    }
  }

  const flatEntries = $derived.by((): (LocalEntry | CommitEntry)[] => versions.flatMap((v) => (v.kind === "session" ? v.entries : [v])));

  function compareLabel(entry: LocalEntry | CommitEntry): string {
    return entry.kind === "commit" ? entry.message : formatTimestamp(entry.timestamp);
  }

  async function selectCompare(id: string) {
    compareId = id;
    compareContent = undefined;
    compareImages = undefined;
    if (id === "__live__") return;
    const doc = getActiveDoc();
    if (!doc) return;
    const entry = flatEntries.find((e) => e.id === id);
    if (!entry) return;
    const result = await loadEntryContent(doc, isDocShared(doc), entry);
    if (result) {
      compareContent = result.content;
      compareImages = result.images;
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
    if (!isShared) await fetchAndMergeRepoHistory(doc);
    const localList = isShared ? await listSharedVersions(doc.workspaceId, doc.id) : await listVersions(doc.id);
    // listVersions/listSharedVersions both return newest-first, but
    // groupSnapshotsIntoSessions requires oldest-first input (a negative
    // gap against a descending list always satisfies "<= sessionGapMs",
    // silently merging every entry into one group) — sort back to
    // oldest-first before grouping.
    const localEntries: LocalEntry[] = localList
      .map((v) => ({ kind: "local" as const, id: v.id, timestamp: v.timestamp }))
      .sort((a, b) => a.timestamp - b.timestamp);
    const groupedLocalEntries: HistoryEntry[] = groupSnapshotsIntoSessions(localEntries).map((g) =>
      g.entries.length > 1
        ? { kind: "session" as const, id: g.entries[0]!.id, timestamp: g.endTimestamp, startTimestamp: g.startTimestamp, endTimestamp: g.endTimestamp, entries: g.entries }
        : g.entries[0]!,
    );
    const commitEntries: HistoryEntry[] = await loadCommitEntries(doc);
    versions = [...groupedLocalEntries, ...commitEntries].sort((a, b) => b.timestamp - a.timestamp);
    loading = false;
    compareId = "__live__";
    compareContent = undefined;
    compareImages = undefined;
    if (versions.length > 0) {
      const first = versions[0]!;
      const initial = first.kind === "session" ? first.entries[first.entries.length - 1]! : first;
      await selectVersion(doc, isShared, initial);
    } else {
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
      // Override .images with the SELECTED version's own images
      // (selectedImages — already resolved per-version by selectVersion,
      // whether local snapshot, shared snapshot, or repo commit), not the
      // live doc's current map. A repo commit's raw text references
      // images by their assets/<slug>/... path, which never matches the
      // live doc's img-key-keyed map — passing doc.images straight
      // through here always failed to resolve those, showing a broken
      // image regardless of what the image was actually named.
      if (doc) void renderVersionPreview(selectedContent, { ...doc, images: selectedImages }, previewEl);
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
            {#if v.kind === "session"}
              <div class="version-history-session">
                <button type="button" class="version-history-row version-history-session-header" onclick={() => toggleSession(v.id)}>
                  <span class="version-history-row-label">
                    <svg class="icon version-history-chevron" class:expanded={expandedSessions.has(v.id)}><use href="#icon-chevron-right"></use></svg>
                    {formatSessionLabel(v.startTimestamp, v.endTimestamp, v.entries.length)}
                  </span>
                  {#if i === 0}<span class="version-history-current">(includes current)</span>{/if}
                </button>
                {#if expandedSessions.has(v.id)}
                  {#each [...v.entries].reverse() as nested, ni (nested.id)}
                    <button
                      type="button"
                      class="version-history-row version-history-nested-row"
                      class:active={nested.id === selectedId}
                      onclick={() => selectVersion(getActiveDoc(), isDocShared(getActiveDoc()), nested)}
                    >
                      <span class="version-history-row-label">{formatTimestamp(nested.timestamp)}</span>
                      {#if i === 0 && ni === 0}<span class="version-history-current">(current)</span>{/if}
                    </button>
                  {/each}
                {/if}
              </div>
            {:else}
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
            {/if}
          {/each}
        {/if}
      </div>
      <div class="version-history-preview-wrap">
        <div class="version-history-view-toggle">
          <button type="button" class:active={viewMode === "preview"} onclick={() => (viewMode = "preview")}>Preview</button>
          <button type="button" class:active={viewMode === "diff"} onclick={() => (viewMode = "diff")}>Diff</button>
        </div>
        {#if viewMode === "diff"}
          <div class="version-history-compare-picker">
            <label for="versionCompareSelect">Compare against</label>
            <select id="versionCompareSelect" value={compareId} onchange={(e) => selectCompare((e.target as HTMLSelectElement).value)}>
              <option value="__live__">Live document</option>
              {#each flatEntries as entry (entry.id)}
                <option value={entry.id}>{compareLabel(entry)}</option>
              {/each}
            </select>
          </div>
          <div class="version-history-preview">
            {#if selectedContent === undefined}
              <div class="empty-state">
                <svg class="empty-state-icon"><use href="#icon-history"></use></svg>
                <div class="empty-state-title">Loading…</div>
              </div>
            {:else}
              <DiffView
                before={selectedContent}
                after={compareId === "__live__" ? $activeDocContent : compareContent}
                beforeImages={selectedImages}
                afterImages={compareId === "__live__" ? getActiveDoc()?.images : compareImages}
              />
            {/if}
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
