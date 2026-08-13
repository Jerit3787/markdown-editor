<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { commentsPanelOpen } from "../stores/commentsPanel";
  import { commentDraft } from "../stores/commentDraft";
  import { activeIdStore, getActiveDoc, addDocNote, deleteDocNote } from "../stores/docs";
  import { listComments, createComment, replyToComment, resolveComment, deleteComment, type CommentThread } from "../comments";
  import { relocateAnchor } from "../anchor";
  import { showToast } from "../stores/toast";
  import type { Note } from "../types";

  type Entry = (Note & { kind: "note" }) | (CommentThread & { kind: "thread" });

  let entries = $state<Entry[]>([]);
  let loading = $state(false);
  let draftBody = $state("");
  let creatingDraft = $state(false);
  let replyBodies = $state<Record<string, string>>({});

  function currentDocContext() {
    const doc = getActiveDoc();
    return doc ? { doc, isShared: !!doc.shared } : null;
  }

  async function loadEntries() {
    const ctx = currentDocContext();
    if (!ctx) {
      entries = [];
      window.MDE.setCommentMarkers([]);
      return;
    }
    loading = true;
    if (ctx.isShared) {
      const threads = await listComments(ctx.doc.id);
      entries = threads.map((t) => ({ ...t, kind: "thread" as const }));
    } else {
      entries = (ctx.doc.notes || []).map((n) => ({ ...n, kind: "note" as const }));
    }
    loading = false;
    const cm = window.MDE.getEditor();
    // Defensive: main.ts mounts this component after Editor.svelte
    // specifically so cm is already registered by the time this first
    // runs (see main.ts's own comment) — this guard is a backstop
    // against that assumption ever breaking, not the primary fix.
    if (!cm) return;
    // relocateAnchor's from/to offsets are computed against the editor's
    // raw text (see createThread/addDocNote, both fed sliceDoc/quote
    // straight from CodeMirror) — the live editor content, not
    // getResolvedContent() (which embeds resolved image/diagram data and
    // would shift every offset).
    const content = cm.state.doc.toString();
    window.MDE.setCommentMarkers(
      entries
        .map((e) => {
          const r = relocateAnchor(content, e);
          return r ? { id: e.id, from: r.from, to: r.to } : null;
        })
        .filter((x): x is { id: string; from: number; to: number } => x !== null),
    );
  }

  async function submitDraft() {
    const ctx = currentDocContext();
    if (!ctx || !draftBody.trim() || !$commentDraft.visible) return;
    const cm = window.MDE.getEditor();
    const quote = cm.state.sliceDoc($commentDraft.from, $commentDraft.to);
    if (ctx.isShared) {
      const thread = await createComment(ctx.doc.id, $commentDraft.from, $commentDraft.to, quote, draftBody.trim());
      if (!thread) showToast("Couldn't add comment", "error");
    } else {
      addDocNote($commentDraft.from, $commentDraft.to, quote, draftBody.trim());
    }
    draftBody = "";
    creatingDraft = false;
    commentsPanelOpen.set(true);
    await loadEntries();
  }

  async function submitReply(threadId: string) {
    const ctx = currentDocContext();
    if (!ctx || !ctx.isShared) return;
    const body = (replyBodies[threadId] || "").trim();
    if (!body) return;
    await replyToComment(ctx.doc.id, threadId, body);
    replyBodies = { ...replyBodies, [threadId]: "" };
    await loadEntries();
  }

  async function toggleResolve(thread: CommentThread) {
    const ctx = currentDocContext();
    if (!ctx || !ctx.isShared) return;
    await resolveComment(ctx.doc.id, thread.id, !thread.resolved);
    await loadEntries();
  }

  async function removeEntry(entry: Entry) {
    const ctx = currentDocContext();
    if (!ctx) return;
    if (entry.kind === "note") {
      deleteDocNote(entry.id);
    } else {
      const ok = await deleteComment(ctx.doc.id, entry.id);
      if (!ok) {
        showToast("Couldn't delete comment", "error");
        return;
      }
    }
    await loadEntries();
  }

  function jumpTo(entry: Entry) {
    const cm = window.MDE.getEditor();
    cm.dispatch({ selection: { anchor: entry.from, head: entry.to }, scrollIntoView: true });
    cm.focus();
  }

  $effect(() => {
    // Re-load whenever the active document changes, regardless of
    // whether the panel itself is open — highlights should reflect the
    // current document even if you haven't opened the panel yet.
    $activeIdStore;
    // For a local document, loadEntries() has no real await (doc.notes
    // is already in memory) and runs fully synchronously, including its
    // cm.dispatch() call inside setCommentMarkers — which, executed
    // synchronously inside this effect's own flush, re-enters Svelte's
    // reactivity system and trips "effect_update_depth_exceeded"
    // (verified empirically: removing this queueMicrotask reproduces it
    // on every load). VersionHistory.svelte's equivalent effect never
    // hits this because IndexedDB is inherently asynchronous, so its
    // loadVersions() always yields for local docs too. queueMicrotask
    // forces the same real yield here regardless of which branch runs.
    queueMicrotask(() => void loadEntries());
  });

  function close() {
    commentsPanelOpen.set(false);
  }

  // #comments-panel-mount now lives inside #body, as a real flex
  // sibling of #main (see index.html) — opening the panel pushes
  // #main's own content narrower instead of floating a fixed-position
  // overlay on top of it, so no manual topbar-offset/z-index handling
  // is needed here any more.
  $effect(() => {
    document.getElementById("commentsBtn")?.classList.toggle("active", $commentsPanelOpen);
  });

  onMount(() => {
    // On mobile, opening comments should close the sidenav bottom
    // sheet first — both are 75vh sheets and would otherwise stack.
    // No-op on desktop: collapseSidebarForMobile() itself no-ops there.
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
    return () => {
      document.getElementById("commentsBtn")?.removeEventListener("click", toggle);
      document.removeEventListener("keydown", onKeydown);
    };
  });
