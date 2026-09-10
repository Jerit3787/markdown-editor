<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { commentsPanelOpen, unresolvedCommentCount } from "../stores/commentsPanel";
  import { pendingSuggestionCount } from "../stores/suggestions";
  import { effectiveMode, collabRole } from "../stores/collabMode";
  import { collabIdentity } from "../stores/collabIdentity";
  import { commentDraft } from "../stores/commentDraft";
  import { activeIdStore, getActiveDoc, addDocNote, deleteDocNote } from "../stores/docs";
  import { fetchAndMergeRepoHistory } from "../repo-history-sync";
  import { workspacesStore } from "../stores/workspaces";
  import {
    listResolvedCommentThreads,
    createCommentThread,
    addCommentReply,
    resolveCommentThread,
    deleteCommentThread,
    addSuggestionReply,
  } from "../comments-doc";
  import { showToast } from "../stores/toast";
  import { viewMode, isEditorOn } from "../stores/view";
  import { railAnnotationsForShared, railAnnotationsForLocal, underlyingIds, type RailAnnotation } from "../annotations";
  import { layoutCards, type CardAnchor } from "../annotation-rail-layout";
  import { activeAnnotationIds } from "../stores/annotations";
  import { resolveSuggestion, withdrawSuggestion } from "../suggestions";
  import AnnotationCard from "./AnnotationCard.svelte";

  const GAP = 8;

  let annotations = $state<RailAnnotation[]>([]);
  let loading = $state(false);
  let manualList = $state(false);
  let focusedId = $state<string | null>(null);
  let draftBody = $state("");
  let creatingDraft = $state(false);
  let draftAnchorEl = $state<HTMLDivElement | undefined>();
  let draftAnchorLeft = $state(0);
  let draftAnchorTop = $state(0);
  let canvasEl = $state<HTMLDivElement | undefined>();
  let placements = $state<Record<string, { top: number; clamped: "top" | "bottom" | null; connectorY: number | null }>>({});

  const isMobile = () => window.matchMedia("(max-width: 780px)").matches;
  const anchored = $derived(isEditorOn($viewMode) && !isMobile() && !manualList);

  function currentDocContext() {
    const doc = getActiveDoc();
    if (!doc) return null;
    const ws = get(workspacesStore).find((w) => w.id === doc.workspaceId);
    // A joined workspace's local id differs from the Durable Object's —
    // every /api/workspace/* call addresses the room by ws.remoteId.
    const roomId = ws?.remoteId ?? doc.workspaceId;
    return { doc, isShared: !!ws?.shared, roomId };
  }

  // The editor's current raw text — relocateAnchor / changeText slices
  // are computed against it. Read fresh right before building the list
  // (never at the top of loadEntries: on a first run just after a doc
  // switch the editor can still be empty, which would orphan every
  // comment).
  const editorContent = () => window.MDE.getEditor()?.state.doc.toString() ?? "";

  async function loadEntries() {
    const ctx = currentDocContext();
    if (!ctx) {
      annotations = [];
      unresolvedCommentCount.set(0);
      pendingSuggestionCount.set(0);
      if (lastMarkerKey !== "[]") {
        lastMarkerKey = "[]";
        window.MDE.setCommentMarkers?.([]);
      }
      scheduleReposition();
      return;
    }
    loading = true;
    if (ctx.isShared) {
      // SP-B — comments now live in a `comments` Y.Map on the doc, read
      // synchronously (Yjs sync is the liveness; collab.ts's per-binding
      // observer drives re-derive via window.MDE.onCommentsChanged).
      const doc = window.MDE.getActiveYDoc?.() ?? null;
      const threads = doc ? listResolvedCommentThreads(doc, editorContent()) : [];
      const suggestions = window.MDE.getResolvedSuggestions?.() ?? [];
      annotations = railAnnotationsForShared(suggestions, threads, editorContent());
      unresolvedCommentCount.set(threads.filter((t) => !t.resolved).length);
    } else {
      await fetchAndMergeRepoHistory(ctx.doc);
      const freshDoc = getActiveDoc(); // re-read: repo history may have updated doc.notes
      annotations = railAnnotationsForLocal(freshDoc?.notes ?? [], editorContent());
      unresolvedCommentCount.set(0);
      pendingSuggestionCount.set(0); // a local doc has no suggestions
    }
    loading = false;
    // Editor highlights for comment anchors only — suggestion marks are
    // drawn by suggestion-editor.ts's own extension. Skip the dispatch
    // when nothing changed: setCommentMarkers calls view.dispatch, and a
    // redundant dispatch fired from inside a reactive flush re-enters
    // Svelte's scheduler (an effect_update_depth_exceeded loop —
    // see project memory / the v1.61.1 fix).
    const markers = annotations
      .filter((a) => a.kind === "comment" && !a.orphaned && a.anchorTo > a.anchorFrom)
      .map((a) => ({ id: a.id, from: a.anchorFrom, to: a.anchorTo }));
    const markerKey = JSON.stringify(markers);
    if (markerKey !== lastMarkerKey) {
      lastMarkerKey = markerKey;
      window.MDE.setCommentMarkers?.(markers);
    }
    scheduleReposition();
  }

  // reposition() reads layout and writes `placements`; it must never run
  // synchronously inside a reactive flush (see effect_update_depth), so
  // every caller goes through this rAF-coalesced scheduler.
  let lastMarkerKey = "";
  let repositionPending = false;
  function scheduleReposition() {
    if (repositionPending) return;
    repositionPending = true;
    requestAnimationFrame(() => {
      repositionPending = false;
      reposition();
    });
  }

  function reposition() {
    if (!anchored) {
      if (Object.keys(placements).length) placements = {};
      return;
    }
    const cm = window.MDE.getEditor();
    if (!cm || !canvasEl) return;
    const scroller = cm.scrollDOM.getBoundingClientRect();
    const railTop = canvasEl.getBoundingClientRect().top;
    const anchors: CardAnchor[] = annotations.map((a) => {
      const coords = cm.coordsAtPos(a.anchorFrom);
      const slot = canvasEl!.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(a.id)}"]`);
      const height = slot?.offsetHeight ?? 64;
      if (!coords || coords.top < scroller.top || coords.top > scroller.bottom) {
        const above = (coords && coords.top < scroller.top) || (!coords && a.anchorFrom === 0);
        return { id: a.id, anchorY: null, direction: above ? "above" : "below", height };
      }
      return { id: a.id, anchorY: coords.top - railTop, height };
    });
    const out = layoutCards(anchors, { height: canvasEl.clientHeight }, GAP);
    const anchorYById = new Map(anchors.map((x) => [x.id, x.anchorY]));
    placements = Object.fromEntries(
      out.map((p) => [p.id, { top: p.top, clamped: p.clamped, connectorY: p.clamped ? null : (anchorYById.get(p.id) ?? null) }]),
    );
  }

  // Recompute card positions when the mode or the annotation set changes.
  // Reads only what should retrigger it, and defers the actual work to a
  // frame — reposition() writes `placements`, which must not happen
  // synchronously inside this flush.
  $effect(() => {
    void $viewMode;
    void manualList;
    void annotations;
    scheduleReposition();
  });

  // ── Actions, by annotation id ────────────────────────────────────
  const ydoc = () => window.MDE.getActiveYDoc?.() ?? null;

  function acceptSuggestion(a: RailAnnotation) {
    const doc = ydoc();
    if (doc) underlyingIds(a).forEach((id) => resolveSuggestion(doc, id, "accept"));
  }
  function rejectSuggestion(a: RailAnnotation) {
    const doc = ydoc();
    if (doc) underlyingIds(a).forEach((id) => resolveSuggestion(doc, id, "reject"));
  }
  function withdrawOwn(a: RailAnnotation) {
    const doc = ydoc();
    if (doc) underlyingIds(a).forEach((id) => withdrawSuggestion(doc, id));
  }
  function resolveSubEdit(ids: string[], outcome: "accept" | "reject") {
    const doc = ydoc();
    if (doc) ids.forEach((id) => resolveSuggestion(doc, id, outcome));
  }

  // The current user's collaboration identity — a GitHub username or the
  // server-assigned "anon:<id>". Empty only in the brief window before the
  // MESSAGE_ANON_IDENTITY frame lands on a first-ever anonymous visit.
  const viewerId = () => window.MDE.githubUsername || $collabIdentity.id;

  function submitReply(a: RailAnnotation, body: string) {
    const ctx = currentDocContext();
    const doc = ydoc();
    if (!ctx || !ctx.isShared || !doc || !body.trim()) return;
    if (a.kind === "suggestion") {
      addSuggestionReply(doc, underlyingIds(a)[0], viewerId(), body.trim());
    } else {
      addCommentReply(doc, a.id, viewerId(), body.trim());
    }
    void loadEntries();
  }

  function toggleResolve(threadId: string, resolved: boolean) {
    const ctx = currentDocContext();
    const doc = ydoc();
    if (!ctx || !ctx.isShared || !doc) return;
    resolveCommentThread(doc, threadId, resolved);
    void loadEntries();
  }

  async function removeAnnotation(a: RailAnnotation) {
    const ctx = currentDocContext();
    if (!ctx) return;
    if (!ctx.isShared) {
      deleteDocNote(a.id);
    } else {
      const doc = ydoc();
      if (!doc) {
        showToast("Couldn't delete comment", "error");
        return;
      }
      deleteCommentThread(doc, a.id);
    }
    await loadEntries();
  }

  function jumpTo(a: RailAnnotation) {
    const cm = window.MDE.getEditor();
    if (!cm) return;
    cm.dispatch({ selection: { anchor: a.anchorFrom, head: a.anchorTo }, scrollIntoView: true });
    cm.focus();
  }

  async function submitDraft() {
    const ctx = currentDocContext();
    if (!ctx || !draftBody.trim() || !$commentDraft.visible) return;
    const cm = window.MDE.getEditor();
    const quote = cm.state.sliceDoc($commentDraft.from, $commentDraft.to);
    if (ctx.isShared) {
      const doc = ydoc();
      if (!doc) showToast("Couldn't add comment", "error");
      else createCommentThread(doc, $commentDraft.from, $commentDraft.to, quote, viewerId(), draftBody.trim());
    } else {
      addDocNote($commentDraft.from, $commentDraft.to, quote, draftBody.trim());
    }
    draftBody = "";
    creatingDraft = false;
    commentsPanelOpen.set(true);
    await loadEntries();
  }

  // ── Effects ─────────────────────────────────────────────────────
  // Reload on every active-doc change. The extra rAF-chained reloads
  // cover the first mount / doc switch, when Editor.svelte may not have
  // pushed the document text yet — relocating a comment against an empty
  // editor would orphan it. Cheap (bounded, and loadEntries is a no-op
  // re-derive once the content is stable).
  $effect(() => {
    void $activeIdStore;
    let frames = 0;
    const kick = () => {
      void loadEntries();
      // Keep retrying only while the editor is still empty (the race we
      // guard against) — stop as soon as it has content or we've waited
      // long enough. Avoids re-fetching comments on every frame.
      if (frames++ < 8 && editorContent() === "" && currentDocContext()) requestAnimationFrame(kick);
    };
    queueMicrotask(kick);
  });

  function close() {
    commentsPanelOpen.set(false);
  }

  $effect(() => {
    document.getElementById("commentsBtn")?.classList.toggle("active", $commentsPanelOpen);
  });

  // CV2-1b — Viewing mode has no comments surface.
  $effect(() => {
    const viewing = $effectiveMode === "viewing";
    document.getElementById("commentsBtn")?.toggleAttribute("disabled", !$activeIdStore || viewing);
    if (viewing) commentsPanelOpen.set(false);
  });

  // One badge for everything the rail surfaces — unresolved comment
  // threads plus pending suggestions (the dedicated #suggestionsBtn and
  // its own badge were removed; that button had no panel to open).
  $effect(() => {
    const badge = document.getElementById("commentsBadge");
    if (!badge) return;
    const count = $unresolvedCommentCount + $pendingSuggestionCount;
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? "99+" : String(count);
  });

  let lastDraftKey = $state<string | null>(null);
  $effect(() => {
    const key = $commentDraft.visible ? `${$commentDraft.from}:${$commentDraft.to}` : null;
    if (key !== lastDraftKey) {
      lastDraftKey = key;
      creatingDraft = false;
      draftBody = "";
    }
  });

  $effect(() => {
    const coords = $commentDraft.coords;
    void creatingDraft;
    if (!coords) return;
    const margin = 8;
    draftAnchorTop = coords.bottom + 4;
    draftAnchorLeft = coords.left;
    if (!draftAnchorEl) return;
    draftAnchorLeft = Math.max(margin, Math.min(coords.left, window.innerWidth - draftAnchorEl.offsetWidth - margin));
    draftAnchorTop = Math.max(margin, Math.min(draftAnchorTop, window.innerHeight - draftAnchorEl.offsetHeight - margin));
  });

  onMount(() => {
    const toggle = () => {
      const willOpen = !get(commentsPanelOpen);
      if (willOpen) window.MDE.collapseSidebarForMobile();
      commentsPanelOpen.update((open) => !open);
    };
    document.getElementById("commentsBtn")?.addEventListener("click", toggle);
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && creatingDraft) creatingDraft = false;
    };
    document.addEventListener("keydown", onKeydown);

    // Re-derive when the active doc's suggestions or comment threads
    // change (local edit or a remote collaborator's, via collab.ts's
    // per-binding Y.Map observers).
    window.MDE.onSuggestionsChanged = () => queueMicrotask(() => void loadEntries());
    window.MDE.onCommentsChanged = () => queueMicrotask(() => void loadEntries());

    const cm = window.MDE.getEditor();
    const onScroll = () => scheduleReposition();
    cm?.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    // A window resize covers the important editor-pane resize cases
    // (sidebar/rail open-close reflow, browser resize). Divider drags
    // don't fire it — a small gap accepted for SP-A rather than run a
    // ResizeObserver, whose "loop completed" warning trips Vite's dev
    // overlay in the e2e suite.
    window.addEventListener("resize", onScroll);

    return () => {
      document.getElementById("commentsBtn")?.removeEventListener("click", toggle);
      document.removeEventListener("keydown", onKeydown);
      window.MDE.onSuggestionsChanged = null;
      window.MDE.onCommentsChanged = null;
      cm?.scrollDOM.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  });

  const viewer = $derived({ role: $collabRole, name: window.MDE.githubUsername || $collabIdentity.id });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="mobile-sheet-backdrop" class:visible={$commentsPanelOpen} onclick={close}></div>

