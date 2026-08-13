<script lang="ts">
  import { onMount } from "svelte";
  import { whatsNewOpen } from "../stores/whatsNew";

  // Bumped only when there's a new entry worth announcing — not tied to
  // every patch release. Matches package.json's version at the time this
  // was last updated; the two are allowed to drift (a patch release with
  // nothing to announce shouldn't reopen this for everyone).
  const CURRENT_VERSION = "1.13.0";
  const STORAGE_KEY = "mde:whatsNewSeen";

  function dismiss() {
    whatsNewOpen.set(false);
    localStorage.setItem(STORAGE_KEY, CURRENT_VERSION);
  }
  function backdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) dismiss();
  }

  onMount(() => {
    if (localStorage.getItem(STORAGE_KEY) !== CURRENT_VERSION) {
      whatsNewOpen.set(true);
    }
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $whatsNewOpen) dismiss();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $whatsNewOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" data-svelte-modal onclick={backdropClick}>
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="whatsNewTitle">
      <h2 id="whatsNewTitle"><svg class="icon"><use href="#icon-rocket"></use></svg> What's new</h2>
      <div class="menu-section-label">Threaded Comments</div>
      <p class="hint-text">
        Select any text and click "Add comment" to anchor a note to it — a personal note on
        your own documents, or a full discussion thread with replies and resolve/reopen once
        a document is shared. Open the panel from File &gt; Comments or the new icon next to
        Version History.
      </p>
      <div class="menu-section-label">Version History</div>
      <p class="hint-text">
        Every document now builds up automatic version history as you edit. Open it from
        File &gt; Version History or the new clock icon next to Share, preview any past
        version, and restore it — nothing is ever deleted, so a restore is itself undoable.
      </p>
      <div class="menu-section-label">Slash Commands</div>
      <p class="hint-text">
        Type <code>/</code> at the start of an empty line to insert headings, lists, tables,
        code blocks, and more — fuzzy-filter by typing after the slash, then Enter or Tab to
        pick.
      </p>
      <div class="menu-section-label">Command Palette</div>
      <p class="hint-text">
        Press <code>Ctrl/Cmd+Shift+P</code> (or use Help &gt; Command Palette) to search and run
        any command, or jump straight to any open document by name.
      </p>
      <div class="modal-actions">
        <button class="primary-btn" type="button" onclick={dismiss}>Got it</button>
      </div>
    </div>
  </div>
{/if}
