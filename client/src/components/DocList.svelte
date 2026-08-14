<script lang="ts">
  import { onMount } from "svelte";
  import { docsStore, activeIdStore, activeDocContent, duplicateDoc, deleteDoc } from "../stores/docs";

  const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

  interface Heading {
    level: number;
    text: string;
    line: number;
  }

  function extractHeadings(content: string): Heading[] {
    const headings: Heading[] = [];
    content.split("\n").forEach((line, i) => {
      const match = line.match(HEADING_RE);
      if (match) headings.push({ level: match[1].length, text: match[2], line: i });
    });
    return headings;
  }

  const sorted = $derived([...$docsStore].sort((a, b) => b.updatedAt - a.updatedAt));

  // Each row's heading outline, Google-Docs "Document tabs" style — nested
  // under the doc itself rather than a separate global panel. The active
  // doc reads live (undebounced) editor content so its outline updates
  // as-you-type; inactive docs read their last-saved content, which is all
  // that exists for them anyway (their CodeMirror buffer isn't live).
  const rows = $derived(
    sorted.map((doc) => ({
      doc,
      headings: extractHeadings(doc.id === $activeIdStore ? $activeDocContent : doc.content || ""),
    }))
  );

  let expandedIds = $state(new Set<string>());
  let openMenuId = $state<string | null>(null);
  let menuPos = $state({ top: 0, left: 0 });
  let activeTab = $state<"documents" | "headings">("documents");

  // rows already computes {doc, headings} per document above; these just
  // narrow it to whichever document is currently active, for the
  // top-level Headings tab (mobile only — see style.css .doclist-tabs).
  const activeDocHeadings = $derived(rows.find((r) => r.doc.id === $activeIdStore)?.headings ?? []);
  const activeDocName = $derived(rows.find((r) => r.doc.id === $activeIdStore)?.doc.name || "Untitled");

  function select(id: string) {
    window.MDE.switchDoc(id);
  }

  function toggleOutline(id: string, e: MouseEvent) {
    e.stopPropagation();
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedIds = next;
  }

  function jump(id: string, line: number) {
    window.MDE.jumpToLine(id, line);
  }

  const MENU_WIDTH = 170;
  // 3 fixed rows (Rename/Duplicate/Delete) at this CSS's own padding/
  // font-size, plus the popover's 1px top+bottom border — a plain
  // estimate rather than measuring the real element after render,
  // since the content here never varies (avoids a visible
  // render-at-wrong-position-then-jump flash).
  const MENU_HEIGHT = 120;

  function openMenu(id: string, e: MouseEvent) {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // Flip above the trigger instead of below when there isn't room —
    // the mobile bottom sheet is short enough (50vh) that a row near
    // its bottom edge would otherwise push "Delete" past the viewport
    // with no way to scroll it into view.
    const top =
      rect.bottom + 4 + MENU_HEIGHT > window.innerHeight ? Math.max(8, rect.top - MENU_HEIGHT - 4) : rect.bottom + 4;
    menuPos = { top, left: Math.max(8, rect.right - MENU_WIDTH) };
    openMenuId = openMenuId === id ? null : id;
  }

  function closeMenu() {
    openMenuId = null;
  }

  function rename(id: string) {
    closeMenu();
    if (id !== $activeIdStore) window.MDE.switchDoc(id);
    const input = document.getElementById("docTitle") as HTMLInputElement | null;
    input?.focus();
    input?.select();
  }

  function duplicate(id: string) {
    closeMenu();
    duplicateDoc(id);
  }

  function del(id: string) {
    closeMenu();
    deleteDoc(id);
  }

  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (openMenuId && !(e.target as HTMLElement).closest(".doc-menu-popover, .doc-menu-btn")) closeMenu();
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  });
</script>

<div class="doclist-tabs">
  <button type="button" class:active={activeTab === "documents"} onclick={() => (activeTab = "documents")}>
    Documents
  </button>
  <button type="button" class:active={activeTab === "headings"} onclick={() => (activeTab = "headings")}>
    Headings
  </button>
</div>

{#if activeTab === "documents"}
  <ul id="docList">
    {#each rows as { doc, headings } (doc.id)}
      <li class:active={doc.id === $activeIdStore}>
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="doc-row" onclick={() => select(doc.id)}>
          {#if headings.length > 0}
            <button
              type="button"
              class="doc-outline-toggle"
              class:expanded={expandedIds.has(doc.id)}
              aria-label={expandedIds.has(doc.id) ? "Hide outline" : "Show outline"}
              onclick={(e) => toggleOutline(doc.id, e)}
            >
              <svg class="icon"><use href="#icon-chevron-right"></use></svg>
            </button>
          {:else}
            <span class="doc-outline-toggle-spacer"></span>
          {/if}
          <svg class="icon doc-icon"><use href="#icon-file"></use></svg>
          <span class="doc-name">{doc.name || "Untitled"}</span>
          <button type="button" class="doc-menu-btn" class:active={openMenuId === doc.id} aria-label="Document options" onclick={(e) => openMenu(doc.id, e)}>
            <svg class="icon"><use href="#icon-ellipsis-vertical"></use></svg>
          </button>
        </div>
        {#if headings.length > 0 && expandedIds.has(doc.id)}
          <ul class="doc-outline">
            {#each headings as h (h.line)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <li class="outline-item" data-level={h.level} title={h.text} onclick={() => jump(doc.id, h.line)}>
                {h.text}
              </li>
            {/each}
          </ul>
        {/if}
      </li>
    {/each}
  </ul>
{:else}
  <div class="doclist-headings-tab">
    <div class="doclist-headings-tab-label">{activeDocName}</div>
    {#if activeDocHeadings.length === 0}
      <p class="modal-hint">No headings in this document.</p>
    {:else}
      <ul class="doc-outline">
        {#each activeDocHeadings as h (h.line)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <li class="outline-item" data-level={h.level} title={h.text} onclick={() => jump($activeIdStore, h.line)}>
            {h.text}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

{#if openMenuId}
  {@const menuDocId = openMenuId}
  <div class="doc-menu-popover" style:top="{menuPos.top}px" style:left="{menuPos.left}px">
    <button type="button" onclick={() => rename(menuDocId)}>
      <svg class="icon"><use href="#icon-pencil"></use></svg> Rename
    </button>
    <button type="button" onclick={() => duplicate(menuDocId)}>
      <svg class="icon"><use href="#icon-copy"></use></svg> Duplicate
    </button>
    <button type="button" class="danger" onclick={() => del(menuDocId)}>
      <svg class="icon"><use href="#icon-trash-2"></use></svg> Delete
    </button>
  </div>
{/if}
