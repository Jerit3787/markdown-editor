<script lang="ts">
  import { SearchQuery, setSearchQuery, findNext, findPrevious, replaceNext, replaceAll } from "@codemirror/search";
  import { countMatches } from "../search";
  import { findBarOpen, findBarMode, closeFindBar } from "../stores/findReplace";

  let findText = $state("");
  let replaceText = $state("");
  let caseSensitive = $state(false);
  let wholeWord = $state(false);
  let regexp = $state(false);
  let matchInfo = $state<{ total: number; index: number }>({ total: 0, index: 0 });
  let readOnly = $state(false);
  let findInputEl: HTMLInputElement | undefined = $state();

  const query = $derived(new SearchQuery({ search: findText, replace: replaceText, caseSensitive, wholeWord, regexp }));

  function view() {
    return window.MDE.getEditor();
  }

  function refresh() {
    const v = view();
    matchInfo = countMatches(v.state, query);
    readOnly = v.state.readOnly;
  }

  // Reactively pushes every query change (typing, or a toggle) into the
  // editor's search state and recomputes the match count. Doesn't cover
  // findNext/findPrevious/replaceNext/replaceAll below, which move the
  // selection or change the document without changing the query itself
  // — those call refresh() directly instead.
  $effect(() => {
    if (!$findBarOpen) return;
    view().dispatch({ effects: setSearchQuery.of(query) });
    refresh();
  });

  // Focuses (and selects the existing text of) the find input every time
  // the bar opens — Ctrl/Cmd+F while it's already open just refocuses,
  // matching VS Code.
  $effect(() => {
    if ($findBarOpen) {
      findInputEl?.focus();
      findInputEl?.select();
    }
  });

  function goNext() {
    findNext(view());
    refresh();
  }
  function goPrev() {
    findPrevious(view());
    refresh();
  }
  function doReplace() {
    replaceNext(view());
    refresh();
  }
  function doReplaceAll() {
    replaceAll(view());
    refresh();
  }
  function toggleReplaceRow() {
    findBarMode.set($findBarMode === "replace" ? "find" : "replace");
  }
  function close() {
    closeFindBar();
    view().focus();
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
    }
  }
</script>

{#if $findBarOpen}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="find-replace-bar" role="search" onkeydown={onKeydown}>
    <div class="find-row">
      <input
        type="text"
        placeholder="Find"
        bind:value={findText}
        bind:this={findInputEl}
        class:invalid={findText.length > 0 && !query.valid}
        aria-label="Find"
      />
      <span class="match-count">{matchInfo.total === 0 ? (findText ? "No results" : "") : `${matchInfo.index} of ${matchInfo.total}`}</span>
      <button type="button" onclick={goPrev} disabled={!query.valid || matchInfo.total === 0} aria-label="Previous match">
        <svg class="icon"><use href="#icon-chevron-left"></use></svg>
      </button>
      <button type="button" onclick={goNext} disabled={!query.valid || matchInfo.total === 0} aria-label="Next match">
        <svg class="icon"><use href="#icon-chevron-right"></use></svg>
      </button>
      <button type="button" class:active={caseSensitive} onclick={() => (caseSensitive = !caseSensitive)} aria-label="Match case" aria-pressed={caseSensitive}>
        Aa
      </button>
      <button type="button" class:active={wholeWord} onclick={() => (wholeWord = !wholeWord)} aria-label="Whole word" aria-pressed={wholeWord}>
        [ab]
      </button>
      <button type="button" class:active={regexp} onclick={() => (regexp = !regexp)} aria-label="Use regular expression" aria-pressed={regexp}>
        .*
      </button>
      <button type="button" onclick={toggleReplaceRow} aria-label="Toggle replace" aria-expanded={$findBarMode === "replace"}>
        <svg class="icon"><use href={$findBarMode === "replace" ? "#icon-chevron-down" : "#icon-chevron-right"}></use></svg>
      </button>
      <button type="button" onclick={close} aria-label="Close">
        <svg class="icon"><use href="#icon-x"></use></svg>
      </button>
    </div>
    {#if $findBarMode === "replace"}
      <div class="replace-row">
        <input type="text" placeholder="Replace" bind:value={replaceText} aria-label="Replace" />
        <button type="button" onclick={doReplace} disabled={readOnly || !query.valid || matchInfo.total === 0}>Replace</button>
        <button type="button" onclick={doReplaceAll} disabled={readOnly || !query.valid || matchInfo.total === 0}>Replace All</button>
      </div>
    {/if}
  </div>
{/if}
