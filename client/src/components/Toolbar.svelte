<script lang="ts">
  import { onMount } from "svelte";
  import { diagramEditorOpen, diagramEditorRef } from "../stores/diagramEditor";
  import { viewMode, isEditorOn, isPreviewOn, toggleEditorPane, togglePreviewPane } from "../stores/view";
  import { runCmd } from "../formatting-commands";

  function run(cmd: string) {
    runCmd(cmd);
    window.MDE.getEditor().focus();
  }

  const editorOn = $derived(isEditorOn($viewMode));
  const previewOn = $derived(isPreviewOn($viewMode));

  let toolbarButtonsEl: HTMLDivElement;
  let overflowWrapEl: HTMLDivElement;
  let overflowBtn: HTMLButtonElement;
  let overflowMenuEl: HTMLDivElement;

  // #sidebarToggleOut + its separator (the first two children) are
  // structural navigation, not formatting commands — Google Docs' own
  // overflow collapse never touches its equivalent (undo/redo, zoom)
  // either, only the actual tool buttons after them.
  const ALWAYS_VISIBLE_COUNT = 2;

  // Re-measures which buttons fit in the visible row and moves whichever
  // don't into the overflow dropdown (as real DOM-node moves, not clones
  // — every button keeps its Svelte-bound onclick regardless of which
  // container currently holds it). Runs on mount and whenever
  // .toolbar-buttons' available width changes for any reason: window
  // resize, the document sidenav collapsing/expanding, or the comments
  // panel opening/closing (all of which change #body's grid columns
  // without necessarily firing a window resize event, which is why this
  // uses a ResizeObserver rather than a resize listener).
  // Whether every currently-visible button in .toolbar-buttons fits
  // within its own current width. Re-measures clientWidth fresh on each
  // call rather than caching it — .toolbar-buttons is flex:1 next to
  // .toolbar-overflow's flex-shrink:0, so showing/hiding the overflow
  // toggle (or changing how many buttons are in the row) changes
  // .toolbar-buttons' own available width via the browser's normal flex
  // distribution, no manual budget math needed. Reading each item's
  // rendered right edge (rather than summing offsetWidth) also
  // automatically accounts for the flex gap AND .sep's own
  // `margin: 3px 4px`, both of which a width-only sum would miss.
  function allVisibleFit(): boolean {
    const available = toolbarButtonsEl.clientWidth;
    const containerLeft = toolbarButtonsEl.getBoundingClientRect().left;
    return [...toolbarButtonsEl.children].every(
      (el) => (el as HTMLElement).getBoundingClientRect().right - containerLeft <= available,
    );
  }

  function recalcOverflow() {
    if (!toolbarButtonsEl || !overflowWrapEl || !overflowBtn || !overflowMenuEl) return;

    // Reset to "everything visible" first so each recalculation starts
    // from a known state instead of compounding a previous decision.
    // overflowWrapEl is a flex sibling of toolbarButtonsEl (not a
    // descendant — see the markup below, and the comment on
    // .toolbar-overflow in style.css explaining why), so a plain
    // appendChild always puts a returning item back at the end of the
    // visible row.
    while (overflowMenuEl.firstChild) {
      toolbarButtonsEl.appendChild(overflowMenuEl.firstChild);
    }
    overflowBtn.hidden = true;
    if (allVisibleFit()) return; // nothing overflows — leave the toggle hidden

    overflowBtn.hidden = false;
    while (toolbarButtonsEl.children.length > ALWAYS_VISIBLE_COUNT && !allVisibleFit()) {
      overflowMenuEl.appendChild(toolbarButtonsEl.lastElementChild as HTMLElement);
    }
  }

  onMount(() => {
    window.MDE.toggleDropdown(overflowBtn, overflowMenuEl);
    // toggleDropdown only closes on an outside click by design (it
    // explicitly skips clicks inside an open .dropdown-menu, since most
    // dropdowns — File/Edit/View/Help — need multiple clicks to
    // navigate submenus). This one's items are one-shot commands, same
    // as MenuBar.svelte's own menu items, which close via their act()
    // wrapper — event delegation here does the equivalent for buttons
    // that get moved in and out of overflowMenuEl at runtime.
    overflowMenuEl.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) window.MDE.closeAllDropdowns();
    });

    const observer = new ResizeObserver(recalcOverflow);
    observer.observe(toolbarButtonsEl);
    return () => observer.disconnect();
  });
</script>

