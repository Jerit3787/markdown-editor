<script lang="ts">
  import { onMount } from "svelte";
  import { whatsNewOpen } from "../stores/whatsNew";
  import { WHATS_NEW_ENTRIES } from "../whats-new-entries";
  import { missedEntries } from "../whats-new";

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
  // anyone already caught up. `slides` switches to the full list once
  // `showAll` flips true, below.
  const missed = missedEntries(WHATS_NEW_ENTRIES, localStorage.getItem(STORAGE_KEY));
  // The Help menu's "What's New" entry is a manual, on-demand re-open —
  // like any other app's changelog menu item, it should always show
  // everything, not just whatever's still unseen.
  let showAll = $state(false);
  const slides = $derived(showAll ? WHATS_NEW_ENTRIES : missed);
  let slideIndex = $state(0);
  const isLast = $derived(slideIndex >= slides.length - 1);

  function dismiss() {
    whatsNewOpen.set(false);
    localStorage.setItem(STORAGE_KEY, CURRENT_VERSION);
  }
  function backdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) dismiss();
  }
  function next() {
    if (isLast) {
      dismiss();
      return;
    }
    slideIndex += 1;
  }
  function prev() {
    if (slideIndex > 0) slideIndex -= 1;
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
    // — i.e. the Help menu — and should show everything.
    let sawInitialValue = false;
    const unsubscribe = whatsNewOpen.subscribe((open) => {
      if (!sawInitialValue) {
        sawInitialValue = true;
        return;
      }
      if (open) {
        showAll = true;
        slideIndex = 0;
      }
    });
    return () => {
      document.removeEventListener("keydown", onKeydown);
      unsubscribe();
    };
  });
</script>

{#if $whatsNewOpen && slides[slideIndex]}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="modal-backdrop" data-svelte-modal onclick={backdropClick}>
    <div class="modal-box modal-box-wide" role="dialog" aria-modal="true" aria-labelledby="whatsNewTitle">
      <h2 id="whatsNewTitle"><svg class="icon"><use href="#icon-rocket"></use></svg> What's new</h2>
      <div class="whats-new-slide">
        <img class="whats-new-screenshot" src={slides[slideIndex].screenshot} alt={slides[slideIndex].title} />
        <div class="whats-new-text">
          <div class="menu-section-label">{slides[slideIndex].title}</div>
          <p class="hint-text">{slides[slideIndex].description}</p>
        </div>
      </div>
      {#if slides.length > 1}
        <div class="whats-new-nav">
          <button type="button" class="secondary-btn" disabled={slideIndex === 0} onclick={prev}>← Back</button>
          <span class="whats-new-counter">{slideIndex + 1} of {slides.length}</span>
          <button type="button" class="primary-btn" onclick={next}>{isLast ? "Got it" : "Next →"}</button>
        </div>
      {:else}
        <div class="modal-actions">
          <button class="primary-btn" type="button" onclick={dismiss}>Got it</button>
        </div>
      {/if}
    </div>
  </div>
{/if}