{#if $commentDraft.visible && $commentDraft.coords}
  <div class="comment-draft-anchor" bind:this={draftAnchorEl} style="left: {draftAnchorLeft}px; top: {draftAnchorTop}px;">
    {#if !creatingDraft}
      <button type="button" class="secondary-btn comment-add-btn" onclick={() => (creatingDraft = true)}>Add comment</button>
    {:else}
      <div class="comment-draft-box">
        <textarea bind:value={draftBody} placeholder="Add a comment…" rows="2"></textarea>
        <div class="comment-draft-actions">
          <button type="button" class="secondary-btn" onclick={() => { creatingDraft = false; draftBody = ""; }}>Cancel</button>
          <button type="button" class="primary-btn" disabled={!draftBody.trim()} onclick={submitDraft}>Comment</button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<div class="annotation-rail" class:collapsed={!$commentsPanelOpen} role="complementary" aria-label="Comments">
  <div class="annotation-rail-header">
    <h2>Comments</h2>
    {#if isEditorOn($viewMode) && !isMobile()}
      <button type="button" class="secondary-btn" onclick={() => (manualList = !manualList)}>{manualList ? "Anchored" : "List"}</button>
    {/if}
    <button type="button" class="secondary-btn" onclick={close}>Close</button>
  </div>
  <div class="annotation-rail-canvas" class:anchored bind:this={canvasEl}>
    {#if loading}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-message-square"></use></svg>
        <div class="empty-state-title">Loading…</div>
      </div>
    {:else if annotations.length === 0}
      <div class="empty-state">
        <svg class="empty-state-icon"><use href="#icon-message-square"></use></svg>
        <div class="empty-state-title">No comments yet</div>
        <div class="empty-state-desc">Select text and click "Add comment" to start one.</div>
      </div>
    {:else}
      {#each annotations as a (a.id)}
        {#if anchored && placements[a.id]?.connectorY != null}
          <span class="annotation-connector" style="top: {placements[a.id].connectorY}px;"></span>
        {/if}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="annotation-rail-slot"
          data-card-id={a.id}
          style={anchored && placements[a.id] ? `position:absolute; top:${placements[a.id].top}px; left:8px; right:8px;` : ""}
          onmouseenter={() => activeAnnotationIds.set(underlyingIds(a))}
          onmouseleave={() => activeAnnotationIds.set([])}
        >
          <AnnotationCard
            annotation={a}
            {viewer}
            focused={focusedId === a.id}
            active={underlyingIds(a).some((id) => $activeAnnotationIds.includes(id))}
            onFocus={() => (focusedId = a.id)}
            onJump={() => jumpTo(a)}
            onAccept={() => acceptSuggestion(a)}
            onReject={() => rejectSuggestion(a)}
            onWithdraw={() => withdrawOwn(a)}
            onSubEdit={(ids, outcome) => resolveSubEdit(ids, outcome)}
            onResolve={(r) => toggleResolve(a.id, r)}
            onDelete={() => removeAnnotation(a)}
            onReply={(body) => submitReply(a, body)}
          />
        </div>
      {/each}
    {/if}
  </div>
</div>