</script>

{#if $commentsPanelOpen && $commentDraft.visible && $commentDraft.coords}
  <div class="comment-draft-anchor" style="left: {$commentDraft.coords.left}px; top: {$commentDraft.coords.bottom + 4}px;">
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

{#if $commentsPanelOpen}
  <div class="mobile-sheet-backdrop" onclick={close}></div>
  <div class="comments-panel" role="complementary" aria-label="Comments">
    <div class="comments-panel-header">
      <h2>Comments</h2>
      <button type="button" class="secondary-btn" onclick={close}>Close</button>
    </div>
    <div class="comments-panel-list">
      {#if loading}
        <p class="modal-hint">Loading…</p>
      {:else if entries.length === 0}
        <p class="modal-hint">No comments yet — select text and click "Add comment" to start one.</p>
      {:else}
        {#each entries as entry (entry.id)}
          <div class="comment-entry" class:orphaned={entry.orphaned}>
            <button type="button" class="comment-entry-quote" onclick={() => jumpTo(entry)}>
              "{entry.quote}"{#if entry.orphaned} <span class="comment-orphaned-label">(text no longer found)</span>{/if}
            </button>
            {#if entry.kind === "note"}
              <p class="comment-body">{entry.body}</p>
            {:else}
              {#each entry.comments as reply (reply.id)}
                <p class="comment-body"><strong>{reply.author}:</strong> {reply.body}</p>
              {/each}
              <div class="comment-reply-row">
                <input
                  type="text"
                  placeholder="Reply…"
                  value={replyBodies[entry.id] || ""}
                  oninput={(e) => (replyBodies = { ...replyBodies, [entry.id]: (e.target as HTMLInputElement).value })}
                />
                <button type="button" class="secondary-btn" onclick={() => submitReply(entry.id)}>Reply</button>
              </div>
              <button type="button" class="secondary-btn" onclick={() => toggleResolve(entry)}>
                {entry.resolved ? "Reopen" : "Resolve"}
              </button>
            {/if}
            <button type="button" class="comment-delete-btn" onclick={() => removeEntry(entry)} aria-label="Delete">
              <svg class="icon"><use href="#icon-trash-2"></use></svg>
            </button>
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}