<div id="toolbar">
  <div class="toolbar-buttons" bind:this={toolbarButtonsEl}>
    <!-- Always present now (a real toggle with an active/inactive state,
         not a button that appears/disappears depending on sidebar state)
         — sits inline with the formatting tools instead of floating over
         the editor. Wired by app.ts's initSidebar(), same as before —
         this component only owns the markup/id, not the click behavior
         or the active-state class, since sidebar state lives there. -->
    <button id="sidebarToggleOut" class="icon-btn" title="Toggle documents panel" aria-label="Toggle documents panel"><svg class="icon"><use href="#icon-menu"></use></svg></button>
    <span class="sep"></span>
    <button type="button" title="Bold (Ctrl+B)" onclick={() => run("bold")}><b>B</b></button>
    <button type="button" title="Italic (Ctrl+I)" onclick={() => run("italic")}><i>I</i></button>
    <button type="button" title="Strikethrough" onclick={() => run("strike")}><svg class="icon"><use href="#icon-strikethrough"></use></svg></button>
    <span class="sep"></span>
    <button type="button" title="Heading 1" onclick={() => run("h1")}>H1</button>
    <button type="button" title="Heading 2" onclick={() => run("h2")}>H2</button>
    <button type="button" title="Heading 3" onclick={() => run("h3")}>H3</button>
    <span class="sep"></span>
    <button type="button" title="Blockquote" onclick={() => run("quote")}><svg class="icon"><use href="#icon-quote"></use></svg></button>
    <button type="button" title="Inline code" onclick={() => run("code")}><svg class="icon"><use href="#icon-code"></use></svg></button>
    <button type="button" title="Code block" onclick={() => run("codeblock")}><svg class="icon"><use href="#icon-braces"></use></svg></button>
    <span class="sep"></span>
    <button type="button" title="Bullet list" onclick={() => run("ul")}><svg class="icon"><use href="#icon-list"></use></svg></button>
    <button type="button" title="Numbered list" onclick={() => run("ol")}><svg class="icon"><use href="#icon-list-ordered"></use></svg></button>
    <button type="button" title="Task list" onclick={() => run("task")}><svg class="icon"><use href="#icon-square-check"></use></svg></button>
    <span class="sep"></span>
    <button type="button" title="Link (Ctrl+K)" onclick={() => run("link")}><svg class="icon"><use href="#icon-link"></use></svg></button>
    <button type="button" title="Image" onclick={() => run("image")}><svg class="icon"><use href="#icon-image"></use></svg></button>
    <!-- Wired by app.ts's initImagesManager(), same as before. -->
    <button id="imagesManagerBtn" type="button" title="Manage images"><svg class="icon"><use href="#icon-images"></use></svg></button>
    <button type="button" title="Table" onclick={() => run("table")}><svg class="icon"><use href="#icon-table"></use></svg></button>
    <button type="button" title="Horizontal rule" onclick={() => run("hr")}>―</button>
    <button type="button" title="Insert diagram" onclick={() => { diagramEditorRef.set(null); diagramEditorOpen.set(true); }}><svg class="icon"><use href="#icon-workflow"></use></svg></button>
    <!-- A text glyph, not an SVG icon — matches the existing H1/H2/H3 and
         ― buttons in this same toolbar, which use plain text rather than
         inventing a new icon sprite entry. -->
    <button type="button" title="Math" onclick={() => run("math")}>&Sigma;</button>
    <button type="button" title="Footnote" onclick={() => run("footnote")}>[^]</button>
  </div>

  <!-- Google Docs-style overflow: buttons that don't fit the row above
       get moved here by recalcOverflow() above, rather than wrapping to
       a 2nd line or scrolling. Hidden by default; recalcOverflow() shows
       it only once something has actually overflowed. A flex SIBLING of
       .toolbar-buttons, not nested inside it — .toolbar-buttons has
       overflow:hidden (to clip the buttons it can't fit), which would
       also clip this dropdown's popup menu if it lived inside that same
       clipped box, even though the popup is position:absolute. -->
  <div class="dropdown toolbar-overflow" bind:this={overflowWrapEl}>
    <button type="button" class="icon-btn" bind:this={overflowBtn} title="More formatting options" aria-label="More formatting options" hidden>
      <svg class="icon"><use href="#icon-ellipsis-vertical"></use></svg>
    </button>
    <div class="dropdown-menu toolbar-overflow-menu" bind:this={overflowMenuEl}></div>
  </div>
</div>

<!-- A separate root element (not nested inside #toolbar) so it can sit in
     its own grid column, aligned above the comment sidenav — see
     #body's grid-template-areas in style.css. #toolbar-mount's
     display:contents makes both this and #toolbar direct grid children
     of #body, despite both being rendered by this one component. -->
<div class="view-selector" role="group" aria-label="View mode">
  <button type="button" class:active={editorOn} title="Toggle editor pane" aria-label="Toggle editor pane" aria-pressed={editorOn} onclick={toggleEditorPane}>
    <svg class="icon"><use href="#icon-panel-left"></use></svg>
  </button>
  <button type="button" class:active={previewOn} title="Toggle preview pane" aria-label="Toggle preview pane" aria-pressed={previewOn} onclick={togglePreviewPane}>
    <svg class="icon"><use href="#icon-panel-right"></use></svg>
  </button>
</div>
