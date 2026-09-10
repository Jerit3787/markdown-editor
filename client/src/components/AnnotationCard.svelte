<script lang="ts">
  import { displayName, type RailAnnotation } from "../annotations";

  let {
    annotation,
    viewer,
    focused = false,
    active = false,
    onAccept,
    onReject,
    onWithdraw,
    onSubEdit,
    onResolve,
    onDelete,
    onReply,
    onJump,
    onFocus,
  }: {
    annotation: RailAnnotation;
    viewer: { role: "editor" | "reviewer" | "viewer" | null; name: string };
    focused?: boolean;
    active?: boolean;
    onAccept?: () => void;
    onReject?: () => void;
    onWithdraw?: () => void;
    onSubEdit?: (ids: string[], outcome: "accept" | "reject") => void;
    onResolve?: (resolved: boolean) => void;
    onDelete?: () => void;
    onReply?: (body: string) => void;
    onJump?: () => void;
    onFocus?: () => void;
  } = $props();

  let replyBody = $state("");

  const isSuggestion = $derived(annotation.kind === "suggestion");
  const isOwn = $derived(!!annotation.author && annotation.author === viewer.name);
  const isEditor = $derived(viewer.role === "editor");
  const isAnon = $derived(annotation.author.startsWith("anon:"));
  const isGroup = $derived(!!annotation.subEdits);
  const label = $derived(displayName(annotation.author, annotation.authorName));
  // encodeURIComponent so a hostile author string can't smuggle a query
  // param or path segment into the avatar URL. The server already
  // constrains `author` to a real GitHub username or an `anon:` id, but
  // the card renders local-note and legacy data too — cheap defence in
  // depth. An `anon:` author has no GitHub avatar → generic icon.
  const avatarUrl = $derived(annotation.author && !isAnon ? `https://github.com/${encodeURIComponent(annotation.author.trim())}.png` : "");

  function submitReply() {
    const b = replyBody.trim();
    if (b) {
      onReply?.(b);
      replyBody = "";
    }
  }
</script>

<article
  class="annotation-card"
  class:suggestion={isSuggestion}
  class:comment={!isSuggestion}
  class:focused
  class:active
  class:resolved={annotation.resolved}
  class:orphaned={annotation.orphaned}
  onmouseenter={() => onFocus?.()}
>
  <header class="annotation-card-head">
    {#if avatarUrl}
      <img
        class="annotation-card-avatar"
        src={avatarUrl}
        alt=""
        onerror={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = "hidden")}
      />
    {:else if isAnon}
      <span class="annotation-card-avatar annotation-card-avatar-anon" aria-hidden="true">
        <svg class="icon"><use href="#icon-user"></use></svg>
      </span>
    {/if}
    <div class="annotation-card-meta">
      <span class="annotation-card-author"
        >{label || "Someone"}{#if isSuggestion}<span class="annotation-card-role"> · suggesting</span>{/if}</span
      >
      {#if isSuggestion && isGroup}
        <span class="annotation-card-change">{annotation.subEdits!.length} changes</span>
      {:else if isSuggestion}
        <span class="annotation-card-change">
          {#if annotation.replacedText != null}
            Replace <del>{annotation.replacedText}</del> → <ins>{annotation.changeText}</ins>
          {:else if annotation.changeKind === "insert"}
            Add <ins>{annotation.changeText}</ins>
          {:else}
            Remove <del>{annotation.changeText}</del>
          {/if}
        </span>
      {:else}
        <button type="button" class="annotation-card-quote" onclick={() => onJump?.()}>
          "{annotation.quote}"{#if annotation.orphaned}<span class="annotation-card-orphan"> (text no longer found)</span>{/if}
        </button>
      {/if}
    </div>
  </header>

  {#if isGroup}
    <ul class="annotation-card-subedits">
      {#each annotation.subEdits! as sub, i (i)}
        <li class="annotation-card-subedit">
          <span class="annotation-card-subedit-text">
            {#if sub.kind === "replace"}
              Replace <del>{sub.replacedText}</del> → <ins>{sub.changeText}</ins>
            {:else if sub.kind === "insert"}
              Add <ins>{sub.changeText}</ins>
            {:else}
              Remove <del>{sub.replacedText ?? sub.changeText}</del>
            {/if}
          </span>
          {#if isEditor}
            <span class="annotation-card-subedit-acts">
              <button type="button" data-act="accept" data-sub={i} title="Accept" onclick={() => onSubEdit?.(sub.ids, "accept")}>✓</button>
              <button type="button" data-act="reject" data-sub={i} title="Reject" onclick={() => onSubEdit?.(sub.ids, "reject")}>✗</button>
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if !isSuggestion || focused || (annotation.replies?.length ?? 0) > 0}
    <div class="annotation-card-body">
      {#each annotation.replies ?? [] as reply (reply.id)}
        <p class="annotation-card-reply">{#if reply.author}<strong>{reply.author}</strong>&nbsp;{/if}{reply.body}</p>
      {/each}
      {#if focused}
        <div class="annotation-card-reply-row">
          <input type="text" placeholder="Reply…" bind:value={replyBody} onkeydown={(e) => e.key === "Enter" && submitReply()} />
          <button type="button" class="secondary-btn" onclick={submitReply}>Reply</button>
        </div>
        <!-- A comment's first reply is its opening text; every reply on a
             suggestion is discussion. So the collapsed "N replies" count
             starts above 1 for a comment, above 0 for a suggestion. -->
      {:else if (annotation.replies?.length ?? 0) > (isSuggestion ? 0 : 1)}
        <p class="annotation-card-count">{annotation.replies!.length === 1 ? "1 reply" : `${annotation.replies!.length} replies`}</p>
      {/if}
    </div>
  {/if}

  {#if isSuggestion && isEditor}
    <div class="annotation-card-actions">
      <button type="button" data-act="accept" class="primary-btn" onclick={() => onAccept?.()}>{isGroup ? "✓ Accept all" : "✓ Accept"}</button>
      <button type="button" data-act="reject" class="secondary-btn" onclick={() => onReject?.()}>{isGroup ? "✗ Reject all" : "✗ Reject"}</button>
    </div>
  {:else if isSuggestion && isOwn}
    <div class="annotation-card-actions">
      <button type="button" data-act="withdraw" class="secondary-btn" onclick={() => onWithdraw?.()}>{isGroup ? "Withdraw all" : "Withdraw"}</button>
    </div>
  {:else if !isSuggestion}
    <div class="annotation-card-actions">
      <button type="button" class="secondary-btn" onclick={() => onResolve?.(!annotation.resolved)}>{annotation.resolved ? "Reopen" : "Resolve"}</button>
      <button type="button" class="secondary-btn" onclick={() => onDelete?.()}>Delete</button>
    </div>
  {/if}
</article>
