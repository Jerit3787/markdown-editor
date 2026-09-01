<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import { whatsNewOpen } from "../stores/whatsNew";
  import { WHATS_NEW_ENTRIES } from "../whats-new-entries";
  import type { WhatsNewCategory } from "../whats-new-entries";
  import { missedEntries, groupByCategory } from "../whats-new";

  const STORAGE_KEY = "mde:whatsNewSeen";
  // Single source of truth for "what version is this build" — already
  // injected by client/vite.config.ts's `define` from package.json,
  // already used by the About modal (app.ts). Kept independent of
  // WHATS_NEW_ENTRIES so a missing announcement entry is a warning
  // below, not a silently-wrong "current version."
  const CURRENT_VERSION = __APP_VERSION__;

  if (import.meta.env.DEV && WHATS_NEW_ENTRIES.at(-1)?.version !== CURRENT_VERSION) {
    console.warn(
      `WhatsNew: no announcement entry for the current version (${CURRENT_VERSION}) — add one to whats-new-entries.ts.`,
    );
  }

  // Computed once, at mount, against whatever was seen before this page
  // load — used only to decide the *auto*-open-on-load case in onMount
  // below. Re-deriving this on every open would go permanently empty
  // after the first dismissal (which bumps localStorage to
  // CURRENT_VERSION) — that's exactly what made the Help menu's manual
  // "What's New" entry look broken (silently rendering nothing) for
  // anyone already caught up. `slides` switches to a category's own
  // entries once `showAll` flips true and a category is picked, below.
  const missed = missedEntries(WHATS_NEW_ENTRIES, localStorage.getItem(STORAGE_KEY));
  // The Help menu's "What's New" entry is a manual, on-demand re-open —
  // unlike the auto-open catch-up popup (always just the few missed
  // entries, plain stepper), a manual reopen lands on a category index
  // first rather than a 27-entry stepper starting at the oldest release.
  // Only meaningful once `showAll` is true; null means "show the index."
  let showAll = $state(false);
  let categoryView = $state<WhatsNewCategory | null>(null);
  const categoryGroups = $derived(groupByCategory(WHATS_NEW_ENTRIES));
  const slides = $derived(
    !showAll ? missed : categoryView !== null ? (categoryGroups.find((g) => g.category === categoryView)?.entries ?? []) : [],
  );
  let slideIndex = $state(0);
  const isLast = $derived(slideIndex >= slides.length - 1);
  const inCategoryStepper = $derived(showAll && categoryView !== null);
  const doneLabel = $derived(inCategoryStepper ? "Done" : "Got it");

  function dismiss() {
    whatsNewOpen.set(false);
    localStorage.setItem(STORAGE_KEY, CURRENT_VERSION);
  }
  function backToCategories() {
    categoryView = null;
  }
  function next() {
    if (isLast) {
      if (inCategoryStepper) {
        backToCategories();
      } else {
        dismiss();
      }
      return;
    }
    slideIndex += 1;
  }
  function prev() {
    if (slideIndex > 0) slideIndex -= 1;
  }
  function openCategory(category: WhatsNewCategory) {
    categoryView = category;
    slideIndex = 0;
  }

  onMount(() => {
    if (missed.length > 0) whatsNewOpen.set(true);
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $whatsNewOpen) dismiss();
    };
    document.addEventListener("keydown", onKeydown);
    // MenuBar.svelte's Help > What's New button has no dedicated
    // element/id to listen for a click on (unlike the topbar icon
    // buttons other panels wire up) — it just flips whatsNewOpen true
    // directly. Subscribing here lets this component tell that apart
    // from its own auto-open above: subscribe() always replays the
    // current value synchronously as its first callback, so that first
    // call is the auto-open case (or the initial `false`) and is
    // ignored; every later transition to true is a real, later trigger
    // — i.e. the Help menu — and should show the category index.
    let sawInitialValue = false;
    const unsubscribe = whatsNewOpen.subscribe((open) => {
      if (!sawInitialValue) {
        sawInitialValue = true;
        return;
      }
      if (open) {
        showAll = true;
        categoryView = null;
        slideIndex = 0;
      }
    });
    return () => {
      document.removeEventListener("keydown", onKeydown);
      unsubscribe();
    };
  });
</script>

{#if $whatsNewOpen}
  <Modal title="What's new" icon="icon-rocket" maxWidth="680px" labelledBy="whatsNewTitle" onClose={dismiss}>
    {#snippet quickAction()}
      {#if inCategoryStepper}
        <button type="button" class="whats-new-back-link" onclick={backToCategories}>
          <svg class="icon"><use href="#icon-chevron-left"></use></svg> Categories
        </button>
      {/if}
    {/snippet}
    {#if showAll && categoryView === null}
      <div class="whats-new-category-grid">
        {#each categoryGroups as group (group.category)}
          <button type="button" class="whats-new-category-card" onclick={() => openCategory(group.category)}>
            <span class="whats-new-category-name">{group.category}</span>
            <span class="whats-new-category-count">{group.entries.length}</span>
          </button>
        {/each}
      </div>
    {:else if slides[slideIndex]}
      <div class="whats-new-slide">
        <img class="whats-new-screenshot" src={slides[slideIndex].screenshot} alt={slides[slideIndex].title} />
        <div class="whats-new-text">
          <div class="menu-section-label">{slides[slideIndex].title}</div>
          <p class="hint-text">{slides[slideIndex].description}</p>
        </div>
      </div>
    {/if}
    {#snippet footer()}
      {#if showAll && categoryView === null}
        <!-- Index has no footer controls — Modal's own X (or Escape) closes it. -->
      {:else if slides.length > 1}
        <div class="whats-new-nav">
          <button type="button" class="secondary-btn" disabled={slideIndex === 0} onclick={prev}>← Back</button>
          <span class="whats-new-counter">{slideIndex + 1} of {slides.length}</span>
          <button type="button" class="primary-btn" onclick={next}>{isLast ? doneLabel : "Next →"}</button>
        </div>
      {:else}
        <button class="primary-btn" type="button" onclick={next}>{doneLabel}</button>
      {/if}
    {/snippet}
  </Modal>
{/if}
